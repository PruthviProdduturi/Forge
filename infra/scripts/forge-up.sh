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
#   --skip-pg-grants        Skip Postgres schema grants (do manually via kubectl exec)
#   --git-repo <url>        Azure DevOps git repo URL for Airflow DAG git-sync
#   --git-branch <branch>   Git branch for DAG git-sync (default: main)
#   --git-pat <token>       Azure DevOps PAT for Airflow git-sync (optional — Airflow
#                           MI workload identity is used if omitted; requires
#                           id-forge-airflow-<env> added to the ADO org with Read access)
#   --api-tag <tag>         portal-api image tag (default: 1.0)
#   --web-tag <tag>         portal-web image tag (default: 1.0)
#   --build-only <images>   Comma-separated images to rebuild only (no deploy).
#                           Names: spark trino airflow hive-metastore
#                                  trino-auth-proxy portal-api portal-web
#   --skip-compute          Skip Phase 6 (compute cluster: HMS, Spark, Trino)
#   --skip-orch             Skip Phase 7 (orch cluster: Airflow, Portal, ingress)
#   --skip-secrets          Skip phases 2-4 (KV seeding, Postgres grants, K8s secrets)
#                           Safe when credentials haven't changed — saves ~1-2 min
#   --skip-imports          Skip third-party image and Helm chart imports in Phase 5
#                           (saves ~3-5 min when git-sync, spark-operator images and
#                            spark-operator/airflow/trino charts are already in ACR)
#   --run-test              After deploy: seed raw data, trigger all pipelines
#                           once (bronze → silver → gold), verify tables in Trino
#   --test-date <date>      Partition date for test run (default: 2023-01-15)
#                           Pick a date where NYC TLC data exists
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
# Defaults (lowest priority — overridden by env file, then CLI args)
# ---------------------------------------------------------------------------
ENV="dev"
ALIAS=""
LOCATION_ARG=""   # explicit --location override; empty = auto-detect
SKIP_INFRA=false
SKIP_BUILD=false
SKIP_SYNC=false
SKIP_PG_GRANTS=false
RUN_TEST=false
TEST_DATE="2023-01-15"
GIT_REPO=""
GIT_BRANCH=""
GIT_PAT="${FORGE_GIT_PAT:-}"
API_TAG=""
WEB_TAG=""
BUILD_ONLY=""   # comma-separated image names; if set, only those images are built
SKIP_COMPUTE=false
SKIP_ORCH=false
SKIP_IMPORTS=false  # skip third-party image and Helm chart imports (use when already in ACR)
SKIP_SECRETS=false  # skip phases 2-4 (KV seeds, Postgres grants, K8s secrets) on re-deploys
PUBLISH_PACKAGES=false  # publish forge-sdk + forge-dq to ADO Artifacts after deploy

# ---------------------------------------------------------------------------
# Parse args — collect only; env file is sourced after --env is known
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --env)           ENV="$2";          shift 2 ;;
    --alias)         ALIAS="$2";        shift 2 ;;
    --skip-infra)    SKIP_INFRA=true;   shift ;;
    --skip-build)    SKIP_BUILD=true;   shift ;;
    --skip-sync)      SKIP_SYNC=true;      shift ;;
    --skip-pg-grants) SKIP_PG_GRANTS=true; shift ;;
    --run-test)       RUN_TEST=true;       shift ;;
    --test-date)     TEST_DATE="$2";    shift 2 ;;
    --git-repo)      GIT_REPO="$2";     shift 2 ;;
    --git-branch)    GIT_BRANCH="$2";   shift 2 ;;
    --git-pat)       GIT_PAT="$2";      shift 2 ;;
    --api-tag)       API_TAG="$2";      shift 2 ;;
    --web-tag)       WEB_TAG="$2";      shift 2 ;;
    --build-only)    BUILD_ONLY="$2";   shift 2 ;;
    --skip-compute)  SKIP_COMPUTE=true;  shift ;;
    --skip-orch)     SKIP_ORCH=true;     shift ;;
    --skip-imports)  SKIP_IMPORTS=true;  shift ;;
    --skip-secrets)      SKIP_SECRETS=true;      shift ;;
    --publish-packages)  PUBLISH_PACKAGES=true;  shift ;;
    --location)          LOCATION_ARG="$2";      shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Load config from dev.parameters.json (.forge section)
# CLI args take precedence over values in the file.
# ---------------------------------------------------------------------------
PARAMS_FILE="${REPO_ROOT}/infra/bicep/environments/${ENV}/${ENV}.parameters.json"
[[ ! -f "$PARAMS_FILE" ]] && { echo "ERROR: params file not found: $PARAMS_FILE"; exit 1; }

# JSON reader — uses jq if available, falls back to Python3
_jq() {
  local query="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r "${query} // empty" "$PARAMS_FILE" 2>/dev/null || echo ""
  else
    python3 - "$PARAMS_FILE" "$query" <<'EOF'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
keys = sys.argv[2].lstrip('.').split('.')
v = d
for k in keys:
    v = v.get(k, '') if isinstance(v, dict) else ''
print(v if v != '' else '')
EOF
  fi
}

[[ -z "$ALIAS" ]]      && ALIAS=$(_jq '.forge.alias')
[[ -z "$GIT_REPO" ]]   && GIT_REPO=$(_jq '.forge.gitRepo')
[[ -z "$GIT_BRANCH" ]] && GIT_BRANCH=$(_jq '.forge.gitBranch')
[[ -z "$API_TAG" ]]    && API_TAG=$(_jq '.forge.apiTag')
[[ -z "$WEB_TAG" ]]    && WEB_TAG=$(_jq '.forge.webTag')

FORGE_CLIENT_ID=$(_jq '.forge.clientId')
FORGE_TENANT_ID=$(_jq '.parameters.tenantId.value')
FORGE_ALLOWED_DOMAIN=$(_jq '.forge.allowedDomain')
# FORGE_REDIRECT_URI is computed after LOCATION is known (line ~188)

GIT_BRANCH="${GIT_BRANCH:-main}"
API_TAG="${API_TAG:-1.0}"
WEB_TAG="${WEB_TAG:-1.0}"

# ALIAS is optional — blank means shared/unscoped environment
[[ -z "$FORGE_CLIENT_ID" ]]     && { echo "ERROR: forge.clientId missing from $PARAMS_FILE"; exit 1; }
[[ -z "$FORGE_TENANT_ID" ]]     && { echo "ERROR: parameters.tenantId missing from $PARAMS_FILE"; exit 1; }
[[ -z "$FORGE_ALLOWED_DOMAIN" ]] && { echo "ERROR: forge.allowedDomain missing from $PARAMS_FILE"; exit 1; }

# ---------------------------------------------------------------------------
# Derived names — must match main.bicep naming conventions
# ---------------------------------------------------------------------------
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# When ALIAS is blank, names collapse to shared/unscoped form (e.g. rg-forge-dev)
_A="${ALIAS:+${ALIAS}-}"   # "prproddu-" when set, "" when blank
# ACR name must match shared/main.bicep: alias when set, else first 8 chars of subscription ID
if [[ -n "$ALIAS" ]]; then
  ACR="forgeacr${ALIAS}"
else
  _SUB_SUFFIX="${SUBSCRIPTION_ID//-/}"   # remove hyphens
  _SUB_SUFFIX="${_SUB_SUFFIX:0:8}"       # first 8 chars
  ACR="forgeacr${_SUB_SUFFIX}"
fi
ACR_RG="rg-forge-acr${ALIAS:+-${ALIAS}}"
RESOURCE_GROUP="rg-forge-${_A}${ENV}"
COMPUTE_CLUSTER="aks-forge-compute-${_A}${ENV}"
ORCH_CLUSTER="aks-forge-orchestration-${_A}${ENV}"
# KV, Postgres, ADLS are globally unique — use sub suffix when alias is blank (same as ACR)
# ADLS names must be lowercase — lowercase the alias portion
if [[ -n "$ALIAS" ]]; then
  _ALIAS_LC="${ALIAS,,}"
  KV_NAME="kv-forge-${_ALIAS_LC}-${ENV}"
  PG_SERVER="psql-forge-${_ALIAS_LC}-${ENV}"
  ADLS_ACCOUNT="forgeadls${_ALIAS_LC//-/}${ENV}"
else
  KV_NAME="kv-forge-${_SUB_SUFFIX}-${ENV}"
  PG_SERVER="psql-forge-${_SUB_SUFFIX}-${ENV}"
  ADLS_ACCOUNT="forgeadls${_SUB_SUFFIX}${ENV}"
fi
PG_HOST="${PG_SERVER}.postgres.database.azure.com"
# Azure DNS labels must be lowercase — lowercase the entire label
DNS_LABEL="forge-portal-${_A}${ENV}"; DNS_LABEL="${DNS_LABEL,,}"

# Resolve location: explicit arg > existing RG > existing cluster > westcentralus
# Checking RG (not cluster) means this works correctly on first deploy too.
if [[ -n "$LOCATION_ARG" ]]; then
  LOCATION="$LOCATION_ARG"
else
  LOCATION=$(az group show --name "$RESOURCE_GROUP" --query location -o tsv 2>/dev/null || echo "")
  if [[ -z "$LOCATION" ]]; then
    LOCATION=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$ORCH_CLUSTER" \
      --query location -o tsv 2>/dev/null || echo "westcentralus")
  fi
fi
NODE_RG_ORCH=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$ORCH_CLUSTER" \
  --query nodeResourceGroup -o tsv 2>/dev/null || echo "")

PUBLIC_HOST="${DNS_LABEL}.${LOCATION}.cloudapp.azure.com"
COMPUTE_DNS_LABEL="forge-compute-${_A}${ENV}"; COMPUTE_DNS_LABEL="${COMPUTE_DNS_LABEL,,}"
COMPUTE_PUBLIC_HOST="${COMPUTE_DNS_LABEL}.${LOCATION}.cloudapp.azure.com"
FORGE_REDIRECT_URI="https://${COMPUTE_PUBLIC_HOST}/oauth2/callback"


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
printf "║  portal URL : %-38s║\n" "https://$PUBLIC_HOST"
printf "║  trino UI   : %-38s║\n" "https://$COMPUTE_PUBLIC_HOST"
printf "║  spark conn : %-38s║\n" "sc://$COMPUTE_PUBLIC_HOST:15002"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# Phases 1–4 — skipped entirely when --build-only is set (no cluster needed)
# ---------------------------------------------------------------------------
if [[ -z "$BUILD_ONLY" ]]; then

# ---------------------------------------------------------------------------
# Phase 1 — Bicep infra provisioning (skippable)
# provision-infra.sh handles both Bicep + post-deploy (kubeconfigs + IP tags)
# ---------------------------------------------------------------------------
if [[ "$SKIP_INFRA" == "false" ]]; then
  echo "━━━ [1/8] Provision infrastructure ━━━━━━━━━━━━━━━━━━━━"

  # Pre-Bicep: recover any soft-deleted Key Vault secrets so Bicep can upsert them.
  # Purge protection (enabled on KV) blocks purging, but recover restores the secret
  # to active state so Bicep's PUT succeeds. Without this, re-deploys after RG deletion
  # fail with ConflictError: "secret is in a soft deleted state".
  DELETED_SECRETS=$(az keyvault secret list-deleted --vault-name "$KV_NAME" \
    --query "[].name" -o tsv 2>/dev/null || echo "")
  if [[ -n "$DELETED_SECRETS" ]]; then
    echo "  Recovering soft-deleted KV secrets (purge protection blocks re-create)..."
    while IFS= read -r secret; do
      az keyvault secret recover --vault-name "$KV_NAME" --name "$secret" --output none 2>/dev/null \
        && echo "    Recovered: $secret" \
        || echo "    WARN: could not recover $secret — Bicep may fail if name conflicts"
    done <<< "$DELETED_SECRETS"
  fi

  bash "${SCRIPT_DIR}/provision-infra.sh" --env "$ENV" --alias "$ALIAS" --sub "$SUBSCRIPTION_ID" --location "$LOCATION"
else
  echo "━━━ [1/8] Provision infrastructure — skipped (--skip-infra) ━━━━━━━━━"
  echo "         Refreshing kubeconfigs..."
  az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$COMPUTE_CLUSTER" --overwrite-existing --output none
  az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$ORCH_CLUSTER" --overwrite-existing --output none
  echo "         Done."
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 2 — Key Vault secret seeding
# ---------------------------------------------------------------------------
if [[ "$SKIP_SECRETS" == "true" ]]; then
  echo "━━━ [2/8] Seed Key Vault secrets — skipped (--skip-secrets) ━━━━━━━━━━━━"
  echo "━━━ [3/8] Configure Postgres — skipped (--skip-secrets) ━━━━━━━━━━━━━━━━"
  echo "━━━ [4/8] Create Kubernetes secrets — skipped (--skip-secrets) ━━━━━━━━━"
  # Still need AIRFLOW_WS_KEY and AIRFLOW_MI_NAME_CONN for Phase 7 token jobs
  AIRFLOW_WS_KEY=$(az keyvault secret show --vault-name "$KV_NAME" \
    --name "airflow-webserver-key" --query value -o tsv 2>/dev/null || echo "")
  AIRFLOW_MI_NAME_CONN=$(az identity show \
    --resource-group "$RESOURCE_GROUP" \
    --name "id-forge-airflow-${_A}${ENV}" \
    --query name -o tsv 2>/dev/null || echo "id-forge-airflow-${_A}${ENV}")
else
echo "━━━ [2/8] Seed Key Vault secrets ━━━━━━━━━━━━━━━━━━━━━━"

