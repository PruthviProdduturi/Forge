"""
forge_dq.runner — Orchestrates the full DQ pipeline for a single DataFrame write.

Steps:
  1. Auto-profile the DataFrame
  2. Write auto-metrics to Delta
  3. Evaluate YAML-defined rules (if rules_path provided)
  4. Write rule results to Delta
  5. Run SPC anomaly detection
  6. Write anomaly results to Delta
  7. Emit OpenLineage DQ facet
  8. Raise DQCriticalFailureError if any critical rule fails and fail_on_critical=True
  9. Return a DQRunReport
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from forge_dq.config import DQConfig, get_config

if TYPE_CHECKING:
    from pyspark.sql import DataFrame, SparkSession
    from forge_dq.rules.base import RuleResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public data classes
# ---------------------------------------------------------------------------


@dataclass
class DQRunReport:
    """Summary of a single DQ run."""

    run_id: str
    dataset: str
    pipeline_name: str
    rows_written: int
    profile: dict
    rule_results: list["RuleResult"]
    anomalies: list[dict]
    overall_status: str  # PASS | FAIL | WARN
    critical_failures: list[str]  # rule names
    duration_ms: int


class DQCriticalFailureError(Exception):
    """Raised when one or more CRITICAL rules fail and fail_on_critical=True."""

    def __init__(self, failed_rules: list[str]) -> None:
        self.failed_rules = failed_rules
        super().__init__(
            f"DQ critical failure(s) in rules: {failed_rules}. "
            "Set FORGE_DQ_FAIL_ON_CRITICAL=false to demote to a warning."
        )


# ---------------------------------------------------------------------------
# DQRunner
# ---------------------------------------------------------------------------


class DQRunner:
    """Runs the full DQ pipeline for a given DataFrame.

    Args:
        spark: Active SparkSession.
        dataset: Dataset path relative to the medallion layer
                 (e.g. ``"silver/orders_cleaned"``).
        rules_path: Optional path to a YAML rules file.
        pipeline_name: Human-readable pipeline / job name (used in output rows).
        run_id: Optional run ID; defaults to a new UUID.
        config: Optional :class:`~forge_dq.config.DQConfig`; defaults to the
                module-level singleton populated from environment variables.
    """

    def __init__(
        self,
        spark: "SparkSession",
        dataset: str,
        rules_path: str | None = None,
        pipeline_name: str = "unknown",
        run_id: str | None = None,
        config: DQConfig | None = None,
        dataset_abfss_path: str | None = None,
    ) -> None:
        self.spark = spark
        self.dataset = dataset
        self.rules_path = rules_path
        self.pipeline_name = pipeline_name
        self.run_id = run_id or str(uuid.uuid4())
        self.config = config or get_config()
        self.dataset_abfss_path = dataset_abfss_path

    def run(self, df: "DataFrame") -> DQRunReport:
        """Execute all DQ steps and return a :class:`DQRunReport`.

        DQ failures are always recorded.  An exception is only raised if
        ``config.fail_on_critical=True`` and at least one CRITICAL rule fails.

        Errors in the DQ infrastructure itself (e.g. ADLS write failures) are
        logged as warnings and do not cause the Spark job to fail — the
        business data write has already succeeded.
        """
        if not self.config.enabled:
            logger.info("DQ disabled (FORGE_DQ_ENABLED=false) — skipping for '%s'.", self.dataset)
            return DQRunReport(
                run_id=self.run_id,
                dataset=self.dataset,
                pipeline_name=self.pipeline_name,
                rows_written=0,
                profile={},
                rule_results=[],
                anomalies=[],
                overall_status="PASS",
                critical_failures=[],
                duration_ms=0,
            )

        start_ms = int(time.monotonic() * 1000)

        # ------------------------------------------------------------------
        # 1. Auto-profile
        # ------------------------------------------------------------------
        from forge_dq.profiler import AutoProfiler

        profile: dict = {}
        try:
            profiler = AutoProfiler()
            profile = profiler.profile(df, self.spark)
        except Exception as exc:
            logger.warning("DQ profiling failed for '%s': %s", self.dataset, exc)
            profile = {"rows_written": 0, "schema_json": None, "columns": []}

        # ------------------------------------------------------------------
        # 2. Write auto metrics
        # ------------------------------------------------------------------
        duration_so_far = int(time.monotonic() * 1000) - start_ms
        try:
            from forge_dq.output.writer import DeltaWriter

            writer = DeltaWriter(self.spark, self.config, self.dataset_abfss_path)
            writer.write_auto_metrics(
                dataset_path=self.dataset,
                pipeline_name=self.pipeline_name,
                run_id=self.run_id,
                profile=profile,
                duration_ms=duration_so_far,
            )
        except Exception as exc:
            logger.warning(
                "DQ: failed to write auto metrics for '%s' (run_id=%s): %s",
                self.dataset,
                self.run_id,
                exc,
            )

        # ------------------------------------------------------------------
        # 3. Load and evaluate rules
        # ------------------------------------------------------------------
        rule_results: list["RuleResult"] = []
        anomaly_config: dict | None = None

        if self.rules_path:
            try:
                from forge_dq.rules.loader import load_rules

                rules, anomaly_config = load_rules(self.rules_path)

                # Inject metrics_path for RowCountDeltaRule instances
                from forge_dq.rules.builtin import RowCountDeltaRule
                from forge_dq.output.writer import _container_from_path, _safe_dataset_name

                if self.dataset_abfss_path:
                    metrics_path = self.config.dq_path(self.dataset_abfss_path, "auto")
                else:
                    container = _container_from_path(self.dataset)
                    safe_name = _safe_dataset_name(self.dataset)
                    metrics_path = f"{self.config.dq_base_path(container)}/auto/{safe_name}"

                for rule in rules:
                    if isinstance(rule, RowCountDeltaRule):
                        rule.metrics_path = metrics_path

                for rule in rules:
                    try:
                        result = rule.evaluate(df, self.spark)
                        rule_results.append(result)
                    except Exception as exc:
                        logger.warning(
                            "DQ: rule '%s' raised an exception for '%s': %s",
                            rule.name,
                            self.dataset,
                            exc,
                        )
                        from forge_dq.rules.base import RuleResult, Severity

                        rule_results.append(
                            RuleResult(
                                rule_name=rule.name,
                                rule_type=getattr(rule, "rule_type", "unknown"),
                                severity=rule.severity,
                                status="SKIPPED",
                                message=f"Rule evaluation failed with exception: {exc}",
                            )
                        )
            except Exception as exc:
                logger.warning(
                    "DQ: failed to load/evaluate rules from '%s': %s",
                    self.rules_path,
                    exc,
                )

        # ------------------------------------------------------------------
        # 4. Write rule results
        # ------------------------------------------------------------------
        if rule_results:
            try:
                writer = DeltaWriter(self.spark, self.config, self.dataset_abfss_path)
                writer.write_rule_results(
                    dataset_path=self.dataset,
                    pipeline_name=self.pipeline_name,
                    run_id=self.run_id,
                    results=rule_results,
                )
            except Exception as exc:
                logger.warning(
                    "DQ: failed to write rule results for '%s': %s", self.dataset, exc
                )

        # ------------------------------------------------------------------
        # 5. Run SPC anomaly detection
        # ------------------------------------------------------------------
        anomalies: list[dict] = []
        try:
            from forge_dq.anomaly.detector import SPCDetector

            lookback_days = 30
            z_threshold = 3.0
            if anomaly_config:
                lookback_days = anomaly_config.get("lookback_days", lookback_days)
                z_threshold = anomaly_config.get("z_score_threshold", z_threshold)
                if not anomaly_config.get("enabled", True):
                    logger.debug("Anomaly detection disabled in rules YAML for '%s'.", self.dataset)
                    lookback_days = 0  # skip by using sentinel

            if lookback_days > 0:
                detector = SPCDetector(self.spark, self.config)
                anomalies = detector.detect(
                    dataset_path=self.dataset,
                    current_metrics=profile,
                    lookback_days=lookback_days,
                    z_threshold=z_threshold,
                    dataset_abfss_path=self.dataset_abfss_path,
                )
        except Exception as exc:
            logger.warning(
                "DQ: anomaly detection failed for '%s': %s", self.dataset, exc
            )

        # ------------------------------------------------------------------
        # 6. Write anomaly results
        # ------------------------------------------------------------------
        if anomalies:
            try:
                writer = DeltaWriter(self.spark, self.config)
                writer.write_anomaly_results(
                    dataset_path=self.dataset,
                    run_id=self.run_id,
                    anomalies=anomalies,
                )
            except Exception as exc:
                logger.warning(
                    "DQ: failed to write anomaly results for '%s': %s", self.dataset, exc
                )

        # ------------------------------------------------------------------
        # 7. Emit OpenLineage DQ facet
        # ------------------------------------------------------------------
        try:
            from forge_dq.lineage.facets import build_dq_facet

            facet = build_dq_facet(rule_results, profile)
            # The openlineage-spark integration reads facets emitted via the
            # OpenLineage client.  When running inside a Spark job the facet
            # can be submitted via the OpenLineage transport registered in
            # spark-defaults.conf.  We attempt to attach it here; if the
            # client is unavailable we log and continue.
            _emit_ol_facet(self.run_id, self.dataset, facet)
        except Exception as exc:
            logger.debug("DQ: could not emit OpenLineage facet: %s", exc)

        # ------------------------------------------------------------------
        # 8. Determine overall status and critical failures
        # ------------------------------------------------------------------
        from forge_dq.rules.base import Severity

        critical_failures = [
            r.rule_name
            for r in rule_results
            if r.status == "FAIL" and r.severity == Severity.CRITICAL
        ]

        has_any_fail = any(r.status == "FAIL" for r in rule_results)
        has_any_warn = any(r.status in ("WARN", "FAIL") for r in rule_results)

        if critical_failures:
            overall_status = "FAIL"
        elif has_any_fail:
            overall_status = "FAIL"
        elif has_any_warn:
            overall_status = "WARN"
        else:
            overall_status = "PASS"

        duration_ms = int(time.monotonic() * 1000) - start_ms

        report = DQRunReport(
            run_id=self.run_id,
            dataset=self.dataset,
            pipeline_name=self.pipeline_name,
            rows_written=profile.get("rows_written", 0),
            profile=profile,
            rule_results=rule_results,
            anomalies=anomalies,
            overall_status=overall_status,
            critical_failures=critical_failures,
            duration_ms=duration_ms,
        )

        # ------------------------------------------------------------------
        # 9. Report summary to portal API (best-effort, non-blocking)
        # ------------------------------------------------------------------
        _report_to_portal(report)

        # ------------------------------------------------------------------
        # 10. Raise on critical failure (after writing all results)
        # ------------------------------------------------------------------
        if self.config.fail_on_critical and critical_failures:
            raise DQCriticalFailureError(critical_failures)

        return report


# ---------------------------------------------------------------------------
# Portal API reporting helper
# ---------------------------------------------------------------------------


def _report_to_portal(report: DQRunReport) -> None:
    """POST a DQ summary to the portal API (best-effort).

    The portal-api URL is read from the FORGE_PORTAL_API_URL environment variable
    (e.g. ``http://portal-api.forge.svc.cluster.local:8080``).  If unset or
    unreachable, the call is silently skipped — DQ results still go to ADLS Delta.
    """
    import json
    import os
    import urllib.request
    from datetime import datetime, timezone

    portal_url = os.environ.get("FORGE_PORTAL_API_URL", "").rstrip("/")
    if not portal_url:
        return
    try:
        payload = json.dumps({
            "dataset": report.dataset,
            "pipeline_name": report.pipeline_name,
            "run_id": report.run_id,
            "overall_status": report.overall_status,
            "total_rules": len(report.rule_results),
            "passes": sum(1 for r in report.rule_results if r.status == "PASS"),
            "critical_failures": report.critical_failures,
            "warnings": sum(1 for r in report.rule_results if r.status == "WARN"),
            "run_at": datetime.now(timezone.utc).isoformat(),
        }).encode()
        req = urllib.request.Request(
            f"{portal_url}/api/dq/ingest",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
        logger.info("DQ: reported summary to portal API for '%s'.", report.dataset)
    except Exception as exc:
        logger.debug("DQ: could not report to portal API (non-fatal): %s", exc)


# ---------------------------------------------------------------------------
# OpenLineage emission helper
# ---------------------------------------------------------------------------


def _emit_ol_facet(run_id: str, dataset: str, facet: dict) -> None:
    """Attempt to emit the DQ facet via the OpenLineage Python client.

    This is best-effort; callers catch all exceptions.
    """
    try:
        from openlineage.client import OpenLineageClient
        from openlineage.client.run import RunEvent, RunState, Run, Job
        import os
        from datetime import datetime, timezone

        client = OpenLineageClient.from_environment()
        event = RunEvent(
            eventType=RunState.OTHER,
            eventTime=datetime.now(timezone.utc).isoformat(),
            run=Run(runId=run_id, facets=facet),
            job=Job(namespace="forge", name=dataset),
            producer="https://github.com/your-org/DSEngCoreInfra",
            schemaURL="https://openlineage.io/spec/1-0-5/OpenLineage.json",
        )
        client.emit(event)
    except ImportError:
        logger.debug("openlineage-python not available — DQ facet not emitted.")
