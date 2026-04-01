"""
DAG: forge_demo_bronze
======================
Daily ingestion of synthetic retail orders into the bronze Delta layer.
This DAG is the entry point of the Forge platform end-to-end demo pipeline
and is designed to be self-contained: the Spark job generates ~1 000
synthetic records for the run date rather than pulling from an external
source, so the demo can run in any environment without additional data
dependencies.

Pipeline:
  Source  — Synthetic generator (no external dependency)
  Output  — lakehouse.bronze.retail_orders  (Delta, partitioned by order_date)

Dataset schema (retail_orders):
  order_id          string       — unique order identifier, e.g. "ORD-00000042"
  customer_id       string       — anonymised customer ref, e.g. "CUST-43"
  product_id        string       — product reference, e.g. "PROD-7"
  product_category  string       — one of: Electronics, Clothing, Food, Home, Sports
  quantity          int          — units ordered (1–10)
  unit_price        double       — price per unit in USD (e.g. 42.99)
  order_timestamp   timestamp    — wall-clock time within the partition date
  status            string       — one of: pending, confirmed, shipped, delivered, cancelled
  region            string       — one of: North, South, East, West, Central
  order_date        string       — partition column (yyyy-MM-dd), equals PARTITION_DATE
  _source           string       — audit: always "synthetic-generator"
  _ingested_at      timestamp    — audit: wall-clock time of the Spark write

Schedule:   Daily at 02:00 UTC
SLA:        2 hours (must complete by 04:00 UTC)
Retries:    2 × 5-minute back-off

Portal:     Visible in Forge portal under Pipelines → ingestion, forge-demo tags
Lineage:    Emitted automatically to Microsoft Purview via the OpenLineage
            listener configured in forge_session().  No extra code required.

Dependencies:
  → triggers forge_demo_silver once ingest_orders completes successfully
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
# application_file is a template_field on SparkKubernetesOperator so all
# {{ }} expressions are rendered by Airflow before submission to the operator.
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
    description="Forge demo — daily ingest of synthetic retail orders → bronze Delta",
    schedule="0 2 * * *",
    start_date=datetime(2024, 1, 1),
    catchup=False,
    tags=["forge-demo", "bronze", "ingestion", "retail", "daily"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    ingest_orders = SparkKubernetesOperator(
        task_id="ingest_orders",
        namespace="spark-jobs",
        application_file=_SPARK_APP,
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    trigger_silver = TriggerDagRunOperator(
        task_id="trigger_silver",
        trigger_dag_id="forge_demo_silver",
        logical_date="{{ data_interval_start }}",
        wait_for_completion=False,
        reset_dag_run=True,
    )

    ingest_orders >> trigger_silver
