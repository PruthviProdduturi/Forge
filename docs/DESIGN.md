# Forge — Platform Design Reference

> **Version:** 1.0
> **Status:** Production
> **Classification:** Internal — Platform Team
> **Last updated:** 2026-03-25

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Principles](#2-architecture-principles)
3. [Reference Architecture](#3-reference-architecture)
4. [Two-Cluster Model per Environment](#4-two-cluster-model-per-environment)
5. [Compute Platform](#5-compute-platform)
6. [Orchestration & Control Plane](#6-orchestration--control-plane)
7. [Data Platform — Medallion Lakehouse](#7-data-platform--medallion-lakehouse)
8. [Developer Experience](#8-developer-experience)
9. [Cross-Cutting Concerns](#9-cross-cutting-concerns)
10. [Delivery Lifecycle](#10-delivery-lifecycle)
11. [Implementation Roadmap](#11-implementation-roadmap)
12. [Deep-Dive Reference Index](#12-deep-dive-reference-index)

---

## 1. Executive Summary

Forge is the core data engineering platform that moves data from raw sources to governed, serving-ready analytics — reliably, observably, and at scale.

It is built around three design decisions that distinguish it from simpler ETL approaches:

**Decision 1 — Separate compute from orchestration.**
Two AKS clusters per environment: one for elastic data processing (Spark, Trino), one for stable control-plane services (Airflow, data quality, lineage, observability). A failure or scaling event in one does not impact the other.

**Decision 2 — Azure-native observability.**
No self-hosted Prometheus, Loki, Grafana, or Alertmanager. All telemetry flows through Azure Monitor, Azure Managed Grafana, and Azure Log Analytics — reducing operational burden and maintaining compliance through the existing Azure enterprise agreement.

**Decision 3 — Everything is code.**
Infrastructure is Bicep. Platform configuration is Helm. Pipelines are Python DAGs. Quality rules are YAML. Nothing is clicked into existence. Everything is versioned, reviewed, and promoted through Git.

---

## 2. Architecture Principles

| Principle | What it means in practice |
|-----------|--------------------------|
| **Separation of concerns** | Orchestration and compute are isolated clusters. A Spark OOM does not page the Airflow on-call. |
| **Minimal blast radius** | Each cluster, each layer, each job runs with the minimum permissions needed. No shared credentials. |
| **Environment isolation** | dev and prod are independent deployments. Data, identities, and secrets are never shared across environments. |
| **Everything as code** | Infrastructure, pipelines, quality rules, and dashboards are in Git. Deployments are triggered by merges and tags — never by hand. |
| **Observable by default** | Every pipeline run, every query, every data write is observable without SSH or tribal knowledge. If it can't be monitored, it shouldn't run in prod. |
| **Developer experience is first-class** | Data engineers write and test Spark code from VS Code against a live dev cluster. No local Spark installation. No mock data. Real cluster, real data, real results. |
| **Secure by default** | No public endpoints. Workload identity replaces secrets. Private endpoints for every PaaS service. Zero long-lived credentials. |

---

## 3. Reference Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Developer Interfaces                              │
│                                                                             │
│    VS Code + Spark Connect      Airflow Web UI      Developer Portal        │
│    (dev only, interactive)      (DAGs, runs)        (datasets, lineage,     │
│                                                      DQ, cost, pipelines)  │
└───────────────┬─────────────────────────┬───────────────────┬──────────────┘
                │                         │                   │
                ▼                         ▼                   ▼
┌──────────────────────┐    ┌──────────────────────────────────────────────┐
│   Compute Cluster    │    │           Orchestration Cluster              │
│   (AKS Public)       │    │           (AKS Public)                       │
│                      │◄───│                                              │
│  Spark Operator      │    │  Apache Airflow     Developer Portal         │
│  Spark Connect*      │    │  DQ Framework                                │
│  Trino               │    │  Azure Monitor Agent (AMA DaemonSet)         │
│                      │    │                                              │
│  *dev environment    │    │                                              │
│   only               │    │                                              │
└──────────┬───────────┘    └────────────────────┬─────────────────────────┘
           │                                     │
           └──────────────┬──────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ADLS Gen2 Lakehouse                                 │
│                                                                             │
│   bronze/            silver/            gold/             sandbox/          │
│   Immutable source   Cleaned, schema-   Aggregated,       Per-user (dev     │
│   append-only        enforced, DQ       SLA-governed,     only, 28-day TTL) │
│                      validated          consumer-ready                      │
└─────────────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Shared Azure Services                                  │
│                                                                             │
│   Azure Monitor        Azure Managed Grafana      Log Analytics Workspace   │
│   Key Vault            Azure Container Registry   Azure Monitor Alerts      │
│   Private DNS          Azure Application Gateway  Application Insights      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Two-Cluster Model per Environment

Each environment (dev, prod) is an independent deployment of the same topology. No environment shares infrastructure, identities, or data with another.

```
┌─────────────────────────────────────────────────────────────────┐
│                       dev environment                           │
│                                                                 │
│  aks-forge-compute-dev          aks-forge-orch-dev             │
│  ┌──────────────────────┐       ┌──────────────────────────┐   │
│  │  Spark Operator      │       │  Airflow                 │   │
│  │  Spark Connect ◄─────┼───────┼── VS Code (interactive)  │   │
│  │  Trino               │       │  Developer Portal        │   │
│  └──────────────────────┘       └──────────────────────────┘   │
│  adlsforgedev  (bronze/silver/gold/sandbox)                     │
│  forgeacr-dev  kv-forge-dev                                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      prod environment                           │
│                                                                 │
│  aks-forge-compute-prod         aks-forge-orch-prod            │
│  ┌──────────────────────┐       ┌──────────────────────────┐   │
│  │  Spark Operator      │       │  Airflow                 │   │
│  │  (no Spark Connect)  │       │  Developer Portal        │   │
│  │  Trino               │       │                          │   │
│  └──────────────────────┘       └──────────────────────────┘   │
│  adlsforgeprod  (bronze/silver/gold — no sandbox)               │
│  forgeacr-prod  kv-forge-prod                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Why no Spark Connect in prod?** Interactive sessions bypass DQ, lineage, and audit controls. In prod, every Spark execution is scheduled via Airflow, runs through the Spark Operator, emits lineage, and is fully auditable. See [Environment Promotion](architecture/14-environment-promotion.md) for the full dev→prod workflow.

---

## 5. Compute Platform

The compute cluster provides elastic, scalable execution for batch processing and interactive analytics. It is intentionally kept stateless — durable state lives in ADLS, Key Vault, and the Hive Metastore (Delta catalog).

### 5.1 Apache Spark

| Mode | Trigger | Environment | SparkSession |
|------|---------|-------------|--------------|
| **Interactive (Spark Connect)** | Developer from VS Code | dev only | `.builder.remote("sc://...")` |
| **Batch (Spark Operator)** | Airflow `SparkKubernetesOperator` | dev + prod | `.builder.appName(...)` |

- Workloads use **workload identity** (managed identity + OIDC) for ADLS and Key Vault access — no credentials in code or config
- All jobs emit **OpenLineage** START/COMPLETE/FAIL events to Microsoft Purview automatically
- Spark UI is accessible via port-forward for debugging (not exposed publicly)
- Node pools: `sparkpool` (memory-optimised, Standard_E8s_v5) autoscales 0→20 on demand

### 5.2 Trino

- Federated SQL access layer for BI tools and governed ad-hoc queries
- Delta Lake connector reads from ADLS gold layer
- Query history, performance metrics, and audit signals flow to Azure Monitor
- Coordinators are always-on; workers autoscale based on query queue depth

→ Full detail: [Compute Architecture](architecture/06-compute.md)

---

## 6. Orchestration & Control Plane

The orchestration cluster hosts stable, long-lived platform services. It is sized for high availability and designed to remain independent of compute scaling events.

### 6.1 Apache Airflow (Workflow Scheduling)

- **Executor:** `KubernetesExecutor` — each task gets its own pod, isolated and auditable
- **DAG source:** Git-sync from the `main` branch (dev) or release tag (prod) — live within 30 seconds
- **Auth:** Azure AD OIDC (no local user accounts)
- **Secrets:** Azure Key Vault via CSI secrets store driver — no secrets in environment variables
- **Operators:** `SparkKubernetesOperator` (Spark jobs), `TrinoOperator` (SQL transforms), `DQOperator` (quality gates)
- Airflow triggers Spark jobs on the **compute cluster** via its kubeconfig (stored in Key Vault)

### 6.2 Data Quality Framework

Quality is a first-class pipeline stage, not a post-hoc check. Every bronze→silver and silver→gold transition has a DQ gate:

```
SparkJob (bronze → silver)
    │
    ▼
DQOperator
    │  loads YAML ruleset from orchestration/dq/rules/<dataset>.yaml
    │  runs checks: schema | content | volume | freshness
    │
    ├── PASS  →  next task
    └── FAIL  →  pipeline halted, alert fired, data quarantined
```

Rules are managed as YAML in Git — the same PR review and CI validation process as code.

### 6.3 Lineage (OpenLineage / Microsoft Purview)

- OpenLineage events are emitted automatically by Airflow tasks, Spark jobs, and Trino queries — no manual instrumentation for standard pipeline operations
- Microsoft Purview stores the full lineage graph: upstream source systems → bronze → silver → gold, with dataset versions, column-level flows, and custom facets (DQ summary, compute cost)
- The full lineage chain from source system (SQL Server, PostgreSQL, REST API) to gold is captured when ingest jobs declare their upstream source as an OpenLineage input — see [Lineage Architecture](architecture/10-lineage.md) Section 4 for the upstream source naming convention
- Impact analysis: "what breaks if I change this source table or column?" is answerable from Purview's lineage graph or the Developer Portal's Lineage Explorer
- `id-forge-read-{env}` holds **Purview Data Curator** role on the Purview collection, enabling all emitters (Airflow, Spark, Trino pods) to POST lineage events via workload identity

### 6.4 Observability

All telemetry is Azure-native — no self-hosted stack to maintain:

| Signal | Tool | What it covers |
|--------|------|----------------|
| Metrics | Azure Monitor / Container Insights | AKS nodes, Spark/Trino/Airflow app metrics |
| Logs | Azure Log Analytics Workspace | All pod logs from both clusters (via AMA DaemonSet) |
| Traces | Azure Application Insights | Portal API distributed traces, Spark job traces |
| Dashboards | Azure Managed Grafana | Job health, DQ rates, Trino perf, infra utilisation |
| Alerts | Azure Monitor Alerts | Pipeline failures, SLO breaches, DQ failures → Teams |

→ Full detail: [Orchestration Architecture](architecture/07-orchestration.md) · [Observability Architecture](architecture/08-observability.md)

---

## 7. Data Platform — Medallion Lakehouse

All data lives in ADLS Gen2 with hierarchical namespace. The medallion architecture enforces a clear contract at each layer.

```
SOURCE SYSTEMS
      │
      ▼ raw ingest (Airflow DAG + SparkApplication)
┌─────────────────────────────────────────────────────┐
│  bronze/                                            │
│  abfss://bronze@<account>.dfs.core.windows.net/    │
│  • Immutable — append-only, no overwrites           │
│  • Schema-on-read                                   │
│  • All sources land here before any transform       │
│  • Partitioned: year/month/day/hour (UTC)           │
└──────────────────────────┬──────────────────────────┘
                           │ Spark transform + DQ gate
                           ▼
┌─────────────────────────────────────────────────────┐
│  silver/                                            │
│  • Cleaned, schema-enforced, deduplicated           │
│  • DQ validated — no data reaches silver without    │
│    passing all content, schema, and volume checks   │
│  • Delta Lake format (ACID, time travel)            │
│  • Lineage captured at dataset level                │
└──────────────────────────┬──────────────────────────┘
                           │ aggregation + SLA
                           ▼
┌─────────────────────────────────────────────────────┐
│  gold/                                              │
│  • Aggregated, consumer-ready, SLA-governed         │
│  • Read by Trino, BI tools, ML pipelines            │
│  • SLOs: freshness, completeness, success rate      │
└─────────────────────────────────────────────────────┘
```

→ Full detail: [Storage Architecture](architecture/05-storage.md)

---

## 8. Developer Experience

The developer workflow is designed for speed and safety. Engineers work in a local IDE against real cluster infrastructure — no local Spark, no mock data, no environment drift.

### Phase 1 — Interactive development (VS Code → Spark Connect → dev)

```python
spark = SparkSession.builder \
    .remote("sc://spark-connect.dev.forge.internal:15002") \
    .getOrCreate()

df = spark.read.format("delta") \
    .load("abfss://bronze@adlsforgedev.dfs.core.windows.net/crm/orders/")
df.show()
```

### Phase 2 — Scaffold a notebook with the Forge SDK

Production jobs are **Jupyter notebooks** (`.ipynb`), not standalone `.py` files. The SDK generates a complete notebook with locked preamble, performance settings, and parameter injection — engineers fill in one section.

```bash
# Generate a silver notebook scaffold:
forge generate silver --dataset crm_orders
# → src/spark/jobs/crm_orders_silver.ipynb
```

The generated notebook has:
- **🔒 SDK-locked cells** (preamble, perf settings, params, write, tracker) — not to be edited
- **✏️ Business logic zone** — the only section engineers modify

```python
# ✏️ BUSINESS LOGIC — inside the editable zone
df = (
    raw
    .dropDuplicates(["order_id"])
    .dropna(subset=["order_id", "customer_id"])
)
```

**Performance settings baked in** (all jobs get these automatically):

| Setting | Value | Why |
|---------|-------|-----|
| `spark.sql.adaptive.enabled` | `true` | AQE: auto-optimises join strategies and partition sizes |
| `spark.sql.shuffle.partitions` | `48` / `96` | Right-sized for bronze/silver workloads |
| `spark.databricks.delta.optimizeWrite.enabled` | `true` | Coalesces small files on write |
| `spark.sql.parquet.vorder.enabled` | `true` | V-Order layout — critical for Trino / BI reads on gold |

**Execution model:** Papermill executes notebooks natively on Spark — no `.py` conversion required. `mainApplicationFile` in the `SparkApplication` spec points to a shared `papermill_runner.py`; the notebook path is passed as the `NOTEBOOK_PATH` environment variable.

**tracker.json:** Every run writes a `tracker.json` to the output path (e.g., `silver/nyc_taxi/trips/_tracker/`). This is the authoritative record that a pipeline partition ran — written irrespective of DQ outcome.

### Phase 3 — Schedule via Airflow DAG

```python
# examples/orchestration/airflow/dags/transformation/crm_orders_silver_dag.py
SparkKubernetesOperator(
    task_id="crm_orders_silver",
    application_file=_SILVER_SPEC,   # SparkApplication YAML inline
    ...
)
# SparkApplication spec:
#   mainApplicationFile: "abfss://code@<account>.dfs.core.windows.net/spark/runners/papermill_runner.py"
#   env NOTEBOOK_PATH:   "abfss://code@<account>.dfs.core.windows.net/spark/notebooks/crm_orders_silver.ipynb"
```

### Phase 4 — PR → CI gates → dev deploy → prod promotion

→ Full detail: [Developer Experience Guide](guides/developer-experience.md) · [Environment Promotion](architecture/14-environment-promotion.md)

---

## 9. Cross-Cutting Concerns

### 9.1 Networking

- All AKS clusters have **public API server endpoints** — secured via AAD RBAC; no local accounts
- All PaaS services (ADLS, Key Vault, ACR) are accessed via **private endpoints only** — no public data plane
- Outbound SNAT via pre-created static public IPs (S360 NS2.1.1 ipTag compliant)
- Calico network policies enforce pod-to-pod traffic rules within each cluster

→ Full detail: [Networking Architecture](architecture/03-networking.md)

### 9.2 Identity & Secrets

- **No long-lived credentials** — all service-to-service access via Azure Workload Identity (OIDC federation)
- **No secrets in environment variables or config maps** — all secrets retrieved from Key Vault at runtime via CSI driver
- **Five dedicated workload identities per environment** — each workload runs with exactly the permissions it needs; a compromised workload cannot escalate to other workloads' data or keys
- **Managed identities:**

| Identity | Used by | Storage permissions | KV |
|----------|---------|--------------------|----|
| `id-forge-spark-{alias}-{env}` | Spark Operator pods | **Data Contributor**: bronze, silver, gold, code, checkpoints | Secrets User |
| `id-forge-trino-{alias}-{env}` | Trino query pods | **Data Reader**: silver, gold | Secrets User |
| `id-forge-airflow-{alias}-{env}` | Airflow task pods | **Data Contributor**: bronze · **Data Reader**: code | Secrets User |
| `id-forge-dq-{alias}-{env}` | DQ framework pods | **Data Reader**: bronze, silver, gold | Secrets User |
| `id-forge-portal-{alias}-{env}` | Developer Portal API | **Data Reader**: gold | Secrets User |

Plus 4 AKS infrastructure identities (2× control plane, 2× kubelet) — one set per cluster. See [Infrastructure Overview](architecture/01-overview.md) for the full identity inventory.

All storage role assignments are scoped directly to the individual container (not the storage account), providing container-level least privilege without ABAC conditions.

→ Full detail: [Security (S360)](architecture/04-security-s360.md)

### 9.3 Data Governance

- **Schema enforcement** at the silver layer — no schema drift reaches consumers
- **DQ gates** at every layer transition — failures halt the pipeline and quarantine data
- **Lineage tracking** — every dataset write records its upstream sources, job, and run ID
- **Restatement protocol** — corrupted or late-arriving data is corrected via the controlled restatement process, not ad-hoc overwrites

---

## 10. Delivery Lifecycle

All changes flow through Git — no direct deploys.

```
feature/my-pipeline
        │
        │  PR opened  →  CI: lint, tests, DQ validation, image scan
        │
        ▼
      main  ──────────────────────────────────────▶  dev auto-deploys on merge
        │                                             DAG changes live in 30s
        │  platform team tags release
        ▼
  release/vX.Y  ──────────────────────────────────▶  prod pipeline
                                                       manual approval gate
                                                       ▼
                                                      prod deployed
```

| Change type | Deploy mechanism | Speed |
|-------------|-----------------|-------|
| DAG-only | Airflow git-sync | 30 seconds |
| Spark job code | CD pipeline uploads to ADLS | ~5 minutes |
| Helm config | CD pipeline `helm upgrade` | ~10 minutes |
| Bicep infra | CD pipeline `az deployment sub create` | ~20 minutes |
| Image rebuild | CD pipeline build → scan → push → upgrade | ~30 minutes |

→ Full detail: [CI/CD Pipeline](implementation/06-cicd.md) · [Environment Promotion](architecture/14-environment-promotion.md)

---

## 11. Implementation Roadmap

| Phase | Scope | Duration |
|-------|-------|----------|
| **0 — Design & Foundations** | Final architecture, naming, DNS, repo structure, standards | 1–2 weeks |
| **1 — Networking & Clusters** | VNets, private endpoints, ACR, AKS clusters (both envs) | 2 weeks |
| **2 — Compute Services** | Spark Operator, Spark Connect, Trino deployed to dev → prod | 3 weeks |
| **3 — Orchestration Services** | Airflow, Purview OpenLineage integration, Azure Monitor, Developer Portal to dev → prod | 3 weeks |
| **4 — Data Quality & Lineage** | DQ framework, OpenLineage integration, dashboards | 3–4 weeks |
| **5 — Hardening & Rollout** | Security review, cost guardrails, runbooks, onboarding docs | 2 weeks |

**Total:** ~14–16 weeks from greenfield to production-ready platform.

---

## 12. Deep-Dive Reference Index

| # | Topic | Document |
|---|-------|---------|
| 1 | Infrastructure reference — resource groups, clusters, networking, identities | [01-overview](architecture/01-overview.md) |
| 2 | Resource group inventory — every resource, why it exists | [02-rg-inventory](architecture/02-rg-inventory.md) |
| 3 | VNets, private endpoints, Calico, DNS | [03-networking](architecture/03-networking.md) |
| 4 | Workload identity, Key Vault, RBAC, S360 | [04-security-s360](architecture/04-security-s360.md) |
| 5 | Bronze/silver/gold layers, partitioning, trackers | [05-storage](architecture/05-storage.md) |
| 6 | Spark Operator, Spark Connect, Trino | [06-compute](architecture/06-compute.md) |
| 7 | Airflow executor, DAG patterns, operators | [07-orchestration](architecture/07-orchestration.md) |
| 8 | Azure Monitor, Grafana, Log Analytics, SLOs | [08-observability](architecture/08-observability.md) |
| 9 | DQ rule types, YAML format, severity gating | [09-dq-framework](architecture/09-dq-framework.md) |
| 10 | OpenLineage, Microsoft Purview, column-level lineage | [10-lineage](architecture/10-lineage.md) |
| 11 | Developer Portal API and frontend | [11-developer-portal](architecture/11-developer-portal.md) |
| 12 | Full data flow: source → gold | [12-end-to-end-flow](architecture/12-end-to-end-flow.md) |
| 13 | Restatement, backfill, partition recovery | [13-restatement](architecture/13-restatement.md) |
| 14 | Dev vs prod, Spark Connect vs Operator, PR flow | [14-environment-promotion](architecture/14-environment-promotion.md) |
| — | VS Code setup, cluster connection, DAG authoring | [developer-experience](guides/developer-experience.md) |
| — | ACR, image builds, cluster provisioning, Helm deploys | [implementation/](implementation/01-acr-setup.md) |
| — | Component versions, upgrade policy | [components-versions](implementation/components-versions.md) |
