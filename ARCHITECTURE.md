# Stratum — Platform Architecture

> **Version:** 1.0
> **Status:** Draft for Review
> **Audience:** Platform engineers, data engineers, architects

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

Stratum is built around four principles:

**Separation of concerns.**
Compute, orchestration, storage, and observability are independently deployed and scaled. A failure in one layer does not cascade into others.

**Everything is governed.**
No data moves between zones without schema validation, DQ checks, and lineage emission. Every pipeline run produces a traceable audit trail.

**Developer experience is first-class.**
Engineers write Spark jobs from VS Code using Spark Connect — no cluster access, no SSH, no port-forwards. Airflow DAGs are Python files in Git. The Developer Portal surfaces everything in one place.

**Infrastructure is code.**
All Azure resources are Bicep-managed. All Kubernetes workloads are Helm-managed and GitOps-deployed via ArgoCD. Nothing is clicked into existence.

---

## 2. System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                             Developer Workflow                            │
│                                                                          │
│   VS Code + Spark Connect        Git + DAG files        Portal UI        │
│         │                              │                    │            │
└─────────┼──────────────────────────────┼────────────────────┼────────────┘
          │                              │                    │
          ▼                              ▼                    ▼
┌─────────────────────┐    ┌─────────────────────────────────────────────┐
│   Compute Cluster   │    │            Orchestration Cluster             │
│   (AKS Private)     │    │            (AKS Private)                    │
│                     │    │                                              │
│  ┌───────────────┐  │    │  ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ Spark Operator│  │    │  │ Airflow  │ │ Marquez  │ │  Prometheus│  │
│  │ Spark Connect │  │    │  │ (Sched.) │ │(Lineage) │ │  + Grafana │  │
│  │ Trino         │  │    │  └──────────┘ └──────────┘ └────────────┘  │
│  └───────────────┘  │    │  ┌──────────┐ ┌──────────┐ ┌────────────┐  │
└─────────────────────┘    │  │  DQ      │ │  Loki    │ │  Portal    │  │
          │                │  │ Framework│ │ (Logs)   │ │  Backend   │  │
          │                │  └──────────┘ └──────────┘ └────────────┘  │
          │                └─────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        ADLS Gen2 Lakehouse                               │
│                                                                          │
│   ┌─────────────┐      ┌───────────────┐      ┌───────────────────┐    │
│   │  raw/        │ ──▶ │  curated/      │ ──▶ │  serving/          │   │
│   │  (Parquet)   │      │  (Delta Lake) │      │  (Delta Lake)     │    │
│   │  append-only │      │  schema-enf.  │      │  SLA-governed     │    │
│   └─────────────┘      └───────────────┘      └───────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────┐
│  Shared Azure Resources  │
│  Key Vault │ ACR │ Monitor│
│  Private DNS │ Log Analytics│
└──────────────────────────┘
```

---

## 3. Dual-Cluster Design

### Why Two Clusters?

A single AKS cluster mixing compute and orchestration creates hidden coupling:

- Spark executors consume node resources unpredictably, starving the Airflow scheduler
- A Spark upgrade requiring node pool changes shouldn't require an Airflow maintenance window
- Security posture differs: compute workers need broad storage access; orchestration workers need narrow API credentials

Stratum uses two dedicated private AKS clusters with separate node pools, separate managed identities, and no direct network path between them — all coordination happens through the shared lakehouse and shared Marquez API.

### Cluster Specifications

#### `stratum-compute` — Compute Cluster

| Node Pool | VM SKU | Min/Max Nodes | Purpose |
|-----------|--------|---------------|---------|
| `system` | Standard_D4s_v5 | 1 / 3 | Kubernetes system components |
| `spark` | Standard_E8s_v5 | 0 / 20 | Spark driver + executor pods |
| `trino` | Standard_E16s_v5 | 2 / 8 | Trino coordinator + workers |

- Azure CNI Overlay networking
- Cluster autoscaler enabled on `spark` and `trino` pools
- Workload identity (OIDC) enabled
- Private API server endpoint
- Node OS: Azure Linux (CBL-Mariner)

#### `stratum-orchestration` — Orchestration Cluster

| Node Pool | VM SKU | Min/Max Nodes | Purpose |
|-----------|--------|---------------|---------|
| `system` | Standard_D4s_v5 | 1 / 3 | Kubernetes system components |
| `airflow` | Standard_D8s_v5 | 2 / 10 | Airflow scheduler, webserver, workers |
| `platform` | Standard_D4s_v5 | 1 / 4 | Marquez, Portal, Prometheus, Grafana |

- Azure CNI Overlay networking
- Workload identity (OIDC) enabled
- Private API server endpoint
- Node OS: Azure Linux (CBL-Mariner)

### Inter-Cluster Communication

Clusters communicate **only through shared data stores** — never directly:

```
Compute Cluster                     Orchestration Cluster
      │                                      │
      │  writes results to ADLS serving/     │
      ├──────────────────────────────────────▶ ADLS Gen2
      │                                      │
      │  emits OpenLineage events to Marquez │
      ├──────────────────────────────────────▶ Marquez API (via private endpoint)
      │                                      │
      │  Airflow submits SparkApplication CRD│
      ◀────────────────────────────────────── kubectl (via AKS private API)
