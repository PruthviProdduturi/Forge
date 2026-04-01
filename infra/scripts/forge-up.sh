#!/usr/bin/env bash
# =============================================================================
# forge-up.sh — Full Forge environment deployment
#
# THE one script. Provisions infra (optional) and deploys every application
# component — compute cluster (Spark, Hive, Trino) and orchestration cluster
# (Airflow, Portal, ingress-nginx) — then syncs DAGs and forge_lib.zip.
#
# Usage:
#   bash infra/scripts/forge-up.sh --env dev --alias prproddu [options]
#
# Options:
#   --env <env>             Environment name (default: dev)
#   --alias <alias>         Engineer alias used in resource naming
#   --skip-infra            Skip Bicep provisioning (infra already exists)
#   --skip-build            Skip Docker image builds (images already in ACR)
#   --skip-sync             Skip sync-jobs.sh (DAG/lib sync)
#   --git-repo <url>        Azure DevOps git repo URL for Airflow DAG git-sync
#   --git-branch <branch>   Git branch for DAG git-sync (default: main)
#   --git-pat <token>       Azure DevOps PAT for Airflow git-sync
#   --pg-admin-pass <pass>  Postgres admin password (or set FORGE_PG_ADMIN_PASS)
#   --api-tag <tag>         portal-api image tag (default: 1.0)
#   --web-tag <tag>         portal-web image tag (default: 1.0)
#
# First-run prerequisites:
#   - az login done, correct subscription set
#   - Node.js 20+ installed (for forge generate in sync-jobs.sh)
#   - git configured with push access to origin
#
# Idempotent — safe to re-run at any point.
# =============================================================================

set -euo pipefail
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
ENV="dev"
ALIAS=""
SKIP_INFRA=false
SKIP_BUILD=false
SKIP_SYNC=false
GIT_REPO="https://L1R@dev.azure.com/L1R/Data%20Science%20Engineering/_git/DSEng%20Core%20Infra"
GIT_BRANCH="main"
GIT_PAT="${FORGE_GIT_PAT:-}"
PG_ADMIN_PASS="${FORGE_PG_ADMIN_PASS:-}"
API_TAG="1.0"
WEB_TAG="1.0"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --env)           ENV="$2";          shift 2 ;;
    --alias)         ALIAS="$2";        shift 2 ;;
    --skip-infra)    SKIP_INFRA=true;   shift ;;
    --skip-build)    SKIP_BUILD=true;   shift ;;
    --skip-sync)     SKIP_SYNC=true;    shift ;;
    --git-repo)      GIT_REPO="$2";     shift 2 ;;
    --git-branch)    GIT_BRANCH="$2";   shift 2 ;;
    --git-pat)       GIT_PAT="$2";      shift 2 ;;
    --pg-admin-pass) PG_ADMIN_PASS="$2"; shift 2 ;;
    --api-tag)       API_TAG="$2";      shift 2 ;;
    --web-tag)       WEB_TAG="$2";      shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[[ -z "$ALIAS" ]] && { echo "ERROR: --alias required"; exit 1; }

# ---------------------------------------------------------------------------
# Derived names — must match main.bicep naming conventions
# ---------------------------------------------------------------------------
ACR="forgeacr${ALIAS}"
ACR_RG="rg-forge-acr-${ALIAS}"
RESOURCE_GROUP="rg-forge-${ALIAS}-${ENV}"
COMPUTE_CLUSTER="aks-forge-compute-${ALIAS}-${ENV}"
ORCH_CLUSTER="aks-forge-orchestration-${ALIAS}-${ENV}"
KV_NAME="kv-forge-${ALIAS}-${ENV}"
PG_SERVER="psql-forge-${ALIAS}-${ENV}"
PG_HOST="${PG_SERVER}.postgres.database.azure.com"
ADLS_ACCOUNT="forgeadls${ALIAS//-/}${ENV}"
DNS_LABEL="forge-portal-${ALIAS}-${ENV}"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

