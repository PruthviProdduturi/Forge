"""
Example Forge job — full scaffold template
==========================================
Copy this file as a starting point for new pipeline jobs.

This template shows the complete ForgeJob pattern including:
  - Environment parameter injection (PARTITION_DATE, RESTATE, etc.)
  - Idempotency via ADLS tracker files (prevents double-writes)
  - Source read from bronze / external source
  - Business logic transform block
  - Delta write with replaceWhere (partition-level overwrite)
  - Tracker file write (downstream dependency marker)
  - DQ gate via @track decorator (forge_dq)
  - OpenLineage emitted automatically via forge_session()

Pipeline summary:
    Source:   bronze/<domain>/<dataset>/      (Delta, partitioned daily)
    Output:   silver/<domain>/<dataset>/      (Delta, partitioned by __date)
    HMS:      lakehouse.silver.<dataset>
    Schedule: Daily at 06:00 UTC (or triggered)
    Owner:    data-engineering

Deploy:
    1. Copy to examples/src/spark/jobs/<dataset>_silver.py
    2. Add SparkKubernetesOperator to orchestration/airflow/dags/
    3. Add DQ rules to orchestration/dq/rules/<dataset>_silver.yaml
    4. Register source in portal Data Sources tab if reading from external source

DQ rules:
    orchestration/dq/rules/<dataset>_silver.yaml

Lineage:
    Emitted automatically to Microsoft Purview via the OpenLineage listener
    configured in forge_session(). No extra code required.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from pyspark.sql import functions as F

from forge_sdk import ForgeJob

try:
    from forge_dq import track  # type: ignore[import-untyped]
except ImportError:
    import functools

    def track(**kwargs):  # type: ignore[misc]
        """No-op fallback when forge_dq is not installed."""
        def decorator(fn):
            @functools.wraps(fn)
            def wrapper(*args, **kw):
                return fn(*args, **kw)
            return wrapper
        return decorator


# ---------------------------------------------------------------------------
# Parameters — injected by Airflow via SparkApplication env vars
# ---------------------------------------------------------------------------
FORGE_ENV      = os.environ.get("FORGE_ENV", "dev")
PARTITION_DATE = os.environ.get("PARTITION_DATE", "")        # yyyy-MM-dd
PARTITION_HOUR = int(os.environ.get("PARTITION_HOUR", "0"))  # 0–23
RESTATE        = os.environ.get("RESTATE", "false").lower() in ("1", "true", "yes")

# ---------------------------------------------------------------------------
# Dataset identity — update these for each new job
# ---------------------------------------------------------------------------
_DOMAIN      = "demo"          # e.g. crm, finance, transport
_DATASET     = "orders"        # e.g. orders, invoices, trips
_HMS_TABLE   = f"lakehouse.silver.{_DOMAIN}_{_DATASET}"
_BRONZE_PATH = f"bronze/{_DOMAIN}/{_DATASET}"
_SILVER_PATH = f"silver/{_DOMAIN}/{_DATASET}"
_DQ_RULES    = f"orchestration/dq/rules/{_DOMAIN}_{_DATASET}_silver.yaml"


class ExampleSilverJob(ForgeJob):
    """
    Template: reads a daily bronze partition, applies transforms,
    and writes clean data to the silver layer.

    Replace this docstring with a description of your specific job.
    """

    # -----------------------------------------------------------------------
    # Tracker helpers — idempotency (skip re-runs unless RESTATE=true)
    # -----------------------------------------------------------------------

    def _tracker_path(self) -> str:
        """ADLS path for this partition's tracker file."""
        _year, _month, _day = (int(x) for x in PARTITION_DATE.split("-"))
        return (
            f"abfss://silver@{self.storage}/{_DOMAIN}/{_DATASET}/_tracker"
            f"/{_year}/{_month}/{_day}/{PARTITION_HOUR}/tracker.json"
        )

    def _tracker_exists(self) -> bool:
        try:
            _path = self._tracker_path()
            _jvm  = self.spark.sparkContext._jvm
            _conf = self.spark.sparkContext._jsc.hadoopConfiguration()
            _p    = _jvm.org.apache.hadoop.fs.Path(_path)
            return bool(_p.getFileSystem(_conf).exists(_p))
        except Exception:
            return False

    def setup(self) -> None:
        if not RESTATE and self._tracker_exists():
            self.log.info(
                "partition_complete skipping table=%s date=%s — pass RESTATE=true to force rerun",
                _HMS_TABLE, PARTITION_DATE,
            )
            raise SystemExit(0)
        if RESTATE:
            self.log.info("restatement_mode table=%s tracker=%s", _HMS_TABLE, self._tracker_path())

    # -----------------------------------------------------------------------
    # Core job logic
    # -----------------------------------------------------------------------

    def run(self) -> None:
        _year, _month, _day = (int(x) for x in PARTITION_DATE.split("-"))

        # -------------------------------------------------------------------
        # 1. Read source from bronze (filter to this partition)
        # -------------------------------------------------------------------
        raw = (
            self.spark.read
            .format("delta")
            .load(self.bronze(_BRONZE_PATH))
            .filter(
                (F.col("__year") == _year) &
                (F.col("__month") == _month) &
                (F.col("__day") == _day)
            )
        )
        self.log.info("source_read path=%s partition=%s", _BRONZE_PATH, PARTITION_DATE)

        # -------------------------------------------------------------------
        # 2. Business logic — replace this block with your transforms
        # -------------------------------------------------------------------
        df = (
            raw
            # Drop duplicates on natural key
            .dropDuplicates(["id"])
            # Drop rows missing critical fields
            .dropna(subset=["id", "created_at"])
            # Cast and derive fields
            .withColumn("amount", F.col("amount").cast("double"))
            .withColumn("created_date", F.to_date("created_at"))
            .withColumn("_processed_at", F.current_timestamp())
            # Drop raw staging columns
            .drop("_source", "_ingested_at")
        )

        # -------------------------------------------------------------------
        # 3. DQ gate — fails fast if error-severity rules are violated
        # -------------------------------------------------------------------
        @track(
            dataset=_HMS_TABLE,
            rules=_DQ_RULES,
            fail_fast=True,
        )
        def _write() -> None:
            (
                df
                .withColumn("__date", F.lit(PARTITION_DATE))
                .write
                .format("delta")
                .mode("overwrite")
                .option("overwriteSchema", "true")
                .option("replaceWhere", f"__date = '{PARTITION_DATE}'")
                .partitionBy("__date")
                .saveAsTable(_HMS_TABLE)
            )

        # -------------------------------------------------------------------
        # 4. Write
        # -------------------------------------------------------------------
        _row_count = df.count()
        self.log.info("rows_to_write count=%d", _row_count)
        if _row_count == 0:
            self.log.warning("empty_partition_skipping table=%s date=%s", _HMS_TABLE, PARTITION_DATE)
            return

        _write()
        self.log.info("write_complete table=%s rows=%d", _HMS_TABLE, _row_count)

        # -------------------------------------------------------------------
        # 5. Write tracker — marks partition complete for downstream DAGs
        # -------------------------------------------------------------------
        _tracker = {
            "version":      "v1",
            "job":          self.__class__.__name__,
            "table":        _HMS_TABLE,
            "partition":    {"date": PARTITION_DATE, "hour": PARTITION_HOUR},
            "status":       "success",
            "rows_written": _row_count,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "forge_env":    FORGE_ENV,
        }
        _tracker_path = self._tracker_path()
        _jvm  = self.spark.sparkContext._jvm
        _conf = self.spark.sparkContext._jsc.hadoopConfiguration()
        _p    = _jvm.org.apache.hadoop.fs.Path(_tracker_path)
        _out  = _p.getFileSystem(_conf).create(_p, True)
        _out.write(bytearray(json.dumps(_tracker, indent=2).encode("utf-8")))
        _out.close()
        self.log.info("tracker_written path=%s rows=%d", _tracker_path, _row_count)


if __name__ == "__main__":
    ExampleSilverJob().execute()
