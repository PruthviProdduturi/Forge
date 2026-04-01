"""
NYC Taxi — Bronze Ingestion
===========================
Reads raw NYC TLC parquet data from Azure Open Datasets and writes it as
Delta to the bronze layer, partitioned by year and month.

Source:   wasbs://nyctlc@azureopendatastore.blob.core.windows.net/{taxi_type}/
Output:   bronze/nyc_taxi/{taxi_type}/year={Y}/month={M:02d}/
Schedule: Monthly via nyc_taxi_bronze DAG

Env vars:
  TAXI_TYPE       — yellow | green | fhv | hvfhv  (default: yellow)
  PARTITION_YEAR  — int (default: 2023)
  PARTITION_MONTH — int (default: 1)
  FORGE_ENV       — dev | staging | prod
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from pyspark.sql import functions as F

from forge_sdk import ForgeJob

# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------
TAXI_TYPE       = os.environ.get("TAXI_TYPE",        "yellow")
PARTITION_YEAR  = int(os.environ.get("PARTITION_YEAR",  "2023"))
PARTITION_MONTH = int(os.environ.get("PARTITION_MONTH", "1"))
FORGE_ENV       = os.environ.get("FORGE_ENV",        "dev")

STARTED_AT = datetime.now(timezone.utc)

# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------
job = ForgeJob(name="NycTaxiBronze")
spark = job.spark
log = job.log

log.info("params", taxi_type=TAXI_TYPE, year=PARTITION_YEAR, month=PARTITION_MONTH, env=FORGE_ENV)

# ---------------------------------------------------------------------------
# Source read — Azure Open Datasets (public, no auth required)
# ---------------------------------------------------------------------------
spark.conf.set(
    "fs.azure.account.auth.type.azureopendatastore.blob.core.windows.net", "None"
)

SRC = (
    f"wasbs://nyctlc@azureopendatastore.blob.core.windows.net"
    f"/{TAXI_TYPE}/puYear={PARTITION_YEAR}/puMonth={PARTITION_MONTH}/*.parquet"
)

raw = (
    spark.read
    .option("mergeSchema", "true")
    .parquet(SRC)
)

log.info("source_read", path=SRC, schema_fields=len(raw.schema.fields))

# ---------------------------------------------------------------------------
# Add audit columns
# ---------------------------------------------------------------------------
df = (
    raw
    .select(
        "*",
        F.current_timestamp().alias("_ingested_at"),
        F.input_file_name().alias("_source_file"),
        F.lit(TAXI_TYPE).alias("_taxi_type"),
    )
)

# ---------------------------------------------------------------------------
# Validate and write
# ---------------------------------------------------------------------------
row_count = df.count()
log.info("row_count", taxi_type=TAXI_TYPE, year=PARTITION_YEAR, month=PARTITION_MONTH, count=row_count)

if row_count == 0:
    log.warning("no_data_skipping_write")
    raise SystemExit(0)

DEST = job.paths.bronze(f"nyc_taxi/{TAXI_TYPE}/year={PARTITION_YEAR}/month={PARTITION_MONTH:02d}")

(
    df.write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .save(DEST)
)

log.info("write_complete", dest=DEST, rows=row_count)

# ---------------------------------------------------------------------------
# Tracker
# ---------------------------------------------------------------------------
tracker = {
    "version":      "v1",
    "job":          "NycTaxiBronze",
    "dataset":      f"bronze/nyc_taxi/{TAXI_TYPE}",
    "partition":    {"year": PARTITION_YEAR, "month": PARTITION_MONTH},
    "status":       "success",
    "rows_written": row_count,
    "started_at":   STARTED_AT.isoformat(),
    "completed_at": datetime.now(timezone.utc).isoformat(),
    "forge_env":    FORGE_ENV,
}

tracker_path = job.paths.bronze(
    f"nyc_taxi/{TAXI_TYPE}/year={PARTITION_YEAR}/month={PARTITION_MONTH:02d}/_tracker/tracker.json"
)

jvm  = spark.sparkContext._jvm
conf = spark.sparkContext._jsc.hadoopConfiguration()
p    = jvm.org.apache.hadoop.fs.Path(tracker_path)
out  = p.getFileSystem(conf).create(p, True)
out.write(bytearray(json.dumps(tracker, indent=2).encode("utf-8")))
out.close()

log.info("tracker_emitted", path=tracker_path)