LOCATION=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$ORCH_CLUSTER" \
  --query location -o tsv 2>/dev/null || echo "northcentralus")
NODE_RG_ORCH=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$ORCH_CLUSTER" \
  --query nodeResourceGroup -o tsv 2>/dev/null || echo "")

PUBLIC_HOST="${DNS_LABEL}.${LOCATION}.cloudapp.azure.com"

# Trino auth proxy constants (app registration is fixed across envs)
TRINO_APP_CLIENT_ID="f21cd19e-5e8b-4739-b0fb-1ebd13b8c036"
TRINO_TENANT_ID="72f988bf-86f1-41af-91ab-2d7cd011db47"
TRINO_ALLOWED_DOMAIN="microsoft.com"
TRINO_REDIRECT_URI="http://localhost:8080/oauth2/callback"

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Forge — Full Environment Deploy                     ║"
echo "╠══════════════════════════════════════════════════════╣"
printf "║  env        : %-38s║\n" "$ENV"
printf "║  alias      : %-38s║\n" "$ALIAS"
printf "║  ACR        : %-38s║\n" "${ACR}.azurecr.io"
printf "║  compute    : %-38s║\n" "$COMPUTE_CLUSTER"
printf "║  orch       : %-38s║\n" "$ORCH_CLUSTER"
printf "║  portal URL : %-38s║\n" "http://$PUBLIC_HOST"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# Phase 1 — Bicep infra provisioning (skippable)
# deploy.sh handles both Bicep + post-deploy (kubeconfigs + IP tags)
# ---------------------------------------------------------------------------
if [[ "$SKIP_INFRA" == "false" ]]; then
  echo "━━━ [1/7] Bicep infra + post-deploy ━━━━━━━━━━━━━━━━━━━━"
  bash "${SCRIPT_DIR}/deploy.sh" --env "$ENV" --alias "$ALIAS" --sub "$SUBSCRIPTION_ID"
else
  echo "━━━ [1/7] Bicep infra — skipped (--skip-infra) ━━━━━━━━━"
  echo "         Refreshing kubeconfigs..."
  bash "${SCRIPT_DIR}/post-deploy.sh" --env "$ENV" --alias "$ALIAS" --sub "$SUBSCRIPTION_ID"
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 2 — Key Vault secret seeding
# ---------------------------------------------------------------------------
echo "━━━ [2/7] Key Vault secret seeding ━━━━━━━━━━━━━━━━━━━━━━"

_kv_seed() {
  local name="$1" value="$2"
  local existing
  existing=$(az keyvault secret show --vault-name "$KV_NAME" --name "$name" \
    --query value -o tsv 2>/dev/null || echo "")
  if [[ -z "$existing" ]]; then
    az keyvault secret set --vault-name "$KV_NAME" --name "$name" --value "$value" --output none
    echo "  Created: $name"
  else
    echo "  Exists:  $name"
  fi
}

# Portal auth config
_kv_seed "forge-portal-auth-provider" "local"
_kv_seed "forge-portal-aad-client-id" ""
_kv_seed "forge-portal-aad-tenant-id" ""

# Airflow DB password — generate once, store in KV
AIRFLOW_DB_PASS=$(az keyvault secret show --vault-name "$KV_NAME" \
  --name "airflow-db-password" --query value -o tsv 2>/dev/null || echo "")
if [[ -z "$AIRFLOW_DB_PASS" ]]; then
  AIRFLOW_DB_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)
  az keyvault secret set --vault-name "$KV_NAME" \
    --name "airflow-db-password" --value "$AIRFLOW_DB_PASS" --output none
  echo "  Created: airflow-db-password"
else
  echo "  Exists:  airflow-db-password"
fi

# Airflow webserver secret key — generate once
AIRFLOW_WS_KEY=$(az keyvault secret show --vault-name "$KV_NAME" \
  --name "airflow-webserver-key" --query value -o tsv 2>/dev/null || echo "")