```

Airflow has read-write access to the compute cluster's Kubernetes API server via its kubeconfig (stored in Key Vault) to submit `SparkApplication` CRDs via the `SparkKubernetesOperator`. There is no other cross-cluster path.

---

## 4. Lakehouse Architecture

Stratum uses the **Medallion architecture** — Bronze, Silver, Gold — as the organisational model for the ADLS Gen2 lakehouse. Each layer is a dedicated container, with a separate **Sandbox** container for all user experimentation.

### Medallion Layers

```
Source Systems
     │
     │  (ingestion DAGs)
     ▼
┌─────────────────────────────────────────────────────────────┐
│  BRONZE                                                      │
│  abfss://bronze@<account>.dfs.core.windows.net/            │
│                                                              │
│  • Immutable. Append-only. No updates, no deletes.          │
│  • Format: source-native (Parquet preferred, CSV tolerated) │
│  • Partitioned by: source_system / entity / ingestion_date  │
│  • Retention: 7 years (lifecycle policy)                    │
│  • Access: Stratum platform only                            │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  │  (Silver transform DAGs — Spark Delta merge)
                  ▼
┌─────────────────────────────────────────────────────────────┐
│  SILVER                                                      │
│  abfss://silver@<account>.dfs.core.windows.net/            │
│                                                              │
│  • Delta Lake format. MERGE (upsert) semantics.             │
│  • Schema enforced. Evolution via ALTER TABLE only.         │
│  • DQ checks required before write succeeds.                │
│  • Partitioned by: domain / entity / year / month          │
│  • Retention: unlimited (Delta log compaction weekly)       │
│  • Access: Stratum platform + approved internal tooling     │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  │  (Gold publish DAGs — Trino views + Delta optimize)
                  ▼
┌─────────────────────────────────────────────────────────────┐
│  GOLD                                                        │
│  abfss://gold@<account>.dfs.core.windows.net/              │
│                                                              │
│  • Delta Lake format. Optimized (Z-ORDER, VACUUM).          │
│  • SLA-governed: freshness SLAs defined per dataset.        │
│  • Consumer-ready: Trino catalogs, Spark reads, Portal.     │
│  • Partitioned by: domain / entity (consumer-optimised)     │
│  • Access: all authenticated consumers                      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  SANDBOX                                                     │
│  abfss://sandbox@<account>.dfs.core.windows.net/           │
│                                                              │
│  • Per-user experimentation area. No SLAs. No DQ gates.     │
│  • Path convention: sandbox/{user_alias}/...                │
│  • Every user in the platform has read/write to their path  │
│  • No data from Sandbox ever promotes to Bronze/Silver/Gold │
│    automatically — promotion is a deliberate pipeline act   │
│  • Retention: 30 days (lifecycle policy auto-deletes)       │
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
stratum<env>adls (ADLS Gen2, HNS enabled)
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

Stratum runs Spark in two modes:

#### 1. Batch Jobs (Spark Operator)

Batch pipelines submit `SparkApplication` CRDs via the Airflow `SparkKubernetesOperator`. The Spark Operator watches the `spark-jobs` namespace and launches driver + executor pods on the `spark` node pool.