_kv_seed() {
  local name="$1" value="$2"
  # Skip if no value — Azure CLI rejects empty strings; optional secrets are
  # seeded manually via portal Settings once AAD SSO is configured.
  if [[ -z "$value" ]]; then
    echo "  Skipped: $name (no value — set manually when needed)"
    return
  fi
  local existing
  existing=$(az keyvault secret show --vault-name "$KV_NAME" --name "$name" \
    --query value -o tsv 2>/dev/null || echo "")
  if [[ -z "$existing" ]]; then
    az keyvault secret set --vault-name "$KV_NAME" --name "$name" --value "$value" --output none
    echo "  Created: $name"
  elif [[ "$existing" != "$value" ]]; then
    az keyvault secret set --vault-name "$KV_NAME" --name "$name" --value "$value" --output none
    echo "  Updated: $name"
  else
    echo "  Exists:  $name"
  fi
}

# Portal auth config
_kv_seed "forge-portal-auth-provider" "azure_ad"
_kv_seed "forge-portal-aad-client-id" "$FORGE_CLIENT_ID"
_kv_seed "forge-portal-aad-tenant-id" "$FORGE_TENANT_ID"

# Register OAuth2 redirect URIs on the app registration.
#
# Both portal and Trino use server-side OAuth2 (Web redirect URIs).
# The portal-auth-proxy uses the same pattern as the Trino auth proxy —
# no MSAL.js, no SPA platform, no PKCE required.
echo "  Registering OAuth2 redirect URIs..."
MSYS_NO_PATHCONV=1 az ad app update --id "$FORGE_CLIENT_ID" \
  --web-redirect-uris \
    "https://${PUBLIC_HOST}/oauth2/callback" \
    "http://localhost:8080/oauth2/callback" \
    "https://${COMPUTE_PUBLIC_HOST}/oauth2/callback" \
  2>/dev/null \
  && echo "    Web redirect URIs registered (portal + Trino auth proxies)" \
  || echo "    WARN: could not set Web redirect URIs — add manually"

# Expose an API scope so 'az account get-access-token --resource $FORGE_CLIENT_ID'
# works from the CLI (needed for Trino CLI bearer-token auth).
# Without this scope, Azure AD returns AADSTS650057 because the app has no
# permissions exposed and the token endpoint rejects the resource request.
# The scope UUID is fixed so re-runs are idempotent.
# Set identifierUri so 'az account get-access-token --resource api://$FORGE_CLIENT_ID' works.
# Without identifierUris, Azure AD returns AADSTS650057 ("List of valid resources: empty")
# even when oauth2PermissionScopes are present.
FORGE_IDENTIFIER_URI="api://${FORGE_CLIENT_ID}"
EXISTING_URI=$(az ad app show --id "$FORGE_CLIENT_ID" \
  --query "identifierUris[?@=='${FORGE_IDENTIFIER_URI}']" -o tsv 2>/dev/null || echo "")
if [[ -z "$EXISTING_URI" ]]; then
  MSYS_NO_PATHCONV=1 az ad app update --id "$FORGE_CLIENT_ID" \
    --identifier-uris "$FORGE_IDENTIFIER_URI" \
    2>/dev/null \
    && echo "    identifierUri set: ${FORGE_IDENTIFIER_URI} (enables az account get-access-token)" \
    || echo "    WARN: could not set identifierUri — add api://${FORGE_CLIENT_ID} manually"
else
  echo "    identifierUri already set: ${FORGE_IDENTIFIER_URI}"
fi

# Expose API scope 'access' on the app registration (required alongside identifierUri).
FORGE_API_SCOPE_ID="7d2e8f1a-3b4c-5d6e-7f8a-9b0c1d2e3f4a"
EXISTING_SCOPE=$(az ad app show --id "$FORGE_CLIENT_ID" \
  --query "api.oauth2PermissionScopes[?value=='access'].id" -o tsv 2>/dev/null || echo "")
if [[ -z "$EXISTING_SCOPE" ]]; then
  APP_OBJ_ID=$(az ad app show --id "$FORGE_CLIENT_ID" --query id -o tsv)
  EXISTING_SCOPES_JSON=$(az ad app show --id "$FORGE_CLIENT_ID" \
    --query "api.oauth2PermissionScopes" -o json 2>/dev/null || echo "[]")
  NEW_SCOPE="{\"adminConsentDescription\":\"Access Forge\",\"adminConsentDisplayName\":\"Access Forge\",\"id\":\"${FORGE_API_SCOPE_ID}\",\"isEnabled\":true,\"type\":\"User\",\"userConsentDescription\":\"Access Forge\",\"userConsentDisplayName\":\"Access Forge\",\"value\":\"access\"}"
  MERGED=$(echo "$EXISTING_SCOPES_JSON" | python3 -c "import sys,json; scopes=json.load(sys.stdin); scopes.append(json.loads('${NEW_SCOPE}')); print(json.dumps(scopes))")
  MSYS_NO_PATHCONV=1 az rest --method PATCH \
    --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}" \
    --headers "Content-Type=application/json" \
    --body "{\"api\":{\"oauth2PermissionScopes\":${MERGED}}}" \
    2>/dev/null \
    && echo "    API scope 'access' exposed on app registration" \
    || echo "    WARN: could not expose API scope — add manually via app registration manifest"
else
  echo "    API scope 'access' already present on app registration"
fi

# No Airflow DB password — Postgres is AAD-only. Airflow pods authenticate
# via workload identity token (see Phase 3 and Airflow Helm values).

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
# Phase 3 — Postgres: grant Airflow managed identity access to airflow DB
#
# Postgres is AAD-only (passwordAuth: Disabled). Server is VNet-integrated
# (private endpoint) — reachable from corpnet via ExpressRoute.
#
# The airflow database and AAD admin registrations are created by Bicep.
# This phase grants the Airflow managed identity schema-level privileges
# that ARM resources cannot set (GRANT ON SCHEMA requires a live SQL session).
#
# Auth: uses the calling engineer's az login AAD session — no password needed.
# The engineer's AAD group is registered as a Postgres AAD admin by Bicep
# (platformAdminGroupObjectId), so the CLI token is accepted directly.
# ---------------------------------------------------------------------------
echo "━━━ [3/8] Configure Postgres (Airflow schema grants) ━━━━━━━━━━━━━━━━━━━━"

AIRFLOW_MI_NAME=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "id-forge-airflow-${_A}${ENV}" \
  --query name -o tsv 2>/dev/null || echo "")

if [[ "$SKIP_PG_GRANTS" == "true" ]]; then
  echo "  Skipped (--skip-pg-grants) — grants assumed already applied."
elif [[ -z "$AIRFLOW_MI_NAME" ]]; then
  echo "  WARNING: Airflow managed identity not found — skipping grants."
  echo "           Run without --skip-infra first to provision it."
else
  echo "  Grants applied in Phase 7.0 via Airflow MI workload identity Job."
  echo "  (Postgres private endpoint unreachable from outside cluster —"
  echo "   using in-cluster OIDC token exchange instead of az postgres execute)"
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 4 — K8s secrets for Airflow (both clusters)
# ---------------------------------------------------------------------------
echo "━━━ [4/8] Create Kubernetes secrets ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Airflow connects to Postgres via AAD token (workload identity).
# The connection string uses the managed identity name as the PostgreSQL user;
# the password field is intentionally empty here — the Airflow Helm chart uses
# an init container to fetch the token from the IMDS endpoint and inject it at
# startup (see infra/helm/orchestration/airflow/values.yaml extraInitContainers).
AIRFLOW_MI_NAME_CONN=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "id-forge-airflow-${_A}${ENV}" \
  --query name -o tsv 2>/dev/null || echo "id-forge-airflow-${_A}${ENV}")
AIRFLOW_DB_CONN="postgresql+psycopg2://${AIRFLOW_MI_NAME_CONN}@${PG_HOST}/airflow?sslmode=require"

# Ensure airflow namespace exists before creating secrets
kubectl create namespace airflow \
  --context "$ORCH_CLUSTER" \
  --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f - 2>/dev/null || true

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

# Git-sync credentials — requires PAT.
# git-sync v4 uses GITSYNC_* env vars; chart also sets legacy GIT_SYNC_* aliases.
# Both key names must exist in the secret or pods fail with CreateContainerConfigError.
if [[ -n "$GIT_PAT" ]]; then
  kubectl create secret generic airflow-git-credentials \
    --from-literal="GIT_SYNC_USERNAME=forge" \
    --from-literal="GIT_SYNC_PASSWORD=${GIT_PAT}" \
    --from-literal="GITSYNC_USERNAME=forge" \
    --from-literal="GITSYNC_PASSWORD=${GIT_PAT}" \
    --namespace airflow \
    --context "$ORCH_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f -
  echo "    airflow-git-credentials"
else
  # No PAT — create placeholder credentials now; the token-init Job in [7.0]
  # will overwrite GIT_SYNC_PASSWORD/GITSYNC_PASSWORD with a live AAD access
  # token fetched via Airflow MI workload identity (OIDC). git-sync will start
  # failing until [7.0] runs, but it retries every 30s so it self-heals.
  # Prerequisite: id-forge-airflow-<env> must have Read access in the ADO org.
  kubectl create secret generic airflow-git-credentials \
    --from-literal="GIT_SYNC_USERNAME=forge" \
    --from-literal="GIT_SYNC_PASSWORD=placeholder" \
    --from-literal="GITSYNC_USERNAME=forge" \
    --from-literal="GITSYNC_PASSWORD=placeholder" \
    --namespace airflow \
    --context "$ORCH_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f -
  echo "    airflow-git-credentials (placeholder — ADO MI token injected in [7.0])"
fi

# Airflow OAuth — federated credential (same pattern as Trino UI AAD, S360-compliant).
# The Airflow webserver reads AZURE_FEDERATED_TOKEN_FILE (workload identity) and uses
# it as client_assertion when exchanging OAuth auth codes — no client_secret, no cert.
# forge-up.sh registers a federated credential on the app registration that trusts:
#   issuer:  orch cluster OIDC issuer
#   subject: system:serviceaccount:airflow:airflow
APP_OBJ_ID=$(az ad app show --id "$FORGE_CLIENT_ID" --query id -o tsv 2>/dev/null || echo "")
if [[ -n "$APP_OBJ_ID" ]]; then
  # Pre-flight: verify Graph API write access before attempting any federated credential ops.
  # Federated credential creation requires Application.ReadWrite.All or Application.ReadWrite.OwnedBy
  # on the identity running forge-up.sh. Without it, all FC operations silently fail and
  # auth (Airflow OAuth, Portal proxy, Trino proxy) breaks at runtime.
  FC_TEST=$(MSYS_NO_PATHCONV=1 az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
    2>&1) || true   # || true: prevent set -e from exiting on 403/error before we can inspect FC_TEST
  if echo "$FC_TEST" | grep -qi "Authorization_RequestDenied\|Forbidden\|Insufficient privileges\|does not have permission"; then
    echo ""
    echo "ERROR: Cannot manage federated credentials on app registration ${FORGE_CLIENT_ID}."
    echo "       Grant 'Application.ReadWrite.All' (or OwnedBy) to the identity running forge-up.sh:"
    echo "       az ad app owner add --id ${FORGE_CLIENT_ID} --owner-object-id <your-object-id>"
    echo ""
    exit 1
  fi

  # Airflow OAuth federated credential.
  # Retry OIDC issuer fetch — on fresh AKS deploy it can take up to 60s to propagate.
  ORCH_OIDC_ISSUER=""
  for _i in 1 2 3 4 5 6; do
    ORCH_OIDC_ISSUER=$(az aks show --resource-group "$RESOURCE_GROUP" \
      --name "$ORCH_CLUSTER" --query oidcIssuerProfile.issuerUrl -o tsv 2>/dev/null || echo "")
    [[ -n "$ORCH_OIDC_ISSUER" ]] && break
    echo "    Waiting for AKS OIDC issuer (attempt ${_i}/6)..."
    sleep 15
  done
  if [[ -n "$ORCH_OIDC_ISSUER" ]]; then
    FC_SUBJECT="system:serviceaccount:airflow:airflow"
    # Upsert by name: if airflow-orch-federation exists (possibly with stale issuer/subject
    # from a prior cluster), PATCH it. Otherwise POST. Checking by subject alone misses the
    # stale-name case and causes a name-conflict error on POST.
    FC_LIST=$(MSYS_NO_PATHCONV=1 az rest --method GET \
      --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
      -o json 2>&1) || true
    EXISTING_FC_ID=$(echo "$FC_LIST" | python3 -c \
      "import sys,json; fcs=json.load(sys.stdin).get('value',[]); match=[f['id'] for f in fcs if f.get('name')=='airflow-orch-federation']; print(match[0] if match else '')" 2>/dev/null || echo "")
    if [[ -n "$EXISTING_FC_ID" ]]; then
      if FC_ERR=$(MSYS_NO_PATHCONV=1 az rest --method PATCH \
          --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials/${EXISTING_FC_ID}" \
          --headers "Content-Type=application/json" \
          --body "{\"issuer\":\"${ORCH_OIDC_ISSUER}\",\"subject\":\"${FC_SUBJECT}\"}" \
          --output none 2>&1); then
        echo "    Updated airflow-orch-federation (issuer + subject → new cluster)"
      elif echo "$FC_ERR" | grep -q "InvalidFederatedIdentityCredentialValue\|not allowed as per assigned policy"; then
        echo "    WARN: Tenant policy blocks AKS OIDC issuer — airflow-orch-federation kept with prior issuer."
        echo "          Airflow OAuth login may not work until policy is relaxed or cluster is stable."
      else
        echo "    ERROR: Failed to update airflow federated credential: ${FC_ERR}"; exit 1
      fi
    else
      if FC_ERR=$(MSYS_NO_PATHCONV=1 az rest --method POST \
          --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
          --body "{\"name\":\"airflow-orch-federation\",\"issuer\":\"${ORCH_OIDC_ISSUER}\",\"subject\":\"${FC_SUBJECT}\",\"audiences\":[\"api://AzureADTokenExchange\"]}" \
          --output none 2>&1); then
        echo "    Federated credential created: airflow → app reg"
      elif echo "$FC_ERR" | grep -q "InvalidFederatedIdentityCredentialValue\|not allowed as per assigned policy"; then
        echo "    WARN: Tenant policy blocks AKS OIDC issuer — airflow-orch-federation not created."
        echo "          Airflow OAuth login may not work until policy is relaxed."
      else
        echo "    ERROR: Failed to create airflow federated credential: ${FC_ERR}"; exit 1
      fi
    fi
  else
    echo "    ERROR: AKS OIDC issuer not available after 90s — cannot create airflow federated credential."
    exit 1
  fi
fi

# Portal auth proxy — ensure app registration has federated credential for portal MI.
# The proxy exchanges its SA OIDC token (AZURE_FEDERATED_TOKEN_FILE) for a portal MI
# access token (via fc-portal-orchestration-dev on the MI), then uses that MI token as
# client_assertion.  The app registration must trust tokens from the portal MI's
# principalId (sub) issued by login.microsoftonline.com/v2.0 (AAD issuer — not AKS
# OIDC issuer, which is blocked by tenant policy).
PORTAL_MI_PRINCIPAL_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
  --name "id-forge-portal-${_A}${ENV}" --query principalId -o tsv 2>/dev/null || echo "")