if [[ -z "$AIRFLOW_WS_KEY" ]]; then
  AIRFLOW_WS_KEY=$(openssl rand -hex 32)
  az keyvault secret set --vault-name "$KV_NAME" \
    --name "airflow-webserver-key" --value "$AIRFLOW_WS_KEY" --output none
  echo "  Created: airflow-webserver-key"
else
  echo "  Exists:  airflow-webserver-key"
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 3 — Postgres: create airflow database and user
# ---------------------------------------------------------------------------
echo "━━━ [3/7] Postgres: airflow DB setup ━━━━━━━━━━━━━━━━━━━━"

# Resolve pg admin password: flag > env var > Key Vault
if [[ -z "$PG_ADMIN_PASS" ]]; then
  PG_ADMIN_PASS=$(az keyvault secret show --vault-name "$KV_NAME" \
    --name "postgres-admin-password" --query value -o tsv 2>/dev/null || echo "")
fi
if [[ -z "$PG_ADMIN_PASS" ]]; then
  echo "  ERROR: Postgres admin password not found."
  echo "  Provide via --pg-admin-pass, FORGE_PG_ADMIN_PASS env var,"
  echo "  or store in Key Vault secret 'postgres-admin-password'."
  exit 1
fi

# Store admin pass in KV for future runs
az keyvault secret set --vault-name "$KV_NAME" \
  --name "postgres-admin-password" --value "$PG_ADMIN_PASS" --output none 2>/dev/null || true

_pg_exec() {
  az postgres flexible-server execute \
    --name "$PG_SERVER" \
    --resource-group "$RESOURCE_GROUP" \
    --admin-user "forgeadmin" \
    --admin-password "$PG_ADMIN_PASS" \
    --database-name "postgres" \
    --querytext "$1" \
    --output none 2>/dev/null || true
}

echo "  Ensuring airflow database exists..."
_pg_exec "SELECT 1 FROM pg_database WHERE datname='airflow'" 2>/dev/null | grep -q 1 || \
  _pg_exec "CREATE DATABASE airflow;"
echo "  Ensuring airflow user exists..."
_pg_exec "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='airflow') THEN
    CREATE USER airflow WITH PASSWORD '${AIRFLOW_DB_PASS}';
  ELSE
    ALTER USER airflow WITH PASSWORD '${AIRFLOW_DB_PASS}';
  END IF;
END \$\$;"
_pg_exec "GRANT ALL PRIVILEGES ON DATABASE airflow TO airflow;"
# Postgres 15+: also grant on schema
_pg_exec "\\c airflow; GRANT ALL ON SCHEMA public TO airflow;" 2>/dev/null || true
echo "  Postgres airflow DB ready"
echo ""

# ---------------------------------------------------------------------------
# Phase 4 — K8s secrets for Airflow (both clusters)
# ---------------------------------------------------------------------------
echo "━━━ [4/7] K8s secrets ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

AIRFLOW_DB_CONN="postgresql+psycopg2://airflow:${AIRFLOW_DB_PASS}@${PG_HOST}:5432/airflow?sslmode=require"

# Airflow namespace secrets (orchestration cluster)
echo "  Orchestration cluster secrets..."

kubectl create secret generic airflow-db-credentials \
  --from-literal="connection=${AIRFLOW_DB_CONN}" \
  --namespace airflow \
  --context "$ORCH_CLUSTER" \
  --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f -
echo "    airflow-db-credentials"

kubectl create secret generic airflow-webserver-secret \
  --from-literal="webserver-secret-key=${AIRFLOW_WS_KEY}" \
  --namespace airflow \
  --context "$ORCH_CLUSTER" \
  --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f -
echo "    airflow-webserver-secret"

