# Forge — Image Builds & ACR Push

> **Document:** 02-image-builds
> **Status:** Current
> **Last updated:** 2026-03-24
> **Audience:** Platform engineers, CI/CD pipeline authors

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org)

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [ACR Login](#2-acr-login)
3. [Tag Convention](#3-tag-convention)
4. [Custom Images](#4-custom-images)
   - [spark:4.1.0](#41-spark351)
   - [trino:438](#42-trino438)
   - [airflow:3.1.0](#43-airflow293)
   - [Azure Managed Grafana (no custom image)](#44-azure-managed-grafana-no-custom-image)
   - [portal-api](#45-portal-api)
   - [portal-web](#46-portal-web)
5. [Imported Images](#5-imported-images)
6. [Helm Chart Import](#6-helm-chart-import)
7. [Full Build Script](#7-full-build-script)
8. [Verification](#8-verification)
9. [CI Pipeline Integration](#9-ci-pipeline-integration)

---

## 1. Prerequisites

The following tools must be available in the environment where builds run.

| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| Docker | 24.x | Build and push images |
| Azure CLI (`az`) | 2.57.x | ACR login, tag queries |
| `jq` | 1.6 | Parse JSON in build script |
| `curl` | 7.x | Download upstream artifacts in Dockerfiles |

### Azure CLI login

For local workstation builds:

```bash
az login
az account set --subscription <forge-subscription-id>
```

For CI/CD (Azure DevOps / GitHub Actions), an AzureCLI task or `azure/login` action provides the authenticated context using a workload identity federated credential — no client secret required (see [Section 8](#8-ci-pipeline-integration)).

### ACR naming convention

| Environment | Registry FQDN |
|-------------|--------------|
| dev | `forgeacr-dev.azurecr.io` |
| staging | `forgeacr-staging.azurecr.io` |
| prod | `forgeacr-prod.azurecr.io` |

The ACR name passed to all scripts and commands is the **FQDN**, not the short name. Examples in this document use `forgeacr-dev.azurecr.io` and `forgeacr-prod.azurecr.io` as representative values.

---

## 2. ACR Login

### Local workstation

```bash
REGISTRY="forgeacr-dev.azurecr.io"
az acr login --name forgeacr-dev
```

`az acr login` refreshes the Docker credential store with a short-lived token (valid 3 hours). Re-run before a long build session.

### CI — workload identity (Azure DevOps)

In Azure DevOps, the pipeline service connection is federated to a managed identity that holds `AcrPush` on the ACR resource. The login step in the pipeline YAML:

```yaml
- task: AzureCLI@2
  displayName: ACR login
  inputs:
    azureSubscription: sc-forge-$(environment)
    scriptType: bash
    scriptLocation: inlineScript
    inlineScript: |
      az acr login --name forgeacr-$(environment)
```

No password or token is stored. The federated OIDC credential is exchanged for a short-lived ACR refresh token automatically.

### CI — workload identity (GitHub Actions)

```yaml
- uses: azure/login@v2
  with:
    client-id: ${{ vars.AZURE_CLIENT_ID }}
    tenant-id: ${{ vars.AZURE_TENANT_ID }}
    subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

- name: ACR login
  run: az acr login --name forgeacr-${{ inputs.environment }}
```

---

## 3. Tag Convention

All images in ACR use the following tag scheme:

```
{registry}/{image}:{version}-{env}
```

| Segment | Example | Notes |
|---------|---------|-------|
| `registry` | `forgeacr-prod.azurecr.io` | Full FQDN always |
| `image` | `spark` | Lowercase, hyphenated |
| `version` | `4.1.0` | Upstream version or `git-sha` for first-party code |
| `env` | `prod` | `dev`, `staging`, or `prod` |

**Examples:**

```
forgeacr-prod.azurecr.io/spark:4.1.0-prod
forgeacr-dev.azurecr.io/airflow:3.1.0-dev
forgeacr-prod.azurecr.io/portal-api:a3f92c1-prod
forgeacr-dev.azurecr.io/portal-api:a3f92c1-dev
```

For first-party images (`portal-api`, `portal-web`) where there is no upstream version, the tag is the **short Git SHA** of the commit being built. The CI pipeline sets this from `$(Build.SourceVersion)` (Azure DevOps) or `${{ github.sha }}` (GitHub Actions).

---

## 4. Custom Images

Custom images have a Dockerfile in `infra/docker/<name>/`. Build them locally or in CI before pushing.

---

### 4.1 spark:4.1.0

**Purpose:** Spark driver and executor pods for all Bronze, Silver, and Gold processing jobs. This image is the workhorse of the platform — every SparkApplication CRD references it.

**What is included:**
- Eclipse Temurin 17 JRE (OpenJDK 17, Ubuntu Jammy base)
- Apache Spark 4.1.0 with Hadoop 3.3.4 (full distribution, Kubernetes-ready)
- Delta Lake 4.0.0 JAR (`delta-spark==4.0.0.0.jar`)
- Hadoop Azure (`hadoop-azure-3.3.6.jar`) — the ABFS driver for ADLS Gen2
- Azure Identity + Azure Storage File DataLake JARs — workload identity token provider
- OpenLineage Spark integration (`openlineage-spark-1.18.0.jar`) — automatic lineage emission
- Python 3.11, pip, PySpark, delta-spark, pandas, pyarrow, azure-identity
- `spark-defaults.conf` with ADLS and OpenLineage defaults baked in
- Runs as non-root user `spark` (UID 185)

**Dockerfile:** `infra/docker/spark/Dockerfile`

**Build:**

```bash
REGISTRY="forgeacr-dev.azurecr.io"
ENV="dev"
VERSION="4.1.0"

docker build \
  --tag "${REGISTRY}/spark:${VERSION}-${ENV}" \
  --file infra/docker/spark/Dockerfile \
  infra/docker/spark/
```

**Push:**

```bash
docker push "${REGISTRY}/spark:${VERSION}-${ENV}"
```

**When to rebuild:**
- Spark patch release
- Delta Lake patch/minor release
- Security CVE alert from Defender for Containers on the base image
- Any change to `spark-defaults.conf` or JAR versions

---

### 4.2 trino:438

**Purpose:** Trino coordinator and worker pods for ad-hoc SQL queries against Silver and Gold Delta tables, and for Gold materialisation jobs that use Trino CTAS.

**What is included:**
- Official `trinodb/trino:438` base (includes Delta Lake connector in distribution)
- OpenLineage Trino plugin (`openlineage-trino-1.18.0.jar`) installed to `/usr/lib/trino/plugin/openlineage/`
- Custom `catalog-discovery` plugin for dynamic per-tenant catalog registration (Forge-built JAR, placed in `/usr/lib/trino/plugin/catalog-discovery/`)
- Proper file ownership on plugin directories for the `trino` user
- Shell access removed for the `trino` user (security hardening — `/sbin/nologin`)

**Dockerfile:** `infra/docker/trino/Dockerfile`

**Build:**

```bash
REGISTRY="forgeacr-dev.azurecr.io"
ENV="dev"
VERSION="438"

docker build \
  --tag "${REGISTRY}/trino:${VERSION}-${ENV}" \
  --file infra/docker/trino/Dockerfile \
  infra/docker/trino/
```

**Push:**

```bash
docker push "${REGISTRY}/trino:${VERSION}-${ENV}"
```

---

### 4.3 airflow:3.1.0

**Purpose:** Airflow scheduler, webserver, and worker pods. All DAG orchestration for Bronze ingestion, Silver transformation, DQ validation, and Gold publication runs from this image.

**What is included:**
- Official `apache/airflow:3.1.0-python3.12` base
- `apache-airflow-providers-cncf-kubernetes` — `SparkKubernetesOperator`, `KubernetesPodOperator`
- `apache-airflow-providers-microsoft-azure` — ADLS hooks, Azure Key Vault secrets backend
- `openlineage-airflow` — automatic OpenLineage START/COMPLETE/FAIL emission for every task
- `azure-identity`, `azure-storage-file-datalake` — workload identity token handling
- `forge-dq` wheel — Forge DQ SDK (from `sdk/` build context, if present)
- `forge-lineage` wheel — Forge lineage helpers (from `sdk/` build context, if present)
- All dependencies pinned in `infra/docker/airflow/requirements.txt`

**Dockerfile:** `infra/docker/airflow/Dockerfile`

**Build:**

```bash
REGISTRY="forgeacr-dev.azurecr.io"
ENV="dev"
VERSION="3.1.0"

docker build \
  --tag "${REGISTRY}/airflow:${VERSION}-${ENV}" \
  --file infra/docker/airflow/Dockerfile \
  --build-arg AIRFLOW_VERSION="3.1.0" \
  infra/docker/airflow/
```

**Push:**

```bash
docker push "${REGISTRY}/airflow:${VERSION}-${ENV}"
```

---

### 4.4 Azure Managed Grafana (no custom image)

**Purpose:** Azure Managed Grafana serves all platform observability dashboards — Spark job metrics, Airflow pipeline health, DQ pass rates, Trino query performance, and infrastructure resource utilisation.

Forge uses **Azure Managed Grafana** — no custom container image is built or pushed to ACR. Dashboard JSON files are version-controlled in Git under `infra/grafana/dashboards/` and provisioned to the Managed Grafana instance via the Grafana HTTP API in the CI/CD pipeline:

```bash
# Provision dashboards to Azure Managed Grafana (run in CI/CD)
GRAFANA_URL=$(az grafana show \
  --name grafana-forge-${ENV} \
  --resource-group rg-forge-${ENV} \
  --query "properties.endpoint" -o tsv)

for dashboard_file in infra/grafana/dashboards/*.json; do
  az grafana dashboard create \
    --name grafana-forge-${ENV} \
    --resource-group rg-forge-${ENV} \
    --definition "@${dashboard_file}"
done
```

Data source connections (Azure Monitor, Log Analytics, Application Insights) are configured via Bicep — no manual provisioning YAML required.

---

### 4.5 portal-api

**Purpose:** FastAPI backend for the Forge Developer Portal. Aggregates data from Airflow, Purview (lineage), Trino (DQ store), Azure Cost Management, and ADLS catalog. Runs on the `platform` node pool.

**What is included:**
- `mcr.microsoft.com/cbl-mariner/base/python:3.11` base (Azure-hosted, no public registry dependency)
- FastAPI + uvicorn server
- `azure-identity` for workload identity credential
- Airflow REST API client, Purview SDK (`azure-purview-catalog`), Trino Python driver
- All source code from `portal/api/` copied in at build time

**Tag scheme:** Uses Git SHA — no upstream version number applies.

**Build:**

```bash
REGISTRY="forgeacr-dev.azurecr.io"
ENV="dev"
GIT_SHA=$(git rev-parse --short HEAD)

docker build \
  --tag "${REGISTRY}/portal-api:${GIT_SHA}-${ENV}" \
  --file infra/docker/portal-api/Dockerfile \
  .
```

> The build context is the repo root (`.`) because the Dockerfile copies from `portal/api/`.

**Push:**

```bash
docker push "${REGISTRY}/portal-api:${GIT_SHA}-${ENV}"
```

---

### 4.6 portal-web

**Purpose:** Next.js 14 frontend for the Forge Developer Portal. Server-side rendered, served via Node.js runtime. Proxies API calls to `portal-api`.

**What is included:**
- `mcr.microsoft.com/cbl-mariner/base/node:20` base
- Multi-stage build: Node.js build stage produces `.next/` standalone output, then copied to a lean runtime stage
- All source code from `portal/web/` built and embedded

**Tag scheme:** Uses Git SHA.

**Build:**

```bash
REGISTRY="forgeacr-dev.azurecr.io"
ENV="dev"
GIT_SHA=$(git rev-parse --short HEAD)

docker build \
  --tag "${REGISTRY}/portal-web:${GIT_SHA}-${ENV}" \
  --file infra/docker/portal-web/Dockerfile \
  .
```

**Push:**

```bash
docker push "${REGISTRY}/portal-web:${GIT_SHA}-${ENV}"
```

---

## 5. Imported Images

Imported images are not modified — they are pulled from upstream, retagged, and pushed to ACR. No Dockerfile involved.

The full import loop is encapsulated in the build script (see [Section 6](#6-full-build-script)). The manual procedure for a single image is:

```bash
REGISTRY="forgeacr-prod.azurecr.io"
ENV="prod"

# Pull from upstream
docker pull trinodb/trino:438

# Retag to ACR
docker tag trinodb/trino:438 "${REGISTRY}/trino:438-${ENV}"

# Push to ACR
docker push "${REGISTRY}/trino:438-${ENV}"
```

### Full import table

| Image | Upstream Source | ACR Tag |
|-------|----------------|---------|
| `hive-metastore:3.1.3` | `apache/hive:3.1.3` | `forgeacr/hive-metastore:3.1.3-{env}` |
| `statsd-exporter:0.26.1` | `prom/statsd-exporter:v0.26.1` | `forgeacr/statsd-exporter:0.26.1-{env}` |
| `spark-operator:1.4.6` | `ghcr.io/kubeflow/spark-operator:v1.4.6` | `forgeacr/spark-operator:1.4.6-{env}` |
| `gatekeeper:3.16.3` | `openpolicyagent/gatekeeper:v3.16.3` | `forgeacr/gatekeeper:3.16.3-{env}` |

---

## 6. Helm Chart Import

All Helm charts must be stored in ACR as OCI artifacts before deployment. No cluster pulls from public Helm repositories — all `helm upgrade --install` commands in Steps 04 and 05 reference `oci://forgeacr-{env}.azurecr.io/helm/...`.

### Why OCI Helm charts in ACR

- **S360 compliance** — AKS nodes and CI agents must not egress to public Helm repos (`kubeflow.github.io`, `trinodb.github.io`, `airflow.apache.org`)
- **Supply chain control** — chart tarballs are scanned and pinned before entering the environment
- **Consistency** — same ACR is the single source of truth for both images and charts

### Import procedure (manual / first-time)

```bash
REGISTRY="forgeacr-dev.azurecr.io"
az acr login --name forgeacr-dev

# 1. Pull the chart from the public Helm repo (run from a machine with internet access)
helm pull spark-operator/spark-operator --version 1.4.6 --repo https://kubeflow.github.io/spark-operator
helm pull trino/trino              --version 0.31.0 --repo https://trinodb.github.io/charts
helm pull apache-airflow/airflow   --version 1.15.0 --repo https://airflow.apache.org

# 2. Push each chart to ACR as an OCI artifact
helm push spark-operator-1.4.6.tgz  oci://${REGISTRY}/helm
helm push trino-0.31.0.tgz          oci://${REGISTRY}/helm
helm push airflow-1.15.0.tgz        oci://${REGISTRY}/helm

# 3. Clean up local tarballs
rm -f spark-operator-*.tgz trino-*.tgz airflow-*.tgz
```

### Helm chart version matrix

| Chart | Chart Version | App Version | ACR path |
|-------|--------------|-------------|----------|
| `spark-operator` | 1.4.6 | Spark Operator 1.4.6 | `oci://forgeacr-{env}.azurecr.io/helm/spark-operator:1.4.6` |
| `trino` | 0.31.0 | Trino 438 | `oci://forgeacr-{env}.azurecr.io/helm/trino:0.31.0` |
| `airflow` | 1.15.0 | Airflow 3.1.0 | `oci://forgeacr-{env}.azurecr.io/helm/airflow:1.15.0` |

Note: Microsoft Purview is a managed Azure service — no Helm chart is required.

The `build-and-push-images.sh` script includes a `--charts-only` flag that runs the chart import loop for all three charts.

---

## 7. Full Build Script

The canonical entry point for all image operations (container images + Helm charts) is `scripts/bootstrap/build-and-push-images.sh`. It handles both custom builds and imports, and accepts `--env` and `--registry` arguments.

See the script at `scripts/bootstrap/build-and-push-images.sh` for the full implementation.

**Usage:**

```bash
# Build and push all images to dev ACR
./scripts/bootstrap/build-and-push-images.sh \
  --env dev \
  --registry forgeacr-dev.azurecr.io

# Build and push to prod ACR
./scripts/bootstrap/build-and-push-images.sh \
  --env prod \
  --registry forgeacr-prod.azurecr.io

# Build only custom images (skip imports)
./scripts/bootstrap/build-and-push-images.sh \
  --env dev \
  --registry forgeacr-dev.azurecr.io \
  --custom-only

# Import only third-party images (skip custom builds)
./scripts/bootstrap/build-and-push-images.sh \
  --env dev \
  --registry forgeacr-dev.azurecr.io \
  --import-only
```

The script outputs a summary table on completion listing every image pushed with its full ACR tag and the duration of each operation.

---

## 8. Verification

### List all repositories in ACR

```bash
az acr repository list \
  --name forgeacr-dev \
  --output table
```

### List tags for a specific image

```bash
az acr repository show-tags \
  --name forgeacr-dev \
  --repository spark \
  --orderby time_desc \
  --output table
```

### Show full manifest details (digest, creation time, size)

```bash
az acr manifest list-metadata \
  --registry forgeacr-dev \
  --name spark \
  --orderby time_desc \
  --output table
```

### Confirm Defender scan result

Defender for Containers scans images on push. Query the scan status via the Azure portal (Defender for Cloud → Container images) or via the REST API:

```bash
# Get vulnerability assessment findings for an image
az security assessment list \
  --query "[?contains(id, 'forgeacr-dev')].{name:name, status:status.code}" \
  --output table
```

A clean image shows `Healthy`. An image with findings shows `Unhealthy` with severity breakdown. Deployments to production are blocked by OPA Gatekeeper policy if the image is not signed by Notation (which only signs after a clean Defender scan in the import pipeline).

### Pull-test from ACR (confirm credentials and reachability)

```bash
docker pull forgeacr-dev.azurecr.io/spark:4.1.0-dev
```

If this succeeds from a cluster node (or CI agent), ACR access is confirmed end-to-end.

---

## 9. CI Pipeline Integration

### Trigger conditions

| Change | Pipeline triggered |
|--------|-------------------|
| `infra/docker/spark/**` modified | Spark image build + push |
| `infra/docker/trino/**` modified | Trino image build + push |
| `infra/docker/airflow/**` modified | Airflow image build + push |
| `infra/grafana/dashboards/**` modified | Azure Managed Grafana dashboard provisioning (HTTP API, not image build) |
| `portal/api/**` or `portal/web/**` modified | Portal API/Web build + push |
| Weekly schedule | Import pipeline — pull + retag + push all third-party images |
| Defender CVE alert webhook | Targeted rebuild of the affected image |

### Azure DevOps pipeline structure

The image build pipeline (`ci/image-build-pipeline.yml`) runs on an Ubuntu agent with Docker-in-Docker or Azure Container Registry Tasks. Key steps:

1. `az acr login` using the service connection (workload identity federated credential)
2. `docker build` — with `--cache-from` pointing to the last pushed image for layer caching
3. Microsoft Defender for Containers scan — fails the pipeline on `CRITICAL` CVEs before pushing
4. `docker push`
5. Notation sign — signs the image digest using the Forge signing key stored in Azure Key Vault

### GitHub Actions pipeline structure

The equivalent GitHub Actions workflow (`.github/workflows/image-build.yml`) follows the same steps using `azure/login@v2`, `azure/defender-for-containers-action`, and the Notation GitHub Action (`notaryproject/notation-action`).

### Layer caching in CI

Both pipelines pass `--cache-from` to Docker to reuse layers from the previous successful build:

```bash
docker build \
  --cache-from "${REGISTRY}/spark:cache" \
  --cache-to   "type=registry,ref=${REGISTRY}/spark:cache,mode=max" \
  --tag "${REGISTRY}/spark:${VERSION}-${ENV}" \
  ...
```

This keeps build times for incremental changes (e.g., a single JAR version bump) under 2 minutes even for the Spark image.