if [[ -z "$PORTAL_MI_PRINCIPAL_ID" ]]; then
  echo "    ERROR: id-forge-portal-${_A}${ENV} MI not found — Bicep provisioning may have failed."
  exit 1
fi
if [[ -n "$APP_OBJ_ID" ]]; then
  FC_ISSUER="https://login.microsoftonline.com/${FORGE_TENANT_ID}/v2.0"
  EXISTING_FC=$(MSYS_NO_PATHCONV=1 az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
    --query "value[?subject=='${PORTAL_MI_PRINCIPAL_ID}'].id" -o tsv 2>/dev/null || echo "")
  if [[ -z "$EXISTING_FC" ]]; then
    # Upsert: update any stale managed-identity-federation entry (from prior env), or create new
    STALE_FC_ID=$(MSYS_NO_PATHCONV=1 az rest --method GET \
      --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
      --query "value[?name=='managed-identity-federation'].id" -o tsv 2>/dev/null || echo "")
    if [[ -n "$STALE_FC_ID" ]]; then
      if FC_ERR=$(MSYS_NO_PATHCONV=1 az rest --method PATCH \
          --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials/${STALE_FC_ID}" \
          --headers "Content-Type=application/json" \
          --body "{\"subject\":\"${PORTAL_MI_PRINCIPAL_ID}\"}" \
          --output none 2>&1); then
        echo "    Updated managed-identity-federation subject → portal MI"
      else
        echo "    ERROR: Failed to update managed-identity-federation: ${FC_ERR}"; exit 1
      fi
    else
      if FC_ERR=$(MSYS_NO_PATHCONV=1 az rest --method POST \
          --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
          --headers "Content-Type=application/json" \
          --body "{\"name\":\"managed-identity-federation\",\"issuer\":\"${FC_ISSUER}\",\"subject\":\"${PORTAL_MI_PRINCIPAL_ID}\",\"audiences\":[\"api://AzureADTokenExchange\"]}" \
          --output none 2>&1); then
        echo "    Created managed-identity-federation: portal MI → app reg"
      else
        echo "    ERROR: Failed to create managed-identity-federation: ${FC_ERR}"; exit 1
      fi
    fi
  else
    echo "    Federated credential already correct: portal MI → app reg"
  fi
fi

# Assign id-forge-portal-{env} MI to orch cluster VMSS nodes so IMDS works from
# portal-auth-proxy pods (same pattern as id-forge-trino-{env} on compute VMSS).
PORTAL_MI_RESOURCE_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-forge-portal-${_A}${ENV}"
NODE_RG_ORCH=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$ORCH_CLUSTER" \
  --query nodeResourceGroup -o tsv 2>/dev/null || echo "")
if [[ -n "$NODE_RG_ORCH" ]]; then
  ORCH_VMSS_NAMES=$(az vmss list --resource-group "$NODE_RG_ORCH" \
    --query "[].name" -o tsv 2>/dev/null || echo "")
  for VMSS_NAME in $ORCH_VMSS_NAMES; do
    MSYS_NO_PATHCONV=1 az vmss identity assign \
      --resource-group "$NODE_RG_ORCH" \
      --name "$VMSS_NAME" \
      --identities "$PORTAL_MI_RESOURCE_ID" \
      --output none 2>/dev/null || true
  done
  echo "    Portal MI assigned to orch cluster VMSS nodes"
fi

kubectl create secret generic airflow-oauth-credentials \
  --from-literal="client-id=${FORGE_CLIENT_ID}" \
  --namespace airflow \
  --context "$ORCH_CLUSTER" \
  --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f -
echo "    airflow-oauth-credentials"

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
if [[ "$SKIP_COMPUTE" == "true" ]]; then
  echo "    proxy-session-secret (skipped — --skip-compute)"
elif ! kubectl get secret proxy-session-secret -n trino --context "$COMPUTE_CLUSTER" &>/dev/null; then
  SESSION_KEY=$(openssl rand -hex 32)
  kubectl create namespace trino --context "$COMPUTE_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$COMPUTE_CLUSTER" -f - 2>/dev/null || true
  kubectl create secret generic proxy-session-secret \
    --from-literal="session-secret=${SESSION_KEY}" \
    --namespace trino \
    --context "$COMPUTE_CLUSTER"
  echo "    proxy-session-secret (trino, compute cluster)"
else
  echo "    proxy-session-secret (already exists)"
fi
echo ""

fi  # end SKIP_SECRETS else block

fi  # end phases 1–4 (skipped when --build-only)

# ---------------------------------------------------------------------------
# Phase 5 — Build and push Docker images to ACR
# Builds all custom images. Skippable with --skip-build if already in ACR.
# ---------------------------------------------------------------------------
echo "━━━ [5/8] Build and push images to ACR (parallel) ━━━━━━━━━━━━━━━━━━━━━━"

# Open ACR public access for builds and Helm OCI pulls.
# Closed again after phase 8 (or on script exit via trap).
echo "  Opening ACR public access..."
az acr update --name "$ACR" --public-network-enabled true --default-action Allow --output none
_ACR_OPENED=true
# Wait for firewall rule to propagate before attempting login
sleep 10

_close_acr() {
  if [[ "${_ACR_OPENED:-false}" == "true" ]]; then
    echo ""
    echo "  Closing ACR public access..."
    az acr update --name "$ACR" --public-network-enabled false --default-action Deny --output none 2>/dev/null || true
    echo "  ACR locked down."
  fi
}
trap _close_acr EXIT

SPARK_TAG=$(_jq '.forge.sparkTag // "1.0"')
SPARK_TAG="${SPARK_TAG:-1.0}"
TRINO_TAG=$(_jq '.forge.trinoTag // "1.0"')
TRINO_TAG="${TRINO_TAG:-1.0}"
AIRFLOW_TAG=$(_jq '.forge.airflowTag // "1.0"')
AIRFLOW_TAG="${AIRFLOW_TAG:-1.0}"
HMS_TAG=$(_jq '.forge.hmsTag // "1.0"')
HMS_TAG="${HMS_TAG:-1.0}"

# ---------------------------------------------------------------------------
# Import third-party images and Helm charts into ACR.
# Runs regardless of --skip-build — these are not custom images.
# Azure Policy blocks external registries on AKS nodes; everything must come
# from ACR. Helm charts are pulled from public repos and pushed as OCI artifacts.
# ---------------------------------------------------------------------------

# Helm OCI login — required for helm push and helm upgrade --install from ACR.
echo "  Authenticating Helm with ACR..."
ACR_TOKEN=$(az acr login --name "$ACR" --expose-token --output tsv --query accessToken 2>/dev/null)
echo "$ACR_TOKEN" | helm registry login "${ACR}.azurecr.io" \
  --username "00000000-0000-0000-0000-000000000000" \
  --password-stdin
echo "  Helm ACR login done."

# Third-party container images + Helm charts — idempotent imports into ACR.
# Skippable with --skip-imports when everything is already in ACR.
if [[ "$SKIP_IMPORTS" == "true" ]]; then
  echo "  Skipped: third-party image and Helm chart imports (--skip-imports)"
else
  echo "  Importing third-party images → ACR..."
  _acr_import() {
    local src="$1" dst="$2"
    # Parse repo and tag from dst (e.g. "git-sync:v4.4.2")
    local repo="${dst%%:*}" tag="${dst##*:}"
    # Check if tag already exists — avoids re-importing on every run
    local existing
    existing=$(az acr repository show-tags --name "$ACR" --resource-group "$ACR_RG" \
      --repository "$repo" --query "[?@=='$tag']" -o tsv 2>/dev/null || echo "")
    if [[ -n "$existing" ]]; then
      echo "    ✓ $dst (already in ACR)"
      return
    fi
    az acr import --name "$ACR" --resource-group "$ACR_RG" \
      --source "$src" --image "$dst" --output none 2>/dev/null \
      && echo "    ✓ $dst (imported)" || echo "    WARN: $dst import failed"
  }
  # ingress-nginx — Azure Policy blocks registry.k8s.io on restricted clusters
  _acr_import "registry.k8s.io/ingress-nginx/controller:v1.15.1"               "ingress-nginx/controller:v1.15.1"
  _acr_import "registry.k8s.io/defaultbackend-amd64:1.5"                       "defaultbackend-amd64:1.5"
  _acr_import "registry.k8s.io/git-sync/git-sync:v4.4.2"                        "git-sync:v4.4.2"
  _acr_import "ghcr.io/kubeflow/spark-operator/controller:2.5.0"               "spark-operator-controller:2.5.0"
  _acr_import "ghcr.io/kubeflow/spark-operator/kubectl:2.5.0"                  "spark-operator-kubectl:2.5.0"
  # cert-manager — all 5 images must come from ACR (Azure Policy blocks quay.io)
  _acr_import "quay.io/jetstack/cert-manager-controller:v1.17.1"               "cert-manager-controller:v1.17.1"
  _acr_import "quay.io/jetstack/cert-manager-webhook:v1.17.1"                  "cert-manager-webhook:v1.17.1"
  _acr_import "quay.io/jetstack/cert-manager-cainjector:v1.17.1"               "cert-manager-cainjector:v1.17.1"
  _acr_import "quay.io/jetstack/cert-manager-acmesolver:v1.17.1"               "cert-manager-acmesolver:v1.17.1"
  _acr_import "quay.io/jetstack/cert-manager-startupapicheck:v1.17.1"          "cert-manager-startupapicheck:v1.17.1"

  # Helm charts — pull from public repos, push to ACR OCI registry
  echo "  Importing Helm charts → ACR OCI..."
  _helm_import() {
    local chart="$1" version="$2" repo="$3"
    local tgz="${chart}-${version}.tgz"
    # Skip if already present — helm show chart verifies the manifest exists in ACR
    if helm show chart "oci://${ACR}.azurecr.io/helm/${chart}" --version "$version" &>/dev/null 2>&1; then
      echo "    ✓ helm/${chart}:${version} (already in ACR)"
      return
    fi
    local _helm_tmp
    _helm_tmp=$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}")
    helm pull "$chart" --version "$version" --repo "$repo" --destination "$_helm_tmp" 2>/dev/null \
      && helm push "${_helm_tmp}/${tgz}" "oci://${ACR}.azurecr.io/helm" 2>/dev/null \
      && echo "    ✓ helm/${chart}:${version} (imported)" \
      || echo "    WARN: helm/${chart}:${version} import failed"
    rm -f "${_helm_tmp}/${tgz}"
  }
  _helm_import "spark-operator" "2.5.0"  "https://kubeflow.github.io/spark-operator"
  _helm_import "airflow"        "1.20.0" "https://airflow.apache.org"
  _helm_import "trino"          "1.36.0" "https://trinodb.github.io/charts"
  _helm_import "cert-manager"   "v1.17.1" "https://charts.jetstack.io"
fi

if [[ -n "$BUILD_ONLY" ]]; then
  # --build-only: rebuild specific images, then exit (no deploy phases)
  SKIP_BUILD=false
fi

if [[ "$SKIP_BUILD" == "true" ]]; then
  echo "  Skipped: all custom images (--skip-build)"