# Git-sync credentials — requires PAT
if [[ -n "$GIT_PAT" ]]; then
  kubectl create secret generic airflow-git-credentials \
    --from-literal="GIT_SYNC_USERNAME=forge" \
    --from-literal="GIT_SYNC_PASSWORD=${GIT_PAT}" \
    --namespace airflow \
    --context "$ORCH_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f -
  echo "    airflow-git-credentials"
else
  if ! kubectl get secret airflow-git-credentials -n airflow --context "$ORCH_CLUSTER" &>/dev/null; then
    echo "    WARN: airflow-git-credentials missing — DAG git-sync will not work."
    echo "    Provide --git-pat to create it. Re-run forge-up.sh after adding the PAT."
  else
    echo "    airflow-git-credentials (already exists)"
  fi
fi

# Compute cluster kubeconfig for Airflow (SparkKubernetesOperator)
COMPUTE_KUBECONFIG=$(az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$COMPUTE_CLUSTER" \
  --file - 2>/dev/null || echo "")

if [[ -n "$COMPUTE_KUBECONFIG" ]]; then
  kubectl create secret generic airflow-compute-kubeconfig \
    --from-literal="config=${COMPUTE_KUBECONFIG}" \
    --namespace airflow \
    --context "$ORCH_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f -
  echo "    airflow-compute-kubeconfig"
else
  echo "    WARN: could not fetch compute kubeconfig — SparkKubernetesOperator will fail"
fi

# Trino auth proxy session secret (compute cluster)
if ! kubectl get secret proxy-session-secret -n trino --context "$COMPUTE_CLUSTER" &>/dev/null; then
  SESSION_KEY=$(openssl rand -hex 32)
  kubectl create secret generic proxy-session-secret \
    --from-literal="session-secret=${SESSION_KEY}" \
    --namespace trino \
    --context "$COMPUTE_CLUSTER"
  echo "    proxy-session-secret (trino, compute cluster)"
else
  echo "    proxy-session-secret (already exists)"
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 5 — Compute cluster: Helm deploys
# ---------------------------------------------------------------------------
echo "━━━ [5/7] Compute cluster Helm deploys ━━━━━━━━━━━━━━━━━━"

# Resolve managed identity client IDs
HMS_WI_CLIENT_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
  --name "id-forge-hms-${ENV}" --query clientId -o tsv 2>/dev/null || echo "")
TRINO_WI_CLIENT_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
  --name "id-forge-trino-${ENV}" --query clientId -o tsv 2>/dev/null || echo "")
HMS_HOST=$(az keyvault secret show --vault-name "$KV_NAME" \
  --name "hms-postgres-host" --query value -o tsv 2>/dev/null || echo "$PG_HOST")

echo "  [6.1] Hive Metastore..."
helm upgrade --install hive-metastore \
  "${REPO_ROOT}/infra/helm/compute/hive-metastore" \
  --namespace hive-metastore --create-namespace \
  --kube-context "$COMPUTE_CLUSTER" \
  --set "image.repository=${ACR}.azurecr.io/hive-metastore" \
  --set "image.tag=3.1.3" \
  --set "db.host=${HMS_HOST}" \
  --set "db.user=id-forge-hms-${ENV}" \
  --set "adls.account=${ADLS_ACCOUNT}" \
  ${HMS_WI_CLIENT_ID:+--set "serviceAccount.annotations.azure\.workload\.identity/client-id=${HMS_WI_CLIENT_ID}"} \
  --wait --timeout 5m
echo "    Done"

echo "  [6.2] Spark Operator..."
helm upgrade --install spark-operator \
  "oci://${ACR}.azurecr.io/helm/spark-operator" \
  --version 2.5.0 \
  --namespace spark-system --create-namespace \
  --kube-context "$COMPUTE_CLUSTER" \
  --values "${REPO_ROOT}/infra/helm/compute/spark-operator/values.yaml" \
  --set "image.registry=${ACR}.azurecr.io" \
  --set "image.repository=spark-operator-controller" \
  --set "image.tag=2.5.0" \
  --wait --timeout 5m
