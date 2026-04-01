"""
NYC Taxi — Silver Transform
===========================
Reads all taxi types from bronze, applies a unified schema mapping, filters
invalid rows, deduplicates on trip_id, then writes a cleaned silver Delta
table partitioned by pickup_year and pickup_month.

Source:   bronze/nyc_taxi/{yellow,green,fhv,hvfhv}/year=/month=/
Output:   silver/nyc_taxi/trips/  (partitioned by pickup_year, pickup_month)
DQ rules: dq/rules/nyc_taxi_silver.yaml  (via @track)

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

from forge_sdk import ForgeJob

try:
    from forge_dq import track
except ImportError:
    import functools
    def track(**kwargs):
        def decorator(fn):
            @functools.wraps(fn)
            def wrapper(*a, **kw): return fn(*a, **kw)
            return wrapper
        return decorator

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
job = ForgeJob(name="NycTaxiSilver")
spark = job.spark
log = job.log

log.info("params", year=PARTITION_YEAR, month=PARTITION_MONTH, env=FORGE_ENV)

# ---------------------------------------------------------------------------
# Bronze read — missing taxi types are skipped with a warning
# ---------------------------------------------------------------------------
def _read_bronze(taxi_type: str) -> DataFrame | None:
    path = job.paths.bronze(f"nyc_taxi/{taxi_type}/year={PARTITION_YEAR}/month={PARTITION_MONTH:02d}")
    try:
        df = spark.read.format("delta").load(path)
        log.info("bronze_read", taxi_type=taxi_type)
        return df
    except Exception:
        log.warning("bronze_missing", taxi_type=taxi_type, year=PARTITION_YEAR, month=PARTITION_MONTH)
        return None

TAXI_TYPES = ["yellow", "green", "fhv", "hvfhv"]
bronze_frames = {t: _read_bronze(t) for t in TAXI_TYPES}

# ---------------------------------------------------------------------------
# Schema mappers — one per taxi type → unified silver schema
# ---------------------------------------------------------------------------
def _yellow(df: DataFrame) -> DataFrame:
    return df.select(
        F.sha2(F.concat_ws("|", F.col("tpepPickupDatetime"), F.col("tpepDropoffDatetime"),
                           F.col("PULocationID"), F.col("DOLocationID")), 256).alias("trip_id"),
        F.lit("yellow").alias("taxi_type"),
        F.col("tpepPickupDatetime").cast(T.TimestampType()).alias("pickup_datetime"),
        F.col("tpepDropoffDatetime").cast(T.TimestampType()).alias("dropoff_datetime"),
        F.col("PULocationID").cast(T.IntegerType()).alias("pickup_location_id"),
        F.col("DOLocationID").cast(T.IntegerType()).alias("dropoff_location_id"),
        F.col("passengerCount").cast(T.IntegerType()).alias("passenger_count"),
        F.col("tripDistance").cast(T.DoubleType()).alias("trip_distance"),
        F.col("fare_amount").cast(T.DoubleType()).alias("fare_amount"),
        F.col("tip_amount").cast(T.DoubleType()).alias("tip_amount"),
        F.col("tolls_amount").cast(T.DoubleType()).alias("tolls_amount"),
        F.col("total_amount").cast(T.DoubleType()).alias("total_amount"),
        F.col("payment_type").cast(T.IntegerType()).alias("payment_type"),
        F.coalesce(F.col("congestion_surcharge"), F.lit(0.0)).cast(T.DoubleType()).alias("congestion_surcharge"),
        F.coalesce(F.col("airport_fee"), F.lit(0.0)).cast(T.DoubleType()).alias("airport_fee"),
    )

def _green(df: DataFrame) -> DataFrame:
    return df.select(
        F.sha2(F.concat_ws("|", F.col("lpep_pickup_datetime"), F.col("lpep_dropoff_datetime"),
                           F.col("PULocationID"), F.col("DOLocationID")), 256).alias("trip_id"),
        F.lit("green").alias("taxi_type"),
        F.col("lpep_pickup_datetime").cast(T.TimestampType()).alias("pickup_datetime"),
        F.col("lpep_dropoff_datetime").cast(T.TimestampType()).alias("dropoff_datetime"),
        F.col("PULocationID").cast(T.IntegerType()).alias("pickup_location_id"),
        F.col("DOLocationID").cast(T.IntegerType()).alias("dropoff_location_id"),
        F.col("passenger_count").cast(T.IntegerType()).alias("passenger_count"),
        F.col("trip_distance").cast(T.DoubleType()).alias("trip_distance"),
        F.col("fare_amount").cast(T.DoubleType()).alias("fare_amount"),
        F.col("tip_amount").cast(T.DoubleType()).alias("tip_amount"),
        F.col("tolls_amount").cast(T.DoubleType()).alias("tolls_amount"),
        F.col("total_amount").cast(T.DoubleType()).alias("total_amount"),
        F.col("payment_type").cast(T.IntegerType()).alias("payment_type"),
        F.coalesce(F.col("congestion_surcharge"), F.lit(0.0)).cast(T.DoubleType()).alias("congestion_surcharge"),
        F.lit(0.0).cast(T.DoubleType()).alias("airport_fee"),
    )

def _fhv(df: DataFrame) -> DataFrame:
    return df.select(
        F.sha2(F.concat_ws("|", F.col("pickup_datetime"), F.col("dropOff_datetime"),
                           F.col("PUlocationID"), F.col("DOlocationID")), 256).alias("trip_id"),
        F.lit("fhv").alias("taxi_type"),
        F.col("pickup_datetime").cast(T.TimestampType()).alias("pickup_datetime"),
        F.col("dropOff_datetime").cast(T.TimestampType()).alias("dropoff_datetime"),
        F.col("PUlocationID").cast(T.IntegerType()).alias("pickup_location_id"),
        F.col("DOlocationID").cast(T.IntegerType()).alias("dropoff_location_id"),
        F.lit(None).cast(T.IntegerType()).alias("passenger_count"),
        F.lit(None).cast(T.DoubleType()).alias("trip_distance"),
        F.lit(None).cast(T.DoubleType()).alias("fare_amount"),
        F.lit(None).cast(T.DoubleType()).alias("tip_amount"),
        F.lit(None).cast(T.DoubleType()).alias("tolls_amount"),
        F.lit(None).cast(T.DoubleType()).alias("total_amount"),
        F.lit(None).cast(T.IntegerType()).alias("payment_type"),
        F.lit(0.0).cast(T.DoubleType()).alias("congestion_surcharge"),
        F.lit(0.0).cast(T.DoubleType()).alias("airport_fee"),
    )

def _hvfhv(df: DataFrame) -> DataFrame:
    return df.select(
        F.sha2(F.concat_ws("|", F.col("pickup_datetime"), F.col("dropoff_datetime"),
                           F.col("PULocationID"), F.col("DOLocationID")), 256).alias("trip_id"),
        F.lit("hvfhv").alias("taxi_type"),
        F.col("pickup_datetime").cast(T.TimestampType()).alias("pickup_datetime"),
        F.col("dropoff_datetime").cast(T.TimestampType()).alias("dropoff_datetime"),
        F.col("PULocationID").cast(T.IntegerType()).alias("pickup_location_id"),
        F.col("DOLocationID").cast(T.IntegerType()).alias("dropoff_location_id"),
        F.lit(None).cast(T.IntegerType()).alias("passenger_count"),
        F.col("trip_miles").cast(T.DoubleType()).alias("trip_distance"),
        F.col("base_passenger_fare").cast(T.DoubleType()).alias("fare_amount"),
        F.col("tips").cast(T.DoubleType()).alias("tip_amount"),
        F.col("tolls").cast(T.DoubleType()).alias("tolls_amount"),
        (F.col("base_passenger_fare") + F.coalesce(F.col("tips"), F.lit(0))
         + F.coalesce(F.col("tolls"), F.lit(0))
         + F.coalesce(F.col("congestion_surcharge"), F.lit(0))
         + F.coalesce(F.col("airport_fee"), F.lit(0))).cast(T.DoubleType()).alias("total_amount"),
        F.lit(None).cast(T.IntegerType()).alias("payment_type"),
        F.coalesce(F.col("congestion_surcharge"), F.lit(0.0)).cast(T.DoubleType()).alias("congestion_surcharge"),
        F.coalesce(F.col("airport_fee"), F.lit(0.0)).cast(T.DoubleType()).alias("airport_fee"),
    )

MAPPERS = {"yellow": _yellow, "green": _green, "fhv": _fhv, "hvfhv": _hvfhv}

# ---------------------------------------------------------------------------
# Union all available taxi types
# ---------------------------------------------------------------------------
frames = [MAPPERS[t](df) for t, df in bronze_frames.items() if df is not None]
if not frames:
    log.error("no_bronze_data_available")
    raise SystemExit(1)

combined = frames[0]
for f in frames[1:]:
    combined = combined.union(f)

# ---------------------------------------------------------------------------
# Quality filter
# ---------------------------------------------------------------------------
window_start = datetime(PARTITION_YEAR, PARTITION_MONTH, 1, tzinfo=timezone.utc)
next_month   = PARTITION_MONTH % 12 + 1
next_year    = PARTITION_YEAR + (1 if PARTITION_MONTH == 12 else 0)
window_end   = datetime(next_year, next_month, 1, tzinfo=timezone.utc)

cleaned = (
    combined
    .filter(F.col("pickup_datetime").isNotNull())
    .filter(F.col("dropoff_datetime").isNotNull())
    .filter(F.col("dropoff_datetime") > F.col("pickup_datetime"))
    .filter(F.col("pickup_datetime") >= F.lit(window_start.isoformat()).cast(T.TimestampType()))
    .filter(F.col("pickup_datetime") <  F.lit(window_end.isoformat()).cast(T.TimestampType()))
    .filter(F.col("pickup_location_id").isNotNull() & F.col("pickup_location_id").between(1, 265))
    .filter(F.col("dropoff_location_id").isNotNull() & F.col("dropoff_location_id").between(1, 265))
    .filter(F.col("trip_distance").isNull() | (F.col("trip_distance") >= 0))
    .filter(F.col("fare_amount").isNull()   | (F.col("fare_amount")   >= 0))
)

to_write = (
    cleaned
    .dropDuplicates(["trip_id"])
    .withColumn("pickup_year",  F.year("pickup_datetime"))
    .withColumn("pickup_month", F.month("pickup_datetime"))
    .withColumn("_processed_at", F.current_timestamp())
)

# ---------------------------------------------------------------------------
# DQ gate + write
# ---------------------------------------------------------------------------
DEST = job.paths.silver("nyc_taxi/trips")

@track(
    dataset="silver/nyc_taxi/trips",
    rules="dq/rules/nyc_taxi_silver.yaml",
)
def _write() -> None:
    (
        to_write.write
        .format("delta")
        .mode("overwrite")
        .option("overwriteSchema", "true")
        .partitionBy("pickup_year", "pickup_month")
        .option("replaceWhere",
                f"pickup_year = {PARTITION_YEAR} AND pickup_month = {PARTITION_MONTH}")
        .save(DEST)
    )

_write()

row_count = to_write.count()
log.info("silver_complete", year=PARTITION_YEAR, month=PARTITION_MONTH, rows=row_count)

# ---------------------------------------------------------------------------
# Tracker
# ---------------------------------------------------------------------------
tracker = {
    "version":      "v1",
    "job":          "NycTaxiSilver",
    "dataset":      "silver/nyc_taxi/trips",
    "partition":    {"year": PARTITION_YEAR, "month": PARTITION_MONTH},
    "status":       "success",
    "rows_written": row_count,
    "started_at":   STARTED_AT.isoformat(),
    "completed_at": datetime.now(timezone.utc).isoformat(),
    "forge_env":    FORGE_ENV,
}

tracker_path = job.paths.silver(
    f"nyc_taxi/trips/year={PARTITION_YEAR}/month={PARTITION_MONTH:02d}/_tracker/tracker.json"
)

jvm  = spark.sparkContext._jvm
conf = spark.sparkContext._jsc.hadoopConfiguration()
p    = jvm.org.apache.hadoop.fs.Path(tracker_path)
out  = p.getFileSystem(conf).create(p, True)
out.write(bytearray(json.dumps(tracker, indent=2).encode("utf-8")))
out.close()

log.info("tracker_emitted", path=tracker_path)
