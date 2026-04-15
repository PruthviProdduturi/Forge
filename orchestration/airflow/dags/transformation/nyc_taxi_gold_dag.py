"""
DAG: nyc_taxi_gold
==================
Builds four Gold analytical Delta tables from the NYC Taxi silver layer.

Triggered by: nyc_taxi_silver (via TriggerDagRunOperator)

Gold tables produced (all in lakehouse.gold):
  nyctaxi_daily_summary    — trip count, revenue, avg fare, avg distance, avg duration per day
  nyctaxi_hourly_demand    — trip count and avg fare by pickup hour × date
  nyctaxi_zone_stats       — trips and revenue by pickup/dropoff location ID × date
  nyctaxi_payment_summary  — trips, revenue, avg tip by payment type × date

All four tasks run in parallel once silver completes.
All tables are idempotent (replaceWhere on __date) and queryable via Trino.

Schedule:   Triggered by nyc_taxi_silver (no independent schedule)
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

_SPARK_IMAGE = "{{ var.value.get('spark_image', 'forgeacrdseng.azurecr.io/spark:4.1.1') }}"
_STORAGE_ACCOUNT = "{{ var.value.get('storage_account', 'forgeadlsdsengdev') }}"

_GOLD_TABLES = [
    "daily_summary",
    "hourly_demand",
    "zone_stats",
    "payment_summary",
]


def _gold_spec(gold_table: str) -> str:
    return f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: nyc-taxi-gold-{gold_table.replace('_', '-')}-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
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
      - name: PARTITION_DATE
        value: "{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}"
      - name: GOLD_TABLE
        value: "{gold_table}"
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
    spark.sql.adaptive.enabled: "true"
    spark.sql.adaptive.coalescePartitions.enabled: "true"
"""


default_args = {
    "owner": "data-engineering",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=10),
    "execution_timeout": timedelta(hours=1),
    "sla": timedelta(hours=4),
    "email_on_failure": True,
    "email_on_retry": False,
}

with DAG(
    dag_id="nyc_taxi_gold",
    description="NYC Yellow Taxi silver → gold (daily_summary, hourly_demand, zone_stats, payment_summary)",
    schedule=None,
    start_date=datetime(2025, 1, 1),
    catchup=False,
    max_active_runs=4,
    tags=["nyc-taxi", "gold", "transformation", "transport", "daily"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    # All four gold tables are independent — run in parallel
    for _table in _GOLD_TABLES:
        SparkKubernetesOperator(
            task_id=f"gold_{_table}",
            namespace="spark-jobs",
            application_file=_gold_spec(_table),
            kubernetes_conn_id="kubernetes_compute_cluster",
            do_xcom_push=True,
            poll_interval=30,
        )