echo "    Done"

echo "  [6.3] Spark Connect..."
helm upgrade --install spark-connect \
  "${REPO_ROOT}/infra/helm/compute/spark-connect" \
  --namespace spark-system \
  --kube-context "$COMPUTE_CLUSTER" \
  --values "${REPO_ROOT}/infra/helm/compute/spark-connect/values.yaml" \
  --set "image.repository=${ACR}.azurecr.io/spark" \
  --set "adls.account=${ADLS_ACCOUNT}" \
  --wait --timeout 5m
echo "    Done"

echo "  [6.4] Trino..."
TRINO_WI_ARG=""
[[ -n "$TRINO_WI_CLIENT_ID" ]] && TRINO_WI_ARG="--set serviceAccount.annotations.azure\.workload\.identity/client-id=${TRINO_WI_CLIENT_ID}"
helm upgrade --install trino \
  "oci://${ACR}.azurecr.io/helm/trino" \
  --version 1.36.0 \
  --namespace trino --create-namespace \
  --kube-context "$COMPUTE_CLUSTER" \
  --values "${REPO_ROOT}/infra/helm/compute/trino/values.yaml" \
  --set "image.repository=${ACR}.azurecr.io/trino" \
  --set "image.tag=479" \
  $TRINO_WI_ARG \
  --wait --timeout 5m
echo "    Done"

echo "  [6.5] Trino Auth Proxy..."
# Federated credential setup (IMDS approach)
MI_PRINCIPAL_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
  --name "id-forge-trino-${ENV}" --query principalId -o tsv 2>/dev/null || echo "")
if [[ -n "$MI_PRINCIPAL_ID" ]]; then
  APP_OBJ_ID=$(az ad app show --id "$TRINO_APP_CLIENT_ID" --query id -o tsv 2>/dev/null || echo "")
  if [[ -n "$APP_OBJ_ID" ]]; then
    FC_ISSUER="https://login.microsoftonline.com/${TRINO_TENANT_ID}/v2.0"
    EXISTING_FED=$(MSYS_NO_PATHCONV=1 az rest --method GET \
      --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
      --query "value[?subject=='${MI_PRINCIPAL_ID}'].id" -o tsv 2>/dev/null || echo "")
    if [[ -z "$EXISTING_FED" ]]; then
      MSYS_NO_PATHCONV=1 az rest --method POST \
        --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
        --body "{\"name\":\"forge-trino-mi-federation\",\"issuer\":\"${FC_ISSUER}\",\"subject\":\"${MI_PRINCIPAL_ID}\",\"audiences\":[\"api://AzureADTokenExchange\"]}" \
        --output none 2>/dev/null || echo "    WARN: could not create federated credential"
      echo "    Federated credential created"
    fi
    # Attach MI to VMSS
    NODE_RG_COMPUTE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$COMPUTE_CLUSTER" \
      --query nodeResourceGroup -o tsv 2>/dev/null || echo "")
    if [[ -n "$NODE_RG_COMPUTE" ]]; then
      VMSS_NAME=$(az vmss list --resource-group "$NODE_RG_COMPUTE" \
        --query "[?contains(name,'trino')].name" -o tsv 2>/dev/null || \
        az vmss list --resource-group "$NODE_RG_COMPUTE" --query "[0].name" -o tsv 2>/dev/null || echo "")
      if [[ -n "$VMSS_NAME" ]]; then
        MI_RESOURCE_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-forge-trino-${ENV}"
        MSYS_NO_PATHCONV=1 az vmss identity assign \
          --resource-group "$NODE_RG_COMPUTE" \
          --name "$VMSS_NAME" \
          --identities "$MI_RESOURCE_ID" \
          --output none 2>/dev/null || true
      fi
    fi
  fi
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
  az acr build \
    --registry "$ACR" \
    --resource-group "$ACR_RG" \
    --image "trino-auth-proxy:1.2" \
    --file "${REPO_ROOT}/infra/docker/trino-auth-proxy/Dockerfile" \
    "${REPO_ROOT}/infra/docker/trino-auth-proxy/" 2>/dev/null || \
    echo "    WARN: trino-auth-proxy image build failed — using existing image"
