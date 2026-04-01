"""
DAG: nyc_taxi_gold
==================
NYC taxi gold aggregations: daily_summary, hourly_demand, zone_stats, payment_summary

Triggered by: nyc_taxi_silver (via TriggerDagRunOperator)
Schedule:   Triggered (no independent schedule)
SLA:        4 hours
Retries:    2 × 10-minute back-off

Layer:   gold
Table:   lakehouse.gold.nyctaxi
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

# ---------------------------------------------------------------------------
# Shared template values — resolved at render time via Airflow Variables so
# the same DAG file works across dev / staging / prod without edits.
# ---------------------------------------------------------------------------
_SPARK_IMAGE = "{{ var.value.get('spark_image', 'forgeacrprproddu.azurecr.io/spark:4.1.1') }}"
_STORAGE_ACCOUNT = "{{ var.value.get('storage_account', 'forgeadlsprproddudev') }}"

# ---------------------------------------------------------------------------
# SparkApplication YAML — Jinja-rendered per run.
# ---------------------------------------------------------------------------
_SPARK_APP = f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: nyc-taxi-gold-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/nyc_taxi_gold.py"
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
      app: nyc-taxi-gold
    env:
      - name: PARTITION_YEAR
        value: "{{{{ data_interval_start.strftime('%Y') }}}}"
      - name: PARTITION_MONTH
        value: "{{{{ data_interval_start.strftime('%-m') }}}}"
      - name: GOLD_TABLE
        value: ""  # TODO: set value
      - name: PARTITION_DATE
        value: "{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}"
      - name: PARTITION_HOUR
        value: "{{{{ data_interval_start.strftime('%-H') }}}}"
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
    instances: 2
    memory: "8g"
    labels:
      app: nyc-taxi-gold
  sparkConf:
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.hadoop.hive.metastore.uris: thrift://hive-metastore.metastore.svc.cluster.local:9083
    spark.sql.hive.metastore.version: "3.1.3"
    spark.sql.hive.metastore.jars: builtin
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "24"
    spark.submit.pyFiles: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/lib/forge_lib.zip"
    spark.sql.adaptive.enabled: "true"
    spark.sql.adaptive.coalescePartitions.enabled: "true"
"""

# ---------------------------------------------------------------------------
# Default task arguments
# ---------------------------------------------------------------------------
default_args = {
    "owner": "data-engineering",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=10),
    "execution_timeout": timedelta(hours=2),
    "sla": timedelta(hours=4),
    "email_on_failure": True,
    "email_on_retry": False,
}

# ---------------------------------------------------------------------------
# DAG
# ---------------------------------------------------------------------------
with DAG(
    dag_id="nyc_taxi_gold",
    description="NYC taxi gold aggregations: daily_summary, hourly_demand, zone_stats, payment_summary",
    schedule=None  # triggered by upstream,
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=3,
    tags=["gold", "transformation", "nyc", "taxi", "nyc-taxi", "monthly", "analytics"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    spark_task = SparkKubernetesOperator(
        task_id="transform_gold",
        namespace="spark-jobs",
        application_file=_SPARK_APP,
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

