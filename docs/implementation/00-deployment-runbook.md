# Forge — Full Deployment Runbook

> **Platform:** Linux / Git Bash / WSL
> **Audience:** Platform engineers performing a full environment deployment
> **Run from:** `D:\Repos\DSEngCoreInfra\Forge` (repo root)

---

## The One Script: forge-up.sh

`infra/scripts/forge-up.sh` is the single entry point for deploying the entire Forge platform. It
runs 7 sequential phases plus an optional smoke test:

```
[1/7] Provision infrastructure    (calls provision-infra.sh; skip with --skip-infra)
[2/7] Seed Key Vault secrets      (portal auth config, airflow DB pass, webserver key)
[3/7] Configure Postgres          (create airflow DB + user)
[4/7] Create Kubernetes secrets   (airflow-db-credentials, airflow-git-credentials,
                                   airflow-compute-kubeconfig, proxy-session-secret)
[5/7] Deploy compute cluster      (Hive Metastore, Spark Operator, Spark Connect,
                                   Trino, Trino Auth Proxy)
[6/7] Deploy orchestration cluster (ingress-nginx, Airflow, Portal)
[7/7] Sync pipelines              (forge generate + upload to ADLS + git push DAGs)
[+]   Smoke test                  (--run-test: seed NYC TLC data → bronze→silver→gold → verify Trino)
```

---

## Prerequisites

- Azure CLI logged in: `az login`
- Correct subscription set: `az account set --subscription <subscription-id>`
- `helm`, `kubectl`, `kubelogin` installed
- kubelogin PATH fix (run once per session):
  ```bash
  kubelogin convert-kubeconfig --login azurecli
  ```
- ACR already provisioned with all images (see [01-acr-setup.md](./01-acr-setup.md) and [02-image-builds.md](./02-image-builds.md))

---

## Common Usage

### First-time full deploy

Provisions all Azure infrastructure, deploys all platform components, and syncs pipelines:

```bash
bash infra/scripts/forge-up.sh \
  --env dev \
  --alias prproddu \
  --pg-admin-pass <postgres-admin-password> \
  --git-pat <azure-devops-pat>
```

This takes 30–40 minutes (infrastructure provision dominates).

### Re-deploy apps (infrastructure already exists)

Skips Bicep provisioning — goes straight to deploying/upgrading Helm releases:

```bash
bash infra/scripts/forge-up.sh \
  --env dev \
  --alias prproddu \
  --skip-infra \
  --git-pat <pat>
```

### Re-deploy apps, skip image builds

Skips infrastructure provision and ACR image builds (images already present in ACR):

```bash
bash infra/scripts/forge-up.sh \
  --env dev \
  --alias prproddu \
  --skip-infra \
  --skip-build \
  --git-pat <pat>
```

### Just sync DAGs and library

Re-uploads forge_lib.zip and pushes generated DAG files to ADLS / Airflow git-sync:

```bash
FORGE_ENV=dev OWNER_ALIAS=prproddu bash infra/scripts/sync-jobs.sh
```

### Run smoke test only (after deploy)

Seeds NYC TLC test data, triggers bronze→silver→gold pipeline, queries result via Trino:

```bash
bash infra/scripts/forge-up.sh \
  --env dev \
  --alias prproddu \
  --skip-infra \
  --skip-build \
  --skip-sync \
  --run-test
```

### Local portal dev (no AKS)

Runs the portal backend and frontend locally against stub responses:

```bash
bash infra/scripts/portal-dev.sh
```

---

## forge-up.sh Flags

| Flag | Description |
|------|-------------|
| `--env <env>` | Environment name (`dev`, `prod`) |
| `--alias <alias>` | Owner alias appended to resource names (`prproddu`) |
| `--pg-admin-pass <pass>` | PostgreSQL admin password (required on first run) |
| `--git-pat <pat>` | Azure DevOps PAT for Airflow git-sync (required unless `--skip-sync`) |
| `--skip-infra` | Skip phase [1/7] — Bicep provisioning |
| `--skip-build` | Skip image builds within phase [5/7] and [6/7] |
| `--skip-sync` | Skip phase [7/7] — DAG/lib sync |
| `--run-test` | Run smoke test after all phases complete |

---

## Other Scripts

