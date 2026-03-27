# Forge — Image Builds & ACR Push

> **Document:** 02-image-builds
> **Status:** Current
> **Last updated:** 2026-03-27
> **Audience:** Platform engineers performing initial setup or image updates

[![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [ACR Naming](#3-acr-naming)
4. [Enabling ACR Tasks (public access)](#4-enabling-acr-tasks-public-access)
5. [Custom Images](#5-custom-images)
   - [spark:4.1.1](#51-spark411)
   - [trino:438](#52-trino438)
   - [airflow:3.1.8](#53-airflow318)
   - [portal-api](#54-portal-api)
   - [portal-web](#55-portal-web)
   - [hive-metastore:3.1.3](#56-hive-metastore313)
6. [Third-Party Image Import](#6-third-party-image-import)
7. [Helm Chart Import](#7-helm-chart-import)
8. [Lock ACR Back Down](#8-lock-acr-back-down)
9. [Verification](#9-verification)
10. [CI Pipeline Integration](#10-ci-pipeline-integration)

---

## 1. Overview

All images are built using **ACR Tasks** (`az acr build`). The build runs inside Azure — no local Docker daemon or `docker push` is needed. The only requirement is an authenticated Azure CLI session with `AcrPush` on the registry.

**Why ACR Tasks and not local Docker build + push?**
- No Docker Desktop dependency in CI or on engineer workstations
- Build runs in Azure — no large image upload over a laptop connection
- ACR Tasks natively support workload identity (no stored credentials)
- Defender for Containers scans the image immediately on push

---

## 2. Prerequisites

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Azure CLI (`az`) | ≥ 2.58 | `winget install Microsoft.AzureCLI` |
| Git | ≥ 2.44 | required for `git rev-parse` in portal builds |

**Azure authentication:**
```bash
az login --tenant <tenant-id>
az account set --subscription <subscription-id>
az account show  # verify correct subscription
```

---

## 3. ACR Naming

The shared ACR is created by `infra/bicep/environments/shared/main.bicep`.

| Deployment type | Registry name | Example |
|----------------|--------------|---------|
| Personal dev (with `ownerAlias`) | `forgeacr{alias}` | `forgeacrprproddu` |
| Shared / production | `forgeacr` | `forgeacr` |

Set a shell variable before running any build command:

```bash
ACR="forgeacrprproddu"   # replace with your registry name
```

---

## 4. Enabling ACR Tasks (public access)

ACR is deployed with `publicNetworkAccess: Disabled`. ACR Tasks require temporary public access to run. Follow these steps **before** building images, and lock down after ([Section 8](#8-lock-acr-back-down)).

> **Important:** Export policy must be re-enabled before public access can be toggled.

```bash
# Step 1 — re-enable exports (required before enabling public access)
az acr update --name $ACR --allow-exports true

# Step 2 — enable public network access
az acr update --name $ACR --public-network-enabled true
```

---

## 5. Custom Images

Custom images have a Dockerfile in `infra/docker/<name>/`. Each image uses `az acr build` which packages the build context, uploads it to Azure, and builds + pushes the image in one step.

### Image version matrix

| Image | Version | Dockerfile |
|-------|---------|-----------|
| `spark` | `4.1.1` | `infra/docker/spark/Dockerfile` |
| `trino` | `438` | `infra/docker/trino/Dockerfile` |
| `airflow` | `3.1.8` | `infra/docker/airflow/Dockerfile` |
| `portal-api` | `{git-sha}` | `portal/backend/Dockerfile` |
| `portal-web` | `{git-sha}` | `portal/frontend/Dockerfile` |
| `hive-metastore` | `3.1.3` | `infra/docker/hive-metastore/Dockerfile` |

---

### 5.1 spark:4.1.1

**Purpose:** Spark driver and executor pods for all Bronze, Silver, and Gold processing jobs. Every `SparkApplication` CRD references this image.

**What is included:**
- Eclipse Temurin 17 JRE (OpenJDK 17, Ubuntu Jammy base)
- Apache Spark 4.1.1 (Hadoop 3 distribution)
- Delta Lake 4.1.0 JAR + storage library
- Apache Iceberg 1.10.1 runtime (`iceberg-spark-runtime-4.0_2.13` — Spark 4.x compatible)
- Hadoop Azure 3.4.1 — ABFS driver for ADLS Gen2
- Azure Identity + Azure Storage File DataLake JARs — workload identity token provider
- Azure Core + Azure Core HTTP Netty — transitive Azure SDK dependencies
- OpenLineage Spark 1.39.0 — automatic lineage emission to Purview
- Python 3.11, PySpark, delta-spark, pandas, pyarrow, azure-identity, openlineage-python
- `spark-defaults.conf` with ADLS and OpenLineage defaults baked in
- `forge-dq` SDK (from `sdk/python/`) — baked in so Spark jobs can run DQ checks without a separate install
- Runs as non-root user `spark` (UID 185)

**Build context:** Repo root is required because `sdk/python/` must be accessible to the Dockerfile.
A `.dockerignore` at the repo root limits the upload to only `sdk/python/` and `infra/docker/spark/`.

```bash
# Run from repo root (D:\Repos\DSEngCoreInfra\Forge)
az acr build \
  --registry $ACR \
  --image spark:4.1.1 \
  --file infra/docker/spark/Dockerfile \
  .
```

**When to rebuild:**
- Spark version bump
- Delta Lake / Iceberg version bump
- JAR version change
- `sdk/python/` (forge-dq) changes
- `spark-defaults.conf` changes
- Defender CVE alert on the base image

---

### 5.2 trino:438

**Purpose:** Trino coordinator and worker pods for ad-hoc SQL queries against Delta tables in the Silver and Gold layers.

**What is included:**
- Official `trinodb/trino:438` base (includes Delta Lake connector)
- Custom `catalog-discovery` plugin — dynamic per-tenant catalog registration without static property files (Forge-built JAR; build context includes a `.gitkeep` placeholder if not yet built)
- Proper file ownership on plugin directories for the `trino` user
- Shell access removed for the `trino` user (`/sbin/nologin`) — security hardening

**Note on OpenLineage:** Trino is intentionally not instrumented with OpenLineage. Trino serves
interactive SQL queries — meaningful lineage is captured upstream at the Spark (job) and Airflow
(pipeline) layers. Instrumenting ad-hoc Trino queries produces noise in Purview, not signal.

```bash
az acr build \
  --registry $ACR \
  --image trino:438 \
  --file infra/docker/trino/Dockerfile \
  infra/docker/trino/
```

**When to rebuild:**
- Trino version bump
- `catalog-discovery` plugin update
- Defender CVE alert on the base image

---

### 5.3 airflow:3.1.8

**Purpose:** Airflow scheduler, webserver, triggerer, and worker pods. All pipeline orchestration for Bronze ingestion, Silver transformation, DQ validation, and Gold publication runs from this image.

**What is included:**
- Official `apache/airflow:3.1.8-python3.11` base
- `apache-airflow-providers-cncf-kubernetes==9.0.0` — `SparkKubernetesOperator`, `KubernetesPodOperator`
- `apache-airflow-providers-microsoft-azure==10.0.0` — ADLS hooks, Azure Key Vault secrets backend
- `apache-airflow-providers-openlineage==2.0.0` — OpenLineage provider for Airflow
- `apache-airflow-providers-openlineage (via constraints)` — automatic START/COMPLETE/FAIL lineage emission for every task
- `azure-identity`, `azure-storage-file-datalake`, `azure-keyvault-secrets` — workload identity
- `forge-dq` wheel — Forge DQ SDK (from `wheels/` directory in build context, if present)
- `forge-lineage` wheel — Forge lineage helpers (from `wheels/` directory, if present)
- All dependencies pinned in `infra/docker/airflow/requirements.txt`
- Platform-level DAGs and plugins baked in; domain DAGs mounted at runtime via git-sync

**Build context:** `infra/docker/airflow/`. Wheels directory must exist in build context:
```bash
# If wheels are not yet built, create the placeholder so the COPY step succeeds
mkdir -p infra/docker/airflow/wheels
touch infra/docker/airflow/wheels/.gitkeep
```

```bash
az acr build \
  --registry $ACR \
  --image airflow:3.1.8 \
  --file infra/docker/airflow/Dockerfile \
  infra/docker/airflow/
```

**When to rebuild:**
- Airflow version bump
- Provider package version bump
- `forge-dq` or `forge-lineage` wheel update
- Platform DAG / plugin changes
- Defender CVE alert on the base image

---

### 5.4 portal-api

**Purpose:** FastAPI backend for the Forge Developer Portal. Aggregates data from Airflow, Purview (lineage), Trino, Azure Cost Management, and ADLS catalog.

**Tag scheme:** Git SHA — no upstream version applies to first-party code.

```bash
GIT_SHA=$(git rev-parse --short HEAD)

az acr build \
  --registry $ACR \
  --image "portal-api:${GIT_SHA}" \
  --file portal/backend/Dockerfile \
  portal/backend/
```

---

### 5.5 portal-web

**Purpose:** Next.js frontend for the Forge Developer Portal.

**Tag scheme:** Git SHA.

```bash
GIT_SHA=$(git rev-parse --short HEAD)

az acr build \
  --registry $ACR \
  --image "portal-web:${GIT_SHA}" \
  --file portal/frontend/Dockerfile \
  portal/frontend/
```

### 5.6 hive-metastore:3.1.3

**Purpose:** Hive Metastore standalone server. Provides the Thrift catalog endpoint used by both Spark (`DeltaCatalog`) and Trino (`delta_lake` connector) to resolve table names to ADLS paths.

**Why custom (not a third-party import):** The upstream `apache/hive` image does not include the `azure-identity-extensions` JDBC plugin. This plugin is required for AAD token-based authentication against Azure Database for PostgreSQL — no password is stored anywhere.

**What's added on top of the upstream HMS distribution:**
- `azure-identity-extensions` JAR — JDBC AAD token exchange
- `postgresql` JDBC driver — PostgreSQL backend
- Guava version aligned with Hadoop 3.x (replaces bundled version)

```bash
az acr build \
  --registry $ACR \
  --image "hive-metastore:3.1.3" \
  --file infra/docker/hive-metastore/Dockerfile \
  .
```

---

## 6. Third-Party Image Import

Third-party images are not modified — they are imported directly into ACR using `az acr import`. No local pull or push is required.

```bash
# Spark Operator
az acr import \
  --name $ACR \
  --source ghcr.io/kubeflow/spark-operator:v2.1.1 \
  --image spark-operator:2.1.1
```

### Third-party image version matrix

| Image | Upstream Source | ACR tag |
|-------|----------------|---------|
| `spark-operator` | `ghcr.io/kubeflow/spark-operator:v2.1.1` | `spark-operator:2.1.1` |

---

## 7. Helm Chart Import

All Helm charts are stored in ACR as OCI artifacts before deployment. Cluster deployments reference
`oci://{registry}.azurecr.io/helm/...` — no cluster egresses to public Helm repositories.

```bash
# Authenticate Helm to ACR
az acr login --name $ACR
TOKEN=$(az acr login --name $ACR --expose-token --output tsv --query accessToken)
echo $TOKEN | helm registry login ${ACR}.azurecr.io --username 00000000-0000-0000-0000-000000000000 --password-stdin

# Pull charts from public repos
helm pull spark-operator/spark-operator --version 2.1.1  --repo https://kubeflow.github.io/spark-operator
helm pull trino/trino                   --version 0.31.0 --repo https://trinodb.github.io/charts
helm pull apache-airflow/airflow        --version 1.15.0 --repo https://airflow.apache.org

# Push to ACR
helm push spark-operator-2.1.1.tgz  oci://${ACR}.azurecr.io/helm
helm push trino-0.31.0.tgz          oci://${ACR}.azurecr.io/helm
helm push airflow-1.15.0.tgz        oci://${ACR}.azurecr.io/helm

# Clean up local tarballs
rm -f spark-operator-*.tgz trino-*.tgz airflow-*.tgz
```

### Helm chart version matrix

| Chart | Chart Version | App Version | ACR path |
|-------|--------------|-------------|----------|
| `spark-operator` | `2.1.1` | Spark Operator 2.1.1 | `oci://{acr}.azurecr.io/helm/spark-operator:2.1.1` |
| `trino` | `0.31.0` | Trino 438 | `oci://{acr}.azurecr.io/helm/trino:0.31.0` |
| `airflow` | `1.15.0` | Airflow 3.1.8 | `oci://{acr}.azurecr.io/helm/airflow:1.15.0` |

---

## 8. Lock ACR Back Down

After all builds and imports are complete, restore the secure network configuration:

```bash
# Step 1 — disable public network access
az acr update --name $ACR --public-network-enabled false

# Step 2 — disable exports
az acr update --name $ACR --allow-exports false
```

All access to ACR after this point is via the private endpoint provisioned by `infra/bicep/environments/{env}/main.bicep`.

---

## 9. Verification

### List all repositories

```bash
az acr repository list --name $ACR --output table
```

### List tags for a specific image

```bash
az acr repository show-tags \
  --name $ACR \
  --repository spark \
  --orderby time_desc \
  --output table
```

### Show manifest details (digest, size, creation time)

```bash
az acr manifest list-metadata \
  --registry $ACR \
  --name spark \
  --orderby time_desc \
  --output table
```

### Confirm Defender scan result

Defender for Containers scans every image on push. Check the result in **Defender for Cloud → Container images** in the Azure portal, or query via CLI:

```bash
az security assessment list \
  --query "[?contains(id, '${ACR}')].{name:name, status:status.code}" \
  --output table
```

A clean image shows `Healthy`.

---

## 10. CI Pipeline Integration

In CI (Azure DevOps), the `az acr build` command replaces the local build workflow exactly. The pipeline service connection is federated to a managed identity with `AcrPush` on the registry.

```yaml
- task: AzureCLI@2
  displayName: Build and push Spark image
  inputs:
    azureSubscription: sc-forge-$(environment)
    scriptType: bash
    scriptLocation: inlineScript
    inlineScript: |
      az acr build \
        --registry forgeacr$(ownerAlias) \
        --image spark:$(sparkVersion) \
        --file infra/docker/spark/Dockerfile \
        .
```

### Trigger conditions

| Change | Build triggered |
|--------|----------------|
| `infra/docker/spark/**` | Spark image |
| `infra/docker/trino/**` | Trino image |
| `infra/docker/airflow/**` | Airflow image |
| `sdk/python/**` | Spark image (forge-dq is baked in) |
| `portal/backend/**` | portal-api image |
| `portal/frontend/**` | portal-web image |
| Weekly schedule | Third-party image re-import (base image security patches) |
