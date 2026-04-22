"""
forge_dq.output.writer — Appends DQ results to Delta tables on ADLS Gen2.

All writes use append mode with mergeSchema=True to handle evolution.
Tables are created with the correct schema on first write.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from forge_dq.config import DQConfig
from forge_dq.output.schema import (
    AUTO_METRICS_SCHEMA,
    ANOMALY_RESULTS_SCHEMA,
    RULE_RESULTS_SCHEMA,
)

if TYPE_CHECKING:
    from pyspark.sql import SparkSession

    from forge_dq.rules.base import RuleResult

logger = logging.getLogger(__name__)


def _safe_dataset_name(dataset_path: str) -> str:
    """Derive the safe Delta table directory name from a dataset path.

    Replaces '/' with '_'.  e.g. ``silver/orders_cleaned`` → ``silver_orders_cleaned``.
    """
    return dataset_path.strip("/").replace("/", "_")


def _container_from_path(dataset_path: str) -> str:
    """Derive the ADLS container from the dataset path prefix.

    The first path segment is the container name.
    e.g. ``silver/orders_cleaned`` → ``silver``
         ``gold/aggregates/daily``  → ``gold``
    """
    return dataset_path.strip("/").split("/")[0]


class DeltaWriter:
    """Writes DQ output rows to the three Delta tables on ADLS Gen2.

    Args:
        spark: Active SparkSession.
        config: DQConfig instance.
        dataset_abfss_path: Full ADLS path for the dataset
            (e.g. ``abfss://bronze@.../Transport/.../NycTaxiBronze``).
            When provided, DQ output is written co-located next to the data
            at ``{dataset_abfss_path}/_dq/{output_type}/`` and the table is
            registered in HMS under the ``_dq`` database for portal discovery.
            When omitted, the legacy container-root ``_dq/`` path is used.
    """

    def __init__(
        self,
        spark: "SparkSession",
        config: DQConfig,
        dataset_abfss_path: str | None = None,
    ) -> None:
        self.spark = spark
        self.config = config
        self.dataset_abfss_path = dataset_abfss_path

    # ------------------------------------------------------------------
    # Public write methods
    # ------------------------------------------------------------------

    def write_auto_metrics(
        self,
        dataset_path: str,
        pipeline_name: str,
        run_id: str,
        profile: dict,
        duration_ms: int,
    ) -> None:
        """Append one auto-metrics row to the Delta metrics table."""
        output_path = self._get_output_path(dataset_path, "auto")
        run_ts = datetime.now(timezone.utc)

        row = {
            "run_id": run_id,
            "pipeline_name": pipeline_name,
            "dataset_path": dataset_path,
            "environment": self.config.env,
            "run_timestamp": run_ts,
            "rows_written": int(profile.get("rows_written", 0)),
            "schema_json": profile.get("schema_json"),
            "column_profiles": json.dumps(profile.get("columns", [])),
            "write_duration_ms": int(duration_ms),
        }

        self._append_rows([row], AUTO_METRICS_SCHEMA, output_path)
        self._register_hms(dataset_path, "auto", output_path)

    def write_rule_results(
        self,
        dataset_path: str,
        pipeline_name: str,
        run_id: str,
        results: list["RuleResult"],
    ) -> None:
        """Append rule check result rows to the Delta results table."""
        if not results:
            return

        output_path = self._get_output_path(dataset_path, "rules")
        run_ts = datetime.now(timezone.utc)

        rows = [
            {
                "run_id": run_id,
                "pipeline_name": pipeline_name,
                "dataset_path": dataset_path,
                "run_timestamp": run_ts,
                "rule_name": r.rule_name,
                "rule_type": r.rule_type,
                "severity": r.severity.value if hasattr(r.severity, "value") else str(r.severity),
                "status": r.status,
                "message": r.message,
                "actual_value": r.actual_value,
                "expected_value": r.expected_value,
                "affected_rows": int(r.affected_rows),
            }
            for r in results
        ]

        self._append_rows(rows, RULE_RESULTS_SCHEMA, output_path)
        self._register_hms(dataset_path, "rules", output_path)

    def write_anomaly_results(
        self,
        dataset_path: str,
        run_id: str,
        anomalies: list[dict],
    ) -> None:
        """Append anomaly detection rows to the Delta anomaly table."""
        if not anomalies:
            return

        output_path = self._get_output_path(dataset_path, "anomaly")
        run_ts = datetime.now(timezone.utc)

        rows = []
        for a in anomalies:
            row = dict(a)
            row.setdefault("run_id", run_id)
            row.setdefault("dataset_path", dataset_path)
            row.setdefault("run_timestamp", run_ts)
            rows.append(row)

        self._append_rows(rows, ANOMALY_RESULTS_SCHEMA, output_path)
        self._register_hms(dataset_path, "anomaly", output_path)

    # ------------------------------------------------------------------
    # Path derivation
    # ------------------------------------------------------------------

    def _get_output_path(self, dataset_path: str, output_type: str) -> str:
        """Derive the full ABFS path for a DQ output table.

        When ``dataset_abfss_path`` is set on this writer, returns a co-located
        path alongside the dataset (``{dataset_abfss_path}/_dq/{output_type}``).
        Otherwise falls back to the legacy container-root path.

        Args:
            dataset_path: logical path e.g. ``silver/orders_cleaned``
            output_type: ``auto``, ``rules``, or ``anomaly``
        """
        if self.dataset_abfss_path:
            return self.config.dq_path(self.dataset_abfss_path, output_type)
        container = _container_from_path(dataset_path)
        safe_name = _safe_dataset_name(dataset_path)
        base = self.config.dq_base_path(container)
        return f"{base}/{output_type}/{safe_name}"

    def _register_hms(self, dataset_path: str, output_type: str, path: str) -> None:
        """Register the DQ Delta table in HMS under the ``_dq`` database.

        This makes the table discoverable via ``SHOW TABLES FROM lakehouse._dq``
        so the portal can query DQ summaries without knowing each dataset's path.
        Silently skips if HMS registration fails — DQ data is already written.
        """
        if not self.dataset_abfss_path:
            return
        safe_name = _safe_dataset_name(dataset_path)
        table = f"_dq.{safe_name}_{output_type}"
        try:
            self.spark.sql("CREATE DATABASE IF NOT EXISTS _dq")
            self.spark.sql(
                f"CREATE TABLE IF NOT EXISTS {table} USING DELTA LOCATION '{path}'"
            )
            logger.debug("DeltaWriter: registered HMS table %s → %s", table, path)
        except Exception as exc:
            logger.debug("DeltaWriter: HMS registration skipped for %s: %s", table, exc)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _append_rows(self, rows: list[dict], schema, path: str) -> None:
        """Create a single-row (or multi-row) DataFrame and append to Delta table.

        Uses ``mergeSchema=True`` to handle schema evolution without
        manual table maintenance.
        """
        # Build tuples in schema field order — PySpark maps by position when
        # given a StructType schema, so order must match the schema definition.
        field_names = [f.name for f in schema.fields]
        ordered_rows = [tuple(r[name] for name in field_names) for r in rows]
        df = self.spark.createDataFrame(ordered_rows, schema=schema)

        (
            df.write.format("delta")
            .mode("append")
            .option("mergeSchema", "true")
            .save(path)
        )
        logger.debug("DeltaWriter: appended %d row(s) to %s", len(rows), path)
