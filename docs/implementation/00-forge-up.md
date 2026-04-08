# Forge — forge-up.sh Deploy Guide

> **Platform:** Linux / Git Bash / WSL
> **Audience:** Platform engineers performing a full environment deployment
> **Run from:** repo root (`D:\Repos\DSEngCoreInfra\Forge`)

---

## The One Script: forge-up.sh

`infra/scripts/forge-up.sh` is the single entry point for deploying the entire Forge platform.

```
[1/8] Provision infrastructure     Bicep: AKS × 2, ADLS, Postgres, Key Vault, networking,
                                   managed identities, AcrPull role assignments.
                                   Calls provision-infra.sh → post-provision.sh automatically.
[2/8] Seed Key Vault secrets       Portal AAD client/tenant IDs, airflow webserver key.
[3/8] Configure Postgres           Creates airflow DB, grants Airflow MI schema access (AAD auth).
[4/8] Create Kubernetes secrets    airflow-db-credentials, airflow-git-credentials,
                                   airflow-compute-kubeconfig, proxy-session-secret,
                                   trino workload identity federated credential.
[5/8] Build and push images        Spark, Trino, Airflow, HMS, trino-auth-proxy,
                                   Portal API, Portal Web → ACR (parallel ACR Tasks).
                                   ACR public access opened automatically, closed after phase 8.
[6/8] Deploy compute cluster       Hive Metastore, Spark Operator, Spark Connect, Trino,
                                   Trino Auth Proxy (parallel with phase 7).
[7/8] Deploy orchestration cluster ingress-nginx, Airflow, Portal (parallel with phase 6).
[8/8] Sync pipelines               forge generate → ADLS upload (jobs + DQ rules) → git push DAGs.
[+]   Smoke test                   --run-test: seed NYC TLC data → bronze→silver→gold → verify Trino.
```

---

## Prerequisites

```bash
az login
az account set --subscription <subscription-id>
```

Tools required: `helm`, `kubectl`, `kubelogin`

kubelogin PATH fix (run once per session if kubectl auth fails):
```bash
kubelogin convert-kubeconfig --login azurecli
```

---

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--env <env>` | `dev` | Environment name (`dev` or `prod`) |
| `--alias <alias>` | _(blank)_ | Owner alias appended to resource names (`prproddu`). Leave blank for shared/unscoped deployments — globally unique resource names use subscription ID suffix automatically. |
| `--skip-infra` | false | Skip phase [1/8] — Bicep provisioning (infra already exists) |
| `--skip-build` | false | Skip phase [5/8] — image builds (images already in ACR) |
| `--skip-pg-grants` | false | Skip Postgres schema grants in phase [3/8] |
| `--skip-sync` | false | Skip phase [8/8] — DAG/job sync |
| `--skip-compute` | false | Skip phase [6/8] — compute cluster deploy |
| `--skip-orch` | false | Skip phase [7/8] — orchestration cluster deploy |
| `--run-test` | false | Run end-to-end smoke test after all phases |
| `--test-date <date>` | `2023-01-15` | Partition date for smoke test (NYC TLC data) |
| `--git-repo <url>` | _(from params)_ | Azure DevOps git repo URL for Airflow DAG git-sync |
| `--git-branch <branch>` | `main` | Git branch for DAG git-sync |
| `--git-pat <token>` | _(env: FORGE_GIT_PAT)_ | ADO PAT for git-sync. If omitted, Airflow MI workload identity is used (requires `id-forge-airflow-<env>` added to ADO org with Read access). |
| `--api-tag <tag>` | `1.0` | portal-api image tag |
| `--web-tag <tag>` | `1.0` | portal-web image tag |
| `--build-only <images>` | _(all)_ | Comma-separated list of images to rebuild only, then exit (no deploy). Valid names: `spark trino airflow hive-metastore trino-auth-proxy portal-api portal-web` |

---

## Common Usage

### First-time full deploy (no alias — shared environment)

Provisions all Azure infrastructure using subscription-suffix resource names, builds all images, and deploys:

```bash
bash infra/scripts/forge-up.sh --env dev
```

Resource names when alias is blank (first 8 chars of subscription ID used for globally unique names):
- ACR: `forgeacr<subsuffix>` (e.g. `forgeacreaa4a83d`)
- Key Vault: `kv-forge-<subsuffix>-dev`
- Postgres: `psql-forge-<subsuffix>-dev`
- ADLS: `forgeadls<subsuffix>dev`
- AKS: `aks-forge-compute-dev`, `aks-forge-orchestration-dev`
- RGs: `rg-forge-dev`, `rg-forge-platform-dev`

### First-time full deploy (with alias — personal/test deployment)

```bash
bash infra/scripts/forge-up.sh --env dev --alias prproddu
```

Resource names with alias `prproddu`:
- ACR: `forgeacrprproddu`
- Key Vault: `kv-forge-prproddu-dev`
- Postgres: `psql-forge-prproddu-dev`
- ADLS: `forgeadlsprproddudev`
- AKS: `aks-forge-compute-prproddu-dev`, `aks-forge-orchestration-prproddu-dev`
- RGs: `rg-forge-prproddu-dev`, `rg-forge-platform-prproddu-dev`

### Re-deploy apps (infrastructure already exists)

```bash
bash infra/scripts/forge-up.sh --env dev --skip-infra
```

### Re-deploy apps, skip image builds (images already in ACR)

```bash
bash infra/scripts/forge-up.sh --env dev --skip-infra --skip-build
```

### Rebuild one image only

```bash
bash infra/scripts/forge-up.sh --env dev --build-only portal-web
```

### Re-deploy compute cluster only

```bash
bash infra/scripts/forge-up.sh --env dev --skip-infra --skip-build --skip-sync --skip-orch
```

### Re-deploy orchestration cluster only

```bash
bash infra/scripts/forge-up.sh --env dev --skip-infra --skip-build --skip-sync --skip-compute
```

### Sync DAGs and jobs only

```bash
bash infra/scripts/forge-up.sh --env dev --skip-infra --skip-build --skip-compute --skip-orch
```

Or directly:
```bash
FORGE_ENV=dev bash infra/scripts/sync-jobs.sh --full
```

### Run smoke test only (after deploy)

```bash
bash infra/scripts/forge-up.sh --env dev --skip-infra --skip-build --skip-sync --run-test
```

---

## ACR Public Access

ACR has public network access **disabled by default** (S360 compliance). forge-up.sh manages this automatically:

- **Phase 5 start** — opens ACR public access (`az acr update --public-network-enabled true --default-action Allow`)
- **After phase 8** — closes it (`--public-network-enabled false --default-action Deny`)
- **On any failure** — `trap` ensures ACR is always locked back down on script exit

You do not need to manually open/close ACR during normal deploys.

If you need to open it manually (e.g. for `az acr repository list`):
```bash
az acr update --name <acr-name> --public-network-enabled true --default-action Allow
# ... do your work ...
az acr update --name <acr-name> --public-network-enabled false --default-action Deny
```

---

## Other Scripts

| Script | Purpose |
|--------|---------|
| `infra/scripts/provision-infra.sh` | Bicep Azure resource provisioning only. Called by forge-up.sh phase [1/8], or run standalone. |
| `infra/scripts/post-provision.sh` | kubeconfig fetch + S360 IP tagging. Called automatically by provision-infra.sh. |
| `infra/scripts/sync-jobs.sh` | DAG/job sync to ADLS + Airflow. Called by forge-up.sh phase [8/8], or standalone. |
| `infra/scripts/generate-docs.py` | Export architecture documentation. |

### provision-infra.sh flags

```bash
bash infra/scripts/provision-infra.sh \
  --env dev \
  --alias <alias>   # optional; blank = shared/unscoped
  --sub <sub-id>    # optional; defaults to current az account