fi

helm upgrade --install trino-auth-proxy \
  "${REPO_ROOT}/infra/helm/compute/trino-auth-proxy" \
  --namespace trino \
  --kube-context "$COMPUTE_CLUSTER" \
  --set "image.repository=${ACR}.azurecr.io/trino-auth-proxy" \
  --set "image.tag=1.2" \
  --set "env.tenantId=${TRINO_TENANT_ID}" \
  --set "env.clientId=${TRINO_APP_CLIENT_ID}" \
  --set "env.redirectUri=${TRINO_REDIRECT_URI}" \
  --set "env.allowedDomain=${TRINO_ALLOWED_DOMAIN}" \
  --set "env.trinoBackend=trino:8080" \
  ${TRINO_WI_CLIENT_ID:+--set "env.managedIdentityClientId=${TRINO_WI_CLIENT_ID}"} \
  --wait --timeout 3m
echo "    Done"
echo ""

# ---------------------------------------------------------------------------
# Phase 6 — Orchestration cluster: Helm deploys
# ---------------------------------------------------------------------------
echo "━━━ [6/7] Orchestration cluster Helm deploys ━━━━━━━━━━━━"

# Ensure portal managed identity is available
PORTAL_MI_CLIENT_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
  --name "id-forge-portal-${ENV}" --query clientId -o tsv 2>/dev/null || echo "")

echo "  [7.1] ingress-nginx..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update 2>/dev/null || true
helm repo update ingress-nginx 2>/dev/null || true
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --kube-context "$ORCH_CLUSTER" \
  --values "${REPO_ROOT}/infra/helm/orchestration/ingress-nginx/values.yaml" \
  --set "controller.service.annotations.service\.beta\.kubernetes\.io/azure-dns-label-name=${DNS_LABEL}" \
  --wait --timeout 5m

# Set DNS label directly on public IP (Helm annotation alone is unreliable)
EXTERNAL_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
  --context "$ORCH_CLUSTER" \
  --output jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
if [[ -n "$EXTERNAL_IP" && -n "$NODE_RG_ORCH" ]]; then
  PIP_NAME=$(az network public-ip list \
    --resource-group "$NODE_RG_ORCH" \
    --query "[?ipAddress=='${EXTERNAL_IP}'].name" -o tsv 2>/dev/null || echo "")
  if [[ -n "$PIP_NAME" ]]; then
    az network public-ip update \
      --resource-group "$NODE_RG_ORCH" \
      --name "$PIP_NAME" \
      --dns-name "$DNS_LABEL" \
      --output none 2>/dev/null || true
    echo "    FQDN: ${PUBLIC_HOST}"
  fi
fi
echo "    Done"

echo "  [7.2] Airflow..."
# Build portal-api and portal-web images if needed
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo "    Building portal-api:${API_TAG}..."
  az acr build \
    --registry "$ACR" \
    --image "portal-api:${API_TAG}" \
    --file "${REPO_ROOT}/infra/docker/portal-api/Dockerfile" \
    "${REPO_ROOT}/portal/backend/"

  echo "    Building portal-web:${WEB_TAG}..."
  az acr build \
    --registry "$ACR" \
    --image "portal-web:${WEB_TAG}" \
    --file "${REPO_ROOT}/infra/docker/portal-web/Dockerfile" \
    --build-arg "API_URL=" \
    --build-arg "WEB_URL=http://${PUBLIC_HOST}" \
    "${REPO_ROOT}/portal/frontend/"
fi