| Script | Purpose |
|--------|---------|
| `infra/scripts/provision-infra.sh` | Bicep Azure resource provisioning only (called by forge-up.sh phase [1/7], or run standalone) |
| `infra/scripts/post-provision.sh` | kubeconfig fetch + S360 IP tagging (called automatically by provision-infra.sh) |
| `infra/scripts/sync-jobs.sh` | DAG/lib sync to ADLS + Airflow (called by forge-up.sh phase [7/7], or run standalone) |
| `infra/scripts/build-spark-image.sh` | Rebuild Spark Docker image and push to ACR |
| `infra/scripts/portal-dev.sh` | Local portal dev without AKS |
| `infra/scripts/generate-docs.py` | Export documentation |

---

## Step 1 — Deploy ACR (shared, run once)

> Skip if ACR already exists.

```bash
az deployment sub create \
  --location northcentralus \
  --template-file infra/bicep/environments/shared/main.bicep \
  --parameters @infra/bicep/environments/shared/shared.parameters.json \
  --name forge-shared
```

**Verify:**
```bash
az acr show --name forgeacrprproddu --query provisioningState -o tsv
# Expected: Succeeded
```

---

## Step 2 — Build and Push Images

> Skip if images are already in ACR. See [02-image-builds.md](./02-image-builds.md) for full details.

```bash
ACR="forgeacrprproddu"

# Enable ACR public access for builds
az acr update --name $ACR --allow-exports true
az acr update --name $ACR --public-network-enabled true
az acr update --name $ACR --default-action Allow

# Custom images
az acr build --registry $ACR --image "hive-metastore:3.1.3" --file infra/docker/hive-metastore/Dockerfile .
az acr build --registry $ACR --image "spark:4.1.1"          --file infra/docker/spark/Dockerfile .
az acr build --registry $ACR --image "trino:479"            --file infra/docker/trino/Dockerfile infra/docker/trino/
az acr build --registry $ACR --image "airflow:3.1.8"        --file infra/docker/airflow/Dockerfile infra/docker/airflow/

# Third-party image imports
az acr import --name $ACR --source ghcr.io/kubeflow/spark-operator/controller:2.5.0 --image spark-operator-controller:2.5.0
az acr import --name $ACR --source ghcr.io/kubeflow/spark-operator/kubectl:2.5.0    --image spark-operator-kubectl:2.5.0

# Helm chart imports
TOKEN=$(az acr login --name $ACR --expose-token --query accessToken -o tsv)
helm registry login "${ACR}.azurecr.io" --username "00000000-0000-0000-0000-000000000000" --password "$TOKEN"

helm pull spark-operator --version 2.5.0  --repo https://kubeflow.github.io/spark-operator
helm pull trino          --version 1.36.0 --repo https://trinodb.github.io/charts
helm pull airflow        --version 1.20.0 --repo https://airflow.apache.org

helm push spark-operator-2.5.0.tgz oci://${ACR}.azurecr.io/helm
helm push trino-1.36.0.tgz         oci://${ACR}.azurecr.io/helm
helm push airflow-1.20.0.tgz       oci://${ACR}.azurecr.io/helm

rm -f spark-operator-*.tgz trino-*.tgz airflow-*.tgz

# Lock ACR back down
az acr update --name $ACR --default-action Deny
az acr update --name $ACR --public-network-enabled false
az acr update --name $ACR --allow-exports false
```

**Verify:**
```bash
az acr repository list --name $ACR -o table
# Expected: airflow, hive-metastore, spark, trino, spark-operator-controller,
#           spark-operator-kubectl, helm/spark-operator, helm/trino, helm/airflow
```

---

## Step 3 — Full Platform Deploy

