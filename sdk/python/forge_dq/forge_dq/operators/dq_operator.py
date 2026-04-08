"""
forge_dq.operators.dq_operator — Airflow operator for post-hoc DQ checks.

This operator reads an existing Delta table and runs DQ rule checks against
it as a standalone Airflow task.  It is intended for cases where the Spark
job that writes the data does NOT use the ``@track`` decorator (e.g. legacy
jobs or third-party pipelines).

For pipeline-native DQ, use the ``@track`` decorator in the Spark job instead.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from airflow.models import BaseOperator
from airflow.utils.decorators import apply_defaults

logger = logging.getLogger(__name__)


class DQOperator(BaseOperator):
    """Runs DQ rule checks against an existing Delta dataset.

    Submits a minimal PySpark script via a KubernetesPodOperator-style
    pod that reads the Delta table and runs DQ checks using the forge-dq
    SDK.  Results are written to the standard DQ output Delta tables and
    the summary is returned as XCom.

    Args:
        dataset: Dataset path (e.g. ``"silver/orders_cleaned"``).
        rules_path: Path to the YAML rules file in the DAG repo
                    (mounted into the pod at ``/opt/airflow/dags/``).
        run_id: Run ID to associate results with.
                Templated — defaults to ``{{ run_id }}``.
        fail_on_critical: Whether to fail the Airflow task on a critical
                          DQ failure (default: True).
        spark_image: Docker image containing PySpark + forge-dq
                     (default: reads ``FORGE_SPARK_IMAGE`` env var).
        namespace: Kubernetes namespace for the DQ pod
                   (default: reads ``FORGE_K8S_NAMESPACE`` env var, fallback "forge").
        service_account_name: Kubernetes service account for workload identity
                              (default: reads ``FORGE_K8S_SA`` env var).
        **kwargs: Passed to :class:`airflow.models.BaseOperator`.

    XCom output:
        Returns a JSON-serialisable summary dict with keys:
        ``run_id``, ``dataset``, ``overall_status``, ``rules_total``,
        ``rules_passed``, ``rules_failed``, ``critical_failures``.
    """

    template_fields = ("run_id",)

    @apply_defaults
    def __init__(
        self,
        dataset: str,
        rules_path: str,
        run_id: str = "{{ run_id }}",
        fail_on_critical: bool = True,
        spark_image: str | None = None,
        namespace: str | None = None,
        service_account_name: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.dataset = dataset
        self.rules_path = rules_path
        self.run_id = run_id
        self.fail_on_critical = fail_on_critical
        self.spark_image = spark_image
        self.namespace = namespace
        self.service_account_name = service_account_name

    def execute(self, context: dict) -> dict:
        """Execute DQ checks by launching a Kubernetes pod with PySpark.

        The pod runs a minimal inline Python script that:
          1. Creates a SparkSession
          2. Reads the Delta table
          3. Runs :class:`~forge_dq.runner.DQRunner`
          4. Returns the report summary as a JSON string (captured via pod logs)

        Returns:
            dict: DQ run summary suitable for XCom.

        Raises:
            AirflowException: If the pod fails or a critical DQ rule fails.
        """
        import os

        from airflow.providers.cncf.kubernetes.operators.kubernetes_pod import (
            KubernetesPodOperator,
        )

        spark_image = self.spark_image or os.environ.get(
            "FORGE_SPARK_IMAGE", "forgeacr.azurecr.io/spark:4.1.0-dev"
        )
        namespace = self.namespace or os.environ.get("FORGE_K8S_NAMESPACE", "forge")
        service_account = self.service_account_name or os.environ.get(
            "FORGE_K8S_SA", "forge-spark"
        )

        # Inline Python script executed inside the pod.
        # The forge-dq package is installed in the Spark image.
        dq_script = _build_dq_script(
            dataset=self.dataset,
            rules_path=self.rules_path,
            run_id=self.run_id,
            fail_on_critical=self.fail_on_critical,
        )

        pod_task_id = f"{self.task_id}_pod"

        pod_op = KubernetesPodOperator(
            task_id=pod_task_id,
            name=f"forge-dq-{self.dataset.replace('/', '-')}",
            namespace=namespace,
            image=spark_image,
            image_pull_policy="IfNotPresent",
            service_account_name=service_account,
            cmds=["python3", "-c", dq_script],
            env_vars={
                "FORGE_ENV": os.environ.get("FORGE_ENV", "dev"),
                "FORGE_ADLS_ACCOUNT": os.environ.get("FORGE_ADLS_ACCOUNT", ""),
                "FORGE_DQ_ENABLED": "true",
                "FORGE_DQ_FAIL_ON_CRITICAL": str(self.fail_on_critical).lower(),
            },
            get_logs=True,
            do_xcom_push=True,
            is_delete_operator_pod=True,
            dag=self.dag,
        )

        result = pod_op.execute(context)

        # Parse the JSON summary printed by the DQ script
        try:
            summary = json.loads(result) if isinstance(result, str) else result
        except (json.JSONDecodeError, TypeError):
            logger.warning("DQOperator: could not parse pod XCom output as JSON.")
            summary = {"run_id": self.run_id, "dataset": self.dataset, "overall_status": "UNKNOWN"}

        # Push summary to XCom and return
        logger.info(
            "DQOperator: dataset='%s' status=%s critical_failures=%s",
            self.dataset,
            summary.get("overall_status"),
            summary.get("critical_failures", []),
        )
        return summary


def _build_dq_script(
    dataset: str,
    rules_path: str,
    run_id: str,
    fail_on_critical: bool,
) -> str:
    """Build the inline Python script run inside the DQ pod."""
    return f"""
import json
import sys
from pyspark.sql import SparkSession
from forge_dq.runner import DQRunner, DQCriticalFailureError

spark = (
    SparkSession.builder
    .appName("forge-dq-{dataset.replace('/', '-')}")
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
    .getOrCreate()
)

# Read the Delta table — derive ABFS path from dataset name
import os
container = "{dataset}".strip("/").split("/")[0]
adls_account = os.environ.get("FORGE_ADLS_ACCOUNT", "")
table_path = f"abfss://{{container}}@{{adls_account}}.dfs.core.windows.net/{dataset}"

df = spark.read.format("delta").load(table_path)

runner = DQRunner(
    spark=spark,
    dataset="{dataset}",
    rules_path="{rules_path}",
    pipeline_name="airflow-dq-operator",
    run_id="{run_id}",
)

try:
    report = runner.run(df)
    summary = {{
        "run_id": report.run_id,
        "dataset": report.dataset,
        "overall_status": report.overall_status,
        "rules_total": len(report.rule_results),
        "rules_passed": sum(1 for r in report.rule_results if r.status == "PASS"),
        "rules_failed": sum(1 for r in report.rule_results if r.status == "FAIL"),
        "critical_failures": report.critical_failures,
        "anomalies_detected": len([a for a in report.anomalies if a.get("is_anomaly")]),
    }}
    print(json.dumps(summary))
    spark.stop()
    sys.exit(0)
except DQCriticalFailureError as exc:
    summary = {{
        "run_id": "{run_id}",
        "dataset": "{dataset}",
        "overall_status": "FAIL",
        "critical_failures": exc.failed_rules,
    }}
    print(json.dumps(summary))
    spark.stop()
    sys.exit(1)
"""
