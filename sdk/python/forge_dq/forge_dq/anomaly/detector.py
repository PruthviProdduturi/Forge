"""
forge_dq.anomaly.detector — Statistical Process Control (SPC) anomaly detection.

Reads historical auto-metrics from the Delta table and flags metrics
whose Z-score exceeds the configured threshold.

Monitored metrics per run:
  - rows_written            (absolute row count)
  - null_rate per column    (extracted from the column_profiles JSON blob)
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from forge_dq.config import DQConfig
from forge_dq.output.writer import _container_from_path, _safe_dataset_name

if TYPE_CHECKING:
    from pyspark.sql import SparkSession

logger = logging.getLogger(__name__)

_MIN_HISTORY_RUNS = 7  # require at least this many historical runs


class SPCDetector:
    """Detects anomalies in dataset metrics using Z-score / SPC approach.

    Args:
        spark: Active SparkSession.
        config: DQConfig instance.
    """

    def __init__(self, spark: "SparkSession", config: DQConfig) -> None:
        self.spark = spark
        self.config = config

    def detect(
        self,
        dataset_path: str,
        current_metrics: dict,
        lookback_days: int = 30,
        z_threshold: float = 3.0,
    ) -> list[dict]:
        """Detect metric anomalies for *dataset_path*.

        Args:
            dataset_path: e.g. ``silver/orders_cleaned``
            current_metrics: The profile dict returned by :class:`~forge_dq.profiler.AutoProfiler`.
            lookback_days: How many calendar days of history to include.
            z_threshold: Z-score magnitude above which a metric is flagged.

        Returns:
            List of anomaly dicts compatible with ``ANOMALY_RESULTS_SCHEMA``.
            Returns an empty list if there is insufficient history.
        """
        container = _container_from_path(dataset_path)
        safe_name = _safe_dataset_name(dataset_path)
        metrics_path = f"{self.config.dq_base_path(container)}/auto/{safe_name}"

        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

        try:
            history_df = (
                self.spark.read.format("delta")
                .load(metrics_path)
                .filter(f"run_timestamp >= '{cutoff.isoformat()}'")
                .select("rows_written", "column_profiles", "run_timestamp")
            )
            history_count = history_df.count()
        except Exception as exc:
            logger.warning(
                "SPCDetector: could not read auto metrics from '%s': %s. Skipping anomaly detection.",
                metrics_path,
                exc,
            )
            return []

        if history_count < _MIN_HISTORY_RUNS:
            logger.info(
                "SPCDetector: only %d historical run(s) for '%s' (need %d). Skipping.",
                history_count,
                dataset_path,
                _MIN_HISTORY_RUNS,
            )
            return []

        history_rows = history_df.collect()

        # ------------------------------------------------------------------
        # Build a dict: metric_name → list of historical float values
        # ------------------------------------------------------------------
        historical: dict[str, list[float]] = {}

        for row in history_rows:
            historical.setdefault("rows_written", []).append(float(row["rows_written"]))

            if row["column_profiles"]:
                try:
                    col_profiles = json.loads(row["column_profiles"])
                    for cp in col_profiles:
                        key = f"null_rate__{cp['name']}"
                        historical.setdefault(key, []).append(float(cp.get("null_rate", 0.0)))
                except (json.JSONDecodeError, KeyError, TypeError):
                    pass  # tolerate corrupt historical rows

        # ------------------------------------------------------------------
        # Build current metric dict
        # ------------------------------------------------------------------
        current: dict[str, float] = {
            "rows_written": float(current_metrics.get("rows_written", 0)),
        }
        for cp in current_metrics.get("columns", []):
            current[f"null_rate__{cp['name']}"] = float(cp.get("null_rate", 0.0))

        # ------------------------------------------------------------------
        # Compute Z-scores and flag anomalies
        # ------------------------------------------------------------------
        anomalies: list[dict] = []
        run_ts = datetime.now(timezone.utc)

        for metric_name, hist_values in historical.items():
            if metric_name not in current:
                continue
            if len(hist_values) < _MIN_HISTORY_RUNS:
                continue

            current_val = current[metric_name]
            mean = sum(hist_values) / len(hist_values)
            variance = sum((v - mean) ** 2 for v in hist_values) / len(hist_values)
            stddev = math.sqrt(variance)

            if stddev == 0:
                # No variation in history — skip to avoid division by zero
                continue

            z_score = (current_val - mean) / stddev
            is_anomaly = abs(z_score) > z_threshold
            severity = "critical" if abs(z_score) > z_threshold * 1.5 else "warning"

            anomaly_dict: dict = {
                "run_timestamp": run_ts,
                "metric_name": metric_name,
                "current_value": current_val,
                "mean_30d": mean,
                "stddev_30d": stddev,
                "z_score": z_score,
                "is_anomaly": is_anomaly,
                "severity": severity if is_anomaly else "info",
                "message": (
                    f"ANOMALY: {metric_name}={current_val:.4f} "
                    f"(mean={mean:.4f}, stddev={stddev:.4f}, z={z_score:.2f})"
                    if is_anomaly
                    else f"OK: {metric_name}={current_val:.4f} (z={z_score:.2f})"
                ),
            }
            anomalies.append(anomaly_dict)

        flagged = [a for a in anomalies if a["is_anomaly"]]
        logger.info(
            "SPCDetector: %d metric(s) checked, %d anomaly/anomalies flagged for '%s'.",
            len(anomalies),
            len(flagged),
            dataset_path,
        )
        # Return all computed rows (not just flagged ones) so the full picture
        # is persisted to the anomaly results table.
        return anomalies