```

### post-provision.sh flags

```bash
bash infra/scripts/post-provision.sh \
  --env dev \
  --alias <alias>   # optional
  --sub <sub-id>    # optional
```

---

## Known Issues and Workarounds

### Git Bash path translation (`--build-arg` values mangled on Windows)

Git Bash translates arguments starting with `/` to Windows paths before passing them to native Windows binaries (like `az.cmd`). This causes `--build-arg API_URL=/api` to become `--build-arg API_URL=C:/api`.

forge-up.sh sets `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"` on `az acr build` calls to disable this.

If you run `az acr build` manually with `--build-arg` values containing `/`, prefix the command:
```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" az acr build ...
```

### ACR default-action Deny blocks ACR Tasks

When public access is enabled (`--public-network-enabled true`) but `--default-action` is still `Deny`, ACR's own build agent IPs are blocked. Always set both:
```bash
az acr update --name <acr> --public-network-enabled true --default-action Allow
```

---

## Readiness Checklist

```
[ ] az login — active session, correct subscription
[ ] Shared ACR deployed: forgeacr<subsuffix> in rg-forge-acr
[ ] All custom images in ACR: spark:1.0, trino:1.0, airflow:1.0, hive-metastore:1.0,
    trino-auth-proxy:1.2, portal-api:1.0, portal-web:1.0
[ ] Third-party images in ACR: git-sync:v4.4.2, spark-operator-controller:2.5.0,
    spark-operator-kubectl:2.5.0
[ ] Helm charts in ACR: helm/spark-operator, helm/trino, helm/airflow
[ ] rg-forge-dev: Succeeded
[ ] rg-forge-platform-dev: Succeeded
[ ] aks-forge-compute-dev: all nodes Ready (systempool + sparkpool + trinopool)
[ ] aks-forge-orchestration-dev: all nodes Ready (systempool + airflowpool)
[ ] AcrPull role assigned to both kubelet MIs (deployed via Bicep acrPullCompute/acrPullOrch modules)
[ ] Namespaces present on compute: spark-jobs, spark-system, trino, hive-metastore
[ ] Namespaces present on orch: airflow, portal, ingress-nginx
[ ] HMS pod: 1/1 Running
[ ] Spark Operator: Running, CRDs installed
[ ] Spark Connect: Running
[ ] Trino: coordinator + workers Running
[ ] Trino Auth Proxy: 1/1 Running
[ ] Airflow webserver + scheduler Running
[ ] Portal accessible at http://forge-portal-dev.<region>.cloudapp.azure.com
[ ] Trino port-forward: kubectl port-forward svc/trino-auth-proxy 8080:8080 -n trino --context aks-forge-compute-dev
[ ] Airflow port-forward: kubectl port-forward svc/airflow-api-server 8081:8080 -n airflow --context aks-forge-orchestration-dev
```