else
  # All 7 images are independent — submit all ACR Tasks in parallel.
  # Each az acr build runs in Azure (ACR Tasks), no local CPU contention.
  # Reduces Phase 5 from ~8 min sequential → ~2 min parallel.
  _BUILD_NAMES=()
  _BUILD_PIDS=()
  _BUILD_LOGS=()

  _queue_build() {
    local name="$1" image="$2" tag="$3" dockerfile="$4" context="$5"
    shift 5
    local build_args=("$@")   # optional --build-arg KEY=VALUE pairs
    # If --build-only is set, skip images not in the list
    if [[ -n "$BUILD_ONLY" ]]; then
      if [[ ",${BUILD_ONLY}," != *",${name},"* ]]; then
        echo "  Skipped: ${image}:${tag} (not in --build-only)"
        return
      fi
    fi
    local logfile
    logfile=$(mktemp /tmp/acr-build-XXXXXX.log)
    _BUILD_NAMES+=("$name")
    _BUILD_LOGS+=("$logfile")
    echo "  Queued : ${image}:${tag}"
    # Convert Unix paths to Windows mixed format (D:/path/...) so az.cmd can
    # resolve them. cygpath -m is a no-op on Linux/WSL where paths are native.
    local win_dockerfile win_context
    win_dockerfile=$(cygpath -m "$dockerfile" 2>/dev/null || echo "$dockerfile")
    win_context=$(cygpath -m "$context" 2>/dev/null || echo "$context")
    # MSYS_NO_PATHCONV=1: prevent Git Bash from converting --build-arg values
    # that start with / (e.g. API_URL=/api → API_URL=C:/api without this).
    # Paths above are already Windows-format so they are unaffected.
    # --no-logs: skip streaming to stdout — avoids Windows cp1252 encoding
    # errors on characters like ▲ (U+25B2) from Next.js build output.
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" az acr build \
      --registry "$ACR" \
      --resource-group "$ACR_RG" \
      --image "${image}:${tag}" \
      --file "$win_dockerfile" \
      "${build_args[@]}" \
      "$win_context" \
      --no-logs \
      --output none >"$logfile" 2>&1 &
    _BUILD_PIDS+=($!)
  }

  _queue_build "spark"            "spark"            "$SPARK_TAG"   "${REPO_ROOT}/infra/docker/spark/Dockerfile"             "${REPO_ROOT}/"
  _queue_build "trino"            "trino"            "$TRINO_TAG"   "${REPO_ROOT}/infra/docker/trino/Dockerfile"             "${REPO_ROOT}/infra/docker/trino/"
  _queue_build "airflow"          "airflow"          "$AIRFLOW_TAG" "${REPO_ROOT}/infra/docker/airflow/Dockerfile"           "${REPO_ROOT}/infra/docker/airflow/"
  _queue_build "hive-metastore"   "hive-metastore"   "$HMS_TAG"     "${REPO_ROOT}/infra/docker/hive-metastore/Dockerfile"   "${REPO_ROOT}/infra/docker/hive-metastore/"
  _queue_build "trino-auth-proxy"  "trino-auth-proxy"  "1.2"      "${REPO_ROOT}/infra/docker/trino-auth-proxy/Dockerfile"  "${REPO_ROOT}/infra/docker/trino-auth-proxy/"
  _queue_build "portal-auth-proxy" "portal-auth-proxy" "1.0"      "${REPO_ROOT}/infra/docker/portal-auth-proxy/Dockerfile" "${REPO_ROOT}/infra/docker/portal-auth-proxy/"
  _queue_build "portal-api"        "portal-api"        "$API_TAG"  "${REPO_ROOT}/infra/docker/portal-api/Dockerfile"        "${REPO_ROOT}/portal/backend/"
  _queue_build "portal-web"        "portal-web"        "$WEB_TAG"  "${REPO_ROOT}/infra/docker/portal-web/Dockerfile"        "${REPO_ROOT}/portal/frontend/"

  echo "  Waiting for ${#_BUILD_PIDS[@]} builds to complete..."
  _BUILD_FAILED=()
  for i in "${!_BUILD_PIDS[@]}"; do
    if wait "${_BUILD_PIDS[$i]}"; then
      echo "  ✓ ${_BUILD_NAMES[$i]} → ${ACR}.azurecr.io"
    else
      echo "  ✗ ${_BUILD_NAMES[$i]} — FAILED"
      if [[ -s "${_BUILD_LOGS[$i]}" ]]; then
        echo "    --- az acr build error ---"
        cat "${_BUILD_LOGS[$i]}"
        echo "    --------------------------"
      else
        echo "    View ACR Task logs: az acr task list-runs --registry ${ACR} --resource-group ${ACR_RG} --top 5"
        echo "    Then:               az acr task logs --registry ${ACR} --resource-group ${ACR_RG} --run-id <id>"
      fi
      _BUILD_FAILED+=("${_BUILD_NAMES[$i]}")
    fi
    rm -f "${_BUILD_LOGS[$i]}"
  done

  if [[ ${#_BUILD_FAILED[@]} -gt 0 ]]; then
    echo "ERROR: Image build(s) failed: ${_BUILD_FAILED[*]}"
    exit 1
  fi
fi
echo ""

# If --build-only was used, all requested images are now in ACR — done.
if [[ -n "$BUILD_ONLY" ]]; then
  echo "=== --build-only complete. Skipping deploy phases. ==="
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase 6+7 — Compute and Orchestration cluster deploys (parallel)
# Two separate AKS clusters — fully independent, run simultaneously.
# Phase 6: Hive Metastore, Spark Operator, Spark Connect, Trino, Trino Auth Proxy
# Phase 7: ingress-nginx, Airflow, Portal
# ---------------------------------------------------------------------------
echo "━━━ [6+7/8] Deploy clusters in parallel ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Compute    : $COMPUTE_CLUSTER"
echo "  Orch       : $ORCH_CLUSTER"
echo "  (monitor:    kubectl get pods -A --context <cluster>)"
echo ""


_COMPUTE_LOG=$(mktemp /tmp/forge-compute-XXXXXX.log)
_ORCH_LOG=$(mktemp /tmp/forge-orch-XXXXXX.log)

# ── Phase 6: Compute cluster ────────────────────────────────────────────────
if [[ "$SKIP_COMPUTE" == "true" ]]; then
  echo "Skipped: compute cluster (--skip-compute)" >"$_COMPUTE_LOG"
  true &
  _COMPUTE_PID=$!
else
(
  set -euo pipefail

  HMS_WI_CLIENT_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
    --name "id-forge-hms-${_A}${ENV}" --query clientId -o tsv 2>/dev/null || echo "")
  TRINO_WI_CLIENT_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
    --name "id-forge-trino-${_A}${ENV}" --query clientId -o tsv 2>/dev/null || echo "")
  HMS_HOST=$(az keyvault secret show --vault-name "$KV_NAME" \
    --name "hms-postgres-host" --query value -o tsv 2>/dev/null || echo "$PG_HOST")

  echo "  [6.0] ingress-nginx (compute)..."
  _DNS_LABEL_COMPUTE="${COMPUTE_DNS_LABEL}"
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update 2>/dev/null || true
  helm repo update ingress-nginx 2>/dev/null || true
  # Only clean up truly stuck releases (pending state from a killed process).
  # "failed" releases are left alone — pods may already be running; helm upgrade will succeed.
  _ing_status=$(helm status ingress-nginx -n ingress-nginx --kube-context "$COMPUTE_CLUSTER" 2>/dev/null \
    | awk '/^STATUS:/ {print $2}' || echo "")
  if [[ "$_ing_status" == "pending-install" || "$_ing_status" == "pending-upgrade" || "$_ing_status" == "pending-rollback" ]]; then
    echo "    Resetting stuck ingress-nginx release on compute (status: $_ing_status)..."
    helm uninstall ingress-nginx -n ingress-nginx --kube-context "$COMPUTE_CLUSTER" 2>/dev/null || true
    sleep 5
  fi
  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    --namespace ingress-nginx --create-namespace \
    --kube-context "$COMPUTE_CLUSTER" \
    --values "${REPO_ROOT}/infra/helm/compute/ingress-nginx/values.yaml" \
    --set "controller.service.annotations.service\.beta\.kubernetes\.io/azure-dns-label-name=${_DNS_LABEL_COMPUTE}" \
    --set "controller.image.registry=${ACR}.azurecr.io" \
    --set "controller.image.image=ingress-nginx/controller" \
    --set "controller.image.tag=v1.15.1" \
    --set "controller.image.digest=" \
    --set "defaultBackend.image.registry=${ACR}.azurecr.io" \
    --set "defaultBackend.image.image=defaultbackend-amd64" \
    --set "defaultBackend.image.tag=1.5" \
    --wait --timeout 10m
  # Set DNS label and S360 tag on compute cluster public IP (same as orch)
  COMPUTE_EXTERNAL_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
    --context "$COMPUTE_CLUSTER" \
    --output jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  NODE_RG_COMPUTE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$COMPUTE_CLUSTER" \
    --query nodeResourceGroup -o tsv 2>/dev/null || echo "")
  if [[ -n "$COMPUTE_EXTERNAL_IP" && -n "$NODE_RG_COMPUTE" ]]; then
    COMPUTE_PIP_NAME=$(az network public-ip list \
      --resource-group "$NODE_RG_COMPUTE" \
      --query "[?ipAddress=='${COMPUTE_EXTERNAL_IP}'].name" -o tsv 2>/dev/null || echo "")
    if [[ -n "$COMPUTE_PIP_NAME" ]]; then
      az network public-ip update \
        --resource-group "$NODE_RG_COMPUTE" \
        --name "$COMPUTE_PIP_NAME" \
        --dns-name "$_DNS_LABEL_COMPUTE" \
        --output none 2>/dev/null || true
      az network public-ip update \
        --resource-group "$NODE_RG_COMPUTE" \
        --name "$COMPUTE_PIP_NAME" \
        --ip-tags FirstPartyUsage=/NonProd \
        --output none 2>/dev/null || true
      echo "    FQDN: ${COMPUTE_PUBLIC_HOST}"
    fi
  fi
  echo "    Done"

  echo "  [6.0.5] cert-manager + Let's Encrypt issuer (compute)..."
  az acr login --name "$ACR" --expose-token --output tsv --query accessToken 2>/dev/null \
    | helm registry login "${ACR}.azurecr.io" --username "00000000-0000-0000-0000-000000000000" --password-stdin 2>/dev/null || true
  helm upgrade --install cert-manager \
    "oci://${ACR}.azurecr.io/helm/cert-manager" \
    --version "v1.17.1" \
    --namespace cert-manager --create-namespace \
    --kube-context "$COMPUTE_CLUSTER" \
    --values "${REPO_ROOT}/infra/helm/compute/cert-manager/values.yaml" \
    --set "image.repository=${ACR}.azurecr.io/cert-manager-controller" \
    --set "webhook.image.repository=${ACR}.azurecr.io/cert-manager-webhook" \
    --set "cainjector.image.repository=${ACR}.azurecr.io/cert-manager-cainjector" \
    --set "acmesolver.image.repository=${ACR}.azurecr.io/cert-manager-acmesolver" \
    --set "startupapicheck.image.repository=${ACR}.azurecr.io/cert-manager-startupapicheck" \
    --wait --timeout 8m
  kubectl rollout status deployment/cert-manager-webhook -n cert-manager \
    --context "$COMPUTE_CLUSTER" --timeout=120s 2>/dev/null || true
  kubectl apply -f "${REPO_ROOT}/infra/helm/compute/cert-manager/letsencrypt-issuer.yaml" \
    --context "$COMPUTE_CLUSTER"
  echo "    Done"

  echo "  [6.1] Hive Metastore..."
  # Service account must exist before the Deployment — HMS chart has no SA template.
  kubectl create namespace hive-metastore --context "$COMPUTE_CLUSTER" --dry-run=client -o yaml \
    | kubectl apply --context "$COMPUTE_CLUSTER" -f - 2>/dev/null || true
  kubectl create serviceaccount hive-metastore -n hive-metastore --context "$COMPUTE_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$COMPUTE_CLUSTER" -f - 2>/dev/null || true
  if [[ -n "$HMS_WI_CLIENT_ID" ]]; then
    kubectl annotate serviceaccount hive-metastore -n hive-metastore \
      --context "$COMPUTE_CLUSTER" --overwrite \
      "azure.workload.identity/client-id=${HMS_WI_CLIENT_ID}" 2>/dev/null || true
  fi
  helm upgrade --install hive-metastore \
    "${REPO_ROOT}/infra/helm/compute/hive-metastore" \
    --namespace hive-metastore --create-namespace \
    --kube-context "$COMPUTE_CLUSTER" \
    --set "image.repository=${ACR}.azurecr.io/hive-metastore" \
    --set "image.tag=${HMS_TAG}" \
    --set "db.host=${HMS_HOST}" \
    --set "db.user=id-forge-hms-${_A}${ENV}" \
    --set "adls.account=${ADLS_ACCOUNT}" \
    ${HMS_WI_CLIENT_ID:+--set "serviceAccount.annotations.azure\.workload\.identity/client-id=${HMS_WI_CLIENT_ID}"} \
    --wait --timeout 10m
  echo "    Done"

  echo "  [6.2] Spark Operator..."
  az acr login --name "$ACR" --expose-token --output tsv --query accessToken 2>/dev/null \
    | helm registry login "${ACR}.azurecr.io" --username "00000000-0000-0000-0000-000000000000" --password-stdin 2>/dev/null || true
  kubectl create namespace spark-jobs --context "$COMPUTE_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$COMPUTE_CLUSTER" -f - 2>/dev/null || true
  helm upgrade --install spark-operator \
    "oci://${ACR}.azurecr.io/helm/spark-operator" \
    --version 2.5.0 \
    --namespace spark-system --create-namespace \
    --kube-context "$COMPUTE_CLUSTER" \
    --values "${REPO_ROOT}/infra/helm/compute/spark-operator/values.yaml" \
    --set "image.registry=${ACR}.azurecr.io" \
    --set "image.repository=spark-operator-controller" \
    --set "image.tag=2.5.0" \
    --set "hook.image.registry=${ACR}.azurecr.io" \
    --wait --timeout 5m
  echo "    Done"

  echo "  [6.3] Spark Connect..."
  kubectl create serviceaccount spark -n spark-system --context "$COMPUTE_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$COMPUTE_CLUSTER" -f - 2>/dev/null || true
  helm upgrade --install spark-connect \
    "${REPO_ROOT}/infra/helm/compute/spark-connect" \
    --namespace spark-system \
    --kube-context "$COMPUTE_CLUSTER" \
    --values "${REPO_ROOT}/infra/helm/compute/spark-connect/values.yaml" \
    --values "${REPO_ROOT}/infra/helm/compute/spark-connect/values-dev.yaml" \
    --set "image.repository=${ACR}.azurecr.io/spark" \
    --set "image.tag=${SPARK_TAG}" \
    --set "adls.account=${ADLS_ACCOUNT}" \
    --wait --timeout 10m
  echo "    Done"

  echo "  [6.4] Trino..."
  kubectl create namespace trino --context "$COMPUTE_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$COMPUTE_CLUSTER" -f - 2>/dev/null || true
  kubectl create serviceaccount trino -n trino --context "$COMPUTE_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$COMPUTE_CLUSTER" -f - 2>/dev/null || true
  if [[ -n "$TRINO_WI_CLIENT_ID" ]]; then
    # Annotate both the trino workload SA and the auth proxy SA
    kubectl annotate serviceaccount trino -n trino --context "$COMPUTE_CLUSTER" --overwrite \
      "azure.workload.identity/client-id=${TRINO_WI_CLIENT_ID}" 2>/dev/null || true
    kubectl annotate serviceaccount oauth2-proxy-sa -n trino --context "$COMPUTE_CLUSTER" --overwrite \
      "azure.workload.identity/client-id=${TRINO_WI_CLIENT_ID}" 2>/dev/null || true
  fi
  TRINO_WI_ARG=""
  [[ -n "$TRINO_WI_CLIENT_ID" ]] && TRINO_WI_ARG="--set serviceAccount.annotations.azure\.workload\.identity/client-id=${TRINO_WI_CLIENT_ID}"
  helm upgrade --install trino \
    "oci://${ACR}.azurecr.io/helm/trino" \
    --version 1.36.0 \
    --namespace trino --create-namespace \
    --kube-context "$COMPUTE_CLUSTER" \
    --values "${REPO_ROOT}/infra/helm/compute/trino/values.yaml" \
    --set "image.repository=${ACR}.azurecr.io/trino" \
    --set "image.tag=${TRINO_TAG}" \
    $TRINO_WI_ARG \
    --wait --timeout 10m
  echo "    Done"

  echo "  [6.5] Trino Auth Proxy..."
  MI_PRINCIPAL_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
    --name "id-forge-trino-${_A}${ENV}" --query principalId -o tsv 2>/dev/null || echo "")
  if [[ -n "$MI_PRINCIPAL_ID" ]]; then
    APP_OBJ_ID=$(az ad app show --id "$FORGE_CLIENT_ID" --query id -o tsv 2>/dev/null || echo "")
    if [[ -n "$APP_OBJ_ID" ]]; then
      FC_ISSUER="https://login.microsoftonline.com/${FORGE_TENANT_ID}/v2.0"
      EXISTING_FED=$(MSYS_NO_PATHCONV=1 az rest --method GET \
        --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
        --query "value[?subject=='${MI_PRINCIPAL_ID}'].id" -o tsv 2>/dev/null || echo "")
      if [[ -z "$EXISTING_FED" ]]; then
        # Upsert: update any stale forge-trino-mi-federation (from prior env), or create new
        STALE_FED_ID=$(MSYS_NO_PATHCONV=1 az rest --method GET \
          --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
          --query "value[?name=='forge-trino-mi-federation'].id" -o tsv 2>/dev/null || echo "")
        if [[ -n "$STALE_FED_ID" ]]; then
          if FC_ERR=$(MSYS_NO_PATHCONV=1 az rest --method PATCH \
              --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials/${STALE_FED_ID}" \
              --headers "Content-Type=application/json" \
              --body "{\"subject\":\"${MI_PRINCIPAL_ID}\"}" \
              --output none 2>&1); then
            echo "    Updated forge-trino-mi-federation subject → trino MI"
          else
            echo "    ERROR: Failed to update trino federated credential: ${FC_ERR}"; exit 1
          fi
        else
          if FC_ERR=$(MSYS_NO_PATHCONV=1 az rest --method POST \
              --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}/federatedIdentityCredentials" \
              --body "{\"name\":\"forge-trino-mi-federation\",\"issuer\":\"${FC_ISSUER}\",\"subject\":\"${MI_PRINCIPAL_ID}\",\"audiences\":[\"api://AzureADTokenExchange\"]}" \
              --output none 2>&1); then
            echo "    Federated credential created: trino MI → app reg"
          else
            echo "    ERROR: Failed to create trino federated credential: ${FC_ERR}"; exit 1
          fi
        fi
      fi
      NODE_RG_COMPUTE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$COMPUTE_CLUSTER" \
        --query nodeResourceGroup -o tsv 2>/dev/null || echo "")
      if [[ -n "$NODE_RG_COMPUTE" ]]; then
        VMSS_NAME=$(az vmss list --resource-group "$NODE_RG_COMPUTE" \
          --query "[?contains(name,'trino')].name" -o tsv 2>/dev/null || \
          az vmss list --resource-group "$NODE_RG_COMPUTE" --query "[0].name" -o tsv 2>/dev/null || echo "")
        if [[ -n "$VMSS_NAME" ]]; then
          MI_RESOURCE_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-forge-trino-${_A}${ENV}"
          MSYS_NO_PATHCONV=1 az vmss identity assign \
            --resource-group "$NODE_RG_COMPUTE" \
            --name "$VMSS_NAME" \
            --identities "$MI_RESOURCE_ID" \
            --output none 2>/dev/null || true
        fi
      fi
    fi
  fi
  helm upgrade --install trino-auth-proxy \
    "${REPO_ROOT}/infra/helm/compute/trino-auth-proxy" \
    --namespace trino \
    --kube-context "$COMPUTE_CLUSTER" \
    --set "image.repository=${ACR}.azurecr.io/trino-auth-proxy" \
    --set "image.tag=1.2" \
    --set "env.tenantId=${FORGE_TENANT_ID}" \
    --set "env.clientId=${FORGE_CLIENT_ID}" \
    --set "env.redirectUri=${FORGE_REDIRECT_URI}" \
    --set "env.allowedDomain=${FORGE_ALLOWED_DOMAIN}" \
    --set "env.trinoBackend=trino:8080" \
    ${TRINO_WI_CLIENT_ID:+--set "env.managedIdentityClientId=${TRINO_WI_CLIENT_ID}"} \
    ${TRINO_WI_CLIENT_ID:+--set "serviceAccount.annotations.azure\.workload\.identity/client-id=${TRINO_WI_CLIENT_ID}"} \
    --set "ingress.enabled=true" \
    --set "ingress.host=${COMPUTE_PUBLIC_HOST}" \
    --wait --timeout 3m
  echo "    Done"
) >"$_COMPUTE_LOG" 2>&1 &
_COMPUTE_PID=$!
fi  # end SKIP_COMPUTE

# ── Phase 7: Orchestration cluster ──────────────────────────────────────────
if [[ "$SKIP_ORCH" == "true" ]]; then
  echo "Skipped: orchestration cluster (--skip-orch)" >"$_ORCH_LOG"
  true &
  _ORCH_PID=$!
else
(
  set -euo pipefail

  PORTAL_MI_CLIENT_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
    --name "id-forge-portal-${_A}${ENV}" --query clientId -o tsv 2>/dev/null || echo "")
  AIRFLOW_WI_CLIENT_ID=$(az identity show --resource-group "$RESOURCE_GROUP" \
    --name "id-forge-airflow-${_A}${ENV}" --query clientId -o tsv 2>/dev/null || echo "")

  # ── Pre-flight: inject AAD token into airflow-db-credentials ──────────────
  # migrateDatabaseJob and wait-for-airflow-migrations both need a live Postgres
  # token before helm runs. We use a one-shot Job with the Airflow MI workload
  # identity (OIDC federation set up by Bicep: fcAirflowOrchestration).
  #
  # Token exchange: AKS workload identity injects AZURE_FEDERATED_TOKEN_FILE,
  # AZURE_CLIENT_ID, AZURE_TENANT_ID into the pod. We exchange the federated
  # token with Azure AD (NOT IMDS — that's for pod/VM identity) to get a Postgres
  # access token for the Airflow MI. This is the S360-compliant approach: no
  # personal credentials, no static secrets, MI-only authentication.
  #
  # RBAC and the Job are created separately with a sleep in between to allow
  # the Role/RoleBinding to propagate before the pod starts patching the secret.
  echo "  [7.0] Injecting Airflow MI token into DB credentials secret..."

  # Ensure namespace exists
  kubectl create namespace airflow \
    --context "$ORCH_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f - 2>&1 | grep -v "^$" || true

  if [[ -n "$AIRFLOW_WI_CLIENT_ID" ]]; then
    # Step 1: SA + RBAC (applied first, before Job, to avoid propagation race)
    kubectl apply --context "$ORCH_CLUSTER" -f - <<RBAC 2>&1 | grep -v "^$" || true
apiVersion: v1
kind: ServiceAccount
metadata:
  name: airflow
  namespace: airflow
  annotations:
    azure.workload.identity/client-id: "${AIRFLOW_WI_CLIENT_ID}"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: airflow-secret-patcher
  namespace: airflow
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["airflow-db-credentials", "airflow-git-credentials"]
    verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: airflow-secret-patcher
  namespace: airflow
subjects:
  - kind: ServiceAccount
    name: airflow
    namespace: airflow
roleRef:
  kind: Role
  name: airflow-secret-patcher
  apiGroup: rbac.authorization.k8s.io
RBAC

    # Step 2: Wait for RBAC to propagate, then run Jobs
    # 30s covers typical Azure RBAC propagation; 8s was too short on cold starts.
    sleep 30

    # Step 2a: Postgres schema grants — idempotent, safe to re-run.
    # Runs as the Airflow MI (workload identity OIDC) so no engineer credentials
    # or private-endpoint access needed. Grants must exist before db migrate runs.
    if [[ "$SKIP_PG_GRANTS" != "true" ]]; then
      kubectl delete job/airflow-pg-grants -n airflow \
        --context "$ORCH_CLUSTER" --ignore-not-found 2>/dev/null || true

      kubectl apply --context "$ORCH_CLUSTER" -f - <<PGJOB 2>&1 | grep -v "^$" || true
apiVersion: batch/v1
kind: Job
metadata:
  name: airflow-pg-grants
  namespace: airflow
spec:
  ttlSecondsAfterFinished: 120
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: airflow
      restartPolicy: Never
      containers:
        - name: pg-grants
          image: ${ACR}.azurecr.io/airflow:${AIRFLOW_TAG}
          command: [python3, -c]
          args:
            - |
              import urllib.request, urllib.parse, json, os, psycopg2
              tenant_id = os.environ['AZURE_TENANT_ID']
              client_id = os.environ['AZURE_CLIENT_ID']
              with open(os.environ['AZURE_FEDERATED_TOKEN_FILE']) as f:
                  federated_token = f.read().strip()
              data = urllib.parse.urlencode({
                  'grant_type': 'client_credentials',
                  'client_id': client_id,
                  'client_assertion': federated_token,
                  'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                  'scope': 'https://ossrdbms-aad.database.windows.net/.default',
              }).encode()
              token = json.loads(urllib.request.urlopen(
                  urllib.request.Request(
                      'https://login.microsoftonline.com/' + tenant_id + '/oauth2/v2.0/token',
                      data=data), timeout=15).read())['access_token']
              print('Token acquired', flush=True)
              import socket
              try:
                  ip = socket.getaddrinfo('${PG_HOST}', 5432)[0][4][0]
                  print('DNS resolved:', ip, flush=True)
              except Exception as e:
                  print('DNS FAILED:', e, flush=True)
                  raise
              try:
                  conn = psycopg2.connect(
                      host='${PG_HOST}', user='${AIRFLOW_MI_NAME_CONN}',
                      password=token, dbname='postgres', sslmode='require',
                      connect_timeout=30)
              except Exception as e:
                  print('Connect to postgres db FAILED:', e, flush=True)
                  raise
              conn.autocommit = True
              conn.cursor().execute('GRANT ALL PRIVILEGES ON DATABASE airflow TO "${AIRFLOW_MI_NAME_CONN}"')
              print('DB grant done', flush=True)
              conn.close()
              try:
                  conn2 = psycopg2.connect(
                      host='${PG_HOST}', user='${AIRFLOW_MI_NAME_CONN}',
                      password=token, dbname='airflow', sslmode='require',
                      connect_timeout=30)
              except Exception as e:
                  print('Connect to airflow db FAILED:', e, flush=True)
                  raise
              conn2.autocommit = True
              cur = conn2.cursor()
              cur.execute('GRANT ALL ON SCHEMA public TO "${AIRFLOW_MI_NAME_CONN}"')
              cur.execute('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${AIRFLOW_MI_NAME_CONN}"')
              print('Schema grants done — all grants applied successfully', flush=True)
              conn2.close()
PGJOB

      kubectl wait job/airflow-pg-grants \
        -n airflow \
        --context "$ORCH_CLUSTER" \
        --for=condition=complete \
        --timeout=3m \
        && echo "    Postgres grants applied" \
        || { echo "    ERROR: pg-grants job failed — aborting before helm runs."; \
             echo "    Logs: kubectl logs -n airflow job/airflow-pg-grants --context ${ORCH_CLUSTER}"; \
             exit 1; }
    fi

    # Step 2c: Portal Postgres setup — create `portal` DB and grant portal-api MI access.
    # Runs under the Airflow SA (which already has Postgres admin privileges from Bicep).
    # Idempotent: CREATE DATABASE IF NOT EXISTS + GRANT are safe to re-run.
    PORTAL_MI_NAME="id-forge-portal-${_A}${ENV}"
    if [[ "$SKIP_PG_GRANTS" == "true" ]]; then
      echo "  Skipped portal DB setup (--skip-pg-grants)"
    else
      kubectl delete job/portal-pg-setup -n airflow \
        --context "$ORCH_CLUSTER" --ignore-not-found 2>/dev/null || true

      kubectl apply --context "$ORCH_CLUSTER" -f - <<PORTALPGJOB 2>&1 | grep -v "^$" || true
apiVersion: batch/v1
kind: Job
metadata:
  name: portal-pg-setup
  namespace: airflow
spec:
  ttlSecondsAfterFinished: 120
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: airflow
      restartPolicy: Never
      containers:
        - name: portal-pg-setup
          image: ${ACR}.azurecr.io/airflow:${AIRFLOW_TAG}
          command: [python3, -c]
          args:
            - |
              import urllib.request, urllib.parse, json, os, sys, psycopg2
              try:
                  tenant_id = os.environ['AZURE_TENANT_ID']
                  client_id = os.environ['AZURE_CLIENT_ID']
                  with open(os.environ['AZURE_FEDERATED_TOKEN_FILE']) as f:
                      federated_token = f.read().strip()
                  data = urllib.parse.urlencode({
                      'grant_type': 'client_credentials',
                      'client_id': client_id,
                      'client_assertion': federated_token,
                      'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                      'scope': 'https://ossrdbms-aad.database.windows.net/.default',
                  })
                  req = urllib.request.Request(
                      f'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
                      data=data.encode(), method='POST')
                  token = json.loads(urllib.request.urlopen(req, timeout=30).read())['access_token']
                  print('AAD token acquired', flush=True)
                  pg_host = '${PG_HOST}'
                  airflow_mi = '${AIRFLOW_MI_NAME_CONN}'
                  portal_mi  = '${PORTAL_MI_NAME}'
                  if not pg_host or not airflow_mi or not portal_mi:
                      print(f'ERROR: missing config — pg_host={pg_host!r} airflow_mi={airflow_mi!r} portal_mi={portal_mi!r}', flush=True)
                      sys.exit(1)
                  portal_mi_oid = '${PORTAL_MI_PRINCIPAL_ID}'
                  # Step 1: create portal database (connect as Airflow MI to postgres DB)
                  conn = psycopg2.connect(host=pg_host, dbname='postgres',
                      user=airflow_mi, password=token, sslmode='require',
                      connect_timeout=15)
                  conn.autocommit = True
                  cur = conn.cursor()
                  # Register portal MI as a Postgres AAD principal (idempotent)
                  cur.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (portal_mi,))
                  if not cur.fetchone():
                      cur.execute("SELECT pgaadauth_create_principal_with_oid(%s, %s, 'service', false, false)",
                                  (portal_mi, portal_mi_oid))
                      print(f'AAD principal created: {portal_mi}', flush=True)
                  else:
                      print(f'AAD principal already exists: {portal_mi}', flush=True)
                  cur.execute("SELECT 1 FROM pg_database WHERE datname='portal'")
                  if not cur.fetchone():
                      cur.execute('CREATE DATABASE portal')
                      print('portal database created', flush=True)
                  else:
                      print('portal database already exists', flush=True)
                  cur.execute(f'GRANT ALL PRIVILEGES ON DATABASE portal TO "{portal_mi}"')
                  print(f'DB grant done for {portal_mi}', flush=True)
                  conn.close()
                  # Step 2: schema grants inside the portal database
                  conn2 = psycopg2.connect(host=pg_host, dbname='portal',
                      user=airflow_mi, password=token, sslmode='require',
                      connect_timeout=15)
                  conn2.autocommit = True
                  cur2 = conn2.cursor()
                  cur2.execute(f'GRANT ALL ON SCHEMA public TO "{portal_mi}"')
                  cur2.execute(f'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "{portal_mi}"')
                  print('Schema grants done', flush=True)
                  conn2.close()
              except Exception as e:
                  print(f'ERROR: portal-pg-setup failed: {e}', flush=True)
                  sys.exit(1)
