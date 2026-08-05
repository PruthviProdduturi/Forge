# Forge — Platform Brief

> One-page summary of what Forge is, what it does, and how it is built.

---

## What is Forge?

Forge is the core platform that moves data from raw source systems to governed, serving-ready analytics — reliably, observably, and at scale. It is the single system through which all data enters the lakehouse, gets validated, and becomes trusted for downstream consumption.

---

## What problems does it solve?

| Problem | How Forge addresses it |
|---|---|
| Raw data from many sources is unreliable and inconsistent | Medallion lakehouse with DQ gates at every layer transition — no unvalidated data reaches consumers |
| Ad-hoc Spark jobs run on developer laptops with no governance | Spark Operator on AKS — every production job is scheduled, tracked, and auditable |
| "Who changed this data and when?" is unanswerable | OpenLineage events on every job — full column-level lineage from source to gold |
| Secrets in code, shared credentials, manual access management | Workload Identity (OIDC) + Key Vault — zero long-lived credentials anywhere in the platform |
| Engineers wait hours for environment setup | VS Code + Spark Connect — write and run Spark code against a live dev cluster in minutes |
| Pipeline failures are discovered by data consumers, not the platform | DQ gates halt pipelines on failure; Azure Monitor Alerts notify on-call before data ships |

---

## Platform Components

### Two AKS Clusters

| Cluster | What runs on it | Why separate |
|---|---|---|
| **Compute** `aks-forge-compute-*` | Spark Operator, Spark Connect (dev), Trino | Elastic — scales aggressively with workload; failures here do not affect orchestration |
| **Orchestration** `aks-forge-orchestration-*` | Airflow, DQ runner, Developer Portal | Stable — always-on services; sized conservatively; never interrupted by Spark scaling |

### ADLS Gen2 Lakehouse

```
Source Systems
      │
      ▼  raw ingest
  bronze/   — append-only, schema-on-read, immutable source of truth
      │
      ▼  Spark transform + DQ gate
  silver/   — cleaned, schema-enforced, DQ-validated, Delta Lake
      │
      ▼  aggregation + SLA
  gold/     — consumer-ready, SLA-governed, read by BI / ML / Portal
```

### Platform Services

| Service | What it does |
|---|---|
| **Apache Airflow** | Schedules all pipelines via `KubernetesExecutor` — each task gets its own pod |
| **Spark Operator** | Runs batch Spark jobs submitted by Airflow as `SparkApplication` CRDs |
| **Spark Connect** | Dev-only interactive Spark endpoint — engineers write code from VS Code against a live cluster |
| **Trino** | Federated SQL over the gold and silver layers — used by BI tools and ad-hoc queries |
| **DQ Framework** | YAML-defined quality rules (schema, content, volume, freshness) gating every layer transition |
| **Developer Portal** | Web UI + API for pipeline status, dataset catalogue, DQ results, lineage explorer, cost |
| **Azure Monitor + Grafana** | Platform-wide observability — metrics, logs, alerts, dashboards, SLOs |

---

## Security Posture (S360)

| Principle | Implementation |
|---|---|
| No long-lived credentials | Azure Workload Identity (OIDC) — pods exchange K8s tokens for short-lived Azure tokens |
| No secrets in code or config | Azure Key Vault + CSI driver — secrets mounted as in-memory volumes at pod start |
| Per-workload least privilege | 5 dedicated managed identities — Spark, Trino, Airflow, DQ, Portal — each with minimum required permissions |
| No public data plane | ADLS, Key Vault, ACR all behind private endpoints — unreachable from the internet |
| Audit trail | Every `kubectl` command, every secret access, every storage read/write logged in Log Analytics |
| Threat detection | Microsoft Defender for Containers, Storage, Key Vault, and CSPM — all at subscription scope |

---

## Developer Workflow

```
1. Write   VS Code notebook → Spark Connect → live dev cluster (real data, real results)
2. Test    forge generate → scaffold → business logic → run DQ locally
3. Review  PR → CI: lint, tests, DQ validation, image scan
4. Deploy  Merge to main → auto-deploy to dev (DAGs live in 30s)
5. Promote Release tag → manual approval → prod deployment
```

---

## Infrastructure at a Glance

| What | Detail |
|---|---|
| Cloud | Azure (West Central US) |
| Infrastructure as Code | Bicep — single `az deployment sub create` provisions everything |
| Kubernetes | AKS 1.32, Azure CNI Overlay, Calico network policy |
| Storage | ADLS Gen2 with hierarchical namespace, Delta Lake 4.0 |
| Container Registry | Private ACR with Defender image scanning |
| Environments | `dev` (personal, alias-scoped) → `prod` (shared, release-gated) |
| Compliance | S360 — full control mapping in [04-security-s360](architecture/04-security-s360.md) |

---

## Where to go next

| I want to… | Go to |
|---|---|
| Understand the full design and principles | [DESIGN.md](DESIGN.md) |
| See exactly what Azure resources are deployed | [02-rg-inventory.md](architecture/02-rg-inventory.md) |
| Connect to the cluster and start coding | [developer-experience.md §1](guides/developer-experience.md#1-cluster-access-setup-aad) |
| Understand the full data flow end-to-end | [12-end-to-end-flow.md](architecture/12-end-to-end-flow.md) |
| Deploy the platform from scratch | [Implementation guides](implementation/01-acr-setup.md) |
| Check S360 compliance status | [04-security-s360.md](architecture/04-security-s360.md) |
