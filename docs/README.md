# Forge Documentation

---

## Architecture

Deep-dive into how each part of the platform is designed.

| Document | What it covers |
|----------|---------------|
| [`end-to-end-flow.md`](./architecture/end-to-end-flow.md) | **Start here.** Full system map, Bronze→Silver→Gold flow, DAG lifecycle, lineage graph, observability during a run |
| [`compute-architecture.md`](./architecture/compute-architecture.md) | Spark Operator, Spark Connect, Trino, node pools, ADLS access, cost tracking |
| [`orchestration-architecture.md`](./architecture/orchestration-architecture.md) | Airflow KubernetesExecutor, DAG git-sync, Key Vault secrets backend, scheduler HA |
| [`dq-framework.md`](./architecture/dq-framework.md) | YAML rulesets, 4 check types (schema/content/volume/freshness), severity gating, DQ results store |
| [`lineage-architecture.md`](./architecture/lineage-architecture.md) | OpenLineage events, pipeline + dataset upstream/downstream traversal, column-level lineage, impact analysis |
| [`developer-portal-architecture.md`](./architecture/developer-portal-architecture.md) | Portal API + Web, auth flow, all 6 API domains, caching, deployment |
| [`observability-architecture.md`](./architecture/observability-architecture.md) | Azure Monitor / Container Insights, Azure Managed Grafana, Azure Log Analytics, Azure Monitor Alerts, SLOs, cost telemetry |
| [`networking-architecture.md`](./architecture/networking-architecture.md) | VNet layout, private endpoints, DNS resolution, Calico policies, NSGs |
| [`security-s360.md`](./architecture/security-s360.md) | S360 compliance: workload identity, Key Vault, Defender, audit logging, vulnerability management |

---

## Implementation

Step-by-step guides for building and deploying the platform. Follow in order.

| Step | Document | What it covers |
|------|----------|---------------|
| 0 | [`00-overview.md`](./implementation/00-overview.md) | Prerequisites, environment naming, Bicep deployment overview |
| 1 | [`01-acr-setup.md`](./implementation/01-acr-setup.md) | Create ACR, private endpoint, Defender, assign pull/push roles |
| 2 | [`02-image-builds.md`](./implementation/02-image-builds.md) | Build all custom images (Spark 4.1, Trino, Airflow, Portal), import third-party images, push to ACR |
| 3 | [`03-cluster-setup.md`](./implementation/03-cluster-setup.md) | Bicep provisioning + AKS bootstrap (both clusters), workload identity, CSI secrets, namespaces |
| 4 | [`04-deploy-compute.md`](./implementation/04-deploy-compute.md) | Deploy Hive Metastore, Spark Operator, Spark Connect, Trino |
| 5 | [`05-deploy-orchestration.md`](./implementation/05-deploy-orchestration.md) | Deploy Airflow, Marquez, verify Container Insights / Azure Managed Grafana, Developer Portal |
| — | [`components-versions.md`](./implementation/components-versions.md) | Full version matrix, ACR strategy, custom image contents, upgrade policy |

---

## Guides

How-to guides for day-to-day use.

| Document | Audience |
|----------|---------|
| [`developer-experience.md`](./guides/developer-experience.md) | Data engineers: VS Code + Spark Connect setup, DAG authoring, DQ rules, pipeline workflow, CLI reference |

---

## Root Files

| File | Purpose |
|------|---------|
| [`/README.md`](../README.md) | Platform overview, quick start |
| [`/ARCHITECTURE.md`](../ARCHITECTURE.md) | Architecture summary with ADRs — read before the deep-dives |
