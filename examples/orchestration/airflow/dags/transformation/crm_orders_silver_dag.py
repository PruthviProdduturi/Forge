"""
DAG: crm_orders_silver
======================
Runs the CRM Orders bronze → silver pipeline daily at 06:00 UTC.

Pipeline:
    1. crm_orders_silver  — Spark job via SparkKubernetesOperator
                            Applies dedup, null-drop, type casts.
                            DQ gate is embedded inside the job via @track.
    2. (optional) dq_crm_orders_silver — Standalone DQOperator check for
                            observability/alerting (does not block the pipeline
                            on its own; the Spark job already failed-fast on
                            critical DQ failures).  Uncomment once forge-dq's
                            Airflow integration is deployed.

Owner:    data-engineering
Schedule: 0 6 * * *  (daily 06:00 UTC)
SLA:      3 h  (alert if not complete by 09:00 UTC)
Retries:  2 × 5-minute back-off
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

# ---------------------------------------------------------------------------
# Default task arguments
# ---------------------------------------------------------------------------

default_args = {
    "owner": "data-engineering",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(hours=2),
    "sla": timedelta(hours=3),
    "email_on_failure": True,
    "email_on_retry": False,
}

# ---------------------------------------------------------------------------
# DAG definition
# ---------------------------------------------------------------------------

with DAG(
    dag_id="crm_orders_silver",
    description="CRM Orders bronze → silver transform with DQ gate",
    schedule="0 6 * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    max_active_runs=1,
    tags=["crm", "silver", "daily"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    # -----------------------------------------------------------------------
    # Task 1: Spark job — CrmOrdersSilver
    #
    # Submits a SparkApplication CR to the spark-jobs namespace.
    # The SparkApplication spec (image, executor count, resource limits) lives
    # in compute/spark/specs/crm_orders_silver.yaml and is referenced by the
    # operator via the application_file path in the code container.
    # -----------------------------------------------------------------------
    ingest = SparkKubernetesOperator(
        task_id="crm_orders_silver",
        namespace="spark-jobs",
        # Path to the SparkApplication YAML manifest (relative to the Airflow
        # working directory / mounted code volume).  The manifest references
        # the job entry-point at compute/spark/jobs/crm_orders_silver.py.
        application_file="compute/spark/specs/crm_orders_silver.yaml",
        kubernetes_conn_id="kubernetes_compute_cluster",
        # Push the Spark driver pod name to XCom so downstream tasks can
        # retrieve Spark metrics or logs if needed.
        do_xcom_push=True,
        # Poll interval for SparkApplication status (seconds).
        poll_interval=30,
    )

    # -----------------------------------------------------------------------
    # Task 2: DQ observability check (commented out pending DQOperator GA)
    #
    # The @track decorator inside CrmOrdersSilver already runs DQ rules and
    # blocks on critical failures.  This second check is for alerting and
    # dashboard freshness — it runs with fail_on_critical=False so it never
    # re-fails an already-succeeded pipeline run.
    #
    # Uncomment once forge-dq DQOperator is integrated with Airflow:
    #
    # from forge_dq.operators.airflow import DQOperator  # noqa: ERA001
    #
    # dq_check = DQOperator(
    #     task_id="dq_crm_orders_silver",
    #     dataset="silver/crm/orders_cleaned",
    #     rules_path="orchestration/dq/rules/crm_orders_cleaned.yaml",
    #     fail_on_critical=False,
    # )
    #
    # ingest >> dq_check
    # -----------------------------------------------------------------------
