"""
DAG: forge_demo_gold
====================
Builds three Gold analytical Delta tables from the silver retail orders layer
for the specified date partition.

Triggered by: forge_demo_silver (via TriggerDagRunOperator)

Gold tables produced:
  daily_sales         — order count, revenue, avg order value, units sold and
                        cancellation rate aggregated per order_date
  product_performance — revenue, units sold, order count and avg unit price
                        aggregated per product_id × product_category × order_date
  regional_metrics    — order count, revenue and avg order value aggregated
                        per region × status × order_date

All tables:
  - Written as Delta via saveAsTable, partitioned/replaceWhere on order_date
  - Idempotent: replaceWhere on order_date so safe to re-run
  - Queryable immediately via Trino (forge_catalog.gold.retail_*)
  - Visible in Forge portal — Data Explorer → gold → retail

Schedule:   Triggered by forge_demo_silver (no independent schedule)
SLA:        4 hours after trigger
Retries:    2 × 10-minute back-off

Portal:     Visible in Forge portal under Pipelines → transformation, retail tags
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

# ---------------------------------------------------------------------------
# Shared SparkApplication spec template — parameterised by GOLD_TABLE.
# Each task renders its own copy with a distinct GOLD_TABLE env value.
# ---------------------------------------------------------------------------

def _gold_spec(gold_table: str) -> str:
    """Return a SparkApplication YAML manifest for the given gold table."""
    return f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: forge-demo-gold-{gold_table.replace('_', '-')}-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/forge_demo_gold.py"
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
      app: forge-demo-gold
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
      app: forge-demo-gold
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
    dag_id="forge_demo_gold",
    description="Retail orders silver → gold (daily_sales, product_performance, regional_metrics)",
    schedule=None,  # triggered by forge_demo_silver
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=3,
    tags=["forge-demo", "gold", "transformation", "retail", "daily"],
    default_args=default_args,
    doc_md=__doc__,
) as dag:

    # -----------------------------------------------------------------------
    # Three gold tables computed in parallel — no dependency between them.
    # Each submits a separate SparkApplication that reads the same silver
    # partition and writes one gold table via saveAsTable.
    # -----------------------------------------------------------------------

    gold_daily_sales = SparkKubernetesOperator(
        task_id="gold_daily_sales",
        namespace="spark-jobs",
        application_file=_gold_spec("daily_sales"),
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    gold_product_performance = SparkKubernetesOperator(
        task_id="gold_product_performance",
        namespace="spark-jobs",
        application_file=_gold_spec("product_performance"),
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    gold_regional_metrics = SparkKubernetesOperator(
        task_id="gold_regional_metrics",
        namespace="spark-jobs",
        application_file=_gold_spec("regional_metrics"),
        kubernetes_conn_id="kubernetes_compute_cluster",
        do_xcom_push=True,
        poll_interval=30,
    )

    # All three tasks are independent — no >> chaining needed.
    # Terminal node: no TriggerDagRunOperator downstream.