---

## Teardown Guide

### Teardown A — Helm Releases Only

Uninstall all workloads without touching Azure infrastructure or ACR images. Use when you only need to redeploy Helm charts.

```bash
ENV=dev
ALIAS=""          # set to your alias if used, e.g. ALIAS="prproddu"
_A="${ALIAS:+${ALIAS}-}"

COMPUTE="aks-forge-compute-${_A}${ENV}"
ORCH="aks-forge-orchestration-${_A}${ENV}"

# Compute cluster
helm uninstall trino-auth-proxy -n trino          --context "$COMPUTE" --ignore-not-found
helm uninstall trino            -n trino          --context "$COMPUTE" --ignore-not-found
helm uninstall spark-connect    -n spark-system   --context "$COMPUTE" --ignore-not-found
helm uninstall spark-operator   -n spark-system   --context "$COMPUTE" --ignore-not-found
helm uninstall hive-metastore   -n hive-metastore --context "$COMPUTE" --ignore-not-found

# Orchestration cluster
helm uninstall airflow          -n airflow        --context "$ORCH" --ignore-not-found
helm uninstall forge-portal     -n portal         --context "$ORCH" --ignore-not-found
helm uninstall ingress-nginx    -n ingress-nginx  --context "$ORCH" --ignore-not-found

# Delete namespaces for a clean slate
kubectl delete namespace spark-jobs spark-system trino hive-metastore \
  --context "$COMPUTE" --ignore-not-found
kubectl delete namespace airflow portal ingress-nginx \
  --context "$ORCH" --ignore-not-found
```

Resume with:
```bash
bash infra/scripts/forge-up.sh --env dev --skip-infra --skip-build
```

---

### Teardown B — ACR Images and Charts Only

Delete all repositories in ACR so image builds run against a clean registry.

```bash
ACR="forgeacr<subsuffix>"   # e.g. forgeacreaa4a83d
az acr update --name "$ACR" --public-network-enabled true --default-action Allow

for repo in $(az acr repository list --name "$ACR" -o tsv); do
  echo "Deleting $repo"
  az acr repository delete --name "$ACR" --repository "$repo" --yes
done
```

Resume with:
```bash
bash infra/scripts/forge-up.sh --env dev --skip-infra
```

---

### Teardown C — Full Environment (keep ACR)

Deletes both environment resource groups and redeploys all Azure infrastructure. ACR is shared — retained. Key Vault soft-deletes but the name is reserved; Bicep redeploy recovers it automatically.

> Takes ~30–40 minutes total (delete + redeploy).

```bash
ALIAS=""   # set to your alias if used
_A="${ALIAS:+${ALIAS}-}"
ENV=dev

az group delete --name "rg-forge-${_A}${ENV}"          --yes --no-wait
az group delete --name "rg-forge-platform-${_A}${ENV}" --yes --no-wait

# Monitor — wait until both return ResourceGroupNotFound
az group show --name "rg-forge-${_A}${ENV}"          --query properties.provisioningState -o tsv
az group show --name "rg-forge-platform-${_A}${ENV}" --query properties.provisioningState -o tsv
```

Resume with a full deploy:
```bash
bash infra/scripts/forge-up.sh --env dev
```

---

### Teardown D — Full Wipe Including ACR

Nuclear option — deletes everything. Only needed when changing ACR name or subscription.

> Key Vault purge protection means the KV name is reserved for 90 days after soft-delete.

```bash
ALIAS=""
_A="${ALIAS:+${ALIAS}-}"
ENV=dev
ACR_ALIAS="${ALIAS:+-${ALIAS}}"   # note: different suffix pattern for ACR RG

az group delete --name "rg-forge-${_A}${ENV}"          --yes --no-wait
az group delete --name "rg-forge-platform-${_A}${ENV}" --yes --no-wait
az group delete --name "rg-forge-acr${ACR_ALIAS}"      --yes --no-wait

# Monitor
az group list \
  --query "[?starts_with(name,'rg-forge')].{name:name,state:properties.provisioningState}" \
  -o table
```

Resume with a full deploy (shared ACR will be re-created by forge-up.sh phase [1/8]):
```bash
bash infra/scripts/forge-up.sh --env dev
```

---

## Quick Reference — What to Redo After Each Teardown

| Teardown | Resume command |
|----------|---------------|
| A — Helm only | `forge-up.sh --skip-infra --skip-build` |
| B — ACR only | `forge-up.sh --skip-infra` |
| C — Infra (keep ACR) | `forge-up.sh` (full run) |
| D — Full wipe | `forge-up.sh` (full run, ACR recreated in phase 1) |
