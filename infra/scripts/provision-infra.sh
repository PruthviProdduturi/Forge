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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)   ENVIRONMENT="$2";  shift 2 ;;
    --alias) OWNER_ALIAS="$2";  shift 2 ;;
    --sub)   SUBSCRIPTION="$2"; shift 2 ;;
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
echo "  template     : $TEMPLATE"
echo "  deployment   : $DEPLOYMENT_NAME"
echo "========================================================="

az account set --subscription "$SUBSCRIPTION"

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
    --location westcentralus \
    --template-file "$SHARED_TEMPLATE" \
    --parameters "@${SHARED_PARAMS}" \
    --parameters "ownerAlias=${OWNER_ALIAS}" \
    --name "forge-shared-${OWNER_ALIAS:-shared}-$(date +%Y%m%d%H%M)"
  echo "    Done."
fi

# ---------------------------------------------------------------------------
# 1. Bicep deployment
# ---------------------------------------------------------------------------
echo ""
echo "--- [1/7 sub 1/2] Bicep (Azure resource provisioning)"
az deployment sub create \
  --location westcentralus \
  --template-file "$TEMPLATE" \
  --parameters "@${PARAMS}" \
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
