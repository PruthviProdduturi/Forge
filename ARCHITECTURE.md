# Forge — Platform Architecture

> **Version:** 1.0
> **Status:** Production
> **Audience:** Platform engineers, data engineers, architects

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org) [![Delta Lake](https://img.shields.io/badge/Delta%20Lake-003366?style=flat-square&logo=delta&logoColor=white)](https://delta.io) [![ADLS Gen2](https://img.shields.io/badge/ADLS%20Gen2-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/storage/data-lake-storage)

---

## Table of Contents

1. [Platform Philosophy](#1-platform-philosophy)
2. [System Overview](#2-system-overview)
3. [Dual-Cluster Design](#3-dual-cluster-design)
4. [Lakehouse Architecture](#4-lakehouse-architecture)
5. [Compute Layer](#5-compute-layer)
6. [Orchestration Layer](#6-orchestration-layer)
7. [Data Quality Framework](#7-data-quality-framework)
8. [Lineage Architecture](#8-lineage-architecture)
9. [Observability Stack](#9-observability-stack)
10. [Security & Identity](#10-security--identity)
11. [Networking](#11-networking)
12. [Developer Portal](#12-developer-portal)
13. [Data Flow — End to End](#13-data-flow--end-to-end)
14. [Architecture Decision Records](#14-architecture-decision-records)

---

## 1. Platform Philosophy

Forge is built around four principles:

**Separation of concerns.**
Compute, orchestration, storage, and observability are independently deployed and scaled. A failure in one layer does not cascade into others.

**Everything is governed.**
No data moves between zones without schema validation, DQ checks, and lineage emission. Every pipeline run produces a traceable audit trail.

**Developer experience is first-class.**
Engineers write Spark jobs from VS Code using Spark Connect — no cluster access, no SSH, no port-forwards. Airflow DAGs are Python files in Git. The Developer Portal surfaces everything in one place.

**Infrastructure is code.**
All Azure resources are Bicep-managed. All Kubernetes workloads are Helm-managed and deployed via Azure DevOps Pipelines. Nothing is clicked into existence.

---

## 2. System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Developer Workflow                            │
│                                                                          │
│   VS Code + Spark Connect        Git + DAG files        Portal UI        │
│         │                              │                    │            │
└─────────┼──────────────────────────────┼────────────────────┼────────────┘
          │                              │                    │
          ▼                              ▼                    ▼
┌─────────────────────┐    ┌─────────────────────────────────────────────┐
│   Compute Cluster   │    │            Orchestration Cluster            │
│   (AKS Private)     │    │            (AKS Private)                    │
│                     │    │                                             │
│  ┌───────────────┐  │    │  ┌──────────┐ ┌──────────┐ ┌────────────┐   │
│  │ Spark Operator│  │    │  │ Airflow  │ │Developer │ │  Azure     │   │
│  │ Spark Connect │  │    │  │ (Sched.) │ │  Portal  │ │  Monitor   │   │
│  │ Trino         │  │    │  └──────────┘ └──────────┘ └────────────┘   │
│  └───────────────┘  │    │  ┌──────────┐ ┌──────────┐ ┌────────────┐   │
└─────────────────────┘    │  │  DQ      │ │  Log     │ │  Managed   │   │
          │                │  │ Framework│ │ Analytics│ │  Grafana   │   │
          │                │  └──────────┘ └──────────┘ └────────────┘  │
          │                └─────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        ADLS Gen2 Lakehouse                               │
│                                                                          │
│   ┌─────────────┐      ┌───────────────┐      ┌───────────────────┐      │
│   │  bronze/     │ ──▶ │  silver/       │ ──▶ │  gold/             │     │
│   │  (Delta)     │      │  (Delta Lake) │      │  (Delta Lake)     │     │
│   │  append-only │      │  schema-enf.  │      │  SLA-governed     │     │
│   └─────────────┘      └───────────────┘      └───────────────────┘      │
└──────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────────────────────┐
│    Shared Azure Resources                        │
│  Key Vault │ ACR │ Monitor                       │
│  Private DNS │ Log Analytics │ Microsoft Purview  │
└───────────────────────────────────────────────────┘
```

---

## 3. Dual-Cluster Design

### Why Two Clusters?

A single AKS cluster mixing compute and orchestration creates hidden coupling:

- Spark executors consume node resources unpredictably, starving the Airflow scheduler
- A Spark upgrade requiring node pool changes shouldn't require an Airflow maintenance window
- Security posture differs: compute workers need broad storage access; orchestration workers need narrow API credentials

Forge uses two dedicated private AKS clusters with separate node pools, separate managed identities, and no direct network path between them — all coordination happens through the shared lakehouse and shared Azure services.

### Cluster Specifications

#### `forge-compute` — Compute Cluster

| Node Pool | VM SKU | Dev Min/Max | Prod Min/Max | vCPUs (Prod max) | Purpose |
|-----------|--------|-------------|--------------|------------------|---------|
| `systempool` | Standard_D4s_v5 | 1 / 2 | 2 / 4 | — | Kubernetes system components |
| `sparkpool` | Standard_E8s_v5 | 0 / 3 | 0 / 12 | **96** | Spark driver + executor pods |
| `trinopool` | D4s_v5 (dev) / D8s_v5 (prod) | 0 / 3 | 0 / 10 | 80 | Trino coordinator + workers |

- Azure CNI Overlay networking
- Cluster autoscaler enabled on `sparkpool` and `trinopool`
- Workload identity (OIDC) enabled
- Private API server endpoint
- Node OS: Azure Linux (CBL-Mariner)
- Dev: ~24 usable Spark cores; Prod: 96 usable Spark cores

#### `forge-orchestration` — Orchestration Cluster

Intentionally small — runs steady-state services only (no burst workloads).

| Node Pool | VM SKU | Dev Min/Max | Prod Min/Max | Purpose |
|-----------|--------|-------------|--------------|---------|
| `systempool` | Standard_D4s_v5 | 1 / 2 | 2 / 4 | Kubernetes system components |
| `workerpool` | Standard_D4s_v5 | 1 / 4 | 2 / 10 | Airflow, Portal, statsd-exporter |

- Azure CNI Overlay networking
- Workload identity (OIDC) enabled
- Private API server endpoint
- Node OS: Azure Linux (CBL-Mariner)

### Inter-Cluster Communication

Clusters communicate **only through shared data stores** — never directly:

```
Compute Cluster                     Orchestration Cluster
      │                                      │
      │  writes results to ADLS gold/     │
      ├──────────────────────────────────────▶ ADLS Gen2
      │                                      │
      │  emits OpenLineage events to Purview  │
      ├──────────────────────────────────────▶ Purview OpenLineage endpoint (via private endpoint)
      │                                      │
      │  Airflow submits SparkApplication CRD│
      ◀────────────────────────────────────── kubectl (via AKS private API)
```

Airflow has read-write access to the compute cluster's Kubernetes API server via its kubeconfig (stored in Key Vault) to submit `SparkApplication` CRDs via the `SparkKubernetesOperator`. There is no other cross-cluster path.

---

## 4. Lakehouse Architecture

Forge uses the **Medallion architecture** — Bronze, Silver, Gold — as the organisational model for the ADLS Gen2 lakehouse. Each layer is a dedicated container, with a separate **Sandbox** container for all user experimentation.

### Medallion Layers

```
Source Systems
     │
     │  (ingestion DAGs)
     ▼
┌─────────────────────────────────────────────────────────────┐
│  BRONZE                                                     │
│  abfss://bronze@<account>.dfs.core.windows.net/             │
│                                                             │
│  • Immutable. Append-only. No updates, no deletes.          │
│  • Format: Delta Lake (all sources onboarded as Delta)      │
│  • Partitioned by: year / month / day / hour (UTC)          │
│  • Retention: 2 years (lifecycle policy)                    │
│  • Access: Forge platform only                              │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  │  (Silver transform DAGs — Spark Delta merge)
                  ▼
┌─────────────────────────────────────────────────────────────┐
│  SILVER                                                     │
│  abfss://silver@<account>.dfs.core.windows.net/             │
│                                                             │
│  • Delta Lake format. MERGE (upsert) semantics.             │
│  • Schema enforced. Evolution via ALTER TABLE only.         │
│  • DQ checks required before write succeeds.                │
│  • Partitioned by: year / month / day / hour (UTC)          │
│  • Retention: 2 years (lifecycle policy)                    │
│  • Access: Forge platform + approved internal tooling       │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  │  (Gold publish DAGs — Trino views + Delta optimize)
                  ▼
┌─────────────────────────────────────────────────────────────┐
│  GOLD                                                       │
│  abfss://gold@<account>.dfs.core.windows.net/               │
│                                                             │
│  • Delta Lake format. Optimized (Z-ORDER, VACUUM).          │
│  • SLA-governed: freshness SLAs defined per dataset.        │
│  • Consumer-ready: Trino catalogs, Spark reads, Portal.     │
│  • Partitioned by: year / month / day / hour (UTC)          │
│  • Access: all authenticated consumers                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  SANDBOX                                                    │
│  abfss://sandbox@<account>.dfs.core.windows.net/            │
│                                                             │
│  • Per-user experimentation area. No SLAs. No DQ gates.     │
│  • Path: sandbox/<user-or-team>/<project>/YYYYMMDD/         │
│  • Every user in the platform has read/write to their path  │
│  • No data from Sandbox ever promotes to Bronze/Silver/Gold │
│    automatically — promotion is a deliberate pipeline act   │
│  • Retention: 28 days (lifecycle policy auto-deletes)       │
│  • Access: all platform users (scoped to own path)          │
└─────────────────────────────────────────────────────────────┘
```

### Table Format Strategy

All pipeline outputs — Bronze, Silver, and Gold — are written as **Delta Lake 4.0** tables by default. Iceberg is available as an opt-in format for specific datasets.

**Delta Lake (default):**
- All Bronze, Silver, and Gold writes use Delta unless explicitly overridden
- **MERGE** for upserts (composite business keys, never surrogates)
- **Schema enforcement** — evolution requires explicit `ALTER TABLE ADD COLUMN`
- **Change Data Feed** enabled on all Silver and Gold tables
- **OPTIMIZE + VACUUM** run weekly per table via Airflow maintenance DAGs
- Readable by Spark 4.1, Trino (`lakehouse` catalog), and DuckDB

**Apache Iceberg (opt-in):**
- Available for datasets where Iceberg is required by a consumer or upstream source
- Same ADLS path structure; distinguished by catalog (Trino `iceberg` catalog)
- Spark Iceberg runtime JARs bundled in the Spark image
- Trino Iceberg connector configured alongside Delta connector
- DQ framework and lineage treat Iceberg tables identically to Delta

### Storage Account Layout

```
forge<env>adls (ADLS Gen2, HNS enabled)
├── bronze/                      ← container
│   └── {source_system}/{entity}/{yyyy-mm-dd}/
├── silver/                      ← container
│   └── {domain}/{entity}/       (Delta table root)
├── gold/                        ← container
│   └── {domain}/{entity}/       (Delta table root)
├── sandbox/                     ← container
│   └── {user_alias}/            (per-user free area, 30-day TTL)
├── code/                        ← container
│   └── jobs/, wheels/, jars/
└── checkpoints/                 ← container
    └── {pipeline_id}/           (Spark Structured Streaming checkpoints)
```

---

## 5. Compute Layer

### Apache Spark (Spark Operator + Spark Connect)

Forge runs Spark in two modes:

#### 1. Batch Jobs (Spark Operator)

Batch pipelines submit `SparkApplication` CRDs via the Airflow `SparkKubernetesOperator`. The Spark Operator watches the `spark-jobs` namespace and launches driver + executor pods on the `spark` node pool.

```
Airflow DAG
    │
    │  kubectl apply SparkApplication CRD
    ▼
Spark Operator (forge-compute)
    │
    ├── launches Driver Pod
    │       │
    │       └── requests Executor Pods (dynamic allocation: 2–50)
    │
    └── monitors until Complete/Failed
    │
    ▼
Airflow receives status via SparkKubernetesOperator sensor
```

Key configurations:
- **Dynamic resource allocation**: min 2, max 50 executors per job
- **Spot/preemptible nodes**: executors run on spot instances (with graceful shuffle recovery)
- **Shuffle service**: External Shuffle Service enabled for spot tolerance
- **ADLS access**: via workload identity — no storage keys, no SAS tokens

#### 2. Interactive Development (Spark Connect)

A persistent Spark Connect server runs on the `spark` node pool and is reachable from developers' VS Code environments via internal load balancer. This enables:

- Full Spark DataFrame API from a local Python environment
- PySpark code that runs on the actual cluster — no local Spark installation
- Same ADLS access, same cluster config as production jobs

```
Developer's VS Code (local)
    │
    │  SparkSession.builder.remote("sc://<internal-lb>:15002")
    ▼
Spark Connect Server Pod (forge-compute)
    │
    ├── translates Connect protocol → Spark plan
    └── executes against ADLS Gen2 with workload identity
```

### Trino (Federated SQL)

Trino provides federated SQL across all lakehouse zones and external sources. It runs on dedicated `trino` node pool nodes.

```
┌──────────────────────────────────────┐
│  Trino Coordinator (2 replicas)      │
│  • Query planning and optimization   │
│  • Client authentication via OIDC    │
│  • JVM heap: 24GB                    │
└──────────────┬───────────────────────┘
               │  distributes work to
               ▼
┌──────────────────────────────────────┐
│  Trino Workers (2–8, autoscaled)     │
│  • Query execution                   │
│  • JVM heap: 48GB                    │
│  • Max memory per query: 10GB        │
└──────────────┬───────────────────────┘
               │
               │  queries via connectors
               ▼
┌──────────────────────────────────────────────────────────┐
│  Catalogs                                                │
│  ┌────────────┐  ┌───────────┐  ┌──────────────────────┐ │
│  │ lakehouse  │  │   hive    │  │       tpch           │ │
│  │ (Delta)    │  │  (raw)    │  │   (benchmarking)     │ │
│  │ silver/    │  │ bronze/   │  │                      │ │
│  │ gold/      │  │           │  │                      │ │
│  └────────────┘  └───────────┘  └──────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

Trino is the primary query engine for:
- Serving zone reads (portal, ad-hoc analysis)
- Cross-domain joins at serving layer
- Dataset preview in the Developer Portal

---

## 6. Orchestration Layer

### Apache Airflow

Airflow runs on the `forge-orchestration` cluster with **KubernetesExecutor** — every task runs in a fresh, isolated pod. There are no long-running worker nodes.

```
Airflow Scheduler (always-on)
    │
    │  creates pod per task
    ▼
Task Pod (ephemeral, per-task)
    │
    ├── SparkKubernetesOperator → submits SparkApplication to compute cluster
    ├── PythonOperator          → runs DQ checks, catalog updates
    ├── TrinoOperator           → executes Trino SQL for serving views
    └── EmptyOperator           → dependency gates
    │
    ▼
Results written to ADLS / Purview (lineage) / DQ store
```

#### DAG Structure

All pipelines follow a four-stage pattern:

```
ingest_raw    →    transform_curated    →    validate_dq    →    publish_serving
     │                    │                      │                      │
  SparkApp             SparkApp              DQ Runner             Trino views
  (write raw)          (merge curated)      (check curated)       (refresh serving)
     │                    │                      │                      │
  LineageEmit          LineageEmit           DQReport              LineageEmit
```

Each stage emits an OpenLineage event on START, COMPLETE, and FAIL.

#### DAG Repository

DAGs live in Git (`orchestration/airflow/dags/`) and are synced to Airflow via `git-sync` sidecar on the scheduler and webserver pods. No manual DAG uploads — every DAG change is a Git commit.

#### Key Configurations

- `KubernetesExecutor` — no long-running workers, zero idle cost
- `LocalExecutor` for dev environment (single node)
- PostgreSQL (Azure Database for PostgreSQL Flexible Server) as metadata DB
- OIDC authentication (Azure AD) for Airflow webserver
- DAG Git-sync from Azure DevOps / GitHub repo
- SLA miss callbacks → alert webhook (Teams)
- Log retention: 30 days in ADLS, 7 days in pod logs

---

## 7. Data Quality Framework

### Architecture

The DQ framework is a Python SDK (`forge.dq`) that runs inside Airflow task pods and Spark jobs. It is not a separate service.

```
┌─────────────────────────────────────────────────────────────┐
│  DQ SDK (forge.dq)                                          │
│                                                             │
│  ┌──────────────────┐    ┌───────────────────────────────┐  │
│  │  YAML Ruleset    │───▶│  DQRunner                     │  │
│  │  (per dataset)   │    │  • loads rules                │  │
│  └──────────────────┘    │  • runs checks against DF     │  │
│                           │  • aggregates DQRunReport     │ │
│                           └───────────────┬───────────────┘ │
│                                           │                 │
│                           ┌───────────────▼───────────────┐ │
│                           │  Reporters                    │ │
│                           │  • StoreReporter → ADLS Delta │ │
│                           │  • AlertReporter → Webhook    │ │
│                           │  • LineageReporter → Purview  │ │
│                           └───────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Rule Types

| Type | Checks | Example |
|------|--------|---------|
| **Schema** | column presence, data types, nullability | `order_id` must be non-null STRING |
| **Content** | null rate, uniqueness, value range, regex, referential integrity | null rate < 0.01, status IN ('open','closed') |
| **Volume** | row count min/max, row delta vs prior run, partition completeness | row count > 10,000, delta < 20% |
| **Freshness** | max partition age, watermark lag, file modification time | latest partition < 2 hours old |

### DQ Results Store

All DQ run results are written as a Delta table to:

```
abfss://gold@<account>.dfs.core.windows.net/_platform/dq_results/
```

Schema:
```
dq_results/
  dataset_namespace  STRING
  dataset_name       STRING
  run_id             STRING
  pipeline_run_id    STRING
  run_ts             TIMESTAMP
  passed             BOOLEAN
  rule_results       ARRAY<STRUCT<rule_id, check_type, passed, observed_value, threshold, severity>>
  summary            STRUCT<total, passed, failed, critical_failures>
```

Partitioned by `(dataset_namespace, run_ts_date)`.

### Severity and Gating

- `CRITICAL` failures **block** the pipeline — the Airflow task fails and downstream tasks are skipped
- `WARNING` failures **allow** the pipeline to continue but emit a Teams alert
- `INFO` failures are recorded only — no alert, no gate

---

## 8. Lineage Architecture

### OpenLineage Integration

Every pipeline component emits structured OpenLineage events to Microsoft Purview. Events capture:

- **Job**: which DAG task / Spark job produced the output
- **Inputs**: which datasets were read (with schema facet)
- **Outputs**: which datasets were written (with schema facet)
- **Run**: start time, end time, duration, status
- **Custom facets**: DQ summary facet, compute cost facet

```
Airflow Task / Spark Job / Trino
        │
        │  OpenLineage events (HTTPS/JSON)
        │  Bearer token via Azure Workload Identity
        ▼
┌──────────────────────────────────────┐
│  Microsoft Purview                   │
│  purview-forge-{env}.purview.azure.com│
│  OpenLineage REST endpoint           │
│  (managed service — no self-hosted   │
│   infra; org-wide license)           │
└──────────────────────────────────────┘
        │
        │  Data Map API
        ▼
┌──────────────────────────┐
│  Developer Portal        │
│  (lineage explorer UI)   │
└──────────────────────────┘
```

### Lineage Graph Model

```
Source System         Ingest Job        Bronze Dataset     Transform Job      Silver/Gold Dataset
(mssql://crm-server) ──▶ (ingest_raw) ──▶ (bronze/orders) ──▶ (transform)   ──▶ (silver/orders)
     │                        │                 │                   │                   │
  upstream                 run facet         schema facet        run facet          schema facet
  source node              nominalTime       storage facet       DQ facet           DQ facet
                           parent facet                          cost facet
```

### Column-Level Lineage

For Spark jobs, column-level lineage is extracted via the OpenLineage Spark integration which instruments the Spark logical plan. For SQL (Trino), lineage is extracted from the query AST.

Column lineage is surfaced in the Developer Portal and in Purview for impact analysis: "if I change this column, which downstream datasets and dashboards are affected?"

### Purview as Lineage Backend

Microsoft Purview stores the full lineage graph as a managed service — no self-hosted backend, no PostgreSQL to operate. OpenLineage events are emitted automatically by Airflow tasks and Spark jobs — no manual instrumentation. Purview stores the full lineage graph: upstream source systems → bronze → silver → gold, with column-level flows and custom facets (DQ summary, compute cost).

---

## 9. Observability Stack

### Components

```
┌────────────────────────────────────────────────────────────────────┐
│  Observability Stack (Azure-native managed services)              │
│                                                                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐   │
│  │  Azure Monitor   │  │  Azure Managed   │  │  Log Analytics  │   │
│  │  / Container     │  │  Grafana         │  │  Workspace      │   │
│  │  Insights (AMA)  │  │  (dashboards)    │  │  (log aggr.)    │   │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘   │
│                                                                    │
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │  Azure Monitor   │  │  OpenTelemetry   │                        │
│  │  Alerts          │  │  Collector       │                        │
│  └──────────────────┘  └──────────────────┘                        │
└────────────────────────────────────────────────────────────────────┘
```

### Metrics Coverage

| Source | Metrics |
|--------|---------|
| Airflow | `airflow_dag_run_duration`, `airflow_task_instance_state`, `airflow_scheduler_heartbeat` |
| Spark Operator | `spark_app_count`, `spark_app_duration`, executor counts, GC pause |
| Trino | query count, query duration p50/p95/p99, failed queries, memory usage |
| Microsoft Purview | OpenLineage event delivery success rate |
| Azure Monitor Agent (AMA) | CPU, memory, disk IO per node pool |
| Kubernetes | pod restarts, PVC usage, HPA scaling events |
| Azure Monitor | AKS control plane logs, ADLS capacity, Key Vault operations |

### Pre-Built Dashboards

| Dashboard | Purpose |
|-----------|---------|
| Platform Overview | Pipeline health, DQ pass rate, active jobs, storage utilization |
| Spark Cluster | Job throughput, executor utilization, shuffle IO, GC |
| Trino Cluster | Query volume, latency distribution, failed queries, cache hit rate |
| Airflow Health | Task success/failure rate, scheduler lag, SLA misses |
| Lineage Activity | OpenLineage event delivery rate, Purview event ingestion |
| Cost Tracking | Compute cost by pipeline, by cluster, projected vs actual |

### SLOs

| Signal | SLO | Alert Threshold |
|--------|-----|----------------|
| Serving zone freshness | 99.5% of datasets within SLA | < 99% triggers page |
| DQ pass rate | ≥ 98% of runs pass | < 95% triggers page |
| Pipeline success rate | ≥ 99% over 7-day rolling | < 97% triggers page |
| Trino query P95 | ≤ 30s for serving queries | > 60s triggers alert |
| Airflow scheduler heartbeat | ≤ 10s lag | > 30s triggers page |

---

## 10. Security & Identity

### Identity Model

Forge uses **Azure Workload Identity** (OIDC federation) exclusively. No service principal secrets. No storage account keys. No SAS tokens.

```
Pod (annotated with service account)
    │
    │  requests token via OIDC
    ▼
Azure AD (validates OIDC assertion)
    │
    │  issues short-lived access token
    ▼
Azure Resource (ADLS, Key Vault, ACR, etc.)
```

#### Managed Identities (3 per environment)

Three identities per environment, each with a distinct blast radius:

| Identity | Used by | Permissions |
|----------|---------|-------------|
| `id-forge-compute-{env}` | Spark Operator pods | Storage Blob **Data Contributor** (bronze, silver, gold, code, checkpoints) · KV Secrets User |
| `id-forge-read-{env}` | Trino, Airflow task pods, Portal, DQ | Storage Blob **Data Reader** (silver, gold only) · KV Secrets User · Cost Management Reader · **Purview Data Curator** (Purview collection) |
| `id-forge-build-{env}` | CI/CD pipeline (image build + push) | AcrPush + AcrPull **only** — zero data access |

A compromised Trino worker (read path) cannot overwrite data. A compromised build pipeline cannot read your data. Spark (write path) is isolated from the image registry.

### Secret Management

All secrets live in **Azure Key Vault** (`kv-forge-<env>`). Pods access secrets via the **CSI Secrets Store Driver** — secrets are mounted as files or projected as environment variables at pod startup.

Secrets never appear in:
- Helm values files (reference Key Vault secret names only)
- Airflow Connections (backed by Key Vault via the Azure Key Vault Secrets Backend)
- Git repositories
- Container images

### Network Security

- All AKS clusters are **private** — no public API server endpoint
- ADLS, Key Vault, PostgreSQL, ACR — all accessed via **private endpoints only**
- No public IP on any data plane resource
- Ingress to Developer Portal and Azure Managed Grafana via **Azure Application Gateway** (WAF-enabled) + private DNS
- Network Policies (Calico) enforce pod-to-pod traffic rules within each cluster

### RBAC

| Role | Airflow | Portal | Trino | Azure Managed Grafana |
|------|---------|--------|-------|----------------------|
| Platform Admin | Admin | Admin | Admin | Admin |
| Data Engineer | Op | Editor | Full | Editor |
| Analyst | Viewer | Reader | Read (serving only) | Viewer |
| Service Account | — | — | Read (specific schemas) | — |

All roles backed by Azure AD groups — no local user accounts in any platform component.

---

## 11. Networking

### VNet Layout

One VNet per environment — dev and prod are completely isolated, no peering between them.

```
vnet-forge-dev  (10.0.0.0/12)               vnet-forge-prod  (10.16.0.0/12)
├── 10.1.0.0/16  compute-cluster-subnet      ├── 10.17.0.0/16  compute-cluster-subnet
├── 10.2.0.0/16  orch-cluster-subnet         ├── 10.18.0.0/16  orch-cluster-subnet
├── 10.3.0.0/24  private-endpoints-subnet    ├── 10.19.0.0/24  private-endpoints-subnet
├── 10.4.0.0/24  appgw-subnet               ├── 10.20.0.0/24  appgw-subnet
└── 10.5.0.0/24  bastion-subnet             └── 10.21.0.0/24  bastion-subnet
```

Non-overlapping `/12` blocks allow both VNets to peer to a corporate hub (ExpressRoute/VPN) without address conflicts.

### Private DNS Zones

| Zone | Resolves |
|------|---------|
| `privatelink.dfs.core.windows.net` | ADLS Gen2 |
| `privatelink.vaultcore.azure.net` | Key Vault |
| `privatelink.azurecr.io` | Container Registry |
| `privatelink.postgres.database.azure.com` | PostgreSQL |
| `privatelink.monitor.azure.com` | Azure Monitor |
| `privatelink.purview.azure.com` | Microsoft Purview |

All private DNS zones linked to the VNet — no public DNS for any data plane resource.

### Traffic Flows

```
Developer (corp network / VPN)
    │
    │  HTTPS
    ▼
Application Gateway (WAF v2)
    │
    ├──▶ Developer Portal (orchestration cluster ingress)
    └──▶ Azure Managed Grafana (Azure-hosted, private link)

Airflow → compute cluster AKS API
    │  private endpoint to AKS API server
    │  kubeconfig from Key Vault

All cluster egress → Azure services via private endpoints only
No public internet egress for data plane traffic
```

---

## 12. Developer Portal

The Developer Portal is a web application running on the orchestration cluster. It is the single pane of glass for data engineers and platform operators.

### Architecture

```
Browser
  │  HTTPS (via App Gateway)
  ▼
Next.js Frontend (portal-web pod)
  │  REST API calls with Azure AD Bearer token
  ▼
FastAPI Backend (portal-api pod)
  │
  ├── Airflow REST API          — pipeline status, run history, task logs
  ├── Purview Data Map API     — lineage graph, dataset versions, column lineage
  ├── DQ Delta Table (Trino)   — DQ results, trends, failing rules
  ├── Azure Cost Management    — compute cost by pipeline
  └── ADLS catalog (Delta)     — dataset list, schema, partitions
```

### Pages

| Page | What it shows |
|------|---------------|
| **Home** | Platform health: DQ pass rate, pipeline success rate, active jobs, storage |
| **Pipelines** | All Airflow DAGs: status, last run, schedule, owner, DQ badge |
| **Pipeline Detail** | Run history chart, task graph, recent runs, DQ summary, lineage link |
| **Datasets** | Lakehouse catalog: zone, schema, freshness, owner, DQ status |
| **Dataset Detail** | Schema viewer, partitions, DQ history, lineage preview, version history |
| **Lineage Explorer** | Interactive graph: upstream/downstream, column-level toggle, impact analysis |
| **DQ Dashboard** | Pass rate summary, failing datasets, critical alerts, rule drill-down |
| **Cost** | Spend by pipeline, by cluster, trend, projected vs actual |

---

## 13. Data Flow — End to End

```
Source System (e.g. CRM, ERP, event stream)
        │
        │  1. Bronze Ingestion DAG (Airflow + Spark)
        │     • SparkApplication reads source
        │     • Writes Delta to bronze/
        │     • Emits OpenLineage START → COMPLETE
        ▼
bronze/ container (ADLS Gen2)
        │
        │  2. Silver Transform DAG (Airflow + Spark)
        │     • SparkApplication reads bronze/
        │     • Applies schema, cleans, deduplicates
        │     • MERGE into silver/ Delta table
        │     • Emits OpenLineage with schema facet
        ▼
silver/ container (ADLS Gen2)
        │
        │  3. DQ Validation DAG (Airflow + DQ SDK)
        │     • DQRunner loads YAML ruleset
        │     • Runs schema/content/volume/freshness checks
        │     • Writes DQRunReport to _platform/dq_results/
        │     • Emits DQ facet to Purview (via OpenLineage)
        │     • Blocks on CRITICAL failures
        ▼
DQ gate (pass/fail)
        │
        │  4. Gold Publish DAG (Airflow + Trino)
        │     • Trino refreshes gold/ materialization
        │     • OPTIMIZE + VACUUM on Gold table
        │     • Updates metadata catalog
        │     • Checks freshness SLA
        │     • Notifies consumers on completion
        ▼
gold/ container (ADLS Gen2)
        │
        │  Consumers:
        ├──▶ Trino (federated SQL queries)
        ├──▶ Spark Connect (data science, ML)
        └──▶ Developer Portal (previews, metadata)
```

---

## 14. Architecture Decision Records

### ADR-001: Dual-cluster vs single-cluster

**Decision:** Two AKS clusters — compute and orchestration.

**Context:** A single cluster mixing Spark workloads (bursty, memory-intensive) with Airflow (steady, CPU-light) creates resource contention, noisy-neighbor problems, and a large blast radius for upgrades.

**Consequences:** Higher base infrastructure cost (~2 system node pools instead of 1). Accepted trade-off for operational isolation and independent scaling.

---

### ADR-002: Workload Identity over service principal secrets

**Decision:** All Azure resource access via Workload Identity (OIDC federation). Zero long-lived credentials.

**Context:** Service principal client secrets have a maximum 2-year lifetime, require rotation, and leak risk if committed or logged. Workload identity tokens are scoped, short-lived, and require no rotation.

**Consequences:** Slightly more complex initial setup (OIDC issuer, federated credentials). No rotation burden, no secret sprawl.

---

### ADR-003: KubernetesExecutor for Airflow

**Decision:** KubernetesExecutor (task-per-pod) over CeleryExecutor (persistent workers).

**Context:** CeleryExecutor requires always-on worker pods, adding idle cost and maintenance. KubernetesExecutor spawns pods on demand and cleans up after each task.

**Consequences:** Higher task startup latency (~5–10s for pod scheduling). Accepted trade-off for zero idle cost and full task isolation.

---

### ADR-004: Delta Lake as default, Iceberg available

**Decision:** Delta Lake 4.0 is the default table format for all pipeline outputs (Bronze, Silver, Gold). Apache Iceberg is available as a supported alternative for specific datasets where required.

**Context:** All pipeline outputs — including Bronze ingestion writes — are Delta tables. This gives ACID guarantees, schema enforcement, Change Data Feed, and time travel at every layer, not just Silver and Gold. Iceberg is provisioned in Trino and Spark for cases where a consumer or source system requires it (e.g., a feed coming from an Iceberg-native platform, or a dataset shared externally where Iceberg is the agreed standard).

**How it works in practice:**
- Default: all pipelines write Delta. The Spark job config, Hive Metastore catalog, and Trino `lakehouse` catalog all default to Delta.
- Iceberg where needed: a job can write Iceberg by setting `format = iceberg` in the pipeline config. The Trino `iceberg` catalog and Spark Iceberg runtime JARs are available in every environment.
- Both formats coexist in the same ADLS containers — they are distinguished by catalog registration, not path.

**Consequences:** Engineers must be intentional when choosing Iceberg — it is opt-in, not default. The DQ framework and lineage system treat both formats identically.

---

### ADR-005: OpenLineage + Microsoft Purview over self-hosted lineage backend

**Decision:** OpenLineage emission protocol with Microsoft Purview as the lineage backend.

**Context:** OpenLineage is the open standard for lineage metadata. It integrates natively with Airflow, Spark, and Trino. Microsoft Purview supports the OpenLineage REST endpoint directly. Purview is licensed org-wide and provides an enterprise catalog (lineage, data discovery, glossary, sensitivity labels) alongside the lineage graph — removing the need to self-host and operate a dedicated lineage backend.

**Consequences:** Emitters (Airflow, Spark, Trino) are unchanged — they emit the same OpenLineage events. Only the transport destination changes from a self-hosted endpoint to the Purview managed service. The OpenLineage standard ensures the emitters remain backend-portable if the lineage backend changes in future.
