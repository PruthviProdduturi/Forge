"""
DAG: forge_demo_silver
======================
Transforms retail orders bronze data into a cleaned, deduplicated silver Delta
table partitioned by order_date.

Pipeline:
    Source:   bronze/retail/orders/              (Delta, appended by forge_demo_bronze)
    Output:   silver/retail/orders_cleaned/      (Delta, partition-overwrite per run)
    HMS:      lakehouse.silver.retail_orders_cleaned

Transforms applied:
  - Deduplicate on order_id
  - Drop rows with NULL in order_id, customer_id, unit_price, or quantity
  - Filter out non-positive quantity and unit_price
  - Compute total_amount = round(quantity * unit_price, 2)
  - Add _processed_at audit timestamp
  - Drop _source staging column
  - DQ gate via @track decorator (forge_dq)

Triggered by: forge_demo_bronze (via TriggerDagRunOperator)
Can also be run manually to reprocess any date partition.

Schedule:   Triggered by forge_demo_bronze (no independent schedule)
SLA:        3 hours after trigger
Retries:    2 × 10-minute back-off

Portal:     Visible in Forge portal under Pipelines → transformation, retail tags
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
  name: forge-demo-silver-{{{{ data_interval_start.strftime('%Y-%m-%d') }}}}
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "{_SPARK_IMAGE}"
  imagePullPolicy: Always
  mainApplicationFile: "abfss://code@{_STORAGE_ACCOUNT}.dfs.core.windows.net/spark/jobs/forge_demo_silver.py"
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
      app: forge-demo-silver
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
      app: forge-demo-silver
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
    "execution_timeout": timedelta(hours=2),
    "sla": timedelta(hours=3),
    "email_on_failure": True,
    "email_on_retry": False,
}

with DAG(
    dag_id="forge_demo_silver",
    description="Retail orders bronze → silver (clean, dedupe, DQ gate)",
    schedule=None,  # triggered by forge_demo_bronze
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=3,
    tags=["forge-demo", "silver", "transformation", "retail", "daily"],
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
        trigger_dag_id="forge_demo_gold",
        logical_date="{{ data_interval_start }}",
        wait_for_completion=False,
        reset_dag_run=True,
    )

    silver_transform >> trigger_gold
