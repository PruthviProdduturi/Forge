"""
DAG: forge_demo_bronze
======================
Daily ingestion of synthetic retail orders into the bronze Delta layer

Triggers:    forge_demo_silver on success
Schedule:   At 02:00 AM
SLA:        2 hours
Retries:    2 × 5-minute back-off

Layer:   bronze
Table:   lakehouse.bronze.forgedemo
"""
from __future__ import annotations

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.trigger_dagrun import TriggerDagRunOperator
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
  name: forge-demo-bronze-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/forge_demo_bronze.py"
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
      app: forge-demo-bronze
    env:
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
      app: forge-demo-bronze
  sparkConf:
    spark.sql.extensions: io.delta.sql.DeltaSparkSessionExtension
    spark.sql.catalog.spark_catalog: org.apache.spark.sql.delta.catalog.DeltaCatalog
    spark.hadoop.hive.metastore.uris: thrift://hive-metastore.metastore.svc.cluster.local:9083
    spark.sql.hive.metastore.version: "3.1.3"
    spark.sql.hive.metastore.jars: builtin
    spark.databricks.delta.optimizeWrite.enabled: "true"
    spark.sql.shuffle.partitions: "24"
    spark.submit.pyFiles: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/lib/forge_lib.zip"

"""

# ---------------------------------------------------------------------------
# Default task arguments
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# DAG
# ---------------------------------------------------------------------------
with DAG(
    dag_id="forge_demo_bronze",
    description="Daily ingestion of synthetic retail orders into the bronze Delta layer",
    schedule="0 2 * * *",
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=3,
    tags=["bronze", "ingestion", "forge", "demo", "forge-demo", "retail", "daily", "synthetic"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    spark_task = SparkKubernetesOperator(
        task_id="ingest_demo_bronze",
        namespace="spark-jobs",
        application_file=_SPARK_APP,
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    trigger_forge_demo_silver = TriggerDagRunOperator(
        task_id="trigger_forge_demo_silver",
        trigger_dag_id="forge_demo_silver",
        logical_date="{{ data_interval_start }}",
        wait_for_completion=False,
        reset_dag_run=True,
    )
    spark_task >> [trigger_forge_demo_silver]
