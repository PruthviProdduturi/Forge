# Forge — Environment Promotion & Developer Workflow

> **Version:** 1.0
> **Status:** Production
> **Audience:** Data engineers, platform engineers

---

## Table of Contents

1. [Environment Overview](#1-environment-overview)
2. [Spark Connect vs Spark Operator — When to Use Each](#2-spark-connect-vs-spark-operator--when-to-use-each)
3. [Developer Journey — End to End](#3-developer-journey--end-to-end)
4. [Dev → Prod Promotion Flow](#4-dev--prod-promotion-flow)
5. [What Lives in Each Environment](#5-what-lives-in-each-environment)
6. [CI/CD Pipeline Gates](#6-cicd-pipeline-gates)
7. [DAG Changes vs Job Code Changes](#7-dag-changes-vs-job-code-changes)
8. [Rollback Strategy](#8-rollback-strategy)

---

## 1. Environment Overview

Forge runs two environments — `dev` and `prod`. They are structurally identical (same clusters, same components, same networking model) but serve different purposes.

```
┌──────────────────────────────────────────────────────────────────────┐
│                         dev environment                              │
│                                                                      │
│  forge-compute-dev (AKS)        forge-orchestration-dev (AKS)       │
│  ┌────────────────────────┐     ┌──────────────────────────────┐    │
│  │  Spark Operator        │     │  Airflow (dev DAGs)          │    │
│  │  Spark Connect ◄───────┼─────┼── VS Code / notebooks        │    │
│  │  Trino                 │     │  Developer Portal           │    │
│  └────────────────────────┘     │  Azure Monitor / Grafana     │    │
│                                 └──────────────────────────────┘    │
│  ADLS dev account                                                    │
│  bronze-dev / silver-dev / gold-dev / sandbox-dev                   │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        prod environment                              │
│                                                                      │
│  forge-compute-prod (AKS)       forge-orchestration-prod (AKS)      │
│  ┌────────────────────────┐     ┌──────────────────────────────┐    │
│  │  Spark Operator        │     │  Airflow (prod DAGs)         │    │
│  │  NO Spark Connect      │     │  Developer Portal           │    │
│  │  Trino                 │     │  Azure Monitor / Grafana     │    │
│  └────────────────────────┘     └──────────────────────────────┘    │
│                                                                      │
│  ADLS prod account                                                   │
│  bronze / silver / gold  (no sandbox in prod)                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Key difference:** `dev` has a live **Spark Connect server** that developers connect to interactively from VS Code. `prod` has no Spark Connect — every Spark job runs exclusively through the **Spark Operator**, triggered by Airflow.

---

## 2. Spark Connect vs Spark Operator — When to Use Each

This is the single most important distinction for data engineers on the platform.

| | Spark Connect | Spark Operator |
|--|--------------|----------------|
| **What it is** | Client-server gRPC protocol. Your VS Code process sends a logical plan to a remote Spark Connect server pod, which executes on the cluster | Kubernetes operator that accepts `SparkApplication` CRDs and runs a Spark driver + executors on-cluster |
| **Trigger** | You — interactively from VS Code or a notebook | Airflow — via `SparkKubernetesOperator`, on a schedule or event |
| **Environment** | **Dev only** | **Dev and Prod** |
| **SparkSession** | `SparkSession.builder.remote("sc://10.x.x.x:15002").getOrCreate()` | `SparkSession.builder.appName("my-job").getOrCreate()` — Spark Operator injects cluster config |
| **Use case** | Writing and iterating on transformation logic interactively | Running scheduled, automated, production-grade pipeline jobs |
| **Data written** | To dev ADLS only (you control the path) | To the appropriate ADLS container per the pipeline definition |
| **Lineage emitted** | No automatic lineage (sandbox is excluded) | Yes — OpenLineage emits START/COMPLETE/FAIL events to Purview |

### The mental model

Think of Spark Connect as your **workbench** — you're in VS Code, reading a subset of dev data, trying transformations, checking output shapes, tuning logic.

Once your logic works, you **package it as a Spark job** (a `.py` file under `compute/spark/jobs/`) and define a `SparkApplication` CRD for the Spark Operator to run. That job is what gets scheduled by Airflow and runs in both dev and prod.

```
Phase 1: Write & iterate           Phase 2: Package as job          Phase 3: Schedule & promote
─────────────────────────          ─────────────────────────         ──────────────────────────
VS Code                            compute/spark/jobs/               Airflow DAG
  │                                  my_transform.py                   SparkKubernetesOperator
  │  sc://spark-connect:15002         │                                 │
  └──▶ Spark Connect (dev)            │  spark = SparkSession           └──▶ SparkApplication CRD
       (interactive, no lineage)      │    .builder                          (Spark Operator)
                                      │    .appName("my-transform")          runs on dev → then prod
                                      │    .getOrCreate()                    emits lineage
                                      │  # No .remote() — Operator handles it
```

### Why no Spark Connect in prod?

1. **No interactive access to prod data** — prod data contains real customer / operational data; interactive queries bypass DQ, lineage, and audit controls
2. **Resource isolation** — Spark Connect keeps a persistent driver alive; in prod every job gets its own driver that is torn down on completion
3. **Auditability** — every prod Spark execution goes through Airflow and emits a lineage event; ad-hoc Connect sessions do not

---

## 3. Developer Journey — End to End

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. LOCAL DEVELOPMENT                                                   │
│                                                                         │
│  Developer opens VS Code                                                │
│  Connects to Spark Connect on forge-compute-dev                         │
│  sc://spark-connect.dev.forge.internal:15002                            │
│                                                                         │
│  Reads dev data:                                                        │
│  abfss://bronze@adlsforgedev.dfs.core.windows.net/crm/orders/          │
│                                                                         │
│  Writes exploratory output to sandbox:                                  │
│  abfss://sandbox@adlsforgedev.dfs.core.windows.net/<alias>/orders/     │
│  (28-day TTL, no lineage, no DQ enforcement)                           │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │  logic is proven, ready to productionise
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  2. PACKAGE AS A JOB                                                    │
│                                                                         │
│  compute/spark/jobs/crm_orders_silver.py                               │
│    - SparkSession via .builder (no .remote)                            │
│    - Reads from bronze, writes to silver                                │
│    - Emits OpenLineage events                                           │
│                                                                         │
│  orchestration/airflow/dags/crm_orders_dag.py                          │
│    - SparkKubernetesOperator → SparkApplication CRD                    │
│    - schedule="@daily"                                                  │
│    - DQ check task after Spark job task                                 │
│    - OpenLineage emitted automatically                                  │
│                                                                         │
│  orchestration/dq/rules/crm_orders_silver.yaml                         │
│    - null rate, uniqueness, range checks                                │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │  push to feature branch
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  3. TEST IN DEV (via Spark Operator)                                    │
│                                                                         │
│  git push origin feature/crm-orders-silver                             │
│                                                                         │
│  Airflow dev git-sync picks up the DAG within 30s                      │
│  Trigger the DAG manually in Airflow dev UI                            │
│                                                                         │
│  Airflow submits SparkApplication CRD →                                │
│    forge-compute-dev runs the job via Spark Operator                   │
│    (same execution path as prod — no Spark Connect involved)           │
│                                                                         │
│  Check:                                                                 │
│    Spark UI → job completed, no OOM                                    │
│    silver/crm/orders/ → data written correctly                         │
│    DQ task → all checks passed                                         │
│    Purview → lineage graph shows bronze → silver edge                  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │  dev run passes
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  4. RAISE PR → CODE REVIEW → MERGE TO MAIN                             │
│                                                                         │
│  PR opened: feature/crm-orders-silver → main                           │
│                                                                         │
│  CI pipeline runs automatically (Azure DevOps):                        │
│    ✓ Python lint (ruff)                                                 │
│    ✓ Unit tests (pytest)                                                │
│    ✓ DQ ruleset schema validation                                       │
│    ✓ Bicep what-if (if infra changed)                                   │
│    ✓ Image build + Defender scan (if Dockerfile changed)               │
│                                                                         │
│  PR reviewer approves → merged to main                                 │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │  merge to main triggers CD
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  5. DEPLOY TO PROD                                                      │
│                                                                         │
│  Release pipeline triggered on tag (release/vX.Y):                    │
│    Stage 1: Build images (if changed) → push to forgeacr-prod          │
│    Stage 2: Bicep deploy → prod Azure resources                        │
│    Stage 3: Helm upgrade → prod clusters                               │
│    Stage 4: Manual approval gate  ◄── platform lead approves           │
│    Stage 5: DAG changes sync via git-sync (live within 30s)            │
│                                                                         │
│  Airflow prod picks up the new DAG on next git-sync cycle              │
│  First scheduled run → Spark Operator on forge-compute-prod            │
│  Writes to prod ADLS: abfss://silver@adlsforgeprod.dfs.core.windows.net│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Dev → Prod Promotion Flow

### Branch and release model

```
feature/crm-orders-silver
         │
         │  PR review + CI gates
         ▼
       main  ──────────────────────────────────────────▶  always deployable
         │                                                 (dev auto-deploys on merge)
         │  platform team creates release
         ▼
  release/v1.3  ─────────────────────────────────────▶  triggers prod release pipeline
         │
         │  tag v1.3.0
         ▼
       prod  ◄──── manual approval gate
```

### What triggers what

| Event | What happens |
|-------|-------------|
| Push to `feature/*` | CI pipeline runs (lint, test, scan). No deployment. |
| PR merged to `main` | CD pipeline deploys to **dev** automatically |
| DAG-only change merged to `main` | Airflow git-sync picks it up in **dev** within 30s — no pipeline run needed |
| `release/vX.Y` branch created | Release pipeline starts. Deploys to **prod** after manual gate. |
| Image tag changed | Full pipeline: build → scan → push to prod ACR → Helm upgrade |
| Bicep changed | `az deployment sub what-if` runs first; human reviews diff; then applies |

### Promotion checklist

Before creating a `release/` branch, confirm:

- [ ] All CI checks green on `main`
- [ ] Job ran successfully in dev (Spark Operator — not just Spark Connect interactive)
- [ ] DQ checks passed in dev
- [ ] Lineage graph visible in Purview dev
- [ ] No pending infra `what-if` changes that need separate review
- [ ] Data volume in dev run is representative (not just a 10-row sample)

---

## 5. What Lives in Each Environment

| Resource | dev | prod |
|----------|-----|------|
| Spark Connect server | ✅ Yes — `sc://10.x.x.x:15002` | ❌ No |
| Spark Operator | ✅ Yes | ✅ Yes |
| Trino | ✅ Yes | ✅ Yes |
| Airflow | ✅ Yes (git-sync from `main`) | ✅ Yes (git-sync from release tag) |
| Microsoft Purview | ✅ Yes | ✅ Yes |
| Azure Managed Grafana | ✅ Yes | ✅ Yes |
| Sandbox ADLS container | ✅ Yes (28-day TTL) | ❌ No |
| ADLS bronze/silver/gold | ✅ dev account | ✅ prod account |
| ACR | `forgeacr-dev.azurecr.io` | `forgeacr-prod.azurecr.io` |
| Key Vault | `kv-forge-dev` | `kv-forge-prod` |
| AKS cluster names | `aks-forge-compute-dev` / `aks-forge-orch-dev` | `aks-forge-compute-prod` / `aks-forge-orch-prod` |
| Manual approval gate | ❌ Not required | ✅ Required before deployment |
| Spark Operator executor count | Smaller (cost) | Larger (SLA) |

---

## 6. CI/CD Pipeline Gates

### PR gate (runs on every PR to `main`)

```
PR opened
    │
    ├── Python lint (ruff)          ← fail = PR blocked
    ├── Unit tests (pytest)         ← fail = PR blocked
    ├── DQ ruleset validation       ← fail = PR blocked
    ├── Type check (mypy)           ← fail = PR blocked
    ├── Bicep build (syntax)        ← fail = PR blocked
    └── Image scan (if Dockerfile   ← fail = PR blocked
        changed)
```

### Dev CD pipeline (runs on merge to `main`)

```
Merge to main
    │
    ├── Build changed images → push to forgeacr-dev
    ├── az deployment sub create → dev infra (Bicep)
    ├── helm upgrade → dev compute cluster
    ├── helm upgrade → dev orchestration cluster
    └── Done — dev is live (DAGs also auto-sync via git-sync)
```

### Prod release pipeline (runs on `release/vX.Y` tag)

```
release/vX.Y tag pushed
    │
    ├── Build images → push to forgeacr-prod
    ├── az deployment sub what-if → human reviews
    │       │
    │       ▼
    │   ┌─────────────────────────┐
    │   │  MANUAL APPROVAL GATE  │  ◄── platform lead must approve
    │   └─────────────────────────┘
    │       │
    ├── az deployment sub create → prod infra
    ├── helm upgrade → prod compute cluster
    ├── helm upgrade → prod orchestration cluster
    └── Done — Airflow prod git-syncs new DAGs within 30s
```

---

## 7. DAG Changes vs Job Code Changes

There are two kinds of data engineering changes and they have different promotion speeds:

### DAG-only changes (fast path)

If you only change files in `orchestration/airflow/dags/` — schedule, task order, DQ ruleset reference, retry config — Airflow's git-sync picks this up automatically on both dev and prod (prod syncs from the release tag). **No image rebuild. No Helm upgrade. No pipeline run required.**

```
Merge to main
    └── Airflow dev git-sync detects change → live in 30s

release/v1.3 tag
    └── Airflow prod git-sync detects change → live in 30s
```

### Job code changes (standard path)

If you change files in `compute/spark/jobs/` — the PySpark transformation logic — these files are uploaded to ADLS at deploy time (`code/` container), not baked into an image. The job's `SparkApplication` CRD references the ADLS path, so the Spark Operator always pulls the latest uploaded version on the next run.

```
compute/spark/jobs/crm_orders_silver.py
    │
    └── CD pipeline uploads to:
        abfss://code@adlsforgedev.dfs.core.windows.net/jobs/crm_orders_silver.py  (dev)
        abfss://code@adlsforgeprod.dfs.core.windows.net/jobs/crm_orders_silver.py (prod)
```

### Image changes (slowest path)

If you change a `Dockerfile` (Spark base image, Airflow base image, portal image) — a full image build, scan, and push is required. This is the slowest path and only needed when adding new Python packages or updating base image versions.

---

## 8. Rollback Strategy

| Scenario | How to roll back |
|----------|-----------------|
| Bad DAG merged | Revert the commit on `main` → git-sync auto-fixes dev within 30s; create a new `release/` patch tag for prod |
| Bad Spark job logic | Revert the commit → CD pipeline re-uploads previous job file to ADLS; next Airflow run uses it |
| Bad image deployed to prod | `helm upgrade` with previous image tag (`{version}-{previous-sha}`) — no Git change needed |
| Bad infra change (Bicep) | Re-run `az deployment sub create` with the previous parameter file from Git history |
| Data written to wrong partition | Restatement job — see [Restatement Architecture](13-restatement.md) |
