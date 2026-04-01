#!/usr/bin/env bash
# =============================================================================
# post-provision.sh — Post-provisioning steps
# Run immediately after provision-infra.sh (called by it automatically).
#
# What it does:
#   1. Tags all public IPs in the AKS node resource groups (MC_ RGs) with
#      FirstPartyUsage ipTag — required for S360 NS2.1.1 compliance.
#      AKS owns these IPs (API server public FQDN); they cannot be tagged
#      at provision time through Bicep.
#   2. Fetches kubeconfig for both clusters so kubectl works immediately.
#
# Usage:
#   bash infra/scripts/post-deploy.sh [--env dev] [--alias prproddu01] [--sub <subscription-id>]
#
# Defaults: env=dev, alias=prproddu01, sub=(current az account)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults — override via flags
# ---------------------------------------------------------------------------
ENVIRONMENT="dev"
OWNER_ALIAS="prproddu01"
SUBSCRIPTION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)   ENVIRONMENT="$2";   shift 2 ;;
    --alias) OWNER_ALIAS="$2";   shift 2 ;;
    --sub)   SUBSCRIPTION="$2";  shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$SUBSCRIPTION" ]]; then
  SUBSCRIPTION=$(az account show --query id -o tsv)
fi

# Set active subscription
az account set --subscription "$SUBSCRIPTION"

# Derived names (must match main.bicep naming conventions)
ALIAS_SUFFIX="-${OWNER_ALIAS}"
RG_COMPUTE="rg-forge${ALIAS_SUFFIX}-${ENVIRONMENT}"
CLUSTER_COMPUTE="aks-forge-compute${ALIAS_SUFFIX}-${ENVIRONMENT}"
CLUSTER_ORCH="aks-forge-orchestration${ALIAS_SUFFIX}-${ENVIRONMENT}"
MC_RG_COMPUTE="rg-mc-compute${ALIAS_SUFFIX}-${ENVIRONMENT}"
MC_RG_ORCH="rg-mc-orch${ALIAS_SUFFIX}-${ENVIRONMENT}"
IP_TAG_VALUE=$([[ "$ENVIRONMENT" == "prod" ]] && echo "/Prod" || echo "/NonProd")

echo ""
echo "=== Forge post-deploy ==================================="
echo "  subscription : $SUBSCRIPTION"
echo "  environment  : $ENVIRONMENT"
echo "  alias        : $OWNER_ALIAS"
echo "  ip tag value : FirstPartyUsage=$IP_TAG_VALUE"
echo "========================================================="

# ---------------------------------------------------------------------------
# 1. Tag public IPs in AKS node resource groups
# ---------------------------------------------------------------------------
tag_ips_in_rg() {
  local rg="$1"
  echo ""
  echo "--- Tagging public IPs in: $rg"

  # Check RG exists (may not for orch if deploy failed early)
  if ! az group show --name "$rg" --query id -o tsv &>/dev/null; then
    echo "    RG not found — skipping"
    return
  fi

  local ips
  ips=$(az network public-ip list \
    --resource-group "$rg" \
    --query "[?!(ipTags[?ipTagType=='FirstPartyUsage'])].name" \
    -o tsv 2>/dev/null || true)

  if [[ -z "$ips" ]]; then
    echo "    All IPs already tagged — nothing to do"
    return
  fi

  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    echo "    Tagging: $ip"
    az network public-ip update \
      --resource-group "$rg" \
      --name "$ip" \
      --ip-tags "FirstPartyUsage=$IP_TAG_VALUE" \
      --output none \
      || echo "    WARNING: cannot tag $ip (AKS-managed static IPs cannot be tagged post-creation — S360 exemption required)"
  done <<< "$ips"

  echo "    Done."
}

tag_ips_in_rg "$MC_RG_COMPUTE"
tag_ips_in_rg "$MC_RG_ORCH"

# ---------------------------------------------------------------------------
# 2. Fetch kubeconfig for both clusters
# ---------------------------------------------------------------------------
echo ""
echo "--- Fetching kubeconfig"

az aks get-credentials \
  --resource-group "$RG_COMPUTE" \
  --name "$CLUSTER_COMPUTE" \
  --overwrite-existing \
  --output none
echo "    Compute cluster: $CLUSTER_COMPUTE"

az aks get-credentials \
  --resource-group "$RG_COMPUTE" \
  --name "$CLUSTER_ORCH" \
  --overwrite-existing \
  --output none
echo "    Orchestration cluster: $CLUSTER_ORCH"

# ---------------------------------------------------------------------------
# 3. Quick sanity check
# ---------------------------------------------------------------------------
echo ""
echo "--- kubectl get nodes (compute)"
kubectl get nodes --context "$CLUSTER_COMPUTE" 2>/dev/null \
  || echo "    (cluster may still be initialising — retry in a few minutes)"

echo ""
echo "=== Post-deploy complete ================================"
