# Forge — End-to-End Flow Architecture

> **Status:** Current
> **Purpose:** Complete walkthrough of how every component connects and works together, from a developer writing code to data landing in the Gold layer and being queryable.

[![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org) [![Delta Lake](https://img.shields.io/badge/Delta%20Lake-003366?style=flat-square&logo=delta&logoColor=white)](https://delta.io)

---

## System Map

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                              DEVELOPER ENVIRONMENT                               ║
║                                                                                  ║
║   VS Code                                                                        ║
║   ├── Forge Extension  → scaffold Bronze/Silver/Gold notebooks + DAG stubs     ║
║   ├── Jupyter Notebook   → PySpark via Spark Connect (remote, real cluster)      ║
║   └── Git                → push DAGs, jobs, DQ rules to Forge repo             ║
╚══════════════════════╤═══════════════════════════════════════════════════════════╝
                       │
          ┌────────────▼─────────────┐
          │    Git Repository        │
          │    (Azure DevOps / GH)   │
          │                          │
          │  orchestration/          │
          │  └── airflow/dags/   ◄── │── data engineer PRs
          │  infra/              ◄── │── platform engineer PRs
          └────────────┬─────────────┘
                       │
          ┌────────────▼──────────────────────────────────────┐
          │               ADO Pipelines + git-sync                    │
          │                                                     │
          │  ADO Pipeline → deploys infra/ Helm charts to clusters     │
          │  git-sync → pulls dags/ into Airflow scheduler      │
          └────────────┬────────────────────────┬──────────────┘
                       │                        │
         ┌─────────────▼──────────┐  ┌──────────▼────────────────────────────────┐
         │   COMPUTE CLUSTER       │  │         ORCHESTRATION CLUSTER              │
         │   (AKS private)         │  │         (AKS private)                      │
         │                         │  │                                            │
         │  ┌─────────────────┐   │  │  ┌─────────────────────────────────────┐  │
         │  │ Spark Operator  │   │  │  │  Airflow Scheduler (x2 HA)          │  │
         │  │ Spark Connect   │◄──┼──┼──┤  - KubernetesExecutor               │  │
         │  │ Trino           │   │  │  │  - Key Vault secrets backend        │  │
         │  │ Hive Metastore  │   │  │  │  - OpenLineage provider             │  │
         │  └────────┬────────┘   │  │  └──────────────┬────────────────────┘  │  │
         │           │             │  │                 │                        │  │
         └───────────┼─────────────┘  │  ┌─────────────▼────────────────────┐  │  │
                     │                │  │  Marquez API (lineage store)      │  │  │
                     │                │  └──────────────────────────────────┘  │  │
                     │                │  ┌──────────────────────────────────┐  │  │
                     │                │  │  Azure Monitor + Managed Grafana │  │  │
                     │                │  └──────────────────────────────────┘  │  │
                     │                │  ┌──────────────────────────────────┐  │  │
                     │                │  │  Developer Portal (API + Web)    │  │  │
                     │                │  └──────────────────────────────────┘  │  │
                     │                └────────────────────────────────────────┘  │
                     │                                    │
                     └────────────────┬───────────────────┘
                                      │
                     ╔════════════════▼══════════════════════════════╗
                     ║         ADLS Gen2 Lakehouse                   ║
                     ║                                               ║
                     ║   bronze/  →  silver/  →  gold/              ║
                     ║   sandbox/    checkpoints/    code/           ║
                     ╚═══════════════════════════════════════════════╝
```

---

## End-to-End Flow: New Pipeline from Scratch

### Phase 1 — Developer Builds the Pipeline

```
Developer opens VS Code
        │
        │  1. Forge Extension: "New Bronze Pipeline"
        │     → Creates: notebooks/bronze_sales_orders.ipynb
        │                orchestration/airflow/dags/ingestion/ingest_bronze_sales_orders.py (stub)
        │                orchestration/dq/rules/bronze_sales_orders.yaml (scaffold)
        ▼
notebooks/bronze_sales_orders.ipynb
        │
        │  2. Developer configures source:
        │     source_path = "abfss://bronze@forgeadlsdev.dfs.core.windows.net/crm/orders/"
        │
        │  3. Notebook connects to Spark Connect:
        │     spark = SparkSession.builder.remote("sc://10.4.0.10:15002").getOrCreate()
        │
        │  4. Developer reads, explores, and writes transform logic against REAL data
        │     (Spark 4.1 running on compute cluster — same config as production)
        │
        │  5. Developer runs notebook top-to-bottom — all cells pass
        │
        │  6. Forge Extension: "Convert to Production Job"
        │     → Extracts notebook logic into: compute/spark/jobs/ingest_bronze_sales_orders.py
        │     → Updates DAG stub to reference the job file
        │     → Scaffolds DQ ruleset from inferred schema
        ▼
Git commit + PR
        │
        │  Files changed:
        │  ├── compute/spark/jobs/ingest_bronze_sales_orders.py
        │  ├── orchestration/airflow/dags/ingestion/ingest_bronze_sales_orders.py
        │  └── orchestration/dq/rules/bronze_sales_orders.yaml
        │
        │  PR reviewed by team → merged to main
        ▼
git-sync picks up DAG file (within 30 seconds)
ADO Pipeline deploys Spark job file to code/ container on ADLS
```

---

### Phase 2 — First Pipeline Run

```
Airflow Scheduler
        │
        │  DAG: ingest_bronze_sales_orders
        │  Schedule: @daily, 04:00 UTC
        │
        │  1. Scheduler marks task QUEUED
        │  2. KubernetesExecutor creates task pod in airflow namespace
        ▼
Task Pod: ingest_bronze_sales_orders.run_spark_job
        │
        │  3. CSI Secrets Store mounts Key Vault secrets as env vars:
        │     ADLS_ACCOUNT, OPENLINEAGE_URL, etc.
        │
        │  4. OpenLineage emits START event to Marquez:
        │     {job: "ingest_bronze_sales_orders", eventType: "START"}
        │
        │  5. SparkKubernetesOperator submits SparkApplication CRD
        │     to compute cluster (via kubeconfig from Key Vault):
        ▼
        │     SparkApplication: ingest_bronze_sales_orders-{run_id}
        │     Namespace: spark-jobs (compute cluster)
        ▼
Spark Operator (compute cluster)
        │
        │  6. Launches Driver Pod (spark node pool, on-demand)
        │
        │  7. Driver requests Executor Pods (spark node pool, spot)
        │     Dynamic allocation: starts 2, scales to N as needed
        ▼
Spark Driver + Executors
        │
        │  8. Job reads source:
        │     df = spark.read.parquet("abfss://bronze@.../crm/orders/")
        │     (ABFS driver authenticates via workload identity — no keys)
        │
        │  9. Applies minimal transforms:
        │     - adds _ingestion_ts
        │     - adds _source_system = "crm"
        │
        │  10. Writes to Bronze:
        │     df.write.mode("overwrite").parquet(
        │       "abfss://bronze@.../crm/orders/2026-03-24/"
        │     )
        │
        │  11. OpenLineage Spark plugin captures:
        │     - Input dataset: source path + schema
        │     - Output dataset: bronze path + schema + row count
        │     - Emits COMPLETE event to Marquez
        ▼
ADLS Bronze: bronze/crm/orders/2026-03-24/part-*.parquet
        │
        │  12. SparkApplication transitions to COMPLETED
        │  13. Airflow sensor confirms completion
        │  14. Task pod writes XCom: row_count, output_path
        │  15. Task pod terminates (pod is deleted)
        │  16. Airflow task state → SUCCESS
        │  17. Triggers downstream: transform_silver_sales_orders
```

---

### Phase 3 — Silver Transform

```
Task Pod: transform_silver_sales_orders.run_spark_job
        │
        │  1. Reads Bronze partitions since last watermark:
        │     "abfss://bronze@.../crm/orders/{today}/"
        │
        │  2. Applies business transforms:
        │     - Type casting (string → decimal, string → timestamp)
        │     - Deduplication on (order_id, updated_at)
        │     - Derived columns: order_total_usd = subtotal + tax + shipping
        │
        │  3. MERGE into Silver Delta table:
        │     MERGE INTO silver.crm_orders AS target
        │     USING new_data ON target.order_id = new_data.order_id
        │     WHEN MATCHED AND target.record_hash != new_data.record_hash
        │       THEN UPDATE SET *
        │     WHEN NOT MATCHED THEN INSERT *
        │
        │  4. Schema validation: passes (no incompatible changes)
        │
        │  5. Emits OpenLineage COMPLETE with:
        │     - Input: bronze/crm/orders/2026-03-24 (schema + row count)
        │     - Output: silver/crm_orders (version 47, schema + row count)
        │     - Column-level lineage: which silver columns came from which bronze columns
        ▼
ADLS Silver: silver/crm_orders/ (Delta table, version 47)
        │
        │  6. Triggers: validate_dq_silver_crm_orders
```

---

### Phase 4 — DQ Validation

```
Task Pod: validate_dq_silver_crm_orders.run_dq
        │
        │  1. Loads DQ ruleset:
        │     orchestration/dq/rules/silver_crm_orders.yaml
        │
        │  2. DQRunner reads Silver table via Trino:
        │     SELECT COUNT(*), COUNT(order_id), MAX(_updated_ts) FROM silver.crm_orders
        │     WHERE _partition_date = current_date
        │
        │  3. Executes checks in parallel:
        │
        │  ┌────────────────────────────────────────────────────────────────┐
        │  │ Schema checks                                                   │
        │  │  ✓ order_id:    STRING, NOT NULL → PASS                        │
        │  │  ✓ order_total: DECIMAL(18,2)   → PASS                        │
        │  │  ✓ status:      STRING, NOT NULL → PASS                        │
        │  │                                                                  │
        │  │ Content checks                                                  │
        │  │  ✓ order_id null rate: 0.0%  (threshold: 0%)    → PASS         │
        │  │  ✓ status values: all in {'open','closed','cancelled'} → PASS  │
        │  │  ✓ order_total > 0: 99.97% (threshold: 99%)    → PASS         │
        │  │                                                                  │
        │  │ Volume checks                                                   │
        │  │  ✓ row count: 84,231  (min: 10,000)             → PASS         │
        │  │  ✓ delta vs yesterday: +12% (threshold: <50%)  → PASS         │
        │  │                                                                  │
        │  │ Freshness checks                                                │
        │  │  ✓ latest partition: 0h 23m ago (threshold: 2h) → PASS        │
        │  └────────────────────────────────────────────────────────────────┘
        │
        │  4. DQRunReport: ALL PASSED
        │
        │  5. StoreReporter writes report to:
        │     silver/_platform/dq_results/
        │     (Delta table, append)
        │
        │  6. LineageReporter emits DQ facet to Marquez:
        │     silver/crm_orders version 47 → DQ: PASSED, 8/8 rules
        │
        │  7. Task → SUCCESS
        │  8. Triggers: publish_gold_crm_orders
```

---

### Phase 5 — Gold Publish

```
Task Pod: publish_gold_crm_orders.run_publish
        │
        │  1. Trino materializes Gold table:
        │     CREATE OR REPLACE TABLE gold.crm_orders AS
        │     SELECT
        │       order_id,
        │       customer_id,
        │       order_total_usd,
        │       status,
        │       order_date,
        │       _updated_ts
        │     FROM silver.crm_orders
        │     WHERE status != 'test'
        │
        │  2. Spark OPTIMIZE + VACUUM on Gold table:
        │     OPTIMIZE gold.crm_orders ZORDER BY (customer_id, order_date)
        │     VACUUM gold.crm_orders RETAIN 168 HOURS
        │
        │  3. Freshness SLA check:
        │     max(_updated_ts) = 2026-03-24 04:47:00
        │     SLA threshold:    must be < 2h old
        │     2026-03-24 06:00 - 04:47 = 1h 13m → PASS
        │
        │  4. Metadata catalog update:
        │     UPDATE platform.dataset_catalog
        │     SET last_refreshed_ts = now(),
        │         row_count = 84231,
        │         schema_version = 12
        │     WHERE dataset_name = 'gold.crm_orders'
        │
        │  5. Emits OpenLineage COMPLETE:
        │     Input: silver/crm_orders (version 47)
        │     Output: gold/crm_orders (version 8)
        │     DQ facet: PASSED (pass-through)
        │
        │  6. Task → SUCCESS
        ▼
ADLS Gold: gold/crm_orders/ (Delta table, version 8, Z-ORDER optimised)
```

---

### Phase 6 — Data is Queryable

```
gold/crm_orders is now available to all consumers:

  ┌──────────────────────────────────────────────────────────────┐
  │  Trino SQL (via portal or direct client)                      │
  │  SELECT customer_id, SUM(order_total_usd) AS ltv              │
  │  FROM gold.crm_orders                                         │
  │  WHERE order_date >= current_date - interval '30' day         │
  │  GROUP BY customer_id                                          │
  │  ORDER BY ltv DESC LIMIT 100                                   │
  └──────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────┐
  │  Spark Connect (data science notebook)                        │
  │  df = spark.read.format("delta")                              │
  │       .load("abfss://gold@.../crm_orders/")                  │
  │  features = df.groupBy("customer_id").agg(...)                │
  └──────────────────────────────────────────────────────────────┘
```

---

## DAG Structure — Separation of Concerns

```
Forge Git Repository
│
├── infra/                       ← PLATFORM TEAM
│   ├── bicep/                   ← AKS, ADLS, KV, ACR, networking
│   ├── helm/                    ← Spark, Trino, Airflow, Marquez, Observability
│   └── docker/                  ← Custom image Dockerfiles
│
└── orchestration/               ← DATA ENGINEERS
    └── airflow/
        ├── dags/                ← DAG files (git-sync'd to Airflow, live reload)
        │   ├── ingestion/       ← Bronze ingestion DAGs
        │   ├── transformation/  ← Silver transform DAGs
        │   ├── validation/      ← DQ validation DAGs
        │   └── publishing/      ← Gold publish DAGs
        └── plugins/             ← Custom operators (platform team + data engineers)
```

**Key rule:** Changes to `infra/` go through platform team review and trigger ADO Pipeline (Helm redeploy). Changes to `orchestration/airflow/dags/` go through data engineer review and are live in Airflow within 30 seconds via git-sync — no platform redeploy needed.

**DAG naming convention:**

| Layer | DAG ID pattern | Example |
|-------|---------------|---------|
| Bronze ingestion | `ingest_bronze_{domain}_{entity}` | `ingest_bronze_crm_orders` |
| Silver transform | `transform_silver_{domain}_{entity}` | `transform_silver_crm_orders` |
| DQ validation | `validate_dq_{domain}_{entity}` | `validate_dq_crm_orders` |
| Gold publish | `publish_gold_{domain}_{entity}` | `publish_gold_crm_orders` |
| Maintenance | `maintenance_{target}` | `maintenance_vacuum_silver` |

---

## Full Lineage Graph After One Run

```
[source: crm.dbo.Orders]
         │
         │  ingest_bronze_crm_orders  (2026-03-24 04:12 — COMPLETE)
         ▼
[bronze: crm/orders/2026-03-24]
         │         schema: {order_id, customer_id, subtotal, tax, ...}
         │         row count: 84,231
         │
         │  transform_silver_crm_orders  (2026-03-24 04:35 — COMPLETE)
         ▼
[silver: crm_orders]  version 47
         │         schema: {order_id, customer_id, order_total_usd, status, ...}
         │         DQ: PASSED (8/8 rules)
         │         column lineage: order_total_usd ← subtotal + tax + shipping
         │
         ├── validate_dq_crm_orders  (2026-03-24 04:47 — COMPLETE)
         │         │
         │         ▼
         │   [silver: _platform/dq_results] (DQRunReport appended)
         │
         └── publish_gold_crm_orders  (2026-03-24 05:02 — COMPLETE)
                   │
                   ▼
         [gold: crm_orders]  version 8
                   │         schema: {order_id, customer_id, order_total_usd, ...}
                   │         freshness SLA: PASS (1h 13m)
                   │         Z-ORDER: customer_id, order_date
                   │
                   ├── [consumer: Trino ad-hoc queries]
                   └── [consumer: Spark Connect notebooks]
```

---

## Observability During a Pipeline Run

While the pipeline runs, every component feeds into the observability stack:

```
Airflow scheduler    →  Azure Monitor / Container Insights (via AMA + statsd-exporter)
                           - task_instance_state{dag_id, task_id, state}
                           - dag_run_duration{dag_id}
                           - scheduler_heartbeat

Spark Driver/Execs   →  Azure Monitor / Container Insights (via AMA + PrometheusServlet)
                           - spark_executor_count
                           - spark_task_duration_ms (histogram)
                           - spark_shuffle_read_bytes
                           - spark_gc_time_ms

Trino coordinator    →  Azure Monitor / Container Insights (via AMA)
                           - trino_active_queries
                           - trino_query_execution_time (histogram)
                           - trino_failed_queries_total

All pods             →  Azure Log Analytics Workspace (via Azure Monitor Agent DaemonSet)
                           - Structured JSON logs with dag_id, run_id, task_id fields
                           - Searchable by pipeline in portal Log Viewer

OpenLineage events   →  Marquez
                           - Every task START/COMPLETE/FAIL
                           - Queryable as lineage graph

DQ results           →  Delta table (silver/_platform/dq_results/)
                           - Queryable in portal DQ dashboard
```

**Azure Managed Grafana Platform Overview dashboard during this run:**

```
Pipeline Health:        ████████████████████ 100% (1 running, 0 failed)
DQ Pass Rate (7d):      ████████████████████  99.8%
Active Spark Jobs:      ██░░░░░░░░░░░░░░░░░░  1
Gold Freshness SLA:     ████████████████████ PASS (all datasets within SLA)
Trino Query P95:        ████░░░░░░░░░░░░░░░░  8.2s
```
