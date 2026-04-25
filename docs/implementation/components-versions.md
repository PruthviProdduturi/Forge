# Forge — Component Versions & Container Registry Strategy

> **Status:** Production
> **Last updated:** 2026-04-09

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org) [![Delta Lake](https://img.shields.io/badge/Delta%20Lake-003366?style=flat-square&logo=delta&logoColor=white)](https://delta.io) [![Azure Monitor](https://img.shields.io/badge/Azure%20Monitor-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/monitor) [![Azure Managed Grafana](https://img.shields.io/badge/Azure%20Managed%20Grafana-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/managed-grafana) [![OpenLineage](https://img.shields.io/badge/OpenLineage-7B2FBE?style=flat-square&logoColor=white)](https://openlineage.io) [![Azure Key Vault](https://img.shields.io/badge/Key%20Vault-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/key-vault) [![ADLS Gen2](https://img.shields.io/badge/ADLS%20Gen2-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/storage/data-lake-storage)

---

## Principle: Own Every Image

Forge pulls **no images directly from public registries at runtime**. All container images — open source and custom — are:

1. Pulled from upstream (DockerHub / gcr.io / ghcr.io / quay.io) in a controlled import pipeline
2. Scanned by Defender for Containers
3. Re-tagged and pushed to Forge's private Azure Container Registry (`forgeacr<env>.azurecr.io`)
4. Deployed exclusively from ACR

No cluster node ever pulls from a public registry. This eliminates:
- Dependency on public registry availability
- Supply chain risk (image tampering, tag mutation)
- Egress bandwidth to public internet from cluster nodes
- Compliance exposure from unscanned third-party images

---

## Azure Container Registry

| Registry | Environment | SKU | Geo-replication |
|----------|------------|-----|----------------|
| `forgeacr{alias}.azurecr.io` | personal dev (ownerAlias set) | Premium | None |
| `forgeacr.azurecr.io` | shared / prod | Premium | Yes (prod only, secondary region) |

- **Private endpoint** only — no public registry access
- **Defender for Containers** enabled — all images scanned on push and on re-assessment
- **Content trust** — image signing via Notary v2 (Notation); clusters enforce signed images via OPA Gatekeeper
- **Retention policy** — untagged manifests deleted after 7 days; production images retained 1 year
- **Geo-replication** (prod) — images replicated to secondary Azure region for DR

---

## Component Version Matrix

### Compute Layer

| Component | Version | Base Image | ACR Tag | Notes |
|-----------|---------|-----------|---------|-------|
| **Apache Spark** | 4.1.1 | `eclipse-temurin:17-jre-jammy` | `forgeacr/spark:4.1.1` | Custom image — see below |
| **Spark Operator** | 2.5.0 | `ghcr.io/kubeflow/spark-operator:v2.5.0` | `forgeacr/spark-operator:2.5.0` | Imported, not modified |
| **Trino** | 480 | `trinodb/trino:480` | `forgeacr/trino:480` | Custom image (catalog-discovery plugin) |
| **Hive Metastore** | 4.0.0 | `apache/hive:4.0.0` | `forgeacr/hive-metastore:4.0.0` | Custom image — adds `azure-identity-extensions` for AAD PostgreSQL auth; upgraded from 3.1.3 (Hadoop 3.3.6, resolves 232 S360 CVEs) |
| **Delta Lake** | 4.1.0 | — | — | Bundled in Spark image as JAR; no separate container |
| **Apache Iceberg** | 1.10.1 | — | — | Bundled in Spark image as JAR (`iceberg-spark-runtime-4.0_2.13`) |

### Orchestration Layer

| Component | Version | Base Image | ACR Tag | Notes |
|-----------|---------|-----------|---------|-------|
| **Apache Airflow** | 3.1.8 | `apache/airflow:3.1.8-python3.11` | `forgeacr/airflow:3.1.8` | Custom image — see below |

### Observability Layer

| Component | Version | Type | Notes |
|-----------|---------|------|-------|
| **Azure Monitor / Container Insights** | AKS add-on (managed) | Azure-native managed service | Enabled via `az aks enable-addons monitoring`; no image to manage |
| **Azure Log Analytics Workspace** | Service (managed) | Azure-native managed service | Log aggregation; replaces self-hosted Loki |
| **Azure Managed Grafana** | Service (managed) | Azure-native managed service | Dashboards; replaces self-hosted Grafana |
| **Azure Monitor Agent (AMA)** | AKS add-on (managed) | Azure-native managed service | Log/metric collection DaemonSet; replaces Promtail |
| **Azure Monitor / Application Insights** | Service (managed) | Azure-native managed service | Distributed traces; replaces Grafana Tempo |
| **Azure Monitor Alerts / Action Groups** | Service (managed) | Azure-native managed service | Alert routing; replaces Alertmanager |
| **statsd-exporter** | 0.26.1 | `prom/statsd-exporter:v0.26.1` | `forgeacr/statsd-exporter:0.26.1` | For Airflow StatsD → Prometheus-format metrics (scraped by AMA) |

### Developer Portal

| Component | Version | Base Image | ACR Tag | Notes |
|-----------|---------|-----------|---------|-------|
| **Portal Backend** | — | `mcr.microsoft.com/cbl-mariner/base/python:3.11` | `forgeacr/portal-api:<git-sha>` | Built from source |
| **Portal Frontend** | — | `mcr.microsoft.com/cbl-mariner/base/node:20` | `forgeacr/portal-web:<git-sha>` | Built from source |

### Infrastructure / GitOps

| Component | Version | Base Image | ACR Tag | Notes |
|-----------|---------|-----------|---------|-------|
| **Secrets Store CSI Driver** | 1.4.4 | `mcr.microsoft.com/oss/...` | MCR (already Azure-hosted) | No re-tagging needed |
| **Azure Workload Identity** | 1.3.0 | `mcr.microsoft.com/oss/azure/...` | MCR (already Azure-hosted) | No re-tagging needed |
| **OPA Gatekeeper** | 3.16.3 | `openpolicyagent/gatekeeper:v3.16.3` | `forgeacr/gatekeeper:3.16.3` | Imported |

---

## Custom Images

### `forgeacr/spark:4.1.1`

Built from `infra/docker/spark/Dockerfile`. Build context is the repo root (required for `sdk/python/`).

**What's included:**
- OpenJDK 17 (Temurin, Ubuntu Jammy) base
- Spark 4.1.1 (Hadoop 3 distribution, Kubernetes-ready)
- Delta Lake 4.1.0 JAR + storage library
- Apache Iceberg 1.10.1 (`iceberg-spark-runtime-4.0_2.13` — Spark 4.x compatible)
- Hadoop Azure 3.4.1 — ABFS driver for ADLS Gen2
- Azure Identity + Azure Storage File DataLake JARs — workload identity token provider
- OpenLineage Spark 1.39.0 — automatic lineage emission
- Python 3.11, PySpark, delta-spark, pandas, pyarrow, openlineage-python 1.39.0
- `spark-defaults.conf` with ADLS and OpenLineage defaults baked in
- `forge-dq` SDK baked in from `sdk/python/`
- Non-root `spark` user (UID 185)

**Build triggers:**
- Spark version bump
- Delta Lake / Iceberg version bump
- `sdk/python/` (forge-dq) changes
- Security CVE in base image

### `forgeacr/airflow:3.1.8`

Built from `infra/docker/airflow/Dockerfile`.

**What's included:**
- Official `apache/airflow:3.1.8-python3.11` base
- `apache-airflow-providers-cncf-kubernetes` — SparkKubernetesOperator, KubernetesPodOperator
- `apache-airflow-providers-microsoft-azure` — ADLS hooks, Key Vault secrets backend
- `apache-airflow-providers-openlineage` — OpenLineage provider
- `openlineage-airflow` 1.39.0 — automatic START/COMPLETE/FAIL lineage for every task
- `forge-dq` and `forge-lineage` wheels (from `wheels/` in build context)
- Azure Workload Identity dependencies
- Provider versions pinned by the official Airflow 3.1.8 constraints file

### `forgeacr/trino:480`

Built from `infra/docker/trino/Dockerfile`.

**What's included:**
- Official `trinodb/trino:480` base (includes Delta Lake connector)
- Custom `catalog-discovery` plugin for dynamic per-tenant catalog registration (Forge-built JAR)
- Shell access removed for `trino` user (`/sbin/nologin`) — security hardening

**Note:** OpenLineage is intentionally not included. Trino serves interactive SQL — lineage is
captured at the Spark (job) and Airflow (pipeline) layers where it has real value.

### Grafana Dashboards (Azure Managed Grafana)

Forge uses **Azure Managed Grafana** — no custom Grafana container image is built or maintained. Dashboard JSON files are version-controlled in Git under `infra/grafana/dashboards/` and provisioned to the Managed Grafana instance via the Grafana HTTP API in the CI/CD pipeline. Data source connections (Azure Monitor, Log Analytics, Application Insights) are configured via Bicep.

---

## Image Import Pipeline

Upstream images are imported on a weekly schedule (or immediately on security alert) via an automated pipeline:

```
Scheduled trigger / Security alert
         │
         ▼
Import Pipeline (Azure DevOps / GitHub Actions)
  1. az acr import — pulls from upstream and pushes to ACR in one step (no local Docker needed)
  2. Microsoft Defender for Containers scan — triggered automatically on push, fail on CRITICAL CVEs
  3. Notary v2 sign (Notation) — signs the image digest after clean scan
  4. Update version matrix in this document (PR)
  5. Notify platform channel
```

If Microsoft Defender for Containers finds a CRITICAL CVE in a new upstream image:
- Import is **blocked**
- Platform team is alerted
- Existing deployed version remains until a clean upstream release is available or a mitigating base image patch is applied

---

## Upgrade Policy

| Category | Frequency | Process |
|----------|-----------|---------|
| Security patch (CVE CRITICAL) | As fast as possible (target: 7 days) | Emergency PR, fast-track review |
| Patch release (x.y.Z) | Monthly | Standard PR, dev → staging → prod |
| Minor release (x.Y.0) | Quarterly | Extended testing in dev, staging validation, scheduled prod window |
| Major release (X.0.0) | Annually (or less) | Architecture review, ADR, full regression testing |

All version changes go through Git — no image tag updates directly in production without a PR.

---

## Python & Node Runtime Versions

| Runtime | Version | Usage |
|---------|---------|-------|
| Python | 3.11.x | Airflow, Spark (PySpark), Portal backend, DQ SDK |
| Node.js | 20 LTS | Portal frontend build |
| Java | 17 LTS (Temurin) | Spark, Trino JVM |
| Scala | 2.12.x | Spark internals (no custom Scala code) |

---

## Open Source Licenses

| Component | License | Obligation |
|-----------|---------|-----------|
| Apache Spark | Apache 2.0 | Attribution in NOTICE file |
| Trino | Apache 2.0 | Attribution |
| Apache Airflow | Apache 2.0 | Attribution |
| Delta Lake | Apache 2.0 | Attribution |
| Azure Monitor / Container Insights | Microsoft Azure Terms | Covered by Azure enterprise agreement |
| Azure Managed Grafana | Microsoft Azure Terms | Covered by Azure enterprise agreement |
| Azure Log Analytics Workspace | Microsoft Azure Terms | Covered by Azure enterprise agreement |

All licenses permit internal enterprise use. Azure-native observability services (Azure Monitor, Azure Managed Grafana, Log Analytics) are covered by the existing Microsoft Azure enterprise agreement — no AGPL obligations.
