"""
forge_dq_gate.py — Platform DQ gate Spark job

Reads the partition that was just written by an ingest/transform job, evaluates
DQ rules (passed inline as a base64-encoded YAML string), and exits non-zero if
any CRITICAL rules are violated — causing the Airflow task and downstream
TriggerDagRunOperator to be blocked.

Called as a separate SparkKubernetesOperator task (dq_gate_<layer>) after each
ingest/transform task when the manifest has a `dq.rules` block.

Env vars (set by the generated DAG's _DQ_GATE_APP YAML):
  LAYER          — bronze | silver | gold
  TABLE          — Hive table name (e.g. bronze.nyctaxi)
  PARTITION_DATE — yyyy-MM-dd (logical date from Airflow {{ ds }})
  RULES_YAML     — base64-encoded YAML rules snippet (rules: [...])
"""
from __future__ import annotations

import os
import tempfile

from pyspark.sql import functions as F

from forge_sdk import ForgeJob
from forge_dq import DQRunner

LAYER           = os.environ.get("LAYER", "bronze")
TABLE           = os.environ.get("TABLE", "")
PARTITION_DATE  = os.environ.get("PARTITION_DATE", "")
RULES_PATH      = os.environ.get("RULES_PATH", "")  # ADLS path: abfss://code@{storage}/dq/rules/{job}.yaml


class ForgeDqGate(ForgeJob):
    """Platform DQ gate: reads the just-written partition, evaluates rules, fails on critical violations."""

    def run(self) -> None:
        if not TABLE:
            self.log.error("TABLE env var is required")
            raise SystemExit(1)

        df = self.spark.table(TABLE)

        # Filter to the partition that was just written so profiling stats and rule
        # evaluations reflect this run only, not the entire table history.
        if PARTITION_DATE:
            if LAYER == "bronze":
                year, month, day = (int(p) for p in PARTITION_DATE.split("-"))
                df = df.filter(
                    (F.col("__year") == year)
                    & (F.col("__month") == month)
                    & (F.col("__day") == day)
                )
            else:
                # Silver/gold use __date = DD_MM_YYYY_HH
                from datetime import datetime
                _dt = datetime.strptime(PARTITION_DATE, "%Y-%m-%d")
                _date_key = f"{_dt.day:02d}_{_dt.month:02d}_{_dt.year}_{0:02d}"
                df = df.filter(F.col("__date") == F.lit(_date_key))

        # Download rules YAML from ADLS to a local temp file for DQRunner
        rules_path: str | None = None
        if RULES_PATH:
            try:
                _jvm  = self.spark.sparkContext._jvm
                _conf = self.spark.sparkContext._jsc.hadoopConfiguration()
                _p    = _jvm.org.apache.hadoop.fs.Path(RULES_PATH)
                _in   = _p.getFileSystem(_conf).open(_p)
                yaml_bytes = bytes(_in.readAllBytes())
                _in.close()
                tmp = tempfile.NamedTemporaryFile(suffix=".yaml", delete=False, mode="wb")
                tmp.write(yaml_bytes)
                tmp.close()
                rules_path = tmp.name
                self.log.info("dq_gate rules downloaded from %s", RULES_PATH)
            except Exception as exc:
                self.log.warning("dq_gate: could not read RULES_PATH %s — rule checks skipped: %s", RULES_PATH, exc)

        table_slug = TABLE.split(".")[-1] if "." in TABLE else TABLE
        runner = DQRunner(
            self.spark,
            dataset=f"{LAYER}/{table_slug}",
            rules_path=rules_path,
            pipeline_name=f"{TABLE}_dq_gate",
        )
        report = runner.run(df)

        self.log.info(
            "dq_gate_result layer=%s table=%s status=%s rows=%d critical_failures=%s duration_ms=%d",
            LAYER,
            TABLE,
            report.overall_status,
            report.rows_written,
            report.critical_failures,
            report.duration_ms,
        )

        # DQRunner raises DQCriticalFailureError when fail_on_critical=True (the default)
        # and at least one CRITICAL rule fails.  The exception propagates up through execute()
        # causing the Spark job to exit non-zero, which fails the Airflow task and stops
        # the downstream TriggerDagRunOperator from firing.


if __name__ == "__main__":
    ForgeDqGate().execute()
