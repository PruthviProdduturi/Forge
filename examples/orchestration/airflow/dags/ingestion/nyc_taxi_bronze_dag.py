"""
DAG: nyc_taxi_bronze
====================
Monthly ingestion of NYC TLC taxi data from Azure Open Datasets into
the bronze Delta layer. Runs four taxi types in parallel each month.

Pipeline:
  Source  — Azure Open Datasets public blob (wasbs://nyctlc@azureopendatastore...)
  Output  — bronze/nyc_taxi/{taxi_type}/year={Y}/month={M:02d}/  (Delta)

Taxi types (parallel tasks):
  yellow  — Yellow Medallion Taxicabs
  green   — Green Boro Taxis
  fhv     — For-Hire Vehicles
  hvfhv   — High-Volume FHV (Uber, Lyft — 2019-present)

Schedule:   Monthly on the 1st at 00:00 UTC
Backfill:   From 2019-01-01 (catchup=True) — backfills all months automatically
SLA:        4 hours (all four types must complete by 04:00 UTC)
Retries:    2 × 10-minute back-off

Portal:     Visible in Forge portal under Pipelines → ingestion, nyc-taxi tags
Lineage:    Emitted automatically via OpenLineage (forge_session)

Dependencies:
  → triggers nyc_taxi_silver once all four types complete
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

# ---------------------------------------------------------------------------
# Shared SparkApplication YAML template — Jinja-rendered per task/run.
# application_file is a template_field on SparkKubernetesOperator so all
# {{ }} expressions are rendered by Airflow before submission.
# ---------------------------------------------------------------------------
_SPARK_IMAGE = "{{ var.value.get('spark_image', 'forgeacrprproddu.azurecr.io/spark:4.1.1') }}"
_STORAGE_ACCOUNT = "{{ var.value.get('storage_account', 'forgeadlsprproddudev') }}"


def _bronze_spec(taxi_type: str) -> str:
    return f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: nyc-taxi-bronze-{taxi_type}-{{{{ data_interval_start.strftime('%Y-%m') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/runners/papermill_runner.py"
  sparkVersion: "4.1.1"
  restartPolicy:
    type: OnFailure
    onFailureRetries: 1
    onFailureRetryInterval: 10
  driver:
    cores: 2
    memory: "4g"
    serviceAccount: spark
    labels:
      app: nyc-taxi-bronze
      taxi-type: {taxi_type}
    env:
      - name: NOTEBOOK_PATH
        value: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/notebooks/nyc_taxi_bronze.ipynb"
      - name: TAXI_TYPE
        value: "{taxi_type}"
      - name: PARTITION_YEAR
        value: "{{{{ data_interval_start.year }}}}"
      - name: PARTITION_MONTH
        value: "{{{{ data_interval_start.month }}}}"
      - name: FORGE_ENV
        valueFrom:
          configMapKeyRef:
            name: forge-platform-config
            key: env
      - name: FORGE_STORAGE_ACCOUNT
        valueFrom:
          configMapKeyRef:
            name: forge-platform-config
            key: storage_account
  executor:
    cores: 4
    instances: 3
    memory: "8g"
    labels:
      app: nyc-taxi-bronze
  sparkConf:
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "48"
"""


# ---------------------------------------------------------------------------
# Default task arguments
# ---------------------------------------------------------------------------
default_args = {
    "owner": "data-engineering",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=10),
    "execution_timeout": timedelta(hours=3),
    "sla": timedelta(hours=4),
    "email_on_failure": True,
    "email_on_retry": False,
}

# ---------------------------------------------------------------------------
# DAG
# ---------------------------------------------------------------------------
with DAG(
    dag_id="nyc_taxi_bronze",
    description="NYC TLC taxi data — Azure Open Datasets → bronze Delta (all taxi types, monthly)",
    schedule="0 0 1 * *",
    start_date=datetime(2019, 1, 1),
    catchup=True,
    max_active_runs=3,   # allow up to 3 months to backfill in parallel
    tags=["nyc-taxi", "bronze", "ingestion", "open-data", "monthly"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    # Four taxi types ingested in parallel — each is an independent Spark job
    yellow = SparkKubernetesOperator(
        task_id="ingest_yellow",
        namespace="spark-jobs",
        application_file=_bronze_spec("yellow"),
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    green = SparkKubernetesOperator(
        task_id="ingest_green",
        namespace="spark-jobs",
        application_file=_bronze_spec("green"),
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    fhv = SparkKubernetesOperator(
        task_id="ingest_fhv",
        namespace="spark-jobs",
        application_file=_bronze_spec("fhv"),
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    hvfhv = SparkKubernetesOperator(
        task_id="ingest_hvfhv",
        namespace="spark-jobs",
        application_file=_bronze_spec("hvfhv"),
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    # Trigger silver once all four types land successfully
    trigger_silver = TriggerDagRunOperator(
        task_id="trigger_silver",
        trigger_dag_id="nyc_taxi_silver",
        logical_date="{{ data_interval_start }}",
        wait_for_completion=False,
        reset_dag_run=True,
    )

    # All four types run in parallel; silver waits for all to complete
    [yellow, green, fhv, hvfhv] >> trigger_silver