helm upgrade --install airflow \
  "oci://${ACR}.azurecr.io/helm/airflow" \
  --version 1.20.0 \
  --namespace airflow --create-namespace \
  --kube-context "$ORCH_CLUSTER" \
  --values "${REPO_ROOT}/infra/helm/orchestration/airflow/values.yaml" \
  --set "images.airflow.repository=${ACR}.azurecr.io/airflow" \
  --set "images.airflow.tag=3.1.8" \
  --set "dags.gitSync.repo=${GIT_REPO}" \
  --set "dags.gitSync.branch=${GIT_BRANCH}" \
  --set "env[0].value=${ENV}" \
  --wait --timeout 10m
echo "    Done"

echo "  [7.3] Portal..."
helm upgrade --install forge-portal \
  "${REPO_ROOT}/infra/helm/orchestration/portal" \
  --namespace portal --create-namespace \
  --kube-context "$ORCH_CLUSTER" \
  --set "api.image.repository=${ACR}.azurecr.io/portal-api" \
  --set "api.image.tag=${API_TAG}" \
  --set "web.image.repository=${ACR}.azurecr.io/portal-web" \
  --set "web.image.tag=${WEB_TAG}" \
  --set "api.env.forgeEnv=${ENV}" \
  --set "api.env.adlsAccount=${ADLS_ACCOUNT}" \
  --set "api.env.subscriptionId=${SUBSCRIPTION_ID}" \
  --set "api.env.resourceGroup=${RESOURCE_GROUP}" \
  --set "api.env.ownerAlias=${ALIAS}" \
  --set "api.env.computeClusterName=${COMPUTE_CLUSTER}" \
  --set "api.env.orchClusterName=${ORCH_CLUSTER}" \
  --set "api.env.keyVaultUrl=https://${KV_NAME}.vault.azure.net/" \
  --set "ingress.host=${PUBLIC_HOST}" \
  ${PORTAL_MI_CLIENT_ID:+--set "api.env.azureClientId=${PORTAL_MI_CLIENT_ID}"} \
  --wait --timeout 5m
echo "    Done"
echo ""

# ---------------------------------------------------------------------------
# Phase 7 — sync-jobs.sh: generate + upload DAGs, forge_lib.zip, Spark jobs
# ---------------------------------------------------------------------------
if [[ "$SKIP_SYNC" == "false" ]]; then
  echo "━━━ [7/7] Sync jobs (DAGs + forge_lib.zip) ━━━━━━━━━━━━━━"
  FORGE_ENV="$ENV" OWNER_ALIAS="$ALIAS" \
    bash "${SCRIPT_DIR}/sync-jobs.sh" --full
  echo ""
else
  echo "━━━ [7/7] Sync jobs — skipped (--skip-sync) ━━━━━━━━━━━━━"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Forge is up                                         ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  PORTAL                                              ║"
printf "║    URL:    http://%-35s║\n" "$PUBLIC_HOST"
echo "║    Login:  admin / admin                             ║"
echo "║                                                      ║"
echo "║  AIRFLOW                                             ║"
echo "║    kubectl port-forward svc/airflow-webserver \\     ║"
echo "║      8081:8080 -n airflow \\                         ║"
printf "║      --context %-37s║\n" "$ORCH_CLUSTER"
echo "║    Then open: http://localhost:8081                  ║"
echo "║    Login:  admin / admin                             ║"
echo "║                                                      ║"
echo "║  TRINO                                               ║"
echo "║    kubectl port-forward svc/trino-auth-proxy \\      ║"
echo "║      8080:8080 -n trino \\                           ║"
printf "║      --context %-37s║\n" "$COMPUTE_CLUSTER"
echo "║    Then open: http://localhost:8080                  ║"
echo "║                                                      ║"
echo "║  TABLES (after pipelines run)                        ║"
echo "║    SELECT * FROM delta.bronze.nyc_taxi LIMIT 10;     ║"
echo "╚══════════════════════════════════════════════════════╝"
