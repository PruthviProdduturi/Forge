"""
DAG: nyc_taxi_bronze
====================
Daily ingestion of NYC TLC Yellow Taxi trip data from Azure Open Datasets
into the bronze Delta layer, partitioned by pickup date.

Source:   wasbs://nyctlc@azureopendatastorage.blob.core.windows.net/yellow/
          (Azure Open Datasets — public, anonymous access)
Output:   lakehouse.bronze.nyctaxi  (Delta, partitioned by __year/__month/__day)

The DAG runs daily from 2025-01-01 with catchup=True so all historical
partitions from Jan 2025 to today are backfilled automatically on first deploy.

Schedule:   Daily at 02:00 UTC
Retries:    2 × 5-minute back-off
Triggers:   nyc_taxi_silver on success

Data source: registered in portal data_sources as 'nyc-taxi-yellow'
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

_BRONZE_SPEC = f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: nyc-taxi-bronze-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/nyc_taxi_bronze.py"
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
    env:
      - name: TAXI_TYPE
        value: "yellow"
      - name: PARTITION_DATE
        value: "{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}"
      - name: DATA_SOURCE_NAME
        value: "nyc-taxi-yellow"
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
      app: nyc-taxi-bronze
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
    spark.hadoop.fs.azure.account.auth.type.azureopendatastorage.blob.core.windows.net: Anonymous
"""

default_args = {
    "owner": "data-engineering",
    "depends_on_past": False,
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(hours=1),
    "sla": timedelta(hours=2),
    "email_on_failure": True,
    "email_on_retry": False,
}

with DAG(
    dag_id="nyc_taxi_bronze",
    description="NYC Yellow Taxi — Azure Open Datasets → bronze Delta (daily)",
    schedule="0 2 * * *",
    start_date=datetime(2025, 1, 1),
    catchup=True,
    max_active_runs=4,
    tags=["nyc-taxi", "bronze", "ingestion", "transport", "daily", "open-data"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    ingest_bronze = SparkKubernetesOperator(
        task_id="ingest_bronze",
        namespace="spark-jobs",
        application_file=_BRONZE_SPEC,
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    trigger_silver = TriggerDagRunOperator(
        task_id="trigger_silver",
        trigger_dag_id="nyc_taxi_silver",
        logical_date="{{ data_interval_start }}",
        wait_for_completion=False,
        reset_dag_run=True,
    )

    ingest_bronze >> trigger_silver
