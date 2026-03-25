# Forge — Implementation Guide

> **Purpose:** Step-by-step instructions for provisioning and deploying the full Forge platform from zero.
> **Audience:** Platform engineers performing the initial setup or a full environment rebuild.

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org)

---

## Implementation Order

Follow these guides in sequence. Each step has hard dependencies on the previous.

```
Step 01 — ACR Setup
  ↓  (ACR must exist before images are built or clusters pull images)
Step 02 — Image Builds & Push to ACR
  ↓  (Images must be in ACR before pods can start)
Step 03 — Cluster Setup (Bicep + bootstrap)
  ↓  (Clusters must be running before Helm deployments)
Step 04 — Deploy Compute Cluster (Spark + Trino)
  ↓  (Compute cluster must accept SparkApplications before Airflow can submit jobs)
Step 05 — Deploy Orchestration Cluster (Airflow + Marquez + Observability + Portal)
  ↓  (Full platform operational)
Step 06 — Post-Deploy Validation
```

---

## Documents in This Guide

| Step | Document | What it covers |
|------|----------|---------------|
| 01 | [01-acr-setup.md](./01-acr-setup.md) | Create ACR, private endpoint, Defender, assign pull/push roles |
| 02 | [02-image-builds.md](./02-image-builds.md) | Build custom images (Spark, Trino, Airflow, Portal), import third-party images, push all to ACR |
| 03 | [03-cluster-setup.md](./03-cluster-setup.md) | Bicep provisioning, AKS bootstrap (both clusters), workload identity, CSI secrets, namespaces |
| 04 | [04-deploy-compute.md](./04-deploy-compute.md) | Helm deploy Spark Operator, Spark Connect, Trino, Hive Metastore |
| 05 | [05-deploy-orchestration.md](./05-deploy-orchestration.md) | Deploy Airflow, Marquez, verify Container Insights / Azure Managed Grafana, Portal |
| 06 | [06-validation.md](./06-validation.md) | End-to-end validation checklist: submit test Spark job, trigger test DAG, verify lineage, verify DQ, verify Portal |

---

## Environment Naming

All commands use `{env}` as a placeholder. Replace with `dev`, `staging`, or `prod`.

| Variable | Example (dev) | Example (prod) |
|----------|--------------|----------------|
| `{env}` | `dev` | `prod` |
| `{registry}` | `forgeacr-dev.azurecr.io` | `forgeacr-prod.azurecr.io` |
| `{rg_platform}` | `rg-forge-dev` | `rg-forge-prod` |
| `{compute_cluster}` | `aks-forge-compute-dev` | `aks-forge-compute-prod` |
| `{orch_cluster}` | `aks-forge-orch-dev` | `aks-forge-orch-prod` |
| `{adls_account}` | `forgeadlsdev` | `forgeadlsprod` |
| `{keyvault}` | `kv-forge-dev` | `kv-forge-prod` |

---

## Prerequisites (All Steps)

Before starting any step, ensure the following are in place on your workstation:

| Tool | Version | Install |
|------|---------|---------|
| Azure CLI | ≥ 2.58 | `winget install Microsoft.AzureCLI` |
| kubectl | ≥ 1.29 | `az aks install-cli` |
| Helm | ≥ 3.14 | `winget install Helm.Helm` |
| Docker Desktop | ≥ 4.28 | [docs.docker.com](https://docs.docker.com/desktop/install/windows-install/) |
| Git | ≥ 2.44 | `winget install Git.Git` |

**Azure authentication:**
```bash
az login --tenant <tenant-id>
az account set --subscription <subscription-id>
az account show  # verify correct subscription
```

**Clone the repo:**
```bash
git clone https://dev.azure.com/<org>/Forge.git
cd Forge
```

---

## Image Version Reference

The canonical version list is in [`docs/architecture/components-versions.md`](../architecture/components-versions.md).

Quick reference for custom images:

| Image | Version | Dockerfile |
|-------|---------|-----------|
| `spark` | 4.0.0 | `infra/docker/spark/Dockerfile` |
| `trino` | 438 | `infra/docker/trino/Dockerfile` |
| `airflow` | 2.9.3 | `infra/docker/airflow/Dockerfile` |
| `grafana` | 10.4.2 | `infra/docker/grafana/Dockerfile` |
| `portal-api` | `{git-sha}` | `portal/backend/Dockerfile` |
| `portal-web` | `{git-sha}` | `portal/frontend/Dockerfile` |

---

## Bicep Deployment State

Bicep uses ARM deployment history — no external state backend is needed. All deployment history is stored automatically in Azure and queryable via:

```bash
az deployment sub list --query "[?name=='forge-{env}'].{name:name, state:properties.provisioningState}" -o table
az deployment sub show --name forge-{env} --query properties.outputs -o yaml
```
