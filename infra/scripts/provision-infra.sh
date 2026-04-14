#!/usr/bin/env bash
# =============================================================================
# provision-infra.sh — Bicep infrastructure provisioning
#
# Provisions all Azure resources (AKS clusters, ACR, ADLS, Postgres, Key Vault)
# then runs post-provision steps (kubeconfig fetch, S360 IP tagging).
#
# Called by forge-up.sh (Phase 1). Also runnable standalone if you only
# need to re-provision infrastructure without redeploying applications.
#
# Usage:
#   bash infra/scripts/provision-infra.sh [--env dev] [--alias prproddu] [--sub <id>]
#
# Defaults: env=dev, alias=prproddu01, sub=(current az account)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
ENVIRONMENT="dev"
OWNER_ALIAS=""
SUBSCRIPTION=""
LOCATION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)      ENVIRONMENT="$2";  shift 2 ;;
    --alias)    OWNER_ALIAS="$2";  shift 2 ;;
    --sub)      SUBSCRIPTION="$2"; shift 2 ;;
    --location) LOCATION="$2";     shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$SUBSCRIPTION" ]]; then
  SUBSCRIPTION=$(az account show --query id -o tsv)
fi

TEMPLATE="${REPO_ROOT}/infra/bicep/environments/${ENVIRONMENT}/main.bicep"
PARAMS="${REPO_ROOT}/infra/bicep/environments/${ENVIRONMENT}/${ENVIRONMENT}.parameters.json"
DEPLOYMENT_NAME="forge-${ENVIRONMENT}-$(date +%Y%m%d%H%M)"

echo ""
echo "=== Forge provision-infra ========================================"
echo "  subscription : $SUBSCRIPTION"
echo "  environment  : $ENVIRONMENT"
echo "  alias        : $OWNER_ALIAS"
echo "  location     : $LOCATION"
echo "  template     : $TEMPLATE"
echo "  deployment   : $DEPLOYMENT_NAME"
echo "========================================================="

az account set --subscription "$SUBSCRIPTION"

# ---------------------------------------------------------------------------
# Resolve location — explicit arg > existing RG > default westcentralus
# Prevents "InvalidResourceGroupLocation" when an RG already exists from a
# prior (possibly partial) deploy in a different region.
# ---------------------------------------------------------------------------
if [[ -z "$LOCATION" ]]; then
  _MAIN_RG="rg-forge-${OWNER_ALIAS:+${OWNER_ALIAS}-}${ENVIRONMENT}"
  LOCATION=$(az group show --name "$_MAIN_RG" --query location -o tsv 2>/dev/null || echo "")
  if [[ -z "$LOCATION" ]]; then
    LOCATION="westcentralus"
  else
    echo "    Detected existing resource group '${_MAIN_RG}' in ${LOCATION} — using that location."
  fi
fi

# ---------------------------------------------------------------------------
# 0. Shared ACR — idempotent, runs before main Bicep
# Creates rg-forge-acr (or rg-forge-acr-<alias>) and the ACR if not present.
# The main Bicep depends on this ACR for image pulls and private endpoint.
# ---------------------------------------------------------------------------
ACR_RG="rg-forge-acr${OWNER_ALIAS:+-${OWNER_ALIAS}}"
SHARED_TEMPLATE="${REPO_ROOT}/infra/bicep/environments/shared/main.bicep"
SHARED_PARAMS="${REPO_ROOT}/infra/bicep/environments/shared/shared.parameters.json"

# Compute ACR name — must match shared/main.bicep logic exactly
if [[ -n "$OWNER_ALIAS" ]]; then
  ACR_NAME="forgeacr${OWNER_ALIAS}"
else
  _SUB_CLEAN="${SUBSCRIPTION//-/}"
  ACR_NAME="forgeacr${_SUB_CLEAN:0:8}"
fi

echo ""
echo "--- [0/7] Shared ACR (idempotent)"
# Check the ACR itself, not just the RG — RG may exist from a prior partial deploy
ACR_EXISTS=$(az acr show --name "$ACR_NAME" --resource-group "$ACR_RG" \
  --query name -o tsv 2>/dev/null || echo "")
if [[ -n "$ACR_EXISTS" ]]; then
  echo "    ${ACR_NAME} already exists — skipping shared deploy"
else
  echo "    Creating ${ACR_RG} and ${ACR_NAME}..."
  az deployment sub create \
    --location "$LOCATION" \
    --template-file "$SHARED_TEMPLATE" \
    --parameters "@${SHARED_PARAMS}" \
    --parameters "ownerAlias=${OWNER_ALIAS}" \
    --parameters "location=${LOCATION}" \
    --name "forge-shared-${OWNER_ALIAS:-shared}-$(date +%Y%m%d%H%M)"
  echo "    Done."
fi

# ---------------------------------------------------------------------------
# 1. Pre-Bicep: clear KV role assignments to prevent RoleAssignmentExists on
#    re-deploy. Azure RBAC returns HTTP 409 even for identical re-creates, so
#    we must delete first. Role assignments are recreated by Bicep moments later.
# ---------------------------------------------------------------------------
_KV_NAME="${OWNER_ALIAS:+kv-forge-}${OWNER_ALIAS:+${OWNER_ALIAS,,}-}${ENVIRONMENT}"
if [[ -z "$OWNER_ALIAS" ]]; then
  _KV_SUFFIX="${SUBSCRIPTION//-/}"; _KV_NAME="kv-forge-${_KV_SUFFIX:0:8}-${ENVIRONMENT}"
else
  _KV_NAME="kv-forge-${OWNER_ALIAS,,}-${ENVIRONMENT}"
fi
_MAIN_RG_FOR_KV="rg-forge-${OWNER_ALIAS:+${OWNER_ALIAS}-}${ENVIRONMENT}"
_KV_ID=$(az keyvault show --name "$_KV_NAME" --resource-group "$_MAIN_RG_FOR_KV" \
  --query id -o tsv 2>/dev/null || echo "")
if [[ -n "$_KV_ID" ]]; then
  echo "    KV exists — clearing role assignments to allow idempotent Bicep re-deploy..."
  az role assignment delete --scope "$_KV_ID" --output none 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 1. Bicep deployment
# ---------------------------------------------------------------------------
echo ""
echo "--- [1/7 sub 1/2] Bicep (Azure resource provisioning)"
az deployment sub create \
  --location "$LOCATION" \
  --template-file "$TEMPLATE" \
  --parameters "@${PARAMS}" \
  --parameters "location=${LOCATION}" \
  ${OWNER_ALIAS:+--parameters "ownerAlias=${OWNER_ALIAS}"} \
  --name "$DEPLOYMENT_NAME"

echo ""
echo "    Bicep deployment complete."

# ---------------------------------------------------------------------------
# 2. Post-deploy (IP tagging + kubeconfig)
# ---------------------------------------------------------------------------
echo ""
echo "--- [1/7 sub 2/2] Post-provision (kubeconfigs + IP tags)"
bash "${SCRIPT_DIR}/post-provision.sh" \
  --env "$ENVIRONMENT" \
  --alias "$OWNER_ALIAS" \
  --sub "$SUBSCRIPTION"
