"""
DAG: nyc_taxi_silver
====================
Transforms NYC Yellow Taxi bronze data into a clean, typed silver table.

Source:   lakehouse.bronze.nyctaxi  (Delta, written by nyc_taxi_bronze)
Output:   lakehouse.silver.nyctaxi  (Delta, partitioned by __date)

Transforms applied:
  - Filter to partition date (eliminates cross-day spill records)
  - Standardise column names (camelCase → snake_case)
  - Drop records with NULL pickup/dropoff timestamps or locations
  - Filter out zero/negative fares and distances
  - Compute derived fields: trip_duration_minutes, fare_per_mile, speed_mph
  - DQ gate via @track decorator

Triggered by: nyc_taxi_bronze (via TriggerDagRunOperator)
Triggers:     nyc_taxi_gold on success
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)

_SPARK_IMAGE = "{{ var.value.get('spark_image', 'forgeacrdseng.azurecr.io/spark:4.1.1') }}"
_STORAGE_ACCOUNT = "{{ var.value.get('storage_account', 'forgeadlsdsengdev') }}"

_SILVER_SPEC = f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: nyc-taxi-silver-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/nyc_taxi_silver.py"
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
      app: nyc-taxi-silver
    env:
      - name: PARTITION_DATE
        value: "{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}"
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
      app: nyc-taxi-silver
  sparkConf:
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.hadoop.hive.metastore.uris: thrift://hive-metastore.metastore.svc.cluster.local:9083
    spark.sql.hive.metastore.version: "3.1.3"
    spark.sql.hive.metastore.jars: builtin
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "48"
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
    description="NYC Yellow Taxi bronze → silver (clean, type, derive)",
    schedule=None,
    start_date=datetime(2025, 1, 1),
    catchup=False,
    max_active_runs=4,
    tags=["nyc-taxi", "silver", "transformation", "transport", "daily"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    silver_transform = SparkKubernetesOperator(
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

    silver_transform >> trigger_gold