PORTALPGJOB

      kubectl wait job/portal-pg-setup \
        -n airflow \
        --context "$ORCH_CLUSTER" \
        --for=condition=complete \
        --timeout=5m \
        && echo "    Portal DB setup done" \
        || { echo "    ERROR: portal-pg-setup job failed — portal-api will crash without DB access."; \
             echo "    Logs: kubectl logs -n airflow job/portal-pg-setup --context ${ORCH_CLUSTER}"; \
             exit 1; }
    fi

    # Step 2b: Token-init Job — inject AAD token into airflow-db-credentials
    kubectl apply --context "$ORCH_CLUSTER" -f - <<JOB 2>&1 | grep -v "^$" || true
apiVersion: batch/v1
kind: Job
metadata:
  name: airflow-token-init
  namespace: airflow
spec:
  ttlSecondsAfterFinished: 120
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: airflow
      restartPolicy: Never
      containers:
        - name: token-injector
          image: ${ACR}.azurecr.io/airflow:${AIRFLOW_TAG}
          command: [python3, -c]
          args:
            - |
              import urllib.request, urllib.parse, json, base64, ssl, os
              # AKS workload identity: exchange the OIDC federated token for an
              # AAD access token. This is NOT IMDS — workload identity uses a
              # projected service account token exchanged via Azure AD OAuth.
              tenant_id = os.environ['AZURE_TENANT_ID']
              client_id = os.environ['AZURE_CLIENT_ID']
              with open(os.environ['AZURE_FEDERATED_TOKEN_FILE']) as f:
                  federated_token = f.read().strip()
              data = urllib.parse.urlencode({
                  'grant_type': 'client_credentials',
                  'client_id': client_id,
                  'client_assertion': federated_token,
                  'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                  'scope': 'https://ossrdbms-aad.database.windows.net/.default',
              }).encode()
              req = urllib.request.Request(
                  'https://login.microsoftonline.com/' + tenant_id + '/oauth2/v2.0/token',
                  data=data)
              token = json.loads(urllib.request.urlopen(req, timeout=15).read())['access_token']
              base = 'postgresql+psycopg2://${AIRFLOW_MI_NAME_CONN}@${PG_HOST}/airflow?sslmode=require'
              conn = base.replace('@${PG_HOST}', ':' + token + '@${PG_HOST}')
              with open('/var/run/secrets/kubernetes.io/serviceaccount/token') as f:
                  sa = f.read()
              ctx = ssl.create_default_context(
                  cafile='/var/run/secrets/kubernetes.io/serviceaccount/ca.crt')
              patch = json.dumps({'data': {'connection': base64.b64encode(conn.encode()).decode()}}).encode()
              req2 = urllib.request.Request(
                  'https://kubernetes.default.svc/api/v1/namespaces/airflow/secrets/airflow-db-credentials',
                  data=patch,
                  headers={'Authorization': 'Bearer ' + sa,
                           'Content-Type': 'application/strategic-merge-patch+json'},
                  method='PATCH')
              resp = urllib.request.urlopen(req2, context=ctx, timeout=10)
              print('Airflow MI token injected (HTTP ' + str(resp.status) + ')')
              # Fetch ADO token for git-sync (same OIDC exchange, ADO resource scope)
              data_ado = urllib.parse.urlencode({
                  'grant_type': 'client_credentials',
                  'client_id': client_id,
                  'client_assertion': federated_token,
                  'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                  'scope': '499b84ac-1321-427f-aa17-267ca6975798/.default',
              }).encode()
              req_ado = urllib.request.Request(
                  'https://login.microsoftonline.com/' + tenant_id + '/oauth2/v2.0/token',
                  data=data_ado)
              ado_token = json.loads(urllib.request.urlopen(req_ado, timeout=15).read())['access_token']
              git_patch = json.dumps({'data': {
                  'GIT_SYNC_USERNAME': base64.b64encode(b'forge').decode(),
                  'GIT_SYNC_PASSWORD': base64.b64encode(ado_token.encode()).decode(),
                  'GITSYNC_USERNAME': base64.b64encode(b'forge').decode(),
                  'GITSYNC_PASSWORD': base64.b64encode(ado_token.encode()).decode(),
              }}).encode()
              req3 = urllib.request.Request(
                  'https://kubernetes.default.svc/api/v1/namespaces/airflow/secrets/airflow-git-credentials',
                  data=git_patch,
                  headers={'Authorization': 'Bearer ' + sa,
                           'Content-Type': 'application/strategic-merge-patch+json'},
                  method='PATCH')
              resp3 = urllib.request.urlopen(req3, context=ctx, timeout=10)
              print('Git credentials updated (HTTP ' + str(resp3.status) + ')')
