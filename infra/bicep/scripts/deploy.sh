#!/bin/bash
# =============================================================================
# Forge Data Platform — Bicep Deployment Script
# Usage: ./scripts/deploy.sh [environment] [location]
#   environment  dev | prod            (default: dev)
#   location     Azure region          (default: westcentralus)
#
# Prerequisites:
#   - Azure CLI >= 2.57.0 (for Bicep 0.26+ param file support)
#   - az login completed with a principal that has Owner or Contributor +
#     User Access Administrator on the target subscription
#   - AZURE_SUBSCRIPTION_ID environment variable set, or use az account set
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
ENVIRONMENT="${1:-dev}"
LOCATION="${2:-westcentralus}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEPLOYMENT_NAME="forge-${ENVIRONMENT}-${TIMESTAMP}"

# Resolve script directory so the script can be called from any working dir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BICEP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_FILE="${BICEP_ROOT}/environments/${ENVIRONMENT}/main.bicep"
PARAMS_FILE="${BICEP_ROOT}/environments/${ENVIRONMENT}/main.bicepparam"

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
if [[ "${ENVIRONMENT}" != "dev" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "ERROR: environment must be 'dev' or 'prod', got '${ENVIRONMENT}'" >&2
  exit 1
fi

if [[ ! -f "${TEMPLATE_FILE}" ]]; then
  echo "ERROR: Template not found: ${TEMPLATE_FILE}" >&2
  exit 1
fi

if [[ ! -f "${PARAMS_FILE}" ]]; then
  echo "ERROR: Parameter file not found: ${PARAMS_FILE}" >&2
  exit 1
fi

# Ensure an active Azure CLI session exists
if ! az account show --query id -o tsv &>/dev/null; then
  echo "ERROR: No active Azure CLI session. Run 'az login' first." >&2
  exit 1
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
echo "============================================================"
echo "  Forge Infrastructure Deployment"
echo "============================================================"
echo "  Environment  : ${ENVIRONMENT}"
echo "  Location     : ${LOCATION}"
echo "  Subscription : ${SUBSCRIPTION_ID}"
echo "  Deployment   : ${DEPLOYMENT_NAME}"
echo "  Template     : ${TEMPLATE_FILE}"
echo "  Parameters   : ${PARAMS_FILE}"
echo "============================================================"

# ---------------------------------------------------------------------------
# Pre-flight: validate the template without deploying
# ---------------------------------------------------------------------------
echo ""
echo "[1/3] Validating Bicep template..."
az deployment sub validate \
  --name "${DEPLOYMENT_NAME}-validate" \
  --location "${LOCATION}" \
  --template-file "${TEMPLATE_FILE}" \
  --parameters "${PARAMS_FILE}" \
  --output none

echo "      Validation passed."

# ---------------------------------------------------------------------------
# What-if: show a diff of planned changes
# ---------------------------------------------------------------------------
echo ""
echo "[2/3] Running what-if analysis..."
az deployment sub what-if \
  --name "${DEPLOYMENT_NAME}-whatif" \
  --location "${LOCATION}" \
  --template-file "${TEMPLATE_FILE}" \
  --parameters "${PARAMS_FILE}" \
  --result-format FullResourcePayloads

# Prompt for confirmation (skip in CI by setting FORGE_SKIP_CONFIRM=true)
if [[ "${FORGE_SKIP_CONFIRM:-false}" != "true" ]]; then
  echo ""
  read -r -p "Proceed with deployment? [y/N] " CONFIRM
  if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
    echo "Deployment cancelled."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
echo ""
echo "[3/3] Deploying Forge infrastructure..."
az deployment sub create \
  --name "${DEPLOYMENT_NAME}" \
  --location "${LOCATION}" \
  --template-file "${TEMPLATE_FILE}" \
  --parameters "${PARAMS_FILE}" \
  --verbose

echo ""
echo "============================================================"
echo "  Deployment complete: ${DEPLOYMENT_NAME}"
echo "============================================================"

# ---------------------------------------------------------------------------
# Print key outputs
# ---------------------------------------------------------------------------
echo ""
echo "Key outputs:"
az deployment sub show \
  --name "${DEPLOYMENT_NAME}" \
  --query 'properties.outputs' \
  --output table 2>/dev/null || true

echo ""
echo "To retrieve full outputs in JSON:"
echo "  az deployment sub show --name '${DEPLOYMENT_NAME}' --query 'properties.outputs' -o json"