```
Airflow DAG
    │
    │  kubectl apply SparkApplication CRD
    ▼
Spark Operator (stratum-compute)
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
Spark Connect Server Pod (stratum-compute)
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
│  Catalogs                                                 │
│  ┌────────────┐  ┌───────────┐  ┌──────────────────────┐ │
│  │ lakehouse  │  │   hive    │  │       tpch           │ │
│  │ (Delta)    │  │  (raw)    │  │   (benchmarking)     │ │
│  │ curated/   │  │ raw/      │  │                      │ │
│  │ serving/   │  │           │  │                      │ │
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

Airflow runs on the `stratum-orchestration` cluster with **KubernetesExecutor** — every task runs in a fresh, isolated pod. There are no long-running worker nodes.

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
Results written to ADLS / Marquez / DQ store
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
- SLA miss callbacks → alert webhook (Teams/Slack)
- Log retention: 30 days in ADLS, 7 days in pod logs

---

## 7. Data Quality Framework

### Architecture

The DQ framework is a Python SDK (`stratum.dq`) that runs inside Airflow task pods and Spark jobs. It is not a separate service.

```
┌─────────────────────────────────────────────────────────────┐
│  DQ SDK (stratum.dq)                                         │
│                                                              │
│  ┌──────────────────┐    ┌───────────────────────────────┐  │
│  │  YAML Ruleset    │───▶│  DQRunner                     │  │
│  │  (per dataset)   │    │  • loads rules                │  │
│  └──────────────────┘    │  • runs checks against DF     │  │
│                           │  • aggregates DQRunReport     │  │
│                           └───────────────┬───────────────┘  │
│                                           │                  │
│                           ┌───────────────▼───────────────┐  │
│                           │  Reporters                    │  │
│                           │  • StoreReporter → ADLS Delta │  │
│                           │  • AlertReporter → Webhook    │  │
│                           │  • LineageReporter → Marquez  │  │
│                           └───────────────────────────────┘  │
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
abfss://curated@<account>.dfs.core.windows.net/_platform/dq_results/
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
- `WARNING` failures **allow** the pipeline to continue but emit a Slack/Teams alert
- `INFO` failures are recorded only — no alert, no gate

---

## 8. Lineage Architecture

### OpenLineage Integration

Every pipeline component emits structured OpenLineage events to Marquez. Events capture:

- **Job**: which DAG task / Spark job produced the output
- **Inputs**: which datasets were read (with schema facet)
- **Outputs**: which datasets were written (with schema facet)
- **Run**: start time, end time, duration, status
- **Custom facets**: DQ summary facet, compute cost facet

```
Airflow Task / Spark Job
        │
        │  OpenLineage events (HTTP/JSON)
        ▼
┌──────────────────────────┐
│  Marquez API Server      │
│  (orchestration cluster) │
│                          │
│  ┌────────────────────┐  │
│  │  PostgreSQL        │  │
│  │  (lineage store)   │  │
│  └────────────────────┘  │
└──────────────────────────┘
        │
        │  GraphQL + REST API
        ▼
┌──────────────────────────┐
│  Developer Portal        │
│  (lineage explorer UI)   │
└──────────────────────────┘
```

### Lineage Graph Model

```
Dataset Node          Job Node           Dataset Node
(raw/orders)  ──▶  (transform_orders) ──▶  (curated/orders)
     │                     │                      │
  schema facet         run facet              schema facet
  storage facet        DQ facet               DQ facet
                        cost facet
```

### Column-Level Lineage

For Spark jobs, column-level lineage is extracted via the OpenLineage Spark integration which instruments the Spark logical plan. For SQL (Trino), lineage is extracted from the query AST.

Column lineage is surfaced in the Developer Portal for impact analysis: "if I change this column, which downstream datasets and dashboards are affected?"

### Marquez Deployment

Marquez runs as two pods in the `lineage` namespace on the orchestration cluster:

- `marquez-api` — REST + GraphQL API, stores events to PostgreSQL
- `marquez-web` — React UI for lineage graph exploration (internal access only)

PostgreSQL backend: Azure Database for PostgreSQL Flexible Server (private endpoint).

---

## 9. Observability Stack

### Components

```
┌────────────────────────────────────────────────────────────────────┐
│  Observability Stack (orchestration cluster, monitoring namespace)  │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │  Prometheus      │  │  Grafana         │  │  Loki           │  │
│  │  (metrics)       │  │  (dashboards)    │  │  (log aggr.)    │  │
│  │  30d retention   │  │  OIDC auth       │  │  14d retention  │  │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘  │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │  Alertmanager    │  │  OpenTelemetry   │                        │
│  │  → Teams/PagerD  │  │  Collector       │                        │
│  └──────────────────┘  └──────────────────┘                        │
└────────────────────────────────────────────────────────────────────┘
```

### Metrics Coverage

| Source | Metrics |
|--------|---------|
| Airflow | `airflow_dag_run_duration`, `airflow_task_instance_state`, `airflow_scheduler_heartbeat` |
| Spark Operator | `spark_app_count`, `spark_app_duration`, executor counts, GC pause |
| Trino | query count, query duration p50/p95/p99, failed queries, memory usage |
| Marquez | event ingestion rate, API latency |
| Node Exporter | CPU, memory, disk IO per node pool |
| Kubernetes | pod restarts, PVC usage, HPA scaling events |
| Azure Monitor | AKS control plane logs, ADLS capacity, Key Vault operations |