Run `forge-up.sh`. See [Common Usage](#common-usage) above.

The script handles the rest: infrastructure provisioning, kubeconfig fetch, secret seeding, Postgres
setup, K8s secret creation, all Helm deployments, and DAG sync.

**What forge-up.sh deploys internally:**

| Phase | What happens |
|-------|-------------|
| [1/7] Provision infra | Runs `provision-infra.sh` (Bicep: AKS × 2, ADLS, Postgres, Key Vault, identities, networking) |
| [1/7] Post-provision | Runs `post-provision.sh` (kubeconfig fetch + S360 IP tagging) |
| [2/7] Seed secrets | Portal auth config, airflow DB password, webserver key → Key Vault |
| [3/7] Configure Postgres | Creates `airflow` database and user on the Flexible Server |
| [4/7] K8s secrets | `airflow-db-credentials`, `airflow-git-credentials`, `airflow-compute-kubeconfig`, `proxy-session-secret` |
| [5/7] Compute cluster | Hive Metastore, Spark Operator, Spark Connect, Trino, Trino Auth Proxy |
| [6/7] Orchestration cluster | ingress-nginx, Airflow (chart `1.20.0`, image `3.1.8`), Portal |
| [7/7] Sync pipelines | `forge generate` → forge_lib.zip → ADLS upload → git push DAGs |

---

## Trino Azure AD App Registration (one-time setup)

> Skip if the app registration `f21cd19e-5e8b-4739-b0fb-1ebd13b8c036` already exists.

Authentication is handled by **trino-auth-proxy** (Flask/MSAL, no client secret). Trino itself runs
plain HTTP internally and never sees credentials.

**App registration details:**

| Field | Value |
|-------|-------|
| App (client) ID | `f21cd19e-5e8b-4739-b0fb-1ebd13b8c036` |
| Tenant ID | `72f988bf-86f1-41af-91ab-2d7cd011db47` |
| Redirect URI | `http://localhost:8080/oauth2/callback` |

**Auth model — IMDS managed identity as `client_assertion`:**

Tenant policy 538f1913 blocks client secrets, certificate credentials, and AKS OIDC issuers on this
registration. The auth proxy instead:
1. Calls IMDS (`http://169.254.169.254/metadata/identity/oauth2/token`) to get a token for the
   node-pool-attached managed identity (`id-forge-trino-{env}`)
2. Passes that token as `client_assertion` to MSAL
3. The federated credential on the app registration uses Microsoft's own AAD issuer
   (`login.microsoftonline.com/<tenant>/v2.0`) with the managed identity's `principalId` as
   subject — this issuer is allowed by tenant policy

forge-up.sh phase [5/7] handles all setup automatically: attaches the managed identity to the trino
node pool VMSS, creates the federated credential on the app registration, and registers the redirect
URI.

**Access Trino:**
```bash
# In one terminal — leave running
kubectl port-forward svc/trino-auth-proxy 8080:8080 -n trino \
  --context aks-forge-compute-prproddu-dev

# Browser: open http://localhost:8080 → Azure AD login → Trino UI

# CLI:
TOKEN=$(az account get-access-token --resource f21cd19e-5e8b-4739-b0fb-1ebd13b8c036 --query accessToken -o tsv)
trino --server http://localhost:8080 --access-token "$TOKEN"
```

---

## Readiness Checklist

```
[ ] forge-shared: Succeeded
[ ] forge-dev: Succeeded
[ ] All custom images in ACR: hive-metastore:3.1.3, spark:4.1.1, trino:479, airflow:3.1.8
[ ] Spark Operator images in ACR: spark-operator-controller:2.5.0, spark-operator-kubectl:2.5.0
[ ] All 3 Helm charts in ACR: helm/spark-operator, helm/trino, helm/airflow
[ ] Both AKS clusters: all nodes Ready
[ ] Compute bootstrap: spark-jobs, spark-system, trino, hive-metastore namespaces present
[ ] Orch bootstrap: airflow, portal namespaces present
[ ] HMS pod: 1/1 Running
[ ] Spark Operator: Running, CRDs installed
[ ] Spark Connect: Running
[ ] Trino: coordinator + workers Running (ClusterIP)
[ ] Trino auth proxy: pod 1/1 Running, ClusterIP
[ ] Azure AD federated credential: issuer=login.microsoftonline.com/<tenant>/v2.0
[ ] Azure AD redirect URI registered: http://localhost:8080/oauth2/callback
[ ] id-forge-trino-dev attached to trino node pool VMSS
[ ] Browser access: kubectl port-forward → http://localhost:8080 → Azure AD login → Trino UI
[ ] Airflow webserver and scheduler Running
[ ] Airflow git-sync pulling DAGs from branch user/PrProddu/StarRocks
[ ] Portal accessible at http://forge-portal-prproddu-dev.northcentralus.cloudapp.azure.com
[ ] Portal login: admin / admin
```

---

---

# Teardown Guide

Use these sections for test redeployments. Choose the scope that matches what needs to be reset.

---

## Teardown A — Helm Releases Only

Uninstall all workloads without touching ACR images or Azure infrastructure. Use this when you only
need to redeploy Helm charts.

```bash
# Compute cluster — workloads
helm uninstall trino-auth-proxy -n trino          --context aks-forge-compute-prproddu-dev --ignore-not-found
helm uninstall trino            -n trino          --context aks-forge-compute-prproddu-dev --ignore-not-found
helm uninstall spark-connect    -n spark-system   --context aks-forge-compute-prproddu-dev --ignore-not-found
helm uninstall spark-operator   -n spark-system   --context aks-forge-compute-prproddu-dev --ignore-not-found
helm uninstall hive-metastore   -n hive-metastore --context aks-forge-compute-prproddu-dev --ignore-not-found

# Orchestration cluster — workloads
helm uninstall airflow          -n airflow        --context aks-forge-orchestration-prproddu-dev --ignore-not-found
helm uninstall forge-portal     -n portal         --context aks-forge-orchestration-prproddu-dev --ignore-not-found
helm uninstall ingress-nginx    -n ingress-nginx  --context aks-forge-orchestration-prproddu-dev --ignore-not-found

# Bootstrap (namespaces + service accounts)
helm uninstall cluster-bootstrap -n default --context aks-forge-compute-prproddu-dev --ignore-not-found
helm uninstall cluster-bootstrap -n default --context aks-forge-orchestration-prproddu-dev --ignore-not-found
```

To also delete the namespaces so bootstrap recreates them cleanly:
```bash
kubectl delete namespace spark-jobs spark-system trino hive-metastore \
  --context aks-forge-compute-prproddu-dev --ignore-not-found
kubectl delete namespace airflow portal ingress-nginx \
  --context aks-forge-orchestration-prproddu-dev --ignore-not-found
```

Resume with:
```bash
bash infra/scripts/forge-up.sh --env dev --alias prproddu --skip-infra --skip-build --git-pat <pat>
```

---

## Teardown B — ACR Images and Charts Only

Delete all repositories in ACR so image builds run against a clean registry.

```bash
ACR="forgeacrprproddu"

# Open ACR for operations
az acr update --name $ACR --allow-exports true
az acr update --name $ACR --public-network-enabled true
az acr update --name $ACR --default-action Allow

# Delete every repository
for repo in $(az acr repository list --name $ACR -o tsv); do
  echo "Deleting $repo"
  az acr repository delete --name $ACR --repository "$repo" --yes
done
```

Resume from Step 2. ACR is already open — no need to re-enable public access.

---

## Teardown C — Full Environment (Keep ACR and Key Vault)

Delete both resource groups and redeploy all Azure infrastructure. ACR is shared and retained. Key
Vault cannot be purged (purge protection enabled) — it soft-deletes but the name is reserved, so
the Bicep redeploy will recover it.

> This takes 30–40 minutes total (delete + redeploy).

```bash
# Delete resource groups (AKS, ADLS, PostgreSQL, identities, networking all go with them)
az group delete --name rg-forge-prproddu-dev          --yes --no-wait
az group delete --name rg-forge-platform-prproddu-dev --yes --no-wait

# Monitor deletion progress
az group show --name rg-forge-prproddu-dev          --query properties.provisioningState -o tsv
az group show --name rg-forge-platform-prproddu-dev --query properties.provisioningState -o tsv
# Wait until both return: ResourceGroupNotFound
```

Resume with a full deploy (skip ACR setup — it already exists):
```bash
bash infra/scripts/forge-up.sh --env dev --alias prproddu --pg-admin-pass <pass> --git-pat <pat>
```

---

## Teardown D — Full Wipe Including ACR

Nuclear option — deletes everything. Only use this when you need to change the ACR name or subscription.

> Key Vault purge protection means the KV name will be reserved for 90 days after soft-delete.

```bash
# Delete all environment resource groups
az group delete --name rg-forge-prproddu-dev          --yes --no-wait
az group delete --name rg-forge-platform-prproddu-dev --yes --no-wait

# Delete shared ACR resource group
az group delete --name rg-forge-acr-prproddu --yes --no-wait

# Monitor
az group list \
  --query "[?starts_with(name,'rg-forge')].{name:name,state:properties.provisioningState}" \
  -o table
# Wait until all groups are gone
```

Resume from Step 1.

---

## Quick Reference — What to Redo After Each Teardown

| Teardown | Resume command |
|----------|---------------|
| A — Helm only | `forge-up.sh --skip-infra --skip-build` |
| B — ACR only | Step 2 (image builds), then `forge-up.sh --skip-infra` |
| C — Infra (keep ACR) | `forge-up.sh` (full run, skips ACR) |
| D — Full wipe | Step 1 (ACR setup), Step 2 (images), then `forge-up.sh` |
