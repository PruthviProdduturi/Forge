# Forge — Lineage Architecture

> **Version:** 1.0
> **Status:** Current
> **Audience:** Platform engineers, data engineers, architects

---

## Table of Contents

1. [OpenLineage Protocol](#1-openlineage-protocol)
2. [Automatic Emission Points](#2-automatic-emission-points)
3. [Custom Facets](#3-custom-facets)
4. [Marquez Internals](#4-marquez-internals)
5. [Lineage Graph Model](#5-lineage-graph-model)
6. [Column-Level Lineage Extraction](#6-column-level-lineage-extraction)
7. [Impact Analysis](#7-impact-analysis)
8. [Marquez Web UI](#8-marquez-web-ui)
9. [Lineage for Streaming Jobs](#9-lineage-for-streaming-jobs)
10. [Lineage Retention](#10-lineage-retention)
11. [Full Lineage Event Flow and Graph Model](#11-full-lineage-event-flow-and-graph-model)

---

## 1. OpenLineage Protocol

### Overview

OpenLineage is an open standard for collecting lineage metadata from data pipelines. Its core design principle is **emission at the source**: every tool that reads or writes data emits a structured event describing what it did. These events are collected by a backend (in Forge: Marquez) and assembled into a lineage graph.

The standard is defined at [openlineage.io](https://openlineage.io). Forge uses version 1.x of the specification. The Forge components that emit events (Airflow, Spark, Trino) all use the official OpenLineage client libraries, ensuring the events are spec-compliant and backend-portable.

### Event Types

Every OpenLineage event has an `eventType` field that represents the current state of the run producing the event:

| Event Type | When Emitted | Meaning |
|-----------|--------------|---------|
| `START` | Run begins | The job has started executing. Inputs are known; outputs may be partially known or speculative. |
| `RUNNING` | Mid-run (periodic) | Optional heartbeat. Used by long-running streaming jobs to indicate the job is still active. Contains updated metrics. |
| `COMPLETE` | Run ends successfully | The job finished. Final input/output datasets, row counts, schemas, and custom facets are attached. |
| `FAIL` | Run ends with error | The job failed. Partial output information and the error message are attached. Downstream consumers can see the failure in the graph. |
| `ABORT` | Run was cancelled | The run was externally terminated (e.g., Airflow task killed, manual cancellation). Treated similarly to FAIL in the lineage graph. |

A normal Airflow task emits two events: `START` when the task begins, and either `COMPLETE` or `FAIL` when it ends. A streaming job emits `START` once and then periodic `RUNNING` events, followed by `COMPLETE` or `FAIL` when the stream is stopped or crashes.

### Event Structure

Every OpenLineage event is a JSON document. The top-level structure:

```json
{
  "eventType": "COMPLETE",
  "eventTime": "2026-03-24T14:23:45.123Z",
  "run": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "facets": {
      "...run facets..."
    }
  },
  "job": {
    "namespace": "forge-prod",
    "name": "transform_orders",
    "facets": {
      "...job facets..."
    }
  },
  "inputs": [
    {
      "namespace": "forge-prod",
      "name": "raw.orders.2026-03-24",
      "facets": {
        "...dataset facets..."
      }
    }
  ],
  "outputs": [
    {
      "namespace": "forge-prod",
      "name": "curated.orders",
      "facets": {
        "...dataset facets..."
      },
      "outputFacets": {
        "...output-specific facets..."
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
| `eventTime` | ISO 8601 datetime | Timestamp of this event (not the run start time) |
| `run.runId` | UUID | Globally unique identifier for this specific execution of the job. Consistent across START → COMPLETE events for the same run. |
| `run.facets` | object | Key-value map of run facets (metadata about the run: duration, error, parent run ID, etc.) |
| `job.namespace` | string | Logical grouping of jobs. In Forge: `forge-prod` or `forge-dev`. |
| `job.name` | string | Human-readable job name. For Airflow: `<dag_id>.<task_id>`. For Spark: configured via `spark.openlineage.job.name`. |
| `job.facets` | object | Key-value map of job facets (metadata about the job definition: SQL, source code location). |
| `inputs` | array | List of datasets read by this run. Each has namespace, name, and optional facets. |
| `outputs` | array | List of datasets written by this run. Each has namespace, name, and optional facets. |
| `producer` | URI | Identifies the library/integration that emitted this event. Used for provenance. |

### Standard Facets

OpenLineage defines a set of standard facets that emitters can attach. The ones used in Forge:

**Run Facets:**

| Facet | Schema | Contents |
|-------|--------|----------|
| `nominalTime` | standard | The nominal/logical run time (e.g., DAG execution date), distinct from wall-clock start time. Used for backfill identification. |
| `parent` | standard | The parent run ID and job — used by Spark/Trino to link to the Airflow task run that triggered them. Enables the complete lineage from Airflow task → Spark job → datasets. |
| `errorMessage` | standard | Exception class, message, and stack trace on FAIL events. |
| `externalQuery` | standard | For SQL-based jobs, the full SQL query text. |

**Dataset Facets:**

| Facet | Schema | Contents |
|-------|--------|----------|
| `schema` | standard | Column names, types, and descriptions. |
| `dataSource` | standard | Connection URL or ABFS path of the dataset. |
| `dataQualityMetrics` | standard | Row count, byte size, null counts per column (from OpenLineage Spark integration). |
| `columnLineage` | standard | Column-to-column lineage mapping (source columns → output columns). |
| `storage` | standard | File format (delta, parquet), storage layer (ADLS). |
| `lifecycleStateChange` | standard | Whether this was a CREATE, OVERWRITE, APPEND, DROP operation. |

Custom Forge facets (`computeCost`, `dataQuality`) are described in Section 3.

### Transport

All OpenLineage events are sent as **HTTP POST** requests to the Marquez API:

```
POST http://marquez-api.lineage.svc.cluster.local:5000/api/v1/lineage
Content-Type: application/json
Authorization: Bearer <internal service token>

{ ...OpenLineage event JSON... }
```

The Marquez URL is configured in each emitter:

- **Airflow:** `AIRFLOW__OPENLINEAGE__TRANSPORT` environment variable: `{"type": "http", "url": "http://marquez-api.lineage.svc.cluster.local:5000", "endpoint": "/api/v1/lineage"}`
- **Spark:** `spark.openlineage.transport.type = http` and `spark.openlineage.transport.url` in `spark-defaults.conf`
- **Trino:** `openlineage.transport.type = http` in the OpenLineage plugin configuration

Events are sent synchronously from the emitter. If Marquez is unreachable, the emitter logs a warning and the job continues — lineage emission is never allowed to fail a pipeline. The transport includes a 5-second connection timeout and a 10-second read timeout. Failed events are not retried by the emitter (Marquez's idempotent event ingestion means replaying events is safe if a retry mechanism is added in future).

---

## 2. Automatic Emission Points

### Airflow OpenLineage Provider

The Airflow image (`forgeacr/airflow:2.9.3`) includes the `openlineage-airflow` package (version 1.18.0). When installed, this package installs an Airflow plugin that hooks into the Airflow task lifecycle via `TaskInstanceStateChangedCallback`:

```
Airflow Scheduler
        │
        │  Task state change: RUNNING
        ▼
OpenLineage Airflow Plugin
        │  Constructs OpenLineage START event:
        │  - job.namespace: forge-prod
        │  - job.name: <dag_id>.<task_id>
        │  - run.runId: UUID derived from Airflow run_id + task_id
        │  - run.facets.nominalTime: dag execution_date
        │  - inputs: extracted from operator class (e.g. SparkKubernetesOperator
        │    reports the ABFS paths configured in the SparkApplication spec)
        │  - outputs: extracted from operator class
        ▼
HTTP POST → Marquez API

        │  Task completes (COMPLETE or FAILED)
        ▼
OpenLineage Airflow Plugin
        │  Constructs OpenLineage COMPLETE/FAIL event:
        │  - run.runId: same UUID as START
        │  - inputs/outputs: final, with schema facets
        │  - run.facets.errorMessage: (on FAIL)
        ▼
HTTP POST → Marquez API
```

**Operator-specific lineage extraction:**

The OpenLineage Airflow provider includes operator extractors — classes that know how to extract input/output dataset information from specific Airflow operator types. The extractors used in Forge:

| Operator | Extractor Behaviour |
|----------|---------------------|
| `SparkKubernetesOperator` | Reads the `SparkApplication` spec and extracts `mainApplicationFile` path as the code input and reports dataset I/O from the associated Spark run's OpenLineage events (via `parent` facet linking) |
| `PythonOperator` | No automatic dataset extraction; pipeline authors add `@task` with explicit `inlets` and `outlets` decorators where needed |
| `TrinoOperator` (custom) | SQL is parsed and table references extracted; mapped to ADLS paths via Hive Metastore lookup |

Every DAG task emits lineage regardless of whether the operator extractor can determine the exact input/output datasets. At minimum, the job (task) node is created in Marquez, and can be linked to datasets manually or via child runs.

### Spark OpenLineage Integration

The Spark image includes `openlineage-spark-1.18.0.jar`. This JAR registers a `SparkListener` implementation (`OpenLineageSparkListener`) configured via `spark.extraListeners` in `spark-defaults.conf`. The listener is active for both Spark Operator batch jobs and the Spark Connect server.

The listener hooks into:

```
SparkContext initialisation
        │  → emits START event
        │    job.name from spark.openlineage.job.name (or app name)
        │    run.runId: UUID generated at SparkContext start
        │    run.facets.parent: Airflow run ID (passed as spark.openlineage.parentRunId
        │                        env var by SparkKubernetesOperator)
        ▼

SparkContext.runJob() / DataFrame.write (physical plan execution)
        │  → listener receives SparkListenerJobStart
        │    extracts logical plan via the plan node extractor
        │    identifies input datasets (ABFS paths read by FileScan nodes)
        │    identifies output datasets (ABFS paths written by Write nodes)
        │    extracts column lineage (see Section 6)
        │    builds schema facets from Spark StructType
        ▼

SparkContext termination / job completion
        │  → emits COMPLETE event with:
        │    - final input/output dataset list with schema + storage facets
        │    - dataQualityMetrics facet (row counts from WriteTaskMetrics)
        │    - columnLineage facets on output datasets
        │    - computeCost facet (see Section 3)
        ▼

HTTP POST → Marquez API
```

The Spark integration emits one OpenLineage run per `SparkApplication` (for batch jobs). For Spark Connect sessions, each `DataFrame.write` or explicit action triggers a lineage event scoped to that operation.

The `parent` run facet is critical: it links the Spark run to the Airflow task run that submitted it. This allows the lineage graph to show the complete chain: Airflow DAG run → Airflow task → Spark job → input datasets → output datasets.

### Trino OpenLineage Plugin

The Trino image includes `openlineage-trino-1.18.0.jar`, loaded as a Trino event listener plugin. The plugin is configured in `/etc/trino/trino-event-listener.properties`:

```properties
event-listener.name=openlineage
openlineage.transport.type=http
openlineage.transport.url=http://marquez-api.lineage.svc.cluster.local:5000
openlineage.transport.endpoint=/api/v1/lineage
openlineage.namespace=forge-prod
```

The Trino event listener API (`QueryCreatedEvent`, `QueryCompletedEvent`) fires for every query execution. The OpenLineage plugin:

1. Receives `QueryCreatedEvent` → emits `START` event with the query text in `run.facets.externalQuery`
2. Parses the Trino SQL query AST to extract referenced table names (catalog.schema.table)
3. Maps table names to ADLS paths via the Trino connector's metadata layer
4. Receives `QueryCompletedEvent` → emits `COMPLETE` or `FAIL` event with:
   - Input datasets: all tables scanned (with row count from query stats)
   - Output datasets: tables written (for `CREATE TABLE AS SELECT` and `INSERT INTO`)
   - Schema facets from Trino column metadata
   - Query duration and bytes processed in run facets

For `SELECT` queries (read-only), Trino emits lineage with inputs only and no outputs. This allows the lineage graph to show which Trino queries are reading which serving-zone tables, making impact analysis more complete.

---

## 3. Custom Facets

### Overview

OpenLineage's facet system allows emitters to attach arbitrary structured metadata to events without breaking spec compliance. Custom facets must:
1. Have a unique key in the facets object
2. Include a `_producer` URI identifying the emitter
3. Include a `_schemaURL` URI pointing to a JSON Schema document that validates the facet structure

Forge defines two custom facets: the **DQ facet** (data quality summary) and the **cost facet** (compute cost estimate).

### DQ Facet

**Purpose:** Attach data quality run results to the dataset event for the output dataset of a DQ validation task. This enables the Marquez lineage graph and the Developer Portal to show DQ status inline with lineage, without needing a separate API call to the DQ results table.

**Where it is emitted:** The `forge-lineage` SDK's `LineageReporter` class, called at the end of a `DQRunner.run()` call. It is attached to the output dataset facet of the `validate_dq_<entity>` Airflow task's OpenLineage event.

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

This facet is attached to the `outputs[0].facets` of the DQ validation task's COMPLETE event. In Marquez, it is stored as a dataset version facet on the curated dataset node, visible to any consumer querying the lineage graph.

### Cost Facet

**Purpose:** Record the estimated compute cost of each Spark or Trino job run, attached directly to the lineage event. Enables the Developer Portal to aggregate pipeline costs from Marquez without calling Azure Cost Management for every job.

**Where it is emitted:** The OpenLineage Spark listener (`OpenLineageSparkListener`) computes and attaches this facet to the `run.facets` object of the COMPLETE event. For Trino queries, the OpenLineage Trino plugin attaches a simplified version.

**Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://forge.internal/openlineage/facets/compute-cost/v1.json",
  "type": "object",
  "properties": {
    "_producer": { "type": "string", "format": "uri" },
    "_schemaURL": { "type": "string", "format": "uri" },
    "currency": {
      "type": "string",
      "description": "ISO 4217 currency code. Always USD in Forge.",
      "const": "USD"
    },
    "estimatedCostUsd": {
      "type": "number",
      "description": "Total estimated cost in USD for this run."
    },
    "breakdown": {
      "type": "object",
      "properties": {
        "driverCostUsd": { "type": "number" },
        "executorCostUsd": { "type": "number" },
        "coordinatorCostUsd": { "type": "number", "description": "Trino coordinator share only." },
        "workerCostUsd": { "type": "number", "description": "Trino worker share only." }
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
    "priceSource": {
      "type": "string",
      "description": "Source of VM pricing used in calculation.",
      "enum": ["azure-retail-api", "static-config"]
    },
    "priceAsOfDate": {
      "type": "string",
      "format": "date",
      "description": "The date the price was last updated from the source."
    }
  },
  "required": ["_producer", "_schemaURL", "currency", "estimatedCostUsd"]
}
```

This facet is attached to `run.facets` (not `inputs` or `outputs` facets) because cost is a property of the run, not the dataset.

### Schema Facet

The `schema` facet is a **standard** OpenLineage facet (not custom), but its population from Spark's internal types deserves description.

When the Spark OpenLineage listener observes a `WriteToHadoopFsRelation`, `AppendData`, `OverwriteByExpression`, or `CreateTableAsSelect` logical plan node, it extracts the output schema from the node's `schema` attribute, which is a Spark `StructType`:

```scala
// Spark StructType example
StructType([
  StructField("order_id", StringType(), nullable=False),
  StructField("customer_id", LongType(), nullable=False),
  StructField("order_total_usd", DecimalType(18, 2), nullable=True),
  StructField("line_items", ArrayType(
    StructType([
      StructField("product_id", StringType(), nullable=False),
      StructField("quantity", IntegerType(), nullable=False),
      StructField("unit_price", DecimalType(18, 2), nullable=False)
    ])
  ), nullable=True),
  StructField("created_at", TimestampType(), nullable=False)
])
```

The OpenLineage Spark plugin serializes this `StructType` into the standard `schema` facet format:

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

Nested struct and array types are recursively serialized into the `fields` array of the parent field. This allows the Developer Portal's schema viewer to display nested Delta schemas accurately, including array-of-struct patterns common in event data.

---

## 4. Marquez Internals

### Components

Marquez consists of two services deployed in the `lineage` namespace of the `forge-orchestration` cluster:

```
lineage namespace
├── marquez-api  (Deployment, 1 replica)
│   └── Java (Spring Boot) application
│       Port 5000: OpenLineage event ingestion + REST API
│       Port 5001: Admin (health, metrics)
│
└── marquez-web  (Deployment, 1 replica)
    └── React SPA served by Nginx
        Port 3000: Web UI (internal only)
```

Both services are backed by the shared PostgreSQL Flexible Server instance, using a dedicated database named `marquez_db`.

### API Server

The `marquez-api` process exposes two categories of endpoints:

**OpenLineage ingestion endpoint:**
```
POST /api/v1/lineage
```
This is the target for all emitters (Airflow, Spark, Trino). It accepts an OpenLineage event JSON body and:
1. Validates the event structure against the OpenLineage spec
2. Upserts `job`, `run`, `dataset`, and `dataset_version` records in PostgreSQL
3. Creates or updates lineage edges (job_input, job_output) in the graph tables
4. Stores all facets as JSONB in the appropriate facet tables
5. Returns HTTP 200 on success

**REST API for consumers (portal, lineage explorer):**
```
GET  /api/v1/namespaces
GET  /api/v1/namespaces/{namespace}/jobs
GET  /api/v1/namespaces/{namespace}/jobs/{job}
GET  /api/v1/namespaces/{namespace}/jobs/{job}/runs
GET  /api/v1/namespaces/{namespace}/datasets
GET  /api/v1/namespaces/{namespace}/datasets/{dataset}
GET  /api/v1/namespaces/{namespace}/datasets/{dataset}/versions
GET  /api/v1/lineage?nodeId=dataset:<ns>:<name>&depth=3&withDownstream=true
```

The `/api/v1/lineage` endpoint is the most important for the portal — it performs a graph traversal from a given node ID up to a configurable depth, returning all upstream and downstream nodes and edges. This is used for lineage visualization and impact analysis.

### Event Ingestion Pipeline

When Marquez receives a `POST /api/v1/lineage` event:

```
HTTP request received
        │
        │  Deserialization: JSON → OpenLineageEvent POJO
        │  Validation: required fields, eventType enum, ISO 8601 timestamps
        ▼
OpenLineageServiceFactory dispatches to handler by eventType
        │
        ├── START / RUNNING → RunTransitionService.toRunning()
        │     Upserts: job, run (state=RUNNING), run_args
        │     Creates: job_versions_io_mapping (input/output dataset references)
        │
        ├── COMPLETE → RunTransitionService.toComplete()
        │     Upserts: job, run (state=COMPLETED), run_args
        │     Upserts: dataset_versions for all outputs (schema extracted from facets)
        │     Updates: dataset.current_version_uuid
        │     Creates: job_versions_io_mapping (final, with schema)
        │     Stores: all facets as JSONB in run_facets, dataset_facets tables
        │
        └── FAIL / ABORT → RunTransitionService.toFailed() / toAborted()
              Same as COMPLETE but run state = FAILED / ABORTED
              No dataset_version update (output dataset not considered updated)
        │
        ▼
PostgreSQL write (single transaction per event)
        │
        ▼
HTTP 200 returned to emitter
```

The entire event is processed synchronously. Marquez does not use a message queue — events are committed to PostgreSQL before the HTTP response is returned. This provides strong consistency: if the POST returns 200, the event is durably stored.

### Lineage Graph Storage in PostgreSQL

Marquez's PostgreSQL schema implements a directed graph where:
- **Nodes** are either `jobs` or `datasets`
- **Edges** are expressed via the `job_versions_io_mapping` table

Key tables:

```sql
-- Namespaces (logical groupings)
namespaces (uuid, name, description)

-- Jobs (pipeline tasks, Spark apps, Trino queries)
jobs (uuid, namespace_uuid, name, description, current_version_uuid)

job_versions (uuid, job_uuid, version, created_at, location)

-- Edges: which datasets are inputs/outputs of which job version
job_versions_io_mapping (
  uuid,
  job_version_uuid,
  dataset_uuid,
  io_type   -- 'INPUT' or 'OUTPUT'
)

-- Datasets (ADLS paths, tables, external sources)
datasets (
  uuid,
  namespace_uuid,
  name,            -- e.g. "curated.orders"
  description,
  current_version_uuid,
  last_modified_at
)

dataset_versions (
  uuid,
  dataset_uuid,
  version,         -- UUID, changes on each COMPLETE event that writes this dataset
  fields           -- JSONB: serialized schema from the schema facet
)

-- Runs (individual executions of a job)
runs (
  uuid,
  job_version_uuid,
  run_args_checksum,
  nominal_start_time,
  nominal_end_time,
  current_state    -- RUNNING, COMPLETED, FAILED, ABORTED
)

-- Facets (arbitrary JSON attached to runs or datasets)
run_facets (
  uuid, run_uuid, name, facet JSONB, producer, schema_url, created_at
)

dataset_facets (
  uuid, dataset_uuid, dataset_version_uuid, run_uuid, name,
  facet JSONB, producer, schema_url, created_at
)

-- Column-level lineage
column_lineage (
  uuid,
  output_dataset_version_uuid,
  output_field,
  input_dataset_version_uuid,
  input_field,
  transformation_type,   -- 'IDENTITY', 'TRANSFORM', 'AGGREGATE', 'INDIRECT'
  transformation_description
)
```

**Indexes critical for lineage graph traversal:**

```sql
-- Forward traversal (given a dataset, find downstream jobs and datasets)
CREATE INDEX idx_jvio_dataset_input ON job_versions_io_mapping(dataset_uuid)
  WHERE io_type = 'INPUT';

-- Reverse traversal (given a dataset, find upstream jobs and datasets)
CREATE INDEX idx_jvio_dataset_output ON job_versions_io_mapping(dataset_uuid)
  WHERE io_type = 'OUTPUT';

-- Facet lookup
CREATE INDEX idx_run_facets_run_name ON run_facets(run_uuid, name);
CREATE INDEX idx_dataset_facets_version_name ON dataset_facets(dataset_version_uuid, name);
```

### REST API Endpoints Used by Portal

The Developer Portal's FastAPI backend uses these Marquez endpoints:

| Portal Feature | Marquez Endpoint |
|---------------|-----------------|
| Dataset detail: lineage preview | `GET /api/v1/lineage?nodeId=dataset:forge-prod:curated.orders&depth=2` |
| Lineage Explorer: full graph | `GET /api/v1/lineage?nodeId=...&depth=10&withDownstream=true` |
| Pipeline detail: run history | `GET /api/v1/namespaces/forge-prod/jobs/{job}/runs?limit=20` |
| Dataset detail: version history | `GET /api/v1/namespaces/forge-prod/datasets/{dataset}/versions` |
| Dataset detail: schema | `GET /api/v1/namespaces/forge-prod/datasets/{dataset}/versions` (schema in version facets) |
| Cost page: job costs | `GET /api/v1/namespaces/forge-prod/jobs/{job}/runs` → extract computeCost facets |
| DQ badge: dataset DQ status | `GET /api/v1/namespaces/forge-prod/datasets/{dataset}/versions` → extract dataQuality facets |

---

## 5. Lineage Graph Model

### Nodes

The Marquez lineage graph has two node types:

**Dataset nodes** represent named data stores — ADLS paths, Delta tables, external source tables. A dataset node persists across many runs; it has a current version (the schema and state after the last COMPLETE write event) and a version history.

```
Dataset node: "curated.orders"
├── namespace: forge-prod
├── current_version: version UUID (updated on each successful write)
├── schema (from latest version's schema facet):
│   order_id: string NOT NULL
│   customer_id: long NOT NULL
│   order_total_usd: decimal(18,2)
│   ...
└── facets on current version:
    dataQuality: { overallStatus: "PASSED", ... }
    storage: { format: "delta", location: "abfss://silver@...dfs.../sales/orders/" }
```

**Job nodes** represent data processing units — Airflow tasks, Spark applications, Trino queries. A job node has versions (one per logical change to the job definition) and runs (executions).

```
Job node: "transform_orders"
├── namespace: forge-prod
├── current_version: version UUID
└── runs:
    ├── run 550e8400: COMPLETED, 2026-03-24T14:00:00Z → 14:23:45Z
    │   └── facets: computeCost, nominalTime, parent
    ├── run 550e8401: COMPLETED, 2026-03-23T14:00:00Z → 14:19:22Z
    └── ...
```

### Edges

Edges are directional and connect datasets to jobs (input edge) or jobs to datasets (output edge):

```
[Dataset: raw.orders.2026-03-24] --INPUT--> [Job: transform_orders] --OUTPUT--> [Dataset: curated.orders]
```

Edges are stored per job version, not per run. This means: if the `transform_orders` job reads `raw.orders` and writes `curated.orders`, every run of that job version produces the same edges. The `job_versions_io_mapping` table stores the canonical edge set; the `runs` table records individual executions of that edge set.

### How Column-Level Lineage Edges Are Stored

Column-level lineage is stored in the `column_lineage` table. Each row represents one column-to-column edge:

```
(output_dataset_version, "order_total_usd")
    ← TRANSFORM ←
(input_dataset_version: raw.orders.2026-03-24, "order_total")

Transformation description: "CAST(order_total AS DECIMAL(18,2))"
```

Multiple input columns can map to one output column (for derived/computed columns):

```
(curated.orders version X, "order_total_usd")
    ← AGGREGATE ←
(raw.orders.2026-03-24, "subtotal")
(raw.orders.2026-03-24, "tax")

Transformation description: "subtotal + tax, cast to DECIMAL(18,2)"
```

Column lineage edges are scoped to dataset **versions** (not datasets), because column lineage can change between job versions (e.g., if a transform logic changes). The portal queries column lineage for the current dataset version.

---

## 6. Column-Level Lineage Extraction

### How the Spark OpenLineage Plugin Traverses the Logical Plan

Apache Spark represents query execution internally as a tree of `LogicalPlan` nodes (the unresolved plan) which is then analyzed and optimized into a `SparkPlan`. The OpenLineage Spark plugin's column-level lineage extractor operates on the **analyzed logical plan** — after name resolution but before optimization — to capture the user's intended transformation semantics.

The extractor implements a visitor over the plan tree:

```
Analyzed LogicalPlan tree:

Project [order_id, customer_id, (subtotal + tax) AS order_total_usd]
  └── Filter [status != 'cancelled']
        └── Relation [raw.orders] (FileSourceScanExec)

Column lineage extraction:
1. Visit Project node
2. For each output column expression:
   a. "order_id"          → AttributeReference → traces back to Relation[raw.orders].order_id
      → IDENTITY edge: raw.orders.order_id → curated.orders.order_id

   b. "customer_id"       → AttributeReference → traces back to Relation[raw.orders].customer_id
      → IDENTITY edge: raw.orders.customer_id → curated.orders.customer_id

   c. "(subtotal + tax)"  → BinaryArithmetic Add
      → Left: AttributeReference → raw.orders.subtotal
      → Right: AttributeReference → raw.orders.tax
      → TRANSFORM edge: raw.orders.subtotal + raw.orders.tax → curated.orders.order_total_usd
      → Transformation description: "Add(subtotal, tax)"

3. Filter node does not introduce new columns; it only restricts rows.
4. Relation node maps to input dataset "raw.orders.2026-03-24"
```

The extractor resolves column references through intermediate plan nodes (Filter, Sort, Limit, Repartition) that pass through columns without transformation. It stops recursion when it reaches a `Relation` node (leaf: a data source).

For `JOIN` operations:

```
Project [a.order_id, b.customer_email, a.order_total_usd + 0 AS order_total_usd]
  └── Join [a.customer_id = b.customer_id] (INNER)
        ├── Relation [curated.orders AS a]
        └── Relation [curated.customers AS b]

Column lineage:
  curated.enriched_orders.order_id           ← IDENTITY ← curated.orders.order_id
  curated.enriched_orders.customer_email     ← IDENTITY ← curated.customers.customer_email
  curated.enriched_orders.order_total_usd    ← IDENTITY ← curated.orders.order_total_usd
```

### Limitations

The column-level lineage extractor has known limitations:

**What it can capture:**
- Direct column renames: `col("old_name").alias("new_name")`
- Arithmetic expressions: `col("a") + col("b")`
- String functions: `upper(col("name"))`
- Conditional expressions: `when(condition, col("a")).otherwise(col("b"))`
- Joins where the joining key and projected columns are traceable
- Aggregations: `sum(col("amount"))` → marks as AGGREGATE type with both source columns
- `CAST` expressions

**What it cannot capture:**
- **Python UDFs:** A `udf(lambda x: transform(x))` applied to a column is opaque to the plan analyser. The extractor marks the output column as having an `INDIRECT` lineage edge with no source column resolution. The developer must manually document UDF column mappings.
- **SQL string expressions in `expr()`:** If a column is computed via `F.expr("complex_sql_expression")`, the extractor parses this as a SQL fragment but resolution quality depends on the complexity of the expression.
- **Dynamic column names:** Columns generated by `pivot()` or `stack()` where the column names are data-driven are not predictable at plan analysis time.
- **Cross-session lineage in Spark Connect:** When a developer performs multi-step transformations across separate Spark actions (saving intermediate results to temp views), the lineage extractor tracks each action independently. It does not automatically link `tempView_A → tempView_B → final_output` unless the whole operation is a single DataFrame write.
- **External enrichment via external API calls:** Any data brought in via custom connectors or Pandas UDFs is not visible to the Spark plan.

When the extractor cannot determine column lineage for a specific output column, it emits a lineage edge with `transformation_type: "INDIRECT"` and no `input_field`, indicating that the column's provenance is unknown. This prevents false lineage from being recorded while still flagging the gap.

---

## 7. Impact Analysis

### Problem Statement

When a data engineer needs to change a column in an upstream dataset — rename it, change its type, remove it — they need to know: which downstream datasets, jobs, and consumers will break? Without lineage, this requires manual inspection of every pipeline. With column-level lineage in Marquez, this becomes a graph traversal query.

### Graph Traversal Query

Given a starting dataset (e.g., `curated.orders`), the Developer Portal computes all downstream consumers by traversing the lineage graph forward:

```
Starting node: dataset "curated.orders"
        │
        │  Find all OUTPUT edges from this dataset node
        │  (i.e., which jobs have this dataset as an input)
        ▼
Job: "validate_dq_orders" (reads curated.orders)
Job: "publish_serving_orders" (reads curated.orders)
        │
        │  For each job, find all OUTPUT edges
        │  (i.e., which datasets does this job write)
        ▼
Dataset: "serving.orders" (written by publish_serving_orders)
Dataset: "dq_results/curated.orders" (written by validate_dq_orders)
        │
        │  Continue traversal for each newly discovered dataset...
        ▼
Job: "trino_query/ad_hoc_analyst_query" (reads serving.orders)
        │
        │  No further outputs for ad-hoc queries
        ▼
Terminal nodes reached — traversal complete
```

The traversal is implemented as a recursive CTE (Common Table Expression) in PostgreSQL, called by the Marquez `/api/v1/lineage` endpoint:

```sql
WITH RECURSIVE downstream AS (
  -- Anchor: start from the given dataset
  SELECT
    d.uuid,
    d.name,
    'dataset' AS node_type,
    0 AS depth
  FROM datasets d
  WHERE d.namespace_uuid = :namespace_uuid AND d.name = :dataset_name

  UNION ALL

  -- Step 1: find jobs that read this dataset (input edges)
  SELECT
    j.uuid,
    j.name,
    'job' AS node_type,
    ds.depth + 1
  FROM downstream ds
  JOIN job_versions_io_mapping jvio ON jvio.dataset_uuid = ds.uuid AND jvio.io_type = 'INPUT'
  JOIN job_versions jv ON jv.uuid = jvio.job_version_uuid
  JOIN jobs j ON j.uuid = jv.job_uuid
  WHERE ds.node_type = 'dataset' AND ds.depth < :max_depth

  UNION ALL

  -- Step 2: find datasets written by those jobs (output edges)
  SELECT
    d.uuid,
    d.name,
    'dataset' AS node_type,
    ds.depth + 1
  FROM downstream ds
  JOIN job_versions_io_mapping jvio ON jvio.job_version_uuid = (
    SELECT jv2.uuid FROM job_versions jv2 WHERE jv2.job_uuid = ds.uuid
    ORDER BY jv2.created_at DESC LIMIT 1
  ) AND jvio.io_type = 'OUTPUT'
  JOIN datasets d ON d.uuid = jvio.dataset_uuid
  WHERE ds.node_type = 'job' AND ds.depth < :max_depth
)
SELECT DISTINCT uuid, name, node_type, MIN(depth) AS min_depth
FROM downstream
GROUP BY uuid, name, node_type
ORDER BY min_depth, node_type, name;
```

The `depth` parameter defaults to 10 in the portal's impact analysis view (configurable per query). For practical pipeline graphs, depth 3–5 is sufficient to reach all direct consumers.

### Portal Use Case

The Developer Portal's **Lineage Explorer** and **Dataset Detail** pages both surface impact analysis:

**Dataset Detail page:**
- Shows an inline lineage preview (2 hops upstream, 2 hops downstream)
- "Impact Analysis" button triggers a full downstream traversal and lists all downstream datasets, jobs, and last-run status
- Column-level view: select a specific column to see which downstream columns derive from it

**Lineage Explorer (full page):**
- Interactive directed graph rendered with D3.js
- Nodes are clickable (navigate to dataset detail or pipeline detail)
- Edge thickness indicates edge frequency (how many runs have produced this lineage)
- Toggle: dataset-level lineage ↔ column-level lineage overlay
- Search: type a dataset or job name, graph centers on that node

**Typical use case — column rename:**

```
1. Engineer opens Dataset Detail for "curated.orders"
2. Clicks "Impact Analysis"
3. Portal calls: GET /api/v1/lineage?nodeId=dataset:forge-prod:curated.orders&depth=10&withDownstream=true
4. Portal renders: 3 downstream datasets, 4 downstream jobs
5. Engineer clicks column "order_total_usd" in the column-level view
6. Portal queries: column_lineage WHERE input_field = 'order_total_usd' AND input_dataset = 'curated.orders'
7. Portal shows: serving.orders.order_total_usd derives from this column
8. Engineer knows: renaming order_total_usd will break the publish_serving_orders job
   and the serving.orders.order_total_usd column
```

---

## 8. Marquez Web UI

### What It Shows

The Marquez Web UI (`marquez-web`) is a React single-page application that provides a basic lineage graph explorer. It communicates with `marquez-api` via the same REST API used by the Developer Portal.

Pages available in the Marquez Web UI:

| Page | Contents |
|------|----------|
| **Datasets** | List of all datasets in all namespaces; click to see versions and schema |
| **Jobs** | List of all jobs; click to see runs, run status, and linked datasets |
| **Lineage Graph** | Force-directed graph of the full lineage graph; limited to ~50 nodes before performance degrades |
| **Dataset Version** | Schema at a specific version, facets, the run that produced it |
| **Run Detail** | Run facets (nominalTime, errorMessage, computeCost, parent), input/output datasets |

### How It Is Accessed

The Marquez Web UI is **internal only** — it is not exposed via the Application Gateway and has no public URL. It is reachable via:

1. **kubectl port-forward** (operator use): `kubectl port-forward -n lineage svc/marquez-web 3000:3000`
2. **Internal DNS** (within the orchestration cluster): `http://marquez-web.lineage.svc.cluster.local:3000`
3. **Azure Bastion** (for operators on the corporate network who need ad-hoc access)

Day-to-day lineage exploration for data engineers and analysts is done through the Developer Portal, not Marquez Web UI directly. Marquez Web UI is an operator diagnostic tool.

### Limitations vs Developer Portal Lineage Graph

| Capability | Marquez Web UI | Developer Portal |
|-----------|---------------|-----------------|
| Lineage graph visualization | Basic force-directed graph, performance degrades >50 nodes | Optimized D3 rendering, supports large graphs |
| Column-level lineage | Not shown | Overlay toggle in lineage explorer |
| DQ facet display | Raw JSON in run/dataset facets tab | Formatted DQ badge with pass/fail breakdown |
| Cost facet display | Raw JSON | Formatted cost trend charts |
| Pipeline integration | None (Marquez only) | Airflow run status alongside lineage |
| Authentication | None (internal only, trust network) | OIDC via Azure AD |
| Impact analysis | Manual graph traversal | Automated downstream impact report |
| Schema diff between versions | Not available | Version comparison in Dataset Detail |

The Marquez Web UI is the ground truth — it shows exactly what is stored in Marquez without any portal processing. It is valuable for debugging lineage gaps (events not received, incorrect facets) but is not the intended user-facing tool.

---

## 9. Lineage for Streaming Jobs

### Overview

Spark Structured Streaming jobs run as long-lived `SparkApplication` deployments. They do not have a single COMPLETE event — instead, they process data continuously in micro-batches. OpenLineage handles this via the `RUNNING` event type and streaming-specific run facets.

### How Events Are Emitted for Micro-Batches

The Spark OpenLineage listener hooks into `StreamingQueryListener` events:

```
Streaming SparkApplication starts
        │
        │  SparkContext initialised
        ▼
OpenLineage emits START event
  job.name: "stream_ingest_events"
  run.runId: UUID (fixed for the lifetime of this stream)
  run.facets.streaming: { isStreaming: true, trigger: "30s" }
  inputs: [EventHub topic descriptor]
  outputs: [curated.events Delta table]
        │
        │  Micro-batch 0 completes
        ▼
OpenLineage emits RUNNING event
  run.runId: same UUID
  run.facets.streamingRunFacet:
    batchId: 0
    batchStart: "2026-03-24T14:00:00Z"
    batchEnd: "2026-03-24T14:00:30Z"
    rowsWritten: 4523
    bytesRead: 1_048_576
  outputs:
    curated.events:
      outputFacets.outputStatistics:
        rowCount: 4523
        size: 1_048_576
        fileCount: 3
        │
        │  ... repeated every N micro-batches (default: every 10 batches)
        ▼

Streaming job receives SIGTERM (graceful shutdown) or crashes
        │
        ├── Graceful: emits COMPLETE event with final metrics
        └── Crash: emits FAIL event with errorMessage facet
```

**Micro-batch interval for RUNNING events:** To avoid flooding Marquez with a RUNNING event every 30 seconds, the `forge-lineage` integration batches RUNNING events and emits them every 10 micro-batches (approximately every 5 minutes). Each RUNNING event includes aggregated statistics for the N batches since the last RUNNING event.

### Run Facet for Streaming Runs

The `streamingRunFacet` is a Forge custom facet (not yet standardized in OpenLineage spec) that extends streaming run context:

```json
{
  "streamingRunFacet": {
    "_producer": "https://github.com/your-org/forge",
    "_schemaURL": "https://forge.internal/openlineage/facets/streaming-run/v1.json",
    "isStreaming": true,
    "triggerIntervalMs": 30000,
    "checkpointLocation": "abfss://checkpoints@forgeprodadls.dfs.core.windows.net/stream_ingest_events/",
    "currentBatchId": 1440,
    "batchesSinceLastEvent": 10,
    "periodStartBatchId": 1431,
    "periodEndBatchId": 1440,
    "periodStartTime": "2026-03-24T13:55:00Z",
    "periodEndTime": "2026-03-24T14:00:00Z",
    "aggregatedMetrics": {
      "rowsWritten": 45230,
      "bytesRead": 10_485_760,
      "processingTimeMs": 298_000,
      "inputRowsPerSecond": 150.8,
      "processedRowsPerSecond": 25.1
    }
  }
}
```

### Streaming Lineage in the Portal

Streaming jobs appear in the Marquez graph as a single job node with a single run node (the long-running stream). The run state is `RUNNING` until the stream stops. The Developer Portal shows:

- The streaming job in the lineage graph connecting the event source to the curated Delta table
- The current batch ID and last-event time (from the most recent RUNNING facet)
- A "streaming" badge on the job node to distinguish from batch jobs
- Micro-batch metrics in the pipeline detail page (rows/second, bytes/second trend over time)

Schema evolution in the streaming output is tracked by Marquez dataset versions: each time the streaming job writes a micro-batch with a changed schema (new column added via schema evolution), a new dataset version is created and the schema diff is visible in the portal.

---

## 10. Lineage Retention

### How Long Events Are Kept in Marquez PostgreSQL

Marquez stores lineage data indefinitely by default — it has no built-in TTL or purge mechanism. Forge enforces a **1-year active retention policy** in the Marquez PostgreSQL database via a scheduled cleanup job.

**Retention policy:**

| Data Type | Active Retention | Behaviour After Retention Period |
|-----------|-----------------|----------------------------------|
| Run records | 1 year | Archived to ADLS; deleted from PostgreSQL |
| Run facets | 1 year | Archived to ADLS; deleted from PostgreSQL |
| Dataset records | Indefinite | Never deleted (dataset nodes are permanent) |
| Dataset version records | 1 year (beyond latest 10 versions per dataset) | Archived; older versions deleted |
| Column lineage edges | 1 year | Archived; deleted |
| Job records | Indefinite | Never deleted (job nodes are permanent) |

Dataset and job **node** records are kept indefinitely so that the lineage graph structure (which datasets and jobs exist) is always available for impact analysis, even if the run history is trimmed. Only time-series data (runs, run facets, old dataset versions) is subject to the retention window.

### Cleanup Job

The retention cleanup runs as an Airflow DAG (`platform_marquez_cleanup`) on a weekly schedule (Sunday 02:00 UTC):

```python
# orchestration/airflow/dags/platform/marquez_cleanup.py

@dag(schedule="0 2 * * 0", start_date=datetime(2026, 1, 1))
def marquez_cleanup():

    @task
    def archive_old_runs():
        """
        SELECT runs older than 1 year → serialize to NDJSON → write to ADLS archive
        Then DELETE from PostgreSQL.
        """
        cutoff = datetime.utcnow() - timedelta(days=365)
        # Query, serialize, upload to ADLS, delete in batches of 10,000 rows
        ...

    @task
    def archive_old_dataset_versions():
        """
        For each dataset, keep the 10 most recent versions.
        Archive and delete older versions.
        """
        ...

    @task
    def vacuum_postgresql():
        """
        Run VACUUM ANALYZE on large Marquez tables after bulk deletes.
        """
        ...

    archive_old_runs() >> archive_old_dataset_versions() >> vacuum_postgresql()
```

The cleanup queries run in batches to avoid long-running transactions that would block Marquez API operations. Each batch deletes at most 10,000 rows and commits before proceeding to the next batch.

### Archival Strategy to ADLS

Archived lineage data is written to the `curated` container under the `_platform/lineage_archive/` path:

```
abfss://silver@forgeprodadls.dfs.core.windows.net/_platform/lineage_archive/
├── runs/
│   └── year=2025/month=03/
│       └── runs_2025-03.ndjson.gz     ← one file per month, NDJSON format
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

The archive format is NDJSON (newline-delimited JSON), gzip-compressed. Each line is a complete JSON object representing one row from the respective Marquez table, with all columns serialized.

**Archive retrieval:** If historical lineage from more than 1 year ago is needed (e.g., compliance audit), the ADLS archive can be queried directly with Spark or Trino:

```sql
-- Trino: query archived run facets for a specific job in 2025
SELECT *
FROM raw."_platform/lineage_archive/run_facets/year=2025/month=03/run_facets_2025-03.ndjson.gz"
WHERE json_extract_scalar(json, '$.facet.computeCost.estimatedCostUsd') IS NOT NULL
  AND json_extract_scalar(json, '$.run_uuid') IN (
    SELECT run_uuid FROM raw."_platform/lineage_archive/runs/year=2025/month=03/runs_2025-03.ndjson.gz"
    WHERE json_extract_scalar(json, '$.job_name') = 'transform_orders'
  );
```

**Retention for compliance:** Azure Storage lifecycle management policies on the `curated` container retain `_platform/lineage_archive/` objects for 2 years before permanent deletion, satisfying data governance audit requirements.

---

## 11. Full Lineage Event Flow and Graph Model

```
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║                         LINEAGE EVENT FLOW                                           ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝

  EMITTERS                          TRANSPORT                  BACKEND
  ─────────                         ─────────                  ───────

  forge-orchestration cluster:
  ┌────────────────────────────┐
  │  Airflow                   │
  │  ┌──────────────────────┐  │
  │  │ ingest_raw_orders    │──┼──HTTP POST /api/v1/lineage──►┐
  │  │ (task START event)   │  │                              │
  │  └──────────────────────┘  │                              │
  │  ┌──────────────────────┐  │                              │
  │  │ ingest_raw_orders    │──┼──HTTP POST /api/v1/lineage──►│
  │  │ (task COMPLETE event)│  │                              │
  │  └──────────────────────┘  │                              │
  └────────────────────────────┘                              │
                                                              │
  forge-compute cluster:                                    │
  ┌────────────────────────────┐                              │
  │  Spark Job                 │                              │
  │  (SparkApplication pod)    │                              ▼
  │  OpenLineage Spark Listener│                    ┌──────────────────────────┐
  │  ┌──────────────────────┐  │                    │  Marquez API             │
  │  │ SparkContext init    │──┼──START event───────►  marquez-api pod         │
  │  └──────────────────────┘  │                    │  lineage namespace       │
  │  ┌──────────────────────┐  │                    │  orchestration cluster   │
  │  │ DataFrame.write()    │  │                    │                          │
  │  │ Plan traversal:      │  │                    │  ┌─────────────────────┐ │
  │  │  - input datasets    │  │                    │  │ Event ingest pipeline│ │
  │  │  - output datasets   │──┼──COMPLETE event────►  │ (synchronous)       │ │
  │  │  - column lineage    │  │                    │  │ Validates → Upserts  │ │
  │  │  - schema facets     │  │                    │  │ → Returns 200        │ │
  │  │  - cost facet        │  │                    │  └──────────┬──────────┘ │
  │  └──────────────────────┘  │                    │             │             │
  └────────────────────────────┘                    │             ▼             │
                                                    │  ┌─────────────────────┐ │
  ┌────────────────────────────┐                    │  │   PostgreSQL         │ │
  │  Trino                     │                    │  │   marquez_db         │ │
  │  OpenLineage Event Listener│                    │  │                      │ │
  │  ┌──────────────────────┐  │                    │  │  jobs                │ │
  │  │ QueryCreatedEvent    │──┼──START event───────►  │  job_versions        │ │
  │  └──────────────────────┘  │                    │  │  runs                │ │
  │  ┌──────────────────────┐  │                    │  │  run_facets          │ │
  │  │ QueryCompletedEvent  │──┼──COMPLETE event────►  │  datasets            │ │
  │  │  SQL AST parsed      │  │                    │  │  dataset_versions    │ │
  │  │  table refs extracted│  │                    │  │  dataset_facets      │ │
  │  └──────────────────────┘  │                    │  │  job_versions_io_    │ │
  └────────────────────────────┘                    │  │    mapping           │ │
                                                    │  │  column_lineage      │ │
  ┌────────────────────────────┐                    │  └──────────────────────┘ │
  │  DQ Runner                 │                    └──────────────┬─────────────┘
  │  (Airflow task pod)        │                                   │
  │  LineageReporter           │                                   │ REST API
  │  ┌──────────────────────┐  │                                   ▼
  │  │ DQ COMPLETE event    │──┼──DQ facet on dataset──►┌──────────────────────────┐
  │  │ with dataQuality     │  │                        │  Developer Portal        │
  │  │ facet attached to    │  │                        │  portal-api FastAPI       │
  │  │ curated dataset      │  │                        │                          │
  │  └──────────────────────┘  │                        │  GET /api/v1/lineage     │
  └────────────────────────────┘                        │  GET /api/v1/datasets    │
                                                        │  GET /api/v1/jobs/runs   │
                                                        └──────────────────────────┘

═══════════════════════════════════════════════════════════════════════════════════════

  LINEAGE GRAPH MODEL — example: orders pipeline

  [source: crm.Orders]
          │
          │  job: ingest_raw_orders (Airflow DAG run 2026-03-24)
          │    run facets: nominalTime, parent (Airflow run ID)
          ▼
  [dataset: raw.orders.2026-03-24]
    facets: schema, storage, dataSource
          │
          │  job: transform_orders (Spark job, run ID 550e8400)
          │    run facets: nominalTime, parent (ingest_raw_orders run),
          │                computeCost ($1.71), errorMessage (none)
          │
          │  column lineage on output dataset:
          │    raw.orders.order_id         →IDENTITY→    curated.orders.order_id
          │    raw.orders.order_total      →TRANSFORM→   curated.orders.order_total_usd
          │    raw.orders.customer_id      →IDENTITY→    curated.orders.customer_id
          ▼
  [dataset: curated.orders]
    facets: schema, storage, dataQuality (PASSED, 12/12 rules)
          │
          │  job: validate_dq_orders (Airflow DQ task)
          │    run facets: nominalTime
          │    (reads curated.orders, writes DQ results + DQ facet)
          │
          │
          │  job: publish_serving_orders (Trino/Spark)
          │    run facets: nominalTime, computeCost
          ▼
  [dataset: serving.orders]
    facets: schema, storage, dataQuality (pass-through)
          │
          ├──► job: trino_query/portal_preview (read-only, SELECT)
          │        run: COMPLETE, 2.3s, 4.2 MB scanned
          │
          └──► job: trino_query/analyst_ad_hoc (read-only, SELECT)
                   run: COMPLETE, 8.1s, 102 MB scanned

═══════════════════════════════════════════════════════════════════════════════════════

  COLUMN-LEVEL LINEAGE DETAIL

  curated.orders.order_total_usd
          ▲
          │  TRANSFORM (CAST + arithmetic)
          ├── raw.orders.subtotal
          └── raw.orders.tax

  curated.orders.order_id
          ▲
          │  IDENTITY
          └── raw.orders.order_id

  curated.orders.customer_segment   ← computed via Python UDF
          ▲
          │  INDIRECT (UDF — provenance not extractable)
          └── raw.orders.customer_id  (partial, input column known)

═══════════════════════════════════════════════════════════════════════════════════════

  STREAMING LINEAGE MODEL

  [source: EventHub/orders-events topic]
          │
          │  job: stream_ingest_events (long-running SparkApplication)
          │    run state: RUNNING (continuous)
          │    run facets (RUNNING events every 10 micro-batches):
          │      streamingRunFacet:
          │        currentBatchId: 1440
          │        inputRowsPerSecond: 150.8
          │        processedRowsPerSecond: 25.1
          ▼
  [dataset: curated.events]
    (new dataset version created each time schema evolves)

═══════════════════════════════════════════════════════════════════════════════════════

  IMPACT ANALYSIS TRAVERSAL (forward from curated.orders)

  curated.orders
    └── INPUT to → publish_serving_orders
          └── OUTPUT to → serving.orders
                └── INPUT to → trino_query/portal_preview    [terminal]
                └── INPUT to → trino_query/analyst_ad_hoc    [terminal]
                └── INPUT to → spark_ml_feature_pipeline
                      └── OUTPUT to → serving.ml_features    [terminal]
    └── INPUT to → validate_dq_orders
          └── OUTPUT to → _platform/dq_results/curated.orders  [terminal]

  Impact of changing curated.orders.order_total_usd:
    → serving.orders.order_total_usd  (publish_serving_orders transforms this column)
    → ml_feature: customer_ltv_30d    (spark_ml_feature_pipeline uses order_total_usd)
    Downstream breakage risk: HIGH (2 serving datasets, 1 ML pipeline)

═══════════════════════════════════════════════════════════════════════════════════════

  RETENTION FLOW

  Marquez PostgreSQL (active: 1 year)
          │
          │  Weekly cleanup DAG (platform_marquez_cleanup)
          │  Archives runs + facets older than 1 year
          ▼
  ADLS lineage_archive/ (NDJSON.gz, 2-year retention)
  abfss://silver@.../  _platform/lineage_archive/
    runs/year=YYYY/month=MM/
    run_facets/year=YYYY/month=MM/
    dataset_versions/year=YYYY/month=MM/
    column_lineage/year=YYYY/month=MM/
          │
          │  Queryable via Trino or Spark for compliance audits
          ▼
  Azure Storage lifecycle policy → permanent deletion after 2 years
```

---

## 12. Pipeline-Level Lineage Traversal

Pipeline lineage and dataset lineage are two views of the same graph. Forge tracks both, and the Developer Portal exposes both directions of traversal for either starting point.

### The Graph Model — Pipelines and Datasets Together

```
                    PIPELINE VIEW
                    ─────────────

  [ingest_bronze_orders]          ← Airflow DAG (job node)
         │
         │  WRITES TO
         ▼
  [bronze:orders/{date}]          ← Dataset node (Bronze layer)
         │
         │  READ BY
         ▼
  [transform_silver_orders]       ← Airflow DAG (job node)
         │
         │  WRITES TO
         ▼
  [silver:orders]                 ← Dataset node (Silver layer)
         │
         ├── READ BY ──▶  [validate_dq_orders]      ← DQ pipeline
         │                       │
         │                       │  WRITES TO
         │                       ▼
         │               [silver:_platform/dq_results/orders]
         │
         └── READ BY ──▶  [publish_gold_orders]     ← Airflow DAG
                                 │
                                 │  WRITES TO
                                 ▼
                         [gold:orders]               ← Dataset node (Gold layer)
```

Every node in this graph is queryable in both directions.

### Starting from a Pipeline: Find All Data Assets It Touches

Given a pipeline ID (Airflow DAG ID), the portal and Marquez API return:

```
GET /api/v1/lineage/pipeline/{dag_id}

Response:
{
  "pipeline": "transform_silver_orders",
  "inputs": [
    { "namespace": "forge.bronze", "name": "orders", "version": "2026-03-24" }
  ],
  "outputs": [
    { "namespace": "forge.silver", "name": "orders", "version": "5" }
  ],
  "upstream_pipelines": [
    "ingest_bronze_orders"          ← the pipeline that produced the input
  ],
  "downstream_pipelines": [
    "validate_dq_orders",           ← consumes silver:orders
    "publish_gold_orders"           ← consumes silver:orders
  ]
}
```

Use case: "I need to change `transform_silver_orders`. What pipelines will be affected?"

### Starting from a Dataset: Find All Pipelines That Touch It

Given a dataset (namespace + name), the portal returns:

```
GET /api/v1/lineage/dataset/{namespace}/{name}

Response:
{
  "dataset": "forge.silver/orders",
  "produced_by": {
    "pipeline": "transform_silver_orders",
    "last_run": "2026-03-24T06:00:00Z",
    "status": "COMPLETE"
  },
  "consumed_by": [
    { "pipeline": "validate_dq_orders",  "role": "validation" },
    { "pipeline": "publish_gold_orders", "role": "transformation" }
  ],
  "upstream_datasets": [
    "forge.bronze/orders"
  ],
  "downstream_datasets": [
    "forge.gold/orders",
    "forge.silver/_platform/dq_results/orders"
  ]
}
```

Use case: "Who is reading `silver:orders`? If I change its schema, which pipelines break?"

### Full Graph Traversal — Upstream and Downstream

The portal lineage explorer supports full multi-hop traversal in both directions:

```
User selects: silver:orders
Expands upstream (2 hops):
  silver:orders
    ← transform_silver_orders
      ← bronze:orders/{2026-03-24}
        ← ingest_bronze_orders
          ← source:crm_system.dbo.Orders   [root — no further upstream]

Expands downstream (2 hops):
  silver:orders
    → publish_gold_orders
      → gold:orders                        [leaf — consumed by Trino/portal]
    → validate_dq_orders
      → silver:_platform/dq_results/orders [leaf]
```

Depth is configurable (1–10 hops). The default view shows 2 hops in each direction.

### Pipeline Dependency Graph

Airflow DAG dependencies (ExternalTaskSensor) are captured as lineage edges. This means the full execution dependency chain is visible as a lineage graph — not just individual task I/O:

```
ingest_bronze_orders  (daily, 04:00)
        │
        │  triggers (ExternalTaskSensor)
        ▼
transform_silver_orders  (daily, 05:00)
        │
        │  triggers (ExternalTaskSensor)
        ├──▶  validate_dq_orders  (daily, 05:30)
        │            │
        │            │  triggers on DQ pass
        │            ▼
        └──▶  publish_gold_orders  (daily, 06:00)
```

If `ingest_bronze_orders` fails or is delayed, the full downstream chain is visible in the lineage graph — not just in the Airflow UI. The Developer Portal's lineage view can surface this as a "blocked pipeline" state.

### What Is Tracked Per Pipeline Run

Every Airflow DAG run and Spark job submission produces lineage events that capture:

| Field | What it records |
|-------|----------------|
| `run.runId` | Unique run identifier (linked to Airflow DAG run ID) |
| `job.name` | Pipeline name (DAG ID + task ID) |
| `inputs[].name` | Every dataset read (Bronze/Silver/Gold path) |
| `inputs[].facets.schema` | Schema at time of read |
| `outputs[].name` | Every dataset written |
| `outputs[].facets.schema` | Schema at time of write |
| `outputs[].facets.rowCount` | Row count written |
| `run.facets.dq` | DQ run result (pass/warn/fail + rule summary) |
| `run.facets.cost` | Compute cost estimate for this run |
| `run.facets.airflowDagRun` | Airflow DAG run ID, logical date, trigger type |

This means every run is independently traceable — you can find not just which pipelines touch a dataset, but which specific run of a pipeline wrote a specific version of a dataset, what the schema was at that moment, and whether DQ passed.

### Sandbox Data Is Not Tracked

Data written to the `sandbox/` container is **excluded from lineage tracking**. Sandbox paths produce no OpenLineage events. This is intentional — sandbox work is exploratory and untested; tracking it would pollute the lineage graph with noise. When sandbox work is formalised into a pipeline, that pipeline emits lineage from its first production run.