JOB

    kubectl wait job/airflow-token-init \
      -n airflow \
      --context "$ORCH_CLUSTER" \
      --for=condition=complete \
      --timeout=5m 2>/dev/null \
      && echo "    MI token injected" \
      || { echo "    ERROR: token-init job failed — Airflow cannot connect to Postgres without AAD token."; \
           echo "    Logs: kubectl logs -n airflow job/airflow-token-init --context ${ORCH_CLUSTER}"; \
           exit 1; }
  else
    echo "    ERROR: Airflow MI not found — cannot inject Postgres token. Bicep provisioning may have failed."
    exit 1
  fi

  # Step 2c: Run airflow db migrate before helm so wait-for-airflow-migrations
  # passes immediately. migrateDatabaseJob is disabled in values.yaml — this Job
  # gives us a controlled timeout and clear error output.
  # Uses serviceAccountName: default — no workload identity needed, only reads the
  # airflow-db-credentials K8s secret (token already injected by token-init job above).
  echo "  [7.0] Running airflow db migrate (pre-helm)..."
  kubectl delete job/airflow-migrate -n airflow --context "$ORCH_CLUSTER" --ignore-not-found 2>/dev/null || true
  kubectl apply --context "$ORCH_CLUSTER" -f - <<MIGJOB
apiVersion: batch/v1
kind: Job
metadata:
  name: airflow-migrate
  namespace: airflow
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      serviceAccountName: default
      restartPolicy: Never
      containers:
        - name: migrate
          image: ${ACR}.azurecr.io/airflow:${AIRFLOW_TAG}
          command: ["airflow", "db", "migrate"]
          env:
            - name: AIRFLOW__DATABASE__SQL_ALCHEMY_CONN
              valueFrom:
                secretKeyRef:
                  name: airflow-db-credentials
                  key: connection
