"""
DAG: nyc_taxi_gold
==================
Builds four Gold analytical Delta tables from the silver NYC taxi trips
layer for the specified year/month partition.

Triggered by: nyc_taxi_silver (via TriggerDagRunOperator)

Gold tables produced:
  daily_summary   — trips, revenue, avg fare/tip/distance per day × taxi type
  hourly_demand   — trip volume by hour-of-day × day-of-week × taxi type
                    (capacity planning heatmap)
  zone_stats      — pickup/dropoff throughput and top destination per TLC zone
  payment_summary — payment type mix and tip behaviour by date

All tables:
  - Written as Delta, partitioned by pickup_year / pickup_month
  - Idempotent: replaceWhere on partition so safe to re-run
  - Queryable immediately via Trino (forge_catalog.gold.nyc_taxi_*)
  - Visible in Forge portal — Data Explorer → gold → nyc_taxi

Schedule:   Triggered by nyc_taxi_silver (no independent schedule)
SLA:        2 hours after trigger
Retries:    2 × 5-minute back-off

Portal:     Visible in Forge portal under Pipelines → transformation, nyc-taxi tags
Lineage:    Emitted automatically via OpenLineage
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

_SPARK_IMAGE = "{{ var.value.get('spark_image', 'forgeacrprproddu.azurecr.io/spark:4.1.1') }}"
_STORAGE_ACCOUNT = "{{ var.value.get('storage_account', 'forgeadlsprproddudev') }}"

_GOLD_SPEC = f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: nyc-taxi-gold-{{{{ data_interval_start.strftime('%Y-%m') }}}}
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
    onFailureRetryInterval: 5
  driver:
    cores: 2
    memory: "4g"
    serviceAccount: spark
    labels:
      app: nyc-taxi-gold
    env:
      - name: NOTEBOOK_PATH
        value: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/notebooks/nyc_taxi_gold.ipynb"
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
    instances: 4
    memory: "8g"
    labels:
      app: nyc-taxi-gold
  sparkConf:
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "48"
    spark.sql.adaptive.enabled: "true"
"""

default_args = {
    "owner": "data-engineering",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(hours=1, minutes=30),
    "sla": timedelta(hours=2),
    "email_on_failure": True,
    "email_on_retry": False,
}

with DAG(
    dag_id="nyc_taxi_gold",
    description="NYC TLC taxi data — silver → gold aggregations: daily KPIs, hourly demand, zone stats, payment mix (monthly)",
    schedule=None,  # triggered by nyc_taxi_silver
    start_date=datetime(2019, 1, 1),
    catchup=False,
    max_active_runs=3,
    tags=["nyc-taxi", "gold", "transformation", "monthly", "analytics"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    aggregate = SparkKubernetesOperator(
        task_id="gold_aggregate",
        namespace="spark-jobs",
        application_file=_GOLD_SPEC,
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )
