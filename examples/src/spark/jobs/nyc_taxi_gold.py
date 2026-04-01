"""
NYC Taxi — Gold Aggregation
===========================
Builds four Gold analytical Delta tables from the silver nyc_taxi/trips layer
for the specified partition (year × month).

Tables produced:
  daily_summary     — trips, revenue, avg fare/tip/distance per day × taxi type
  hourly_demand     — trip volume by hour × day-of-week × taxi type (capacity heatmap)
  zone_stats        — pickup/dropoff throughput + top destination per TLC zone
  payment_summary   — payment type mix and tip behaviour by date

All tables:
  - Written as Delta, partitioned by pickup_year / pickup_month
  - Idempotent: replaceWhere on pickup_year + pickup_month

Env vars:
  PARTITION_YEAR  — int (default: 2023)
  PARTITION_MONTH — int (default: 1)
  FORGE_ENV       — dev | staging | prod
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from pyspark.sql import types as T
from pyspark.sql.window import Window

from forge_sdk import ForgeJob

# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------
PARTITION_YEAR  = int(os.environ.get("PARTITION_YEAR",  "2023"))
PARTITION_MONTH = int(os.environ.get("PARTITION_MONTH", "1"))
FORGE_ENV       = os.environ.get("FORGE_ENV", "dev")

STARTED_AT = datetime.now(timezone.utc)

# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------
job = ForgeJob(name="NycTaxiGold")
spark = job.spark
log = job.log

log.info("params", year=PARTITION_YEAR, month=PARTITION_MONTH, env=FORGE_ENV)

# ---------------------------------------------------------------------------
# Silver read — cached; reused across all aggregations
# ---------------------------------------------------------------------------
silver_df = (
    spark.read
    .format("delta")
    .load(job.paths.silver("nyc_taxi/trips"))
    .filter(
        (F.col("pickup_year")  == PARTITION_YEAR) &
        (F.col("pickup_month") == PARTITION_MONTH)
    )
    .cache()
)

silver_count = silver_df.count()
log.info("silver_rows", year=PARTITION_YEAR, month=PARTITION_MONTH, count=silver_count)

if silver_count == 0:
    log.warning("no_silver_data_skipping_gold_write")
    raise SystemExit(0)

# ---------------------------------------------------------------------------
# Write helper
# ---------------------------------------------------------------------------
def _write_gold(df: DataFrame, table: str) -> int:
    dest = job.paths.gold(f"nyc_taxi/{table}")
    (
        df.write
        .format("delta")
        .mode("overwrite")
        .option("overwriteSchema", "true")
        .option("replaceWhere",
                f"pickup_year = {PARTITION_YEAR} AND pickup_month = {PARTITION_MONTH}")
        .partitionBy("pickup_year", "pickup_month")
        .save(dest)
    )
    count = df.count()
    log.info("gold_write", table=table, rows=count)
    return count

# ---------------------------------------------------------------------------
# daily_summary — trips, revenue, avg fare/tip/distance per day × taxi type
# ---------------------------------------------------------------------------
daily_summary = (
    silver_df
    .withColumn("pickup_date", F.to_date("pickup_datetime"))
    .groupBy("pickup_date", "taxi_type")
    .agg(
        F.count("*").alias("trip_count"),
        F.sum("total_amount").alias("total_revenue"),
        F.avg("fare_amount").alias("avg_fare"),
        F.avg(
            F.when(F.col("fare_amount") > 0, F.col("tip_amount") / F.col("fare_amount") * 100)
        ).alias("avg_tip_pct"),
        F.avg("trip_distance").alias("avg_distance_miles"),
        F.percentile_approx("fare_amount", 0.95).alias("p95_fare"),
    )
    .withColumn("pickup_year",  F.lit(PARTITION_YEAR))
    .withColumn("pickup_month", F.lit(PARTITION_MONTH))
)

# ---------------------------------------------------------------------------
# hourly_demand — avg trips per hour-of-day × day-of-week × taxi type
# ---------------------------------------------------------------------------
hourly = (
    silver_df
    .withColumn("pickup_date", F.to_date("pickup_datetime"))
    .withColumn("pickup_hour", F.hour("pickup_datetime"))
    .withColumn("day_of_week", F.dayofweek("pickup_datetime"))
    .groupBy("pickup_date", "pickup_hour", "day_of_week", "taxi_type")
    .agg(F.count("*").alias("daily_trip_count"))
)
hourly_demand = (
    hourly
    .groupBy("pickup_hour", "day_of_week", "taxi_type")
    .agg(
        F.sum("daily_trip_count").alias("trip_count"),
        F.avg("daily_trip_count").alias("avg_trip_count_per_day"),
    )
    .withColumn("pickup_year",  F.lit(PARTITION_YEAR))
    .withColumn("pickup_month", F.lit(PARTITION_MONTH))
)

# ---------------------------------------------------------------------------
# zone_stats — pickup/dropoff throughput + top destination per TLC zone
# ---------------------------------------------------------------------------
pair_window = Window.partitionBy("pickup_location_id").orderBy(F.desc("pair_count"))
top_dest = (
    silver_df
    .groupBy("pickup_location_id", "dropoff_location_id")
    .agg(F.count("*").alias("pair_count"))
    .withColumn("rn", F.row_number().over(pair_window))
    .filter(F.col("rn") == 1)
    .select(
        F.col("pickup_location_id").alias("zone_id"),
        F.col("dropoff_location_id").alias("top_destination_zone"),
    )
)
zone_stats = (
    silver_df
    .withColumn("pickup_hour", F.hour("pickup_datetime"))
    .groupBy("pickup_location_id")
    .agg(
        F.count("*").alias("pickup_count"),
        F.avg("fare_amount").alias("avg_fare"),
        F.mode("pickup_hour").alias("top_pickup_hour"),
    )
    .withColumnRenamed("pickup_location_id", "zone_id")
    .join(
        silver_df.groupBy("dropoff_location_id")
                 .agg(F.count("*").alias("dropoff_count"))
                 .withColumnRenamed("dropoff_location_id", "zone_id"),
        "zone_id", "left",
    )
    .join(top_dest, "zone_id", "left")
    .withColumn("pickup_year",  F.lit(PARTITION_YEAR))
    .withColumn("pickup_month", F.lit(PARTITION_MONTH))
)

# ---------------------------------------------------------------------------
# payment_summary — payment type mix and tip behaviour by date
# ---------------------------------------------------------------------------
_PAYMENT_LABELS = {
    1: "Credit Card", 2: "Cash", 3: "No Charge",
    4: "Dispute",     5: "Unknown", 6: "Voided Trip",
}
payment_map = F.create_map(*[x for kv in [(F.lit(k), F.lit(v)) for k, v in _PAYMENT_LABELS.items()] for x in kv])
payment_summary = (
    silver_df
    .filter(F.col("payment_type").isNotNull())
    .withColumn("pickup_date", F.to_date("pickup_datetime"))
    .withColumn("payment_type_label", F.coalesce(payment_map[F.col("payment_type")], F.lit("Other")))
    .groupBy("pickup_date", "payment_type_label")
    .agg(
        F.count("*").alias("trip_count"),
        F.sum("total_amount").alias("total_amount"),
        F.avg(
            F.when(F.col("fare_amount") > 0, F.col("tip_amount") / F.col("fare_amount") * 100)
        ).alias("avg_tip_pct"),
    )
    .withColumn("pickup_year",  F.lit(PARTITION_YEAR))
    .withColumn("pickup_month", F.lit(PARTITION_MONTH))
)

# ---------------------------------------------------------------------------
# Write all tables
# ---------------------------------------------------------------------------
tables = {
    "daily_summary":   _write_gold(daily_summary,  "daily_summary"),
    "hourly_demand":   _write_gold(hourly_demand,   "hourly_demand"),
    "zone_stats":      _write_gold(zone_stats,      "zone_stats"),
    "payment_summary": _write_gold(payment_summary, "payment_summary"),
}

silver_df.unpersist()

# ---------------------------------------------------------------------------
# Tracker
# ---------------------------------------------------------------------------
tracker = {
    "version":      "v1",
    "job":          "NycTaxiGold",
    "dataset":      "gold/nyc_taxi",
    "partition":    {"year": PARTITION_YEAR, "month": PARTITION_MONTH},
    "status":       "success",
    "tables":       tables,
    "rows_written": sum(tables.values()),
    "started_at":   STARTED_AT.isoformat(),
    "completed_at": datetime.now(timezone.utc).isoformat(),
    "forge_env":    FORGE_ENV,
}

tracker_path = job.paths.gold(
    f"nyc_taxi/_tracker/year={PARTITION_YEAR}/month={PARTITION_MONTH:02d}/tracker.json"
)

jvm  = spark.sparkContext._jvm
conf = spark.sparkContext._jsc.hadoopConfiguration()
p    = jvm.org.apache.hadoop.fs.Path(tracker_path)
out  = p.getFileSystem(conf).create(p, True)
out.write(bytearray(json.dumps(tracker, indent=2).encode("utf-8")))
out.close()

log.info("tracker_emitted", path=tracker_path, total_rows=tracker["rows_written"])
