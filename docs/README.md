# Forge Documentation

---

## Architecture

Deep-dive into how each part of the platform is designed. Read in order for the full picture.

| # | Document | What it covers |
|---|----------|---------------|
| 1 | [`01-overview.md`](./architecture/01-overview.md) | **Infrastructure reference.** Resource groups, AKS clusters, node pools, networking, identities, storage, Key Vault, observability, known quirks |
| 2 | [`02-rg-inventory.md`](./architecture/02-rg-inventory.md) | **Resource group inventory.** Every Azure resource, which RG it lives in, why it exists, and what uses it |
| 3 | [`03-networking.md`](./architecture/03-networking.md) | VNet layout, private endpoints, DNS resolution, Calico policies, NSGs |
| 4 | [`04-security-s360.md`](./architecture/04-security-s360.md) | S360 compliance: workload identity, Key Vault, Defender, audit logging, vulnerability management |
| 5 | [`05-storage.md`](./architecture/05-storage.md) | Medallion zones, partitioning standard, run trackers, DQ results files, versioning |
| 6 | [`06-compute.md`](./architecture/06-compute.md) | Spark Operator, Spark Connect, Trino, node pools, ADLS access, cost tracking |
| 7 | [`07-orchestration.md`](./architecture/07-orchestration.md) | Airflow KubernetesExecutor, DAG git-sync, Key Vault secrets backend, scheduler HA |
| 8 | [`08-observability.md`](./architecture/08-observability.md) | Azure Monitor, Container Insights, Azure Managed Grafana, Log Analytics, SLOs, cost telemetry |
| 9 | [`09-dq-framework.md`](./architecture/09-dq-framework.md) | YAML rulesets, 4 check types (schema/content/volume/freshness), severity gating, DQ results store |
| 10 | [`10-lineage.md`](./architecture/10-lineage.md) | OpenLineage events, pipeline + dataset traversal, column-level lineage, impact analysis |
| 11 | [`11-developer-portal.md`](./architecture/11-developer-portal.md) | Portal API + Web, auth flow, all 6 API domains, caching, deployment |
| 12 | [`12-end-to-end-flow.md`](./architecture/12-end-to-end-flow.md) | Full system map, Bronze→Silver→Gold flow, DAG lifecycle, observability during a run |
| 13 | [`13-restatement.md`](./architecture/13-restatement.md) | Partition restatement, backfill, Restatement Registry, safety guards, SDK usage |
| 14 | [`14-environment-promotion.md`](./architecture/14-environment-promotion.md) | Dev vs prod, Spark Connect vs Spark Operator, PR→CI→dev→prod promotion flow, rollback |

---

## Implementation

Step-by-step guides for **building and deploying** the platform from zero. Follow in order for initial setup; use `forge-up.sh` for day-to-day deploys.

| Step | Document | What it covers |
|------|----------|---------------|
| 0 | [`00-forge-up.md`](./implementation/00-forge-up.md) | **Start here for deploys.** forge-up.sh flags, partial re-deploys, smoke test, teardown |
| 1 | [`01-acr-setup.md`](./implementation/01-acr-setup.md) | Create ACR, private endpoint, Defender, assign pull/push roles |
| 2 | [`02-image-builds.md`](./implementation/02-image-builds.md) | Build all custom images (Spark, Trino, Airflow, Portal), import third-party images, push to ACR |
| 3 | [`03-cluster-setup.md`](./implementation/03-cluster-setup.md) | Bicep provisioning + AKS bootstrap (both clusters), workload identity, CSI secrets, namespaces |
| 4 | [`04-deploy-compute.md`](./implementation/04-deploy-compute.md) | Deploy Hive Metastore, Spark Operator, Spark Connect, Trino |
| 5 | [`05-deploy-orchestration.md`](./implementation/05-deploy-orchestration.md) | Deploy Airflow, verify Container Insights / Azure Managed Grafana, Developer Portal |
| — | [`components-versions.md`](./implementation/components-versions.md) | Full version matrix, ACR strategy, custom image contents, upgrade policy |

---

## Guides

| Document | Audience |
|----------|---------|
| [`developer-experience.md`](./guides/developer-experience.md) | Data engineers: VS Code + Spark Connect setup, DAG authoring, DQ rules, pipeline workflow, CLI reference |

---

## Runbooks

Incident response guides for on-call engineers.

| Runbook | Covers |
|---------|--------|
| [`01-airflow-down.md`](./runbooks/01-airflow-down.md) | Scheduler crash, DB connectivity, git-sync failures, SparkKubernetesOperator failures |
| [`02-dq-failure.md`](./runbooks/02-dq-failure.md) | DQ critical failures blocking pipeline, threshold calibration, emergency bypass procedure |
| [`03-adls-connectivity.md`](./runbooks/03-adls-connectivity.md) | 403 errors, missing role assignments, workload identity issues, storage firewall |

---

## Root Files

| File | Purpose |
|------|---------|
| [`/README.md`](../README.md) | Platform overview, quick start |
| [`/docs/platform-brief.md`](./platform-brief.md) | One-page platform summary — what it is, what it solves, all components, security, where to start |
| [`/docs/DESIGN.md`](./DESIGN.md) | Platform design reference — principles, two-cluster model, all layers, delivery lifecycle, roadmap |

## Reference (Printable / Shareable)

| File | Purpose |
|------|---------|
| [`reference/Forge-Platform-Brief.docx`](./reference/Forge-Platform-Brief.docx) | One-pager DOCX with architecture diagram — for sharing with stakeholders |
| [`reference/Forge-Platform-Design-Reference.docx`](./reference/Forge-Platform-Design-Reference.docx) | Full design reference DOCX — principles, clusters, storage, security, observability, document index |
| [`reference/forge-logo.png`](./reference/forge-logo.png) | Forge logo (PNG) |
| [`reference/forge-logo.svg`](./reference/forge-logo.svg) | Forge logo (SVG — for docs, presentations) |

> Regenerate DOCX files after doc changes: `python infra/scripts/generate-docs.py`