MIGJOB
  kubectl wait job/airflow-migrate \
    -n airflow \
    --context "$ORCH_CLUSTER" \
    --for=condition=complete \
    --timeout=5m 2>&1 \
    && echo "    DB migrations complete" \
    || { echo "    ERROR: airflow db migrate failed — aborting before helm runs."; \
         echo "    Logs: kubectl logs -n airflow job/airflow-migrate --context ${ORCH_CLUSTER}"; \
         exit 1; }

  echo "  [7.1] ingress-nginx..."
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update 2>/dev/null || true
  helm repo update ingress-nginx 2>/dev/null || true
  # Only clean up truly stuck releases (pending state from a killed process).
  # "failed" releases are left alone — pods may already be running; helm upgrade will succeed.
  # Also delete any stale ValidatingWebhookConfiguration from a prior install with admissionWebhooks=true.
  kubectl delete validatingwebhookconfiguration ingress-nginx-admission \
    --context "$ORCH_CLUSTER" 2>/dev/null || true
  _ing_status=$(helm status ingress-nginx -n ingress-nginx --kube-context "$ORCH_CLUSTER" 2>/dev/null \
    | awk '/^STATUS:/ {print $2}' || echo "")
  if [[ "$_ing_status" == "pending-install" || "$_ing_status" == "pending-upgrade" || "$_ing_status" == "pending-rollback" ]]; then
    echo "    Resetting stuck ingress-nginx release on orch (status: $_ing_status)..."
    helm uninstall ingress-nginx -n ingress-nginx --kube-context "$ORCH_CLUSTER" 2>/dev/null || true
    sleep 5
  fi
  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    --namespace ingress-nginx --create-namespace \
    --kube-context "$ORCH_CLUSTER" \
    --values "${REPO_ROOT}/infra/helm/orchestration/ingress-nginx/values.yaml" \
    --set "controller.service.annotations.service\.beta\.kubernetes\.io/azure-dns-label-name=${DNS_LABEL}" \
    --set "controller.image.registry=${ACR}.azurecr.io" \
    --set "controller.image.image=ingress-nginx/controller" \
    --set "controller.image.tag=v1.15.1" \
    --set "controller.image.digest=" \
    --set "defaultBackend.image.registry=${ACR}.azurecr.io" \
    --set "defaultBackend.image.image=defaultbackend-amd64" \
    --set "defaultBackend.image.tag=1.5" \
    --wait --timeout 10m
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
      # S360 compliance: tag with FirstPartyUsage. Idempotent — re-applying
      # the same tag value always succeeds; only changing an existing tag fails.
      az network public-ip update \
        --resource-group "$NODE_RG_ORCH" \
        --name "$PIP_NAME" \
        --ip-tags FirstPartyUsage=/NonProd \
        --output none 2>/dev/null || true
      echo "    S360 tag: FirstPartyUsage=/NonProd"
    fi
  fi
  echo "    Done"

  echo "  [7.2] cert-manager + Let's Encrypt issuer..."
  az acr login --name "$ACR" --expose-token --output tsv --query accessToken 2>/dev/null \
    | helm registry login "${ACR}.azurecr.io" --username "00000000-0000-0000-0000-000000000000" --password-stdin 2>/dev/null || true
  helm upgrade --install cert-manager \
    "oci://${ACR}.azurecr.io/helm/cert-manager" \
    --version "v1.17.1" \
    --namespace cert-manager --create-namespace \
    --kube-context "$ORCH_CLUSTER" \
    --values "${REPO_ROOT}/infra/helm/orchestration/cert-manager/values.yaml" \
    --set "image.repository=${ACR}.azurecr.io/cert-manager-controller" \
    --set "webhook.image.repository=${ACR}.azurecr.io/cert-manager-webhook" \
    --set "cainjector.image.repository=${ACR}.azurecr.io/cert-manager-cainjector" \
    --set "acmesolver.image.repository=${ACR}.azurecr.io/cert-manager-acmesolver" \
    --set "startupapicheck.image.repository=${ACR}.azurecr.io/cert-manager-startupapicheck" \
    --wait --timeout 5m
  # Wait for cert-manager webhook to be ready before applying CRDs
  kubectl rollout status deployment/cert-manager-webhook -n cert-manager \
    --context "$ORCH_CLUSTER" --timeout=120s 2>/dev/null || true
  kubectl apply -f "${REPO_ROOT}/infra/helm/orchestration/cert-manager/letsencrypt-issuer.yaml" \
    --context "$ORCH_CLUSTER"
  echo "    Done"

  echo "  [7.4] Airflow..."
  az acr login --name "$ACR" --expose-token --output tsv --query accessToken 2>/dev/null \
    | helm registry login "${ACR}.azurecr.io" --username "00000000-0000-0000-0000-000000000000" --password-stdin 2>/dev/null || true
  # Apply dev DAG policy ConfigMap before Helm — policy plugin is mounted into pods.
  kubectl apply -f "${REPO_ROOT}/infra/helm/orchestration/airflow/forge-dev-policy-configmap.yaml" \
    --context "$ORCH_CLUSTER" 2>&1 | grep -v "^$" || true
  # Apply webserver_config.py ConfigMap — Airflow 3.x chart no longer auto-mounts
  # webserverConfig into the api-server pod; apply explicitly so FABAuthManager picks up OAuth.
  kubectl apply -f "${REPO_ROOT}/infra/helm/orchestration/airflow/webserver-config-configmap.yaml" \
    --context "$ORCH_CLUSTER" 2>&1 | grep -v "^$" || true
  # git-sync image must come from ACR — Azure Policy blocks registry.k8s.io.
  # Import is done in Phase 5 (_import_to_acr). Override image here.
  helm upgrade --install airflow \
    "oci://${ACR}.azurecr.io/helm/airflow" \
    --version 1.20.0 \
    --namespace airflow --create-namespace \
    --kube-context "$ORCH_CLUSTER" \
    --values "${REPO_ROOT}/infra/helm/orchestration/airflow/values.yaml" \
    --set "images.airflow.repository=${ACR}.azurecr.io/airflow" \
    --set "images.airflow.tag=${AIRFLOW_TAG}" \
    --set "dags.gitSync.repo=${GIT_REPO}" \
    --set "dags.gitSync.branch=${GIT_BRANCH}" \
    --set "images.gitSync.repository=${ACR}.azurecr.io/git-sync" \
    --set "images.gitSync.tag=v4.4.2" \
    ${AIRFLOW_WI_CLIENT_ID:+--set "serviceAccount.annotations.azure\.workload\.identity/client-id=${AIRFLOW_WI_CLIENT_ID}"} \
    --wait --timeout 10m

  # Create portal-api-svc local user for REST API auth (idempotent).
  # Password is stored in Key Vault and injected into portal-api at deploy time.
  echo "  [7.4.1] Airflow portal service user..."
  _AIRFLOW_SVC_PWD=$(az keyvault secret show --vault-name "$KV_NAME" \
    --name airflow-portal-api-password --query value -o tsv 2>/dev/null || echo "")
  if [[ -z "$_AIRFLOW_SVC_PWD" ]]; then
    _AIRFLOW_SVC_PWD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 32)
    az keyvault secret set --vault-name "$KV_NAME" \
      --name airflow-portal-api-password --value "$_AIRFLOW_SVC_PWD" \
      --output none 2>/dev/null || true
  fi
  kubectl exec -n airflow --context "$ORCH_CLUSTER" \
    deploy/airflow-api-server -- \
    airflow users create \
      --username portal-api-svc \
      --password "$_AIRFLOW_SVC_PWD" \
      --role Viewer \
      --email portal-api@forge.internal \
      --firstname Portal --lastname API 2>/dev/null || true
  echo "    Done"

  echo "  [7.5] Portal..."
  # portal-api service account must exist before the Deployment.
  kubectl create namespace portal --context "$ORCH_CLUSTER" --dry-run=client -o yaml \
    | kubectl apply --context "$ORCH_CLUSTER" -f - 2>/dev/null || true
  kubectl create serviceaccount portal-api -n portal --context "$ORCH_CLUSTER" \
    --dry-run=client -o yaml | kubectl apply --context "$ORCH_CLUSTER" -f - 2>/dev/null || true

  # Remove legacy split ingresses (forge-portal-web / forge-portal-api) that
  # were replaced by the consolidated forge-portal ingress via portal-auth-proxy.
  kubectl delete ingress forge-portal-web forge-portal-api -n portal \
    --context "$ORCH_CLUSTER" --ignore-not-found 2>/dev/null || true

  # Generate session secret for portal-auth-proxy (idempotent)
  if ! kubectl get secret portal-proxy-session-secret -n portal \
      --context "$ORCH_CLUSTER" &>/dev/null; then
    kubectl create secret generic portal-proxy-session-secret \
      --from-literal=secret="$(openssl rand -hex 32)" \
      -n portal --context "$ORCH_CLUSTER"
  fi

  helm upgrade --install forge-portal \
    "${REPO_ROOT}/infra/helm/orchestration/portal" \
    --namespace portal --create-namespace \
    --kube-context "$ORCH_CLUSTER" \
    --set "proxy.image.repository=${ACR}.azurecr.io/portal-auth-proxy" \
    --set "proxy.image.tag=1.0" \
    --set "proxy.env.tenantId=${FORGE_TENANT_ID}" \
    --set "proxy.env.clientId=${FORGE_CLIENT_ID}" \
    --set "proxy.env.redirectUri=https://${PUBLIC_HOST}/oauth2/callback" \
    --set "proxy.env.allowedDomain=${FORGE_ALLOWED_DOMAIN}" \
    ${PORTAL_MI_CLIENT_ID:+--set "proxy.env.managedIdentityClientId=${PORTAL_MI_CLIENT_ID}"} \
    ${PORTAL_MI_CLIENT_ID:+--set "api.env.azureClientId=${PORTAL_MI_CLIENT_ID}"} \
    --set "api.env.azureTenantId=${FORGE_TENANT_ID}" \
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
    --set "api.env.trinoHost=${COMPUTE_PUBLIC_HOST}" \
    --set "api.env.trinoPort=443" \
    --set "api.env.airflowUsername=portal-api-svc" \
    --set "api.env.airflowPassword=${_AIRFLOW_SVC_PWD}" \
    --set "api.env.keyVaultUrl=https://${KV_NAME}.vault.azure.net/" \
    --set "ingress.host=${PUBLIC_HOST}" \
    --set "api.env.pgHost=${PG_HOST}" \
    --set "api.env.pgUser=id-forge-portal-${_A}${ENV}" \
    --set "api.env.computeRg=rg-mc-compute-${_A}${ENV}" \
    --set "api.env.orchRg=rg-mc-orch-${_A}${ENV}" \
    --wait --timeout 10m
  # Force repull of portal images even when tags are stable (image tag :1.0 is
  # a moving target — new ACR pushes don't trigger Kubernetes restarts otherwise)
  kubectl rollout restart deployment/portal-web deployment/portal-api deployment/portal-auth-proxy \
    -n portal --context "$ORCH_CLUSTER" 2>/dev/null || true
  kubectl rollout status deployment/portal-web deployment/portal-api deployment/portal-auth-proxy \
    -n portal --context "$ORCH_CLUSTER" --timeout=3m 2>/dev/null || true
  echo "    Done"

  # ── Token refresh CronJob ─────────────────────────────────────────────────
  # Runs every 45 min using the Airflow SA (workload identity) to fetch a fresh
  # IMDS token and patch airflow-db-credentials. Kubernetes syncs mounted secret
  # files within ~1 min. pool_recycle (3000s) then opens new connections using
  # the refreshed URL — no pod restart needed.
  echo "  [7.6] Airflow token-refresh CronJob..."
  kubectl apply --context "$ORCH_CLUSTER" -f - <<CRONJOB
apiVersion: batch/v1
kind: CronJob
metadata:
  name: airflow-token-refresh
  namespace: airflow
spec:
  schedule: "*/45 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            azure.workload.identity/use: "true"
        spec:
          serviceAccountName: airflow
          restartPolicy: Never
          containers:
            - name: token-refresher
              image: ${ACR}.azurecr.io/airflow:${AIRFLOW_TAG}
              command: [python3, -c]
              args:
                - |
                  import urllib.request, urllib.parse, json, base64, ssl, os
                  # AKS workload identity OIDC token exchange (not IMDS)
                  tenant_id = os.environ['AZURE_TENANT_ID']
                  client_id = os.environ['AZURE_CLIENT_ID']
                  with open(os.environ['AZURE_FEDERATED_TOKEN_FILE']) as f:
                      federated_token = f.read().strip()
                  data = urllib.parse.urlencode({
                      'grant_type': 'client_credentials',
                      'client_id': client_id,
                      'client_assertion': federated_token,
                      'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                      'scope': 'https://ossrdbms-aad.database.windows.net/.default',
                  }).encode()
                  req = urllib.request.Request(
                      'https://login.microsoftonline.com/' + tenant_id + '/oauth2/v2.0/token',
                      data=data)
                  token = json.loads(urllib.request.urlopen(req, timeout=15).read())['access_token']
                  base = 'postgresql+psycopg2://${AIRFLOW_MI_NAME_CONN}@${PG_HOST}/airflow?sslmode=require'
                  conn = base.replace('@${PG_HOST}', ':' + token + '@${PG_HOST}')
                  with open('/var/run/secrets/kubernetes.io/serviceaccount/token') as f:
                      sa = f.read()
                  ctx = ssl.create_default_context(
                      cafile='/var/run/secrets/kubernetes.io/serviceaccount/ca.crt')
                  patch = json.dumps({'data': {'connection': base64.b64encode(conn.encode()).decode()}}).encode()
                  req2 = urllib.request.Request(
                      'https://kubernetes.default.svc/api/v1/namespaces/airflow/secrets/airflow-db-credentials',
                      data=patch,
                      headers={'Authorization': 'Bearer ' + sa,
                               'Content-Type': 'application/strategic-merge-patch+json'},
                      method='PATCH')
                  resp = urllib.request.urlopen(req2, context=ctx, timeout=10)
                  print('Airflow MI token refreshed (HTTP ' + str(resp.status) + ')')
                  # Refresh ADO token for git-sync (same OIDC exchange, ADO resource scope)
                  data_ado = urllib.parse.urlencode({
                      'grant_type': 'client_credentials',
                      'client_id': client_id,
                      'client_assertion': federated_token,
                      'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                      'scope': '499b84ac-1321-427f-aa17-267ca6975798/.default',
                  }).encode()
                  req_ado = urllib.request.Request(
                      'https://login.microsoftonline.com/' + tenant_id + '/oauth2/v2.0/token',
                      data=data_ado)
                  ado_token = json.loads(urllib.request.urlopen(req_ado, timeout=15).read())['access_token']
                  git_patch = json.dumps({'data': {
                      'GIT_SYNC_USERNAME': base64.b64encode(b'forge').decode(),
                      'GIT_SYNC_PASSWORD': base64.b64encode(ado_token.encode()).decode(),
                      'GITSYNC_USERNAME': base64.b64encode(b'forge').decode(),
                      'GITSYNC_PASSWORD': base64.b64encode(ado_token.encode()).decode(),
                  }}).encode()
                  req3 = urllib.request.Request(
                      'https://kubernetes.default.svc/api/v1/namespaces/airflow/secrets/airflow-git-credentials',
                      data=git_patch,
                      headers={'Authorization': 'Bearer ' + sa,
                               'Content-Type': 'application/strategic-merge-patch+json'},
                      method='PATCH')
                  resp3 = urllib.request.urlopen(req3, context=ctx, timeout=10)
                  print('Git credentials refreshed (HTTP ' + str(resp3.status) + ')')
CRONJOB
  echo "    Done"
) >"$_ORCH_LOG" 2>&1 &
_ORCH_PID=$!
fi  # end SKIP_ORCH

echo "  Compute cluster deploying    (pid $_COMPUTE_PID)..."
echo "  Orchestration cluster deploying (pid $_ORCH_PID)..."
echo ""

_CLUSTER_FAILED=()

echo "─── Compute cluster ───────────────────────────────────────────────────"
if wait "$_COMPUTE_PID"; then
  cat "$_COMPUTE_LOG"
  echo "  ✓ Compute cluster — done"
else
  cat "$_COMPUTE_LOG"
  echo "  ✗ Compute cluster — FAILED"
  _CLUSTER_FAILED+=("compute")
fi
rm -f "$_COMPUTE_LOG"

echo "─── Orchestration cluster ─────────────────────────────────────────────"
if wait "$_ORCH_PID"; then
  cat "$_ORCH_LOG"
  echo "  ✓ Orchestration cluster — done"
else
  cat "$_ORCH_LOG"
  echo "  ✗ Orchestration cluster — FAILED"
  _CLUSTER_FAILED+=("orchestration")
fi
rm -f "$_ORCH_LOG"

