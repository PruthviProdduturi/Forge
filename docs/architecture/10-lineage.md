# Forge — Lineage Architecture

> **Version:** 2.0
> **Status:** Current
> **Audience:** Platform engineers, data engineers, architects

[![OpenLineage](https://img.shields.io/badge/OpenLineage-7B2FBE?style=flat-square&logoColor=white)](https://openlineage.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Full Lineage Chain](#2-full-lineage-chain)
3. [Emission Points](#3-emission-points)
4. [Upstream Source Naming Convention](#4-upstream-source-naming-convention)
5. [OpenLineage Transport Configuration](#5-openlineage-transport-configuration)
6. [OpenLineage Event Structure](#6-openlineage-event-structure)
7. [Custom Facets](#7-custom-facets)
8. [Column-Level Lineage](#8-column-level-lineage)
9. [Impact Analysis](#9-impact-analysis)
10. [Lineage for Streaming Jobs](#10-lineage-for-streaming-jobs)
11. [Lineage Retention](#11-lineage-retention)
12. [Viewing Lineage in the Portal](#12-viewing-lineage-in-the-portal)

---

## 1. Overview

### OpenLineage Standard

OpenLineage is an open standard for collecting lineage metadata from data pipelines. Its core design principle is **emission at the source**: every tool that reads or writes data emits a structured event describing what it did. These events are collected by a backend and assembled into a lineage graph.

The standard is defined at [openlineage.io](https://openlineage.io). Forge uses version 1.x of the specification. The Forge components that emit events (Airflow, Spark, Trino) all use the official OpenLineage client libraries, ensuring the events are spec-compliant and backend-portable.

### Lineage in Forge

Lineage in Forge is derived from **Airflow DAG tags** (`source:` and `output:` tags declared in each DAG) and surfaced through the **portal lineage API**. There is no external lineage store. OpenLineage events are emitted by Airflow tasks and Spark jobs as before, but they are consumed internally — the portal lineage API reads DAG tags and OpenLineage run metadata to build the lineage graph displayed in the Developer Portal.

The namespace convention is `forge-{env}` (e.g., `forge-dev`, `forge-prod`).

---

## 2. Full Lineage Chain

The portal lineage API captures the complete lineage from upstream source systems to the gold serving layer. Opening a gold asset in the Developer Portal shows the full upstream chain: where the data originated, which ingest jobs brought it in, how it was transformed through bronze and silver, and which aggregation jobs produced the gold output.

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                     FULL LINEAGE CHAIN                                           ║
╚══════════════════════════════════════════════════════════════════════════════════╝

  SOURCE SYSTEMS                INGEST                 BRONZE
  ──────────────                ──────                 ──────

  ┌─────────────────────┐
  │ SQL Server / Azure  │
  │ SQL Database        │──────►  ingest_raw_orders  ──► abfss://bronze@.../
  │ mssql://crm-server  │         (Spark job)            orders/2026-03-24/
  └─────────────────────┘
  ┌─────────────────────┐
  │ PostgreSQL /        │
  │ Azure PostgreSQL    │──────►  ingest_raw_customers──► abfss://bronze@.../
  │ postgresql://pg-... │         (Spark job)            customers/2026-03-24/
  └─────────────────────┘
  ┌─────────────────────┐
  │ REST API            │
  │ https://api.ext.io/ │──────►  ingest_raw_events  ──► abfss://bronze@.../
  │                     │         (Spark/Airflow)        events/2026-03-24/
  └─────────────────────┘


  BRONZE               TRANSFORM                SILVER
  ──────               ─────────                ──────

  abfss://bronze@.../
  orders/          ──────► transform_orders    ──► abfss://silver@.../
  customers/       ──────► (Spark job,            sales/orders/
  events/          ──────►  DQ gate)


  SILVER               AGGREGATION              GOLD
  ──────               ───────────              ────

  abfss://silver@.../
  sales/orders/    ──────► publish_orders      ──► abfss://gold@.../
                           (Trino CTAS /           sales/orders_summary/
                            Spark job)


  GOLD                 PORTAL LINEAGE GRAPH
  ────                 ────────────────────

  abfss://gold@.../               ┌───────────────────────────────────────────┐
  sales/orders_summary/ ─────────►│  Developer Portal — Lineage Explorer      │
                                  │                                           │
                                  │  gold/sales/orders_summary                │
                                  │    ← publish_orders                       │
                                  │      ← silver/sales/orders                │
                                  │          ← transform_orders               │
                                  │              ← bronze/orders              │
                                  │                  ← ingest_raw_orders      │
                                  │                      ← mssql://crm-server │
                                  └───────────────────────────────────────────┘
```

**Critical:** The lineage chain from source system to gold is only complete when ingest jobs correctly declare their upstream source as an OpenLineage input. See [Section 4 — Upstream Source Naming Convention](#4-upstream-source-naming-convention) for the required naming patterns.

---

## 3. Emission Points

No manual instrumentation is required for standard Forge pipelines. All three engines emit OpenLineage events automatically via their respective integrations.

| Component | Integration | Emission Trigger | Datasets Auto-Captured |
|-----------|------------|-----------------|------------------------|
| **Apache Airflow** | `openlineage-airflow` package (version 1.18.0) — installs a `TaskInstanceStateChangedCallback` | Task state change: `QUEUED → RUNNING → COMPLETE/FAIL` | Operator-dependent; ADLS inputs/outputs auto-captured for `SparkKubernetesOperator` via parent run linking |
| **Apache Spark** | `openlineage-spark-1.18.0.jar` registered via `spark.extraListeners` | `SparkContext` init, `DataFrame.write` / physical plan execution, `SparkContext` termination | ABFS paths (ADLS) auto-captured from `FileScan` and `WriteToHadoopFs` logical plan nodes. Schema facets, row counts, and column lineage are all automatic. |
| **Trino** | `openlineage-trino-1.18.0.jar` installed as event listener plugin | `QueryCreatedEvent` (START) and `QueryCompletedEvent` (COMPLETE/FAIL) | All tables referenced in the SQL query — resolved via Trino connector metadata. Inputs and outputs for `CREATE TABLE AS SELECT` and `INSERT INTO`. |

### Airflow OpenLineage Provider

The `openlineage-airflow` package hooks into the Airflow task lifecycle and emits events:

```
Airflow Scheduler
        │
        │  Task state change: RUNNING
        ▼
OpenLineage Airflow Plugin
        │  Constructs START event:
        │  - job.namespace: forge-{env}
        │  - job.name: <dag_id>.<task_id>
        │  - run.runId: UUID derived from Airflow run_id + task_id
        │  - run.facets.nominalTime: dag execution_date
        │  - run.facets.parent: links Spark child run to this Airflow task
        ▼
OpenLineage event stored internally (consumed by portal lineage API)

        │  Task completes (COMPLETE or FAILED)
        ▼
OpenLineage Airflow Plugin
        │  Constructs COMPLETE/FAIL event:
        │  - run.runId: same UUID as START
        │  - inputs/outputs: final, with schema facets
        │  - run.facets.errorMessage: (on FAIL)
        ▼
OpenLineage event stored internally (consumed by portal lineage API)
```

**Operator-specific lineage extraction:**

| Operator | Extractor Behaviour |
|----------|---------------------|
| `SparkKubernetesOperator` | Reads the `SparkApplication` spec; links to the Spark job's OpenLineage events via the `parent` run facet. The Spark events carry the actual ADLS dataset inputs and outputs. |
| `PythonOperator` | No automatic dataset extraction; pipeline authors add `@task` with explicit `inlets` and `outlets` decorators where needed. |
| `TrinoOperator` (custom) | SQL is parsed and table references extracted; mapped to ADLS paths via Hive Metastore lookup. |

### Spark OpenLineage Integration

The Spark OpenLineage listener is active for both Spark Operator batch jobs and the Spark Connect server:

```
SparkContext initialisation
        │  → emits START event
        │    job.namespace: forge-{env}
        │    run.runId: UUID generated at SparkContext start
        │    run.facets.parent: Airflow run ID (from spark.openlineage.parentRunId)
        ▼

DataFrame.write (physical plan execution)
        │  → listener receives SparkListenerJobStart
        │    extracts logical plan via plan node extractor
        │    identifies input datasets (ABFS paths from FileScan nodes)
        │    identifies output datasets (ABFS paths from Write nodes)
        │    extracts column lineage (see Section 8)
        │    builds schema facets from Spark StructType
        ▼

SparkContext termination
        │  → emits COMPLETE event:
        │    - final input/output dataset list with schema + storage facets
        │    - dataQualityMetrics facet (row counts from WriteTaskMetrics)
        │    - columnLineage facets on output datasets
        │    - computeCost facet (see Section 7)
        ▼
OpenLineage event stored internally (consumed by portal lineage API)
```

### Trino OpenLineage Plugin

The Trino event listener fires for every query:

1. Receives `QueryCreatedEvent` → emits `START` event with the query text in `run.facets.externalQuery`
2. Parses the Trino SQL query AST to extract referenced table names (catalog.schema.table)
3. Maps table names to ADLS paths via the Trino connector's metadata layer
4. Receives `QueryCompletedEvent` → emits `COMPLETE` or `FAIL` event with input datasets, output datasets, schema facets, and query statistics

For `SELECT` queries (read-only), Trino emits lineage with inputs only and no outputs. This shows which Trino queries read which gold tables, making impact analysis complete.

---

## 4. Upstream Source Naming Convention

This section is critical. Without correctly declaring upstream sources as OpenLineage inputs, lineage starts at the bronze layer instead of the real source system. The portal lineage API cannot show the true origin of data unless ingest jobs declare their upstream inputs.

**ADLS datasets** (bronze, silver, gold) are auto-captured by the OpenLineage Spark integration using ABFS paths. No manual declaration needed.

**External source systems** must be declared explicitly for sources that OpenLineage cannot auto-detect. Use the naming conventions below.

### Naming Conventions by Source Type

| Source Type | Namespace Pattern | Dataset Name Pattern | Example |
|------------|------------------|---------------------|---------|
| **SQL Server / Azure SQL** | `mssql://<server>.database.windows.net/<database>` | `<schema>.<table>` | `mssql://crm-server.database.windows.net/CRM` → `dbo.orders` |
| **PostgreSQL / Azure PostgreSQL** | `postgresql://<server>.postgres.database.azure.com/<database>` | `<schema>.<table>` | `postgresql://pg-erp.postgres.database.azure.com/ERP` → `public.line_items` |
| **REST API / HTTP source** | `https://<api-host>/` | endpoint path | `https://api.payments.io/` → `/v2/transactions` |
| **Azure Blob Storage (non-ADLS)** | `wasbs://<container>@<account>.blob.core.windows.net` | `<path>` | `wasbs://exports@legacyaccount.blob.core.windows.net` → `orders/daily/` |
| **ADLS Gen2** | auto-captured | auto-captured | `abfss://bronze@forgeprodadls.dfs.core.windows.net/crm/orders/` |

### Declaring Upstream Inputs in Ingest Jobs

For sources that OpenLineage cannot auto-detect (JDBC, REST, Blob), you must explicitly declare the upstream dataset as an input in your ingest operator. Use the `forge-lineage` SDK's `IngestLineageContext` helper:

```python
# orchestration/airflow/dags/ingestion/ingest_orders.py

from openlineage.client.run import Dataset
from forge.lineage import IngestLineageContext

# --- Option 1: Via custom SparkKubernetesOperator wrapper ---
# Pass upstream source info as Spark job arguments; the Spark job then
# calls forge.lineage.declare_inputs() at runtime.

ingest_task = SparkKubernetesOperator(
    task_id="ingest_raw_orders",
    application_file="abfss://code@forgeprodadls.dfs.core.windows.net/jobs/ingest_orders.py",
    spark_conf={
        # Source declaration — read by forge.lineage.declare_inputs() in the Spark job
        "spark.forge.lineage.upstream.namespace": "mssql://crm-server.database.windows.net/CRM",
        "spark.forge.lineage.upstream.dataset": "dbo.orders",
    },
)

# --- Option 2: In the Spark job itself (pyspark) ---
# jobs/ingest_orders.py

from pyspark.sql import SparkSession
from forge.lineage import declare_inputs, InputDataset

spark = SparkSession.builder.getOrCreate()

# Explicitly declare the upstream JDBC source so the portal shows the full chain
declare_inputs(spark, [
    InputDataset(
        namespace="mssql://crm-server.database.windows.net/CRM",
        name="dbo.orders",
    )
])

# Read from source, write to bronze
df = (
    spark.read
    .format("jdbc")
    .option("url", "jdbc:sqlserver://crm-server.database.windows.net;databaseName=CRM")
    .option("dbtable", "dbo.orders")
    .load()
)

df.write.format("delta").mode("append").save(
    "abfss://bronze@forgeprodadls.dfs.core.windows.net/crm/orders/"
)
```

**Result in the portal:** The bronze ADLS dataset shows `dbo.orders` from `mssql://crm-server.database.windows.net/CRM` as its upstream source. Following the chain upstream in the portal shows the full SQL Server → bronze → silver → gold path.

### REST API Source Declaration

```python
# Declare an HTTP REST API as the upstream source
declare_inputs(spark, [
    InputDataset(
        namespace="https://api.payments.io/",
        name="/v2/transactions",
    )
])
```

### Multiple Upstream Sources

When an ingest job pulls from multiple tables or endpoints:

```python
declare_inputs(spark, [
    InputDataset(
        namespace="mssql://crm-server.database.windows.net/CRM",
        name="dbo.orders",
    ),
    InputDataset(
        namespace="mssql://crm-server.database.windows.net/CRM",
        name="dbo.order_lines",
    ),
    InputDataset(
        namespace="postgresql://pg-erp.postgres.database.azure.com/ERP",
        name="public.customers",
    ),
])
```

Each declared input appears as a separate upstream node in the portal lineage graph.

---

## 5. OpenLineage Transport Configuration

OpenLineage events are emitted by Airflow tasks and Spark jobs. The events are consumed internally by the portal lineage API — no external lineage backend is used.

#### Airflow (Helm values / environment variables)

```yaml
# infra/helm/orchestration/airflow/values.yaml

env:
  - name: AIRFLOW__LINEAGE__BACKEND
    value: "openlineage.airflow.OpenLineageBackend"
  - name: OPENLINEAGE_NAMESPACE
    value: "forge-{env}"
```

#### Spark (spark-defaults.conf, baked into the Spark image)

```properties
# infra/docker/spark/conf/spark-defaults.conf

spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener

# Namespace
spark.openlineage.namespace=forge-${FORGE_ENV}

# Timeouts (ms) — lineage emission never fails a pipeline
spark.openlineage.transport.timeoutInMillis=10000
```

`FORGE_ENV` is injected as an environment variable in the `SparkApplication` pod spec by the Airflow `SparkKubernetesOperator`.

**Event delivery behaviour:** Events are fire-and-forget. A failure to emit does **not** cause the Airflow task to fail. The failure is logged at WARNING level and the pipeline continues.

---

## 6. OpenLineage Event Structure

### Event Types

Every OpenLineage event has an `eventType` field representing the state of the run:

| Event Type | When Emitted | Meaning |
|-----------|--------------|---------|
| `START` | Run begins | The job has started executing. Inputs are known; outputs may be partially known. |
| `RUNNING` | Mid-run (periodic) | Optional heartbeat. Used by long-running streaming jobs. Contains updated metrics. |
| `COMPLETE` | Run ends successfully | The job finished. Final input/output datasets, row counts, schemas, and custom facets are attached. |
| `FAIL` | Run ends with error | The job failed. Partial output information and the error message are attached. |
| `ABORT` | Run was cancelled | The run was externally terminated. Treated similarly to `FAIL` in the lineage graph. |

A normal Airflow task emits two events: `START` when the task begins, and either `COMPLETE` or `FAIL` when it ends. A streaming job emits `START` once and then periodic `RUNNING` events.

### Event Structure

Every OpenLineage event is a JSON document:

```json
{
  "eventType": "COMPLETE",
  "eventTime": "2026-03-24T14:23:45.123Z",
  "run": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "facets": {
      "nominalTime": { ... },
      "parent": { ... }
    }
  },
  "job": {
    "namespace": "forge-prod",
    "name": "transform_orders",
    "facets": { }
  },
  "inputs": [
    {
      "namespace": "forge-prod",
      "name": "bronze/crm/orders/2026-03-24",
      "facets": {
        "schema": { ... },
        "dataSource": { ... }
      }
    }
  ],
  "outputs": [
    {
      "namespace": "forge-prod",
      "name": "silver/sales/orders",
      "facets": {
        "schema": { ... },
        "columnLineage": { ... },
        "dataQualityMetrics": { ... }
      },
      "outputFacets": {
        "outputStatistics": { "rowCount": 142857, "size": 52428800 }
      }
    }
  ],
  "producer": "https://github.com/OpenLineage/OpenLineage/tree/1.18.0/integration/spark"
}
```

**Field breakdown:**

| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | One of: START, RUNNING, COMPLETE, FAIL, ABORT |
| `eventTime` | ISO 8601 datetime | Timestamp of this event |
| `run.runId` | UUID | Globally unique identifier for this specific execution. Consistent across START → COMPLETE events. |
| `run.facets` | object | Run metadata: duration, error, parent run ID, nominalTime, etc. |
| `job.namespace` | string | Logical grouping. In Forge: `forge-prod` or `forge-dev`. |
| `job.name` | string | Job identifier. For Airflow: `<dag_id>.<task_id>`. For Spark: app name. |
| `inputs` | array | Datasets read by this run, with namespace, name, and facets. |
| `outputs` | array | Datasets written by this run, with namespace, name, and facets. |
| `producer` | URI | Identifies the library that emitted this event. |

### Standard Facets Used in Forge

**Run Facets:**

| Facet | Schema | Contents |
|-------|--------|----------|
| `nominalTime` | standard | The logical run time (DAG execution date). Used for backfill identification. |
| `parent` | standard | Parent run ID and job — links Spark/Trino runs to the Airflow task that triggered them. |
| `errorMessage` | standard | Exception class, message, and stack trace on FAIL events. |
| `externalQuery` | standard | For SQL-based jobs, the full SQL query text. |

**Dataset Facets:**

| Facet | Schema | Contents |
|-------|--------|----------|
| `schema` | standard | Column names, types, and descriptions. |
| `dataSource` | standard | Connection URL or ABFS path of the dataset. |
| `dataQualityMetrics` | standard | Row count, byte size, null counts per column. |
| `columnLineage` | standard | Column-to-column lineage mapping (source columns → output columns). |
| `storage` | standard | File format (delta, parquet), storage layer (ADLS). |
| `lifecycleStateChange` | standard | Whether this was a CREATE, OVERWRITE, APPEND, DROP operation. |

Custom Forge facets (`computeCost`, `dataQuality`) are described in Section 7.

---

## 7. Custom Facets

### Overview

OpenLineage's facet system allows emitters to attach arbitrary structured metadata to events without breaking spec compliance. Custom facets must:

1. Have a unique key in the facets object
2. Include a `_producer` URI identifying the emitter
3. Include a `_schemaURL` URI pointing to a JSON Schema document that validates the facet structure

Forge defines two custom facets: the **DQ facet** (data quality summary) and the **cost facet** (compute cost estimate).

### DQ Facet

**Purpose:** Attach data quality run results to the dataset event for the output dataset of a DQ validation task. This enables the Developer Portal to show DQ status inline with lineage.

**Where it is emitted:** The `forge-lineage` SDK's `LineageReporter` class, called at the end of a `DQRunner.run()` call. Attached to the output dataset facet of the `validate_dq_<entity>` Airflow task's OpenLineage event.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://forge.internal/openlineage/facets/data-quality/v1.json",
  "type": "object",
  "properties": {
    "_producer": { "type": "string", "format": "uri" },
    "_schemaURL": { "type": "string", "format": "uri" },
    "runId": {
      "type": "string",
      "format": "uuid",
      "description": "The DQ run ID, cross-referenceable with the dq_results Delta table."
    },
    "passed": {
      "type": "boolean",
      "description": "True if all CRITICAL rules passed."
    },
    "overallStatus": {
      "type": "string",
      "enum": ["PASSED", "WARNING", "FAILED"],
      "description": "PASSED = all rules passed. WARNING = no CRITICAL failures but WARNING failures exist. FAILED = at least one CRITICAL rule failed."
    },
    "summary": {
      "type": "object",
      "properties": {
        "totalRules": { "type": "integer" },
        "passedRules": { "type": "integer" },
        "failedRules": { "type": "integer" },
        "criticalFailures": { "type": "integer" },
        "warningFailures": { "type": "integer" }
      },
      "required": ["totalRules", "passedRules", "failedRules", "criticalFailures", "warningFailures"]
    },
    "failingRules": {
      "type": "array",
      "description": "Details of failed rules only. Omitted if all rules passed.",
      "items": {
        "type": "object",
        "properties": {
          "ruleId": { "type": "string" },
          "checkType": { "type": "string", "enum": ["schema", "content", "volume", "freshness"] },
          "severity": { "type": "string", "enum": ["CRITICAL", "WARNING", "INFO"] },
          "observedValue": { "type": ["string", "number", "null"] },
          "threshold": { "type": ["string", "number", "null"] },
          "message": { "type": "string" }
        }
      }
    },
    "dqResultsPath": {
      "type": "string",
      "description": "ABFS path to the Delta partition in the dq_results table for this run."
    }
  },
  "required": ["_producer", "_schemaURL", "runId", "passed", "overallStatus", "summary"]
}
```

**Example instance:**

```json
{
  "dataQuality": {
    "_producer": "https://github.com/your-org/forge/tree/main/orchestration/lineage",
    "_schemaURL": "https://forge.internal/openlineage/facets/data-quality/v1.json",
    "runId": "7f3e9a12-4b2c-4d5e-8f6a-1c2d3e4f5a6b",
    "passed": true,
    "overallStatus": "WARNING",
    "summary": {
      "totalRules": 12,
      "passedRules": 11,
      "failedRules": 1,
      "criticalFailures": 0,
      "warningFailures": 1
    },
    "failingRules": [
      {
        "ruleId": "null_rate_order_notes",
        "checkType": "content",
        "severity": "WARNING",
        "observedValue": "0.23",
        "threshold": "0.10",
        "message": "Null rate 0.23 exceeds threshold 0.10 for column order_notes"
      }
    ],
    "dqResultsPath": "abfss://silver@forgeprodadls.dfs.core.windows.net/_platform/dq_results/curated.orders/2026-03-24/"
  }
}
```

This facet is attached to `outputs[0].facets` of the DQ validation task's COMPLETE event. The portal lineage API reads it from the OpenLineage event and surfaces it on the curated dataset node, visible to any consumer navigating the lineage graph.

### Cost Facet

**Purpose:** Record the estimated compute cost of each Spark or Trino job run. Enables the Developer Portal to aggregate pipeline costs from OpenLineage run facets without calling Azure Cost Management for every job.

**Where it is emitted:** The OpenLineage Spark listener computes and attaches this facet to `run.facets` of the COMPLETE event. For Trino queries, the OpenLineage Trino plugin attaches a simplified version.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://forge.internal/openlineage/facets/compute-cost/v1.json",
  "type": "object",
  "properties": {
    "_producer": { "type": "string", "format": "uri" },
    "_schemaURL": { "type": "string", "format": "uri" },
    "currency": { "type": "string", "const": "USD" },
    "estimatedCostUsd": { "type": "number" },
    "breakdown": {
      "type": "object",
      "properties": {
        "driverCostUsd": { "type": "number" },
        "executorCostUsd": { "type": "number" },
        "coordinatorCostUsd": { "type": "number" },
        "workerCostUsd": { "type": "number" }
      }
    },
    "computeDetails": {
      "type": "object",
      "properties": {
        "engine": { "type": "string", "enum": ["spark", "trino"] },
        "driverSkuName": { "type": "string" },
        "executorSkuName": { "type": "string" },
        "executorPriority": { "type": "string", "enum": ["Spot", "OnDemand"] },
        "avgExecutorCount": { "type": "number" },
        "driverDurationSeconds": { "type": "integer" },
        "executorCumulativeSeconds": { "type": "integer" }
      }
    },
    "priceSource": { "type": "string", "enum": ["azure-retail-api", "static-config"] },
    "priceAsOfDate": { "type": "string", "format": "date" }
  },
  "required": ["_producer", "_schemaURL", "currency", "estimatedCostUsd"]
}
```

This facet is attached to `run.facets` because cost is a property of the run, not the dataset.

### Schema Facet

The `schema` facet is a **standard** OpenLineage facet. When the Spark OpenLineage listener observes a write operation, it extracts the output schema from the Spark `StructType` and serializes it into the standard `schema` facet format:

```json
{
  "schema": {
    "_producer": "...",
    "_schemaURL": "https://openlineage.io/spec/facets/1-1-1/SchemaDatasetFacet.json",
    "fields": [
      { "name": "order_id", "type": "string", "description": "not null" },
      { "name": "customer_id", "type": "long", "description": "not null" },
      { "name": "order_total_usd", "type": "decimal(18,2)" },
      {
        "name": "line_items",
        "type": "array",
        "fields": [
          { "name": "product_id", "type": "string" },
          { "name": "quantity", "type": "integer" },
          { "name": "unit_price", "type": "decimal(18,2)" }
        ]
      },
      { "name": "created_at", "type": "timestamp", "description": "not null" }
    ]
  }
}
```

Nested struct and array types are recursively serialized. This allows the Developer Portal's schema viewer to display nested Delta schemas accurately.

---

## 8. Column-Level Lineage

### How the Spark OpenLineage Plugin Extracts Column Lineage

The OpenLineage Spark plugin operates on the **analyzed logical plan** — after name resolution but before optimization — to capture the user's intended transformation semantics. It implements a visitor over the plan tree:

```
Analyzed LogicalPlan:

Project [order_id, customer_id, (subtotal + tax) AS order_total_usd]
  └── Filter [status != 'cancelled']
        └── Relation [raw.orders] (FileSourceScanExec)

Column lineage extraction:
1. "order_id"       → AttributeReference → raw.orders.order_id
   → IDENTITY edge: raw.orders.order_id → curated.orders.order_id

2. "customer_id"    → AttributeReference → raw.orders.customer_id
   → IDENTITY edge: raw.orders.customer_id → curated.orders.customer_id

3. "(subtotal+tax)" → BinaryArithmetic(Add)
   → Left: raw.orders.subtotal
   → Right: raw.orders.tax
   → TRANSFORM edge: raw.orders.{subtotal, tax} → curated.orders.order_total_usd
```

For `JOIN` operations, the extractor traces each projected column through the join to its originating relation.

### What Can and Cannot Be Captured

**What it captures:**
- Direct column renames: `col("old_name").alias("new_name")`
- Arithmetic expressions: `col("a") + col("b")`
- String functions: `upper(col("name"))`
- Conditional expressions: `when(condition, col("a")).otherwise(col("b"))`
- Joins where the joining key and projected columns are traceable
- Aggregations: `sum(col("amount"))` — marked as AGGREGATE type
- `CAST` expressions

**What it cannot capture:**
- **Python UDFs:** Opaque to the plan analyser. Output column is marked as `INDIRECT` lineage with no source column resolution. Document UDF column mappings manually in the dataset schema description.
- **`F.expr()` SQL fragments:** Resolution quality depends on expression complexity.
- **Dynamic column names:** `pivot()` or `stack()` with data-driven column names.
- **Cross-session lineage in Spark Connect:** Multi-step transformations across separate Spark actions are tracked independently per action.
- **External enrichment via external API calls:** Custom connectors or Pandas UDFs that bring in data from outside the Spark plan.

When the extractor cannot determine column lineage, it emits a `INDIRECT` transformation type edge with no `input_field`, flagging the gap without recording false lineage.

### Column Lineage in the Portal

The Developer Portal renders column-level lineage as an overlay on the dataset lineage graph. In the Lineage Explorer:

1. Navigate to an asset (e.g., `gold/sales/orders_summary`)
2. Open the **Lineage** tab
3. Toggle **Column lineage** in the view controls
4. Select a column to highlight its upstream ancestry across all dataset hops

Column lineage is derived from the `columnLineage` facets attached to OpenLineage events and surfaced through the portal lineage API.

---

## 9. Impact Analysis

### Problem Statement

When a data engineer needs to change a column in an upstream dataset — rename it, change its type, remove it — they need to know: which downstream datasets, jobs, and consumers will break? With column-level lineage from OpenLineage, this is a forward graph traversal from the changed column.

### Using the Portal for Impact Analysis

The Developer Portal's **Lineage Explorer** provides impact analysis:

**Dataset-level impact:**
1. Open the dataset asset in the Developer Portal (e.g., `silver/sales/orders`)
2. Go to the **Lineage** tab
3. The graph shows upstream (left) and downstream (right) nodes
4. Downstream nodes are exactly the datasets and jobs that will be affected by a change

**Column-level impact:**
1. Open the dataset asset in the Developer Portal
2. Go to the **Lineage** tab → enable **Column-level lineage**
3. Select a specific column (e.g., `order_total_usd`)
4. The portal highlights all downstream columns that derive from this column across all dataset hops

### Portal Use Case — Column Rename

```
1. Engineer opens Dataset Detail for "silver/sales/orders" in the Developer Portal
2. Clicks "Impact Analysis" button
3. Portal lineage API traverses the lineage graph (built from DAG tags + OpenLineage events)
4. Portal renders: 3 downstream datasets, 4 downstream jobs
5. Engineer clicks column "order_total_usd" → column-level view
6. Portal shows: gold/sales/orders_summary.total_usd derives from this column
7. Engineer knows: renaming order_total_usd will break the publish_orders job
   and the gold/sales/orders_summary.total_usd column
```

**Typical traversal depth:** For practical pipeline graphs, depth 3–5 is sufficient to reach all direct consumers. The portal defaults to depth 10 for the full impact analysis view.

---

## 10. Lineage for Streaming Jobs

### Overview

Spark Structured Streaming jobs run as long-lived `SparkApplication` deployments. They do not have a single COMPLETE event — instead, they process data continuously in micro-batches. OpenLineage handles this via the `RUNNING` event type and streaming-specific run facets.

### How Events Are Emitted for Micro-Batches

```
Streaming SparkApplication starts
        │  → OpenLineage emits START event
        │    run.facets.streaming: { isStreaming: true, trigger: "30s" }
        │    inputs: [EventHub topic or Blob source descriptor]
        │    outputs: [target Delta table ABFS path]
        ▼
Micro-batch 0 completes
        │  → OpenLineage emits RUNNING event
        │    run.runId: same UUID (persists for lifetime of stream)
        │    run.facets.streamingRunFacet:
        │      batchId: 0, rowsWritten: 4523, bytesRead: 1_048_576
        │
        │  ... emitted every 10 micro-batches (approx every 5 minutes)
        │      to avoid generating excessive individual batch events
        ▼
Stream receives SIGTERM (graceful) or crashes
        │  → COMPLETE or FAIL event with final metrics
```

### Streaming Lineage in the Portal

Streaming jobs appear in the portal lineage graph as a single asset with a single run node (the long-running stream). The run state remains `RUNNING` until the stream stops. The Developer Portal shows:

- The streaming job in the lineage graph connecting the event source to the curated Delta table
- The current batch ID and last-event time (from the most recent RUNNING facet)
- A "streaming" badge on the job node to distinguish from batch jobs
- Micro-batch metrics in the pipeline detail page (rows/second, bytes/second trend)

Schema evolution in the streaming output is tracked by dataset versions in the portal: each time the stream writes a micro-batch with a changed schema, a new dataset version is recorded.

---

## 11. Lineage Retention

### Retention Policy

Forge retains lineage data according to the following settings:

| Data Type | Retention | Notes |
|-----------|-----------|-------|
| Asset records (datasets, jobs) | Indefinite | Dataset and job nodes are kept permanently for ongoing impact analysis |
| Run records | 1 year (active) | Active runs visible in the portal lineage graph; older runs archived to ADLS |
| Column lineage edges | 1 year (active) | Current version edges always retained; historical edges archived after 1 year |
| Schema versions | 10 most recent per dataset | Older versions are archived to ADLS lineage archive |
| Custom facets | 1 year (inline) | DQ facets and cost facets retained for 1 year; archived to ADLS thereafter |

### ADLS Lineage Archive

For compliance and audit requirements beyond 1 year, run facets and historical schema versions are archived to ADLS:

```
abfss://silver@forgeprodadls.dfs.core.windows.net/_platform/lineage_archive/
├── run_facets/
│   └── year=2025/month=03/
│       └── run_facets_2025-03.ndjson.gz
├── dataset_versions/
│   └── year=2025/month=03/
│       └── dataset_versions_2025-03.ndjson.gz
└── column_lineage/
    └── year=2025/month=03/
        └── column_lineage_2025-03.ndjson.gz
```

Azure Storage lifecycle management policies on the `silver` container retain `_platform/lineage_archive/` objects for 2 years before permanent deletion.

The archive is queryable directly with Spark or Trino for compliance audits.

---

## 12. Viewing Lineage in the Portal

### Navigating to a Gold Asset

1. Open the Developer Portal and sign in with your Azure AD account
2. In the left navigation, select **Lineage**
3. Search for the gold dataset name (e.g., `orders_summary`)
4. Select the asset from the results — its **Asset detail** page opens

### Viewing the Lineage Graph

1. On the asset detail page, click the **Lineage** tab
2. The lineage graph renders with the selected asset in the centre
3. **Upstream** (left side): shows the complete chain from source systems through bronze and silver to this gold asset
4. **Downstream** (right side): shows any consumers that read this asset (Trino queries, other Spark jobs)

**Navigation in the graph:**

| Action | How |
|--------|-----|
| Expand a node's upstream | Click the **◄** arrow on the left edge of any node |
| Expand a node's downstream | Click the **►** arrow on the right edge of any node |
| Open an asset's detail | Click on a dataset node in the graph |
| Open a job's run history | Click on a job node in the graph |
| Switch to column-level view | Toggle **Column-level lineage** in the view controls (top right) |
| Filter to a specific column | Click a column name in the left panel after enabling column-level lineage |
| Reset the view | Click **Reset** in the graph toolbar |
| Export as image | Use the export button in the graph toolbar |

### Verifying Full Upstream Chain

To confirm that ingest jobs are correctly declaring their upstream source systems:

1. Navigate to a bronze asset (e.g., `bronze/crm/orders/2026-03-24`)
2. Open the **Lineage** tab
3. Click the upstream **◄** arrow
4. If upstream source naming is correctly configured, you should see a source system node (e.g., `mssql://crm-server.database.windows.net/CRM / dbo.orders`)
5. If the upstream node shows only the bronze asset with no parent, the ingest job is not declaring its upstream inputs — see [Section 4](#4-upstream-source-naming-convention)

### Checking Lineage Event Delivery

If a pipeline has run but lineage is not appearing in the portal:

```bash
# Check Airflow OpenLineage transport config
kubectl exec -n airflow deploy/airflow-scheduler -- \
  env | grep -E "OPENLINEAGE|AIRFLOW__LINEAGE"

# Check Airflow task logs for OpenLineage transport errors
kubectl logs -n airflow <task-pod-name> | grep -i "openlineage"
```

If lineage events are being emitted but the graph is not updating in the portal, check the portal lineage API logs for parsing errors against the DAG tags.

---

## Full Lineage Event Flow

```
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║                         LINEAGE EVENT FLOW                                           ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝

  EMITTERS                          EVENTS                     CONSUMER
  ─────────                         ──────                     ────────

  forge-orchestration cluster:
  ┌────────────────────────────┐
  │  Airflow                   │
  │  ┌──────────────────────┐  │
  │  │ ingest_raw_orders    │──┼──START event────────────────────►┐
  │  │ (task START event)   │  │                                  │
  │  └──────────────────────┘  │                                  │
  │  ┌──────────────────────┐  │                                  │
  │  │ ingest_raw_orders    │──┼──COMPLETE event─────────────────►│
  │  │ (task COMPLETE event)│  │                                  │
  │  └──────────────────────┘  │                                  │
  └────────────────────────────┘                                  │
                                                                  │
  forge-compute cluster:                                          │
  ┌────────────────────────────┐                                  │
  │  Spark Job                 │                                  │
  │  OpenLineage Spark Listener│                                  │
  │  ┌──────────────────────┐  │                                  ▼
  │  │ SparkContext init    │──┼──START event────────────►┌─────────────────────────┐
  │  └──────────────────────┘  │                          │  Portal lineage API      │
  │  ┌──────────────────────┐  │                          │  (internal consumer)     │
  │  │ DataFrame.write()    │  │                          │                          │
  │  │ - input datasets     │  │                          │  Reads DAG tags:         │
  │  │ - output datasets    │──┼──COMPLETE event─────────►│  source: / output:       │
  │  │ - column lineage     │  │                          │                          │
  │  │ - schema facets      │  │                          │  Builds lineage graph:   │
  │  │ - cost facet         │  │                          │  assets, processes,      │
  │  └──────────────────────┘  │                          │  column lineage,         │
  └────────────────────────────┘                          │  schema versions,        │
                                                          │  custom facets           │
  ┌────────────────────────────┐                          │                          │
  │  DQ Runner                 │                          └────────────┬─────────────┘
  │  (Airflow task pod)        │                                       │
  │  LineageReporter           │                                       ▼
  │  ┌──────────────────────┐  │                          ┌─────────────────────────┐
  │  │ DQ COMPLETE event    │──┼──DQ facet attached──────►│  Developer Portal        │
  │  │ with dataQuality     │  │                          │  portal-api FastAPI       │
  │  │ facet on output      │  │                          │                          │
  │  │ dataset              │  │                          │  Rendered in Portal:     │
  │  └──────────────────────┘  │                          │  Lineage Explorer        │
  └────────────────────────────┘                          │  Dataset Detail          │
                                                          │  Impact Analysis         │
                                                          └─────────────────────────┘
```
