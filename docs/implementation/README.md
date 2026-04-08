# Forge — Implementation Guide

> **Purpose:** Step-by-step instructions for provisioning and deploying the full Forge platform from zero.
> **Audience:** Platform engineers performing the initial setup or a full environment rebuild.

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org)

---

## Quick Start — One Command Deploy

The entire platform is deployed by a single script:

```bash
# First-time full deploy (from repo root: D:\Repos\DSEngCoreInfra\Forge)
bash infra/scripts/forge-up.sh --env dev --alias prproddu --pg-admin-pass <pass> --git-pat <pat>
```

See [`00-forge-up.md`](./00-forge-up.md) for the full `forge-up.sh` guide: partial re-deploys, flags, teardown, and smoke test.

---

## Implementation Order

```
Step 01 — ACR Setup (shared registry — run once, before everything else)
  ↓  (ACR must exist before images are built or clusters pull images)
Step 02 — Image Builds (build custom images, import third-party images, push to ACR)
  ↓  (Images must be in ACR before pods can start)
Step 03 — Cluster Setup (Bicep env deployment: networking + AKS + storage + identity + Key Vault, then AKS bootstrap)
  ↓  (Clusters must be running before Helm deployments)
Step 04 — Deploy Compute Cluster (Hive Metastore, Spark Operator, Spark Connect, Trino, Trino Auth Proxy)
  ↓  (forge-up.sh phase [6/8] handles this automatically)
Step 05 — Deploy Orchestration Cluster (Airflow + Portal)
  ↓  (forge-up.sh phase [7/8] handles this automatically)
Step 06 — CI/CD Pipeline
```

> **For day-to-day deploys:** Use `forge-up.sh` directly — it automates Steps 03–05 (infra provision
> through orchestration deploy). Steps 01–02 (ACR and image builds) are one-time setup tasks.

> **Networking** is not a separate step. VNet, subnets, NSGs, and private DNS zones are provisioned
> automatically by `infra/bicep/environments/{env}/main.bicep` as part of Step 03.
> See [`networking-reference.md`](./networking-reference.md) for the architecture details.

---

## Documents in This Guide

| | Document | What it covers |
|-|----------|---------------|
| ref | [networking-reference.md](./networking-reference.md) | VNet architecture, subnets, NSGs, private DNS zones — reference only, deployed as part of Step 03 |
| 00 | [00-forge-up.md](./00-forge-up.md) | **Start here.** forge-up.sh flags, partial re-deploys, smoke test, teardown |
| 01 | [01-acr-setup.md](./01-acr-setup.md) | Create shared ACR via `shared/main.bicep`, configure security controls, assign roles |
| 02 | [02-image-builds.md](./02-image-builds.md) | Build custom images (Spark, Trino, Airflow, Portal), import third-party images, push to ACR |
| 03 | [03-cluster-setup.md](./03-cluster-setup.md) | Full env Bicep deployment (`dev/main.bicep` or `prod/main.bicep`), AKS bootstrap, workload identity, namespaces |
| 04 | [04-deploy-compute.md](./04-deploy-compute.md) | Helm deploy Spark Operator, Spark Connect, Trino, Hive Metastore (automated by forge-up.sh [6/8]) |
| 05 | [05-deploy-orchestration.md](./05-deploy-orchestration.md) | Deploy Airflow, Portal (automated by forge-up.sh [7/8]) |
| 06 | [06-cicd.md](./06-cicd.md) | Azure DevOps pipeline definitions for infrastructure and application deployments |

---

## Environment Naming

All commands use `{env}` as a placeholder. Replace with `dev` or `prod`.
For personal dev deployments, set `ownerAlias` (e.g. `prproddu`) — it is appended to all resource names to avoid conflicts.

| Variable | Example (personal dev) | Example (prod) |
|----------|----------------------|----------------|
| `{env}` | `dev` | `prod` |
| `{alias}` | `prproddu` | *(empty)* |
| ACR name | `forgeacrprproddu` | `forgeacr` |
| `rg-forge-acr` | `rg-forge-acr-prproddu` | `rg-forge-acr` |
| `rg-forge-platform-{env}` | `rg-forge-platform-prproddu-dev` | `rg-forge-platform-prod` |
| `rg-forge-{env}` | `rg-forge-prproddu-dev` | `rg-forge-prod` |
| `{compute_cluster}` | `aks-forge-compute-prproddu-dev` | `aks-forge-compute-prod` |
| `{orch_cluster}` | `aks-forge-orchestration-prproddu-dev` | `aks-forge-orchestration-prod` |
| `{adls_account}` | `forgeadlsprproddudev` | `forgeadlsprod` |
| `{keyvault}` | `kv-forge-prproddu-dev` | `kv-forge-prod` |

---

## Prerequisites (All Steps)

| Tool | Version | Install |
|------|---------|---------|
| Azure CLI | ≥ 2.58 | `winget install Microsoft.AzureCLI` |
| kubectl | ≥ 1.29 | `az aks install-cli` |
| Helm | ≥ 3.14 | `winget install Helm.Helm` |
| Git | ≥ 2.44 | `winget install Git.Git` |

> **No Docker Desktop required.** Images are built using ACR Tasks (`az acr build`) — the build
> runs in Azure, not locally. See [02-image-builds.md](./02-image-builds.md).

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

The canonical version list is in [`components-versions.md`](./components-versions.md).

Quick reference for custom images:

| Image | Version | Dockerfile |
|-------|---------|-----------|
| `spark` | `4.1.1` | `infra/docker/spark/Dockerfile` |
| `trino` | `479` | `infra/docker/trino/Dockerfile` |
| `airflow` | `3.1.8` | `infra/docker/airflow/Dockerfile` |
| `portal-api` | `{git-sha}` | `portal/backend/Dockerfile` |
| `portal-web` | `{git-sha}` | `portal/frontend/Dockerfile` |

---

## Bicep Deployment State

Bicep uses ARM deployment history — no external state backend needed. Query via:

```bash
az deployment sub list \
  --query "[?name=='forge-{env}'].{name:name, state:properties.provisioningState}" \
  -o table

az deployment sub show \
  --name forge-{env} \
  --query properties.outputs \
  -o yaml
```
