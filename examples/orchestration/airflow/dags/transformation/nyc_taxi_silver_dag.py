"""
DAG: nyc_taxi_silver
====================
Transforms NYC TLC bronze data (all four taxi types) into a unified,
cleaned silver Delta table partitioned by pickup_year / pickup_month.

Triggered by: nyc_taxi_bronze (via TriggerDagRunOperator)
Can also be run manually to reprocess any month.

Transforms applied:
  - Unified schema across yellow, green, fhv, hvfhv
  - Deterministic surrogate trip_id (SHA-256 of key fields)
  - Null / out-of-window pickup/dropoff removal
  - Negative fare and distance removal
  - Location ID range check (1–265 valid TLC zones)
  - Deduplication on trip_id
  - DQ gate via @track decorator (forge_dq)

Output:
  silver/nyc_taxi/trips/  (Delta, partitioned by pickup_year, pickup_month)

Schedule:   Triggered by nyc_taxi_bronze (no independent schedule)
SLA:        3 hours after trigger
Retries:    2 × 10-minute back-off

Portal:     Visible in Forge portal under Pipelines → transformation, nyc-taxi tags
Lineage:    Emitted automatically via OpenLineage
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

_SPARK_IMAGE = "{{ var.value.get('spark_image', 'forgeacrprproddu.azurecr.io/spark:4.1.1') }}"
_STORAGE_ACCOUNT = "{{ var.value.get('storage_account', 'forgeadlsprproddudev') }}"

_SILVER_SPEC = f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: nyc-taxi-silver-{{{{ data_interval_start.strftime('%Y-%m') }}}}
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
    cores: 4
    memory: "8g"
    serviceAccount: spark
    labels:
      app: nyc-taxi-silver
    env:
      - name: NOTEBOOK_PATH
        value: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/notebooks/nyc_taxi_silver.ipynb"
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
    instances: 6
    memory: "16g"
    labels:
      app: nyc-taxi-silver
  sparkConf:
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "96"
    spark.sql.adaptive.enabled: "true"
    spark.sql.adaptive.coalescePartitions.enabled: "true"
"""

default_args = {
    "owner": "data-engineering",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=10),
    "execution_timeout": timedelta(hours=2),
    "sla": timedelta(hours=3),
    "email_on_failure": True,
    "email_on_retry": False,
}

with DAG(
    dag_id="nyc_taxi_silver",
    description="NYC TLC taxi data — bronze → silver unified schema with DQ gate (monthly)",
    schedule=None,  # triggered by nyc_taxi_bronze
    start_date=datetime(2019, 1, 1),
    catchup=False,
    max_active_runs=3,
    tags=["nyc-taxi", "silver", "transformation", "monthly"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    transform = SparkKubernetesOperator(
        task_id="silver_transform",
        namespace="spark-jobs",
        application_file=_SILVER_SPEC,
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    trigger_gold = TriggerDagRunOperator(
        task_id="trigger_gold",
        trigger_dag_id="nyc_taxi_gold",
        logical_date="{{ data_interval_start }}",
        wait_for_completion=False,
        reset_dag_run=True,
    )

    transform >> trigger_gold