if [[ ${#_CLUSTER_FAILED[@]} -gt 0 ]]; then
  echo "ERROR: Cluster deploy(s) failed: ${_CLUSTER_FAILED[*]}"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 8 — sync-jobs.sh: generate + upload DAGs, forge_lib.zip, Spark jobs
# ---------------------------------------------------------------------------
if [[ "$SKIP_SYNC" == "false" ]]; then
  echo "━━━ [8/8] Sync pipelines (DAGs + forge_lib.zip) ━━━━━━━━━━━━━━"
  FORGE_ENV="$ENV" OWNER_ALIAS="$ALIAS" FORGE_STORAGE_ACCOUNT="$ADLS_ACCOUNT" \
    bash "${SCRIPT_DIR}/sync-jobs.sh" --full
  echo ""

  # ── DAG kubectl-cp fallback (when git-sync is disabled) ───────────────────
  # git-sync is the primary DAG delivery mechanism. When it's disabled (e.g.
  # ADO MI access not yet set up), copy DAG files directly into the scheduler
  # and dag-processor pods. Idempotent — safe to run even when git-sync is on.
  DAGS_SRC="${REPO_ROOT}/orchestration/airflow/dags"
  if [[ -d "$DAGS_SRC" ]]; then
    mapfile -t DAG_FILES < <(find "$DAGS_SRC" -name "*.py" 2>/dev/null)
    if [[ ${#DAG_FILES[@]} -gt 0 ]]; then
      echo "  [8.1] Copying ${#DAG_FILES[@]} DAG file(s) into Airflow pods..."

      # Scheduler is always airflow-scheduler-0 (StatefulSet)
      SCHED_POD="airflow-scheduler-0"
      # dag-processor is a Deployment — look up by label
      DAGPROC_POD=$(kubectl get pod -n airflow --context "$ORCH_CLUSTER" \
        -l component=dag-processor \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

      for dag_file in "${DAG_FILES[@]}"; do
        dag_name="$(basename "$dag_file")"
        # Only copy if the remote file differs — avoids unnecessary pod I/O on re-runs.
        local_md5=$(md5sum "$dag_file" 2>/dev/null | awk '{print $1}' || echo "")
        remote_md5=$(kubectl exec -n airflow "$SCHED_POD" -c scheduler \
          --context "$ORCH_CLUSTER" \
          -- md5sum "/opt/airflow/dags/${dag_name}" 2>/dev/null | awk '{print $1}' || echo "")
        if [[ -n "$local_md5" && "$local_md5" == "$remote_md5" ]]; then
          echo "    unchanged  : ${dag_name}"
          continue
        fi
        kubectl cp "$dag_file" \
          "airflow/${SCHED_POD}:/opt/airflow/dags/${dag_name}" \
          -c scheduler \
          --context "$ORCH_CLUSTER" 2>/dev/null \
          && echo "    scheduler  ← ${dag_name}" \
          || echo "    WARN: failed to copy ${dag_name} to scheduler"
        if [[ -n "$DAGPROC_POD" ]]; then
          kubectl cp "$dag_file" \
            "airflow/${DAGPROC_POD}:/opt/airflow/dags/${dag_name}" \
            -c dag-processor \
            --context "$ORCH_CLUSTER" 2>/dev/null \
            && echo "    dag-proc   ← ${dag_name}" \
            || echo "    WARN: failed to copy ${dag_name} to dag-processor"
        fi
      done
      echo "    DAGs will appear in Airflow UI within ~30s"
    fi
  fi
else
  echo "━━━ [8/8] Sync pipelines — skipped (--skip-sync) ━━━━━━━━━━━━━"
fi

# ---------------------------------------------------------------------------
# Phase 8 — Test pipeline run (--run-test only)
#
# Flow:
#   1. Copy a sample slice of NYC TLC Yellow Taxi data from Azure Open
#      Datasets into the raw container (Transport/Trip/Public/Rideshare/NycTlc)
#   2. Trigger nyc_taxi_bronze DAG for TEST_DATE, wait for completion
#   3. Trigger nyc_taxi_silver DAG for TEST_DATE, wait for completion
#   4. Trigger nyc_taxi_gold  DAG for TEST_DATE, wait for completion
#   5. Smoke-test Trino: SELECT COUNT(*) from each output table
# ---------------------------------------------------------------------------
if [[ "$RUN_TEST" == "true" ]]; then
  echo "━━━ [+] Smoke test: seed raw data + run pipelines ━━"
  echo "  Test date: ${TEST_DATE}"
  echo ""

  # ── Step 8.1: Copy NYC TLC sample from Azure Open Datasets → raw container ─
  echo "  [+.1] Copying NYC TLC sample to raw zone..."

  # Source: Azure Open Datasets public ADLS Gen2 (yellow taxi, 2023-01)
  # One month of yellow taxi parquet — ~50 MB, ~3M rows — enough to prove the pipeline
  ADLS_SOURCE="https://azureopendatastore.blob.core.windows.net/nyctlc/yellow/puYear=2023/puMonth=1/part-00000-tid-8898858832658823408-a1de80bd-ead9-4197-baf0-c90f802a6c6c-451985-1.c000.snappy.parquet"

  RAW_CONTAINER="raw"
  RAW_PATH="Transport/Trip/Public/Rideshare/NycTlc/1/TlcYellowTrip"

  # Download to temp, upload to ADLS raw zone
  _tmpfile=$(mktemp --suffix=.parquet)
  curl -L -s -o "${_tmpfile}" "${ADLS_SOURCE}" && \
    az storage blob upload \
      --account-name "${ADLS_ACCOUNT}" \
      --container-name "${RAW_CONTAINER}" \
      --name "${RAW_PATH}/data.parquet" \
      --file "${_tmpfile}" \
      --auth-mode login \
      --overwrite \
      --output none && \
    echo "  Uploaded sample: ${RAW_CONTAINER}/${RAW_PATH}/data.parquet" || \
    echo "  WARN: raw data upload failed — check ADLS permissions"
  rm -f "${_tmpfile}"

  # ── Step 8.2: Helper — trigger DAG and wait ──────────────────────────────
  # Uses `kubectl exec` on the Airflow scheduler pod — no port-forward needed
  _airflow_exec() {
    kubectl exec \
      -n airflow \
      --context "$ORCH_CLUSTER" \
      "$(kubectl get pod -n airflow --context "$ORCH_CLUSTER" \
          -l component=scheduler \
          --field-selector=status.phase=Running \
          -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)" \
      -- "$@" 2>/dev/null
  }

  _trigger_and_wait() {
    local dag_id="$1"
    local run_id="forge_test_${TEST_DATE//-/}"
    local timeout_mins="${2:-20}"

    echo ""
    echo "  [DAG] ${dag_id} — triggering for ${TEST_DATE}..."

    # Unpause the DAG first
    _airflow_exec airflow dags unpause "${dag_id}" > /dev/null 2>&1 || true

    # Trigger a backfill run for the test date (one execution)
    _airflow_exec airflow dags trigger \
      "${dag_id}" \
      --run-id "${run_id}" \
      --conf "{\"PARTITION_DATE\":\"${TEST_DATE}\"}" \
      > /dev/null 2>&1 || {
        echo "  WARN: trigger failed for ${dag_id} — check Airflow logs"
        return 1
      }

    echo "  Waiting for ${dag_id} (up to ${timeout_mins}m)..."
    local elapsed=0
    local state=""
    while [[ $elapsed -lt $((timeout_mins * 60)) ]]; do
      state=$(_airflow_exec airflow dags state "${dag_id}" "${run_id}" 2>/dev/null | tail -1 || echo "unknown")
      case "$state" in
        success)
          echo "  ${dag_id}: SUCCESS"
          return 0
          ;;
        failed|upstream_failed)
          echo "  ${dag_id}: FAILED (state=${state})"
          echo "  Check logs: kubectl logs -n airflow -l dag_id=${dag_id} --context ${ORCH_CLUSTER}"
          return 1
          ;;
        *)
          sleep 15
          elapsed=$((elapsed + 15))
          echo "  ${dag_id}: ${state} (${elapsed}s elapsed)"
          ;;
      esac
    done
    echo "  ${dag_id}: TIMED OUT after ${timeout_mins}m"
    return 1
  }

  # ── Step 8.3: Wait for Airflow scheduler to be ready ─────────────────────
  echo ""
  echo "  [+.2] Waiting for Airflow scheduler pod..."
  for i in $(seq 1 24); do
    SCHED_POD=$(kubectl get pod -n airflow --context "$ORCH_CLUSTER" \
      -l component=scheduler --field-selector=status.phase=Running \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
    if [[ -n "$SCHED_POD" ]]; then
      echo "  Scheduler ready: ${SCHED_POD}"
      break
    fi
    echo "  Waiting for scheduler... ($((i*5))s)"
    sleep 5
  done

  if [[ -z "$SCHED_POD" ]]; then
    echo "  ERROR: Airflow scheduler not ready. Check: kubectl get pods -n airflow --context ${ORCH_CLUSTER}"
    echo "  Skipping pipeline test."
  else
    # ── Step 8.4: Wait for git-sync to pick up DAGs ───────────────────────
    echo "  Waiting 35s for Airflow git-sync to pick up DAGs..."
    sleep 35

    # ── Step 8.5: Trigger bronze → silver → gold ──────────────────────────
    echo ""
    echo "  [+.3] Triggering pipeline chain: bronze → silver → gold"

    TEST_OK=true
    _trigger_and_wait "nyc_taxi_bronze" 25 || TEST_OK=false

    if [[ "$TEST_OK" == "true" ]]; then
      _trigger_and_wait "nyc_taxi_silver" 20 || TEST_OK=false
    fi

    if [[ "$TEST_OK" == "true" ]]; then
      _trigger_and_wait "nyc_taxi_gold" 15 || TEST_OK=false
    fi

    # ── Step 8.6: Smoke-test Trino ────────────────────────────────────────
    echo ""
    echo "  [+.4] Trino smoke test..."
    TRINO_POD=$(kubectl get pod -n trino --context "$COMPUTE_CLUSTER" \
      -l app=trino,component=coordinator \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

    if [[ -n "$TRINO_POD" ]]; then
      for _layer in bronze silver gold; do
        _count=$(kubectl exec -n trino --context "$COMPUTE_CLUSTER" "${TRINO_POD}" \
          -- trino --server localhost:8080 \
             --execute "SELECT COUNT(*) FROM delta.${_layer}.nyctaxi" \
             --output-format TSV 2>/dev/null | tail -1 || echo "error")
        printf "  %-8s delta.%s.nyctaxi → %s rows\n" "" "${_layer}" "${_count}"
      done
    else
      echo "  WARN: no Trino coordinator pod found — skipping Trino check"
    fi

    if [[ "$TEST_OK" == "true" ]]; then
      echo ""
      echo "  Test pipelines: ALL PASSED"
    else
      echo ""
      echo "  Test pipelines: SOME FAILED — check Airflow UI"
      echo "  kubectl port-forward svc/airflow-api-server 8081:8080 -n airflow --context ${ORCH_CLUSTER}"
    fi
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# S360 IP tagging — run after all services deploy so LoadBalancer IPs exist
# kubernetes-* IPs are created when Trino/Portal/Airflow LoadBalancer services
# come up. Post-provision runs too early (before services); this catches them.
# ---------------------------------------------------------------------------
# Close ACR public access now — all image pulls/pushes are done.
# The trap will no-op since _ACR_OPENED is cleared here.
if [[ "${_ACR_OPENED:-false}" == "true" ]]; then
  echo "━━━ Closing ACR public access ━━━━━━━━━━━━━━━━━━━━━━━━"
  az acr update --name "$ACR" --public-network-enabled false --output none
  _ACR_OPENED=false
  echo "  ACR locked down."
  echo ""
fi

echo "━━━ S360 IP tagging ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
_IP_TAG=$([[ "$ENV" == "prod" ]] && echo "/Prod" || echo "/NonProd")

# Tag all public IPs across every Forge resource group.
# Covers: AKS node RGs (kubernetes-* LoadBalancer IPs) and main/platform RGs.
# UUID-named AKS API server IPs are skipped — Azure blocks ipTag changes on them.
_tag_ips_in_rg() {
  local rg="$1"
  if ! az group show --name "$rg" --query id -o tsv &>/dev/null 2>&1; then
    echo "  $rg not found — skipping"
    return
  fi
  local ips
  ips=$(az network public-ip list --resource-group "$rg" \
    --query "[?starts_with(name,'kubernetes') && !(ipTags[?ipTagType=='FirstPartyUsage'])].name" \
    -o tsv 2>/dev/null || true)
  if [[ -z "$ips" ]]; then
    echo "  $rg — all kubernetes-* IPs already tagged (or none exist yet)"
    return
  fi
  while IFS= read -r _IP; do
    [[ -z "$_IP" ]] && continue
    az network public-ip update --resource-group "$rg" --name "$_IP" \
      --ip-tags "FirstPartyUsage=${_IP_TAG}" --output none 2>/dev/null \
      && echo "  Tagged : $_IP ($rg)" \
      || echo "  WARN: could not tag $_IP ($rg) — in-use static IP, skipping"
  done <<< "$ips"
}

for _RG in \
  "rg-forge-${_A}${ENV}" \
  "rg-forge-platform-${_A}${ENV}" \
  "rg-mc-compute-${_A}${ENV}" \
  "rg-mc-orch-${_A}${ENV}"; do
  _tag_ips_in_rg "$_RG"
done
echo ""

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Forge is up                                         ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  PORTAL                                              ║"
printf "║    URL:    https://%-34s║\n" "$PUBLIC_HOST"
echo "║                                                      ║"
echo "║  TRINO UI (direct — no port-forward needed)          ║"
printf "║    URL:    https://%-34s║\n" "${COMPUTE_PUBLIC_HOST}"
echo "║                                                      ║"
echo "║  SPARK CONNECT (VS Code / notebooks)                 ║"
printf "║    Endpoint: sc://%-35s║\n" "${COMPUTE_PUBLIC_HOST}:15002"
echo "║    export FORGE_COMPUTE_HOST=\\                      ║"
printf "║      %-48s║\n" "$COMPUTE_PUBLIC_HOST"
echo "║                                                      ║"
echo "║  AIRFLOW                                             ║"
echo "║    kubectl port-forward svc/airflow-api-server \\     ║"
echo "║      8081:8080 -n airflow \\                         ║"
printf "║      --context %-37s║\n" "$ORCH_CLUSTER"
echo "║    Then open: http://localhost:8081                  ║"
echo "║                                                      ║"
echo "║  TABLES (after pipelines run)                        ║"
echo "║    SELECT * FROM delta.bronze.nyctaxi LIMIT 10;      ║"
echo "║    SELECT * FROM delta.silver.nyctaxi LIMIT 10;      ║"
echo "║    SELECT * FROM delta.gold.nyctaxi   LIMIT 10;      ║"
echo "║                                                      ║"
echo "║  PUBLISH PACKAGES                                    ║"
echo "║    bash infra/scripts/forge-up.sh \\                 ║"
echo "║      --env dev --alias prproddu \\                   ║"
echo "║      --skip-infra --skip-build --skip-sync \\        ║"
echo "║      --skip-compute --skip-orch \\                   ║"
echo "║      --publish-packages --git-pat <pat>              ║"
echo "╚══════════════════════════════════════════════════════╝"

# ---------------------------------------------------------------------------
# Publish Python packages to ADO Artifacts (opt-in via --publish-packages)
# ---------------------------------------------------------------------------
if [[ "$PUBLISH_PACKAGES" == "true" ]]; then
  echo ""
  echo "━━━ Publishing Python packages to ADO Artifacts ━━━━━━━━━━━━━━━━━━━━━━━━"
  [[ -z "$GIT_PAT" ]] && { echo "ERROR: --git-pat <pat> required for --publish-packages"; exit 1; }
  bash "${REPO_ROOT}/infra/scripts/publish-packages.sh" \
    --pat "$GIT_PAT" \
    --repo-root "$REPO_ROOT"
fi
