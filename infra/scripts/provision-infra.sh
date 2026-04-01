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
OWNER_ALIAS="prproddu01"
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
# 1. Bicep deployment
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 1/2: Bicep (Azure resource provisioning)"
az deployment sub create \
  --location northcentralus \
  --template-file "$TEMPLATE" \
  --parameters "@${PARAMS}" \
  --name "$DEPLOYMENT_NAME"

echo ""
echo "    Bicep deployment complete."

# ---------------------------------------------------------------------------
# 2. Post-deploy (IP tagging + kubeconfig)
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 2/2: Post-provision (kubeconfigs + IP tags)"
bash "${SCRIPT_DIR}/post-provision.sh" \
  --env "$ENVIRONMENT" \
  --alias "$OWNER_ALIAS" \
  --sub "$SUBSCRIPTION"