### Pre-Built Dashboards

| Dashboard | Purpose |
|-----------|---------|
| Platform Overview | Pipeline health, DQ pass rate, active jobs, storage utilization |
| Spark Cluster | Job throughput, executor utilization, shuffle IO, GC |
| Trino Cluster | Query volume, latency distribution, failed queries, cache hit rate |
| Airflow Health | Task success/failure rate, scheduler lag, SLA misses |
| Lineage Activity | OpenLineage event rate, Marquez API latency |
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

Stratum uses **Azure Workload Identity** (OIDC federation) exclusively. No service principal secrets. No storage account keys. No SAS tokens.

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

#### Managed Identities per Workload

| Identity | Permissions |
|----------|-------------|
| `id-stratum-spark` | Storage Blob Data Contributor on raw + curated + code containers |
| `id-stratum-trino` | Storage Blob Data Reader on curated + serving containers |
| `id-stratum-airflow` | Key Vault Secrets User; Storage Blob Data Contributor on checkpoints |
| `id-stratum-dq` | Storage Blob Data Contributor on curated (DQ results table) |
| `id-stratum-lineage` | No storage access; only Marquez API |
| `id-stratum-portal` | Storage Blob Data Reader on serving; Key Vault Secrets User |

### Secret Management

All secrets live in **Azure Key Vault** (`kv-stratum-<env>`). Pods access secrets via the **CSI Secrets Store Driver** — secrets are mounted as files or projected as environment variables at pod startup.

Secrets never appear in:
- Helm values files (reference Key Vault secret names only)
- Airflow Connections (backed by Key Vault via the Azure Key Vault Secrets Backend)
- Git repositories
- Container images

### Network Security

- All AKS clusters are **private** — no public API server endpoint
- ADLS, Key Vault, PostgreSQL, ACR — all accessed via **private endpoints only**
- No public IP on any data plane resource
- Ingress to Developer Portal and Grafana via **Azure Application Gateway** (WAF-enabled) + private DNS
- Network Policies (Calico) enforce pod-to-pod traffic rules within each cluster

### RBAC

| Role | Airflow | Portal | Trino | Grafana |
|------|---------|--------|-------|---------|
| Platform Admin | Admin | Admin | Admin | Admin |
| Data Engineer | Op | Editor | Full | Editor |
| Analyst | Viewer | Reader | Read (serving only) | Viewer |
| Service Account | — | — | Read (specific schemas) | — |

All roles backed by Azure AD groups — no local user accounts in any platform component.

---

## 11. Networking

### VNet Layout

```
stratum-vnet (10.0.0.0/8)
├── 10.1.0.0/16  —  compute-cluster-subnet     (AKS compute nodes)
├── 10.2.0.0/16  —  orchestration-cluster-subnet (AKS orch nodes)
├── 10.3.0.0/24  —  private-endpoints-subnet    (all PaaS private endpoints)
├── 10.4.0.0/24  —  appgw-subnet               (Application Gateway)
└── 10.5.0.0/24  —  bastion-subnet             (Azure Bastion, ops access)
```

### Private DNS Zones

| Zone | Resolves |
|------|---------|
| `privatelink.dfs.core.windows.net` | ADLS Gen2 |
| `privatelink.vaultcore.azure.net` | Key Vault |
| `privatelink.azurecr.io` | Container Registry |
| `privatelink.postgres.database.azure.com` | PostgreSQL |
| `privatelink.monitor.azure.com` | Azure Monitor |

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
    └──▶ Grafana (orchestration cluster ingress)

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
  ├── Airflow REST API        — pipeline status, run history, task logs
  ├── Marquez REST API        — lineage graph, dataset versions
  ├── DQ Delta Table (Trino)  — DQ results, trends, failing rules
  ├── Azure Cost Management   — compute cost by pipeline
  └── ADLS catalog (Delta)    — dataset list, schema, partitions
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
        │     • Writes Parquet to bronze/
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
        │     • Emits DQ facet to Marquez
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

### ADR-005: OpenLineage + Marquez over proprietary lineage

**Decision:** OpenLineage protocol with Marquez as the lineage backend.

**Context:** OpenLineage is the open standard for lineage metadata. It integrates natively with Airflow, Spark, and Trino. Marquez is the reference implementation of the OpenLineage API and is open source.

**Consequences:** Marquez has a smaller feature set than commercial lineage tools (no ML lineage, limited business glossary). Acceptable as a starting point; the OpenLineage standard allows migration to a different backend later without changing emitters.
