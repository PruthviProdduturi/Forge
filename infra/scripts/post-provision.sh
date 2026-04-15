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
OWNER_ALIAS=""
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
_A="${OWNER_ALIAS:+${OWNER_ALIAS}-}"
RG_COMPUTE="rg-forge-${_A}${ENVIRONMENT}"
CLUSTER_COMPUTE="aks-forge-compute-${_A}${ENVIRONMENT}"
CLUSTER_ORCH="aks-forge-orchestration-${_A}${ENVIRONMENT}"
MC_RG_COMPUTE="rg-mc-compute-${_A}${ENVIRONMENT}"
MC_RG_ORCH="rg-mc-orch-${_A}${ENVIRONMENT}"
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

  # Only tag kubernetes-* prefixed IPs (LoadBalancer service IPs).
  # UUID-named IPs are AKS API server IPs created as static — Azure blocks
  # IP tag changes on those at the API level regardless of timing.
  local ips
  ips=$(az network public-ip list \
    --resource-group "$rg" \
    --query "[?starts_with(name,'kubernetes') && !(ipTags[?ipTagType=='FirstPartyUsage'])].name" \
    -o tsv 2>/dev/null || true)

  if [[ -z "$ips" ]]; then
    echo "    No untagged kubernetes-* IPs found — skipping (LoadBalancer IPs appear after service deploy)"
    return
  fi

  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    echo "    Tagging: $ip"
    if az network public-ip update \
        --resource-group "$rg" \
        --name "$ip" \
        --ip-tags "FirstPartyUsage=$IP_TAG_VALUE" \
        --output none 2>&1; then
      echo "    Tagged: $ip"
    else
      echo "    Skipped: $ip (static/in-use IP — Azure blocks IP tag changes on these)"
    fi
  done <<< "$ips"

  echo "    Done."
}

tag_ips_in_rg "$MC_RG_COMPUTE"
tag_ips_in_rg "$MC_RG_ORCH"

# ---------------------------------------------------------------------------
# 2. Key Vault RBAC — idempotent role assignments
#    These are kept out of keyvault.bicep to avoid RoleAssignmentExists HTTP 409
#    on re-deploy (ARM does not support idempotent PUT for role assignments).
# ---------------------------------------------------------------------------
echo ""
echo "--- Key Vault RBAC"

if [[ -n "$OWNER_ALIAS" ]]; then
  _KV_NAME="kv-forge-${OWNER_ALIAS,,}-${ENVIRONMENT}"
else
  _KV_SUFFIX="${SUBSCRIPTION//-/}"; _KV_NAME="kv-forge-${_KV_SUFFIX:0:8}-${ENVIRONMENT}"
fi
_KV_SCOPE="/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG_COMPUTE}/providers/Microsoft.KeyVault/vaults/${_KV_NAME}"

# Role definition IDs (built-in, immutable)
_KV_SECRETS_OFFICER="b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
_KV_CRYPTO_OFFICER="14b46e9e-c2b7-41b4-b07b-48a6ebf60603"
_KV_SECRETS_USER="4633458b-17de-408a-b874-0445c86b69e6"

_kv_assign() {
  local principal="$1" role="$2" type="$3" desc="$4"
  [[ -z "$principal" ]] && { echo "    SKIP (empty principal): $desc"; return; }
  az role assignment create \
    --role "$role" \
    --assignee-object-id "$principal" \
    --assignee-principal-type "$type" \
    --scope "$_KV_SCOPE" \
    --output none 2>/dev/null \
    && echo "    Assigned : $desc" \
    || echo "    Exists   : $desc"
}

# Fetch platform admin group from parameters file
_PARAMS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../bicep/environments/${ENVIRONMENT}/${ENVIRONMENT}.parameters.json"
_ADMIN_GROUP=$(python3 -c "import json,sys; p=json.load(open('${_PARAMS_FILE}')); print(p.get('parameters',{}).get('platformAdminGroupObjectId',{}).get('value',''))" 2>/dev/null || echo "")

_kv_assign "$_ADMIN_GROUP" "$_KV_SECRETS_OFFICER" "Group" "platform admin — Secrets Officer"
_kv_assign "$_ADMIN_GROUP" "$_KV_CRYPTO_OFFICER"  "Group" "platform admin — Crypto Officer"

# Workload identities
for _WL in spark trino airflow dq; do
  _MI_NAME="id-forge-${_WL}-${_A}${ENVIRONMENT}"
  _PRINCIPAL=$(az identity show --resource-group "$RG_COMPUTE" --name "$_MI_NAME" \
    --query principalId -o tsv 2>/dev/null || echo "")
  _kv_assign "$_PRINCIPAL" "$_KV_SECRETS_USER" "ServicePrincipal" "${_WL} — Secrets User"
done

# Portal — Secrets Officer (needs write access for Settings UI)
_PORTAL_KV_PRINCIPAL=$(az identity show --resource-group "$RG_COMPUTE" \
  --name "id-forge-portal-${_A}${ENVIRONMENT}" --query principalId -o tsv 2>/dev/null || echo "")
_kv_assign "$_PORTAL_KV_PRINCIPAL" "$_KV_SECRETS_OFFICER" "ServicePrincipal" "portal — Secrets Officer"

# ---------------------------------------------------------------------------
# 4. Grant portal MI Cost Management Reader on the managed node RGs
#    so the Cost Explorer page can query Azure Cost Management per RG.
# ---------------------------------------------------------------------------
echo ""
echo "--- Granting portal MI Cost Management Reader on node RGs"

_A_VAR="${OWNER_ALIAS:+${OWNER_ALIAS}-}"
PORTAL_MI_PRINCIPAL=$(az identity show \
  --resource-group "rg-forge-${_A_VAR}${ENVIRONMENT}" \
  --name "id-forge-portal-${_A_VAR}${ENVIRONMENT}" \
  --query principalId -o tsv 2>/dev/null || echo "")

if [[ -z "$PORTAL_MI_PRINCIPAL" ]]; then
  echo "    portal MI not found — skipping (run after identity.bicep is deployed)"
else
  # Cost Management Reader role definition ID (built-in, immutable)
  COST_READER_ROLE="72fef05d-4f52-4db4-b412-d74b965b3dd5"
  for _MC_RG in "$MC_RG_COMPUTE" "$MC_RG_ORCH"; do
    if az group show --name "$_MC_RG" --query id -o tsv &>/dev/null; then
      az role assignment create \
        --role "$COST_READER_ROLE" \
        --assignee-object-id "$PORTAL_MI_PRINCIPAL" \
        --assignee-principal-type ServicePrincipal \
        --scope "/subscriptions/${SUBSCRIPTION}/resourceGroups/${_MC_RG}" \
        --output none 2>/dev/null && echo "    Granted on: $_MC_RG" \
        || echo "    Already exists or skipped: $_MC_RG"
    else
      echo "    RG not found — skipping: $_MC_RG"
    fi
  done
fi

# ---------------------------------------------------------------------------
# 5. Fetch kubeconfig for both clusters
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
# 6. Quick sanity check
# ---------------------------------------------------------------------------
echo ""
echo "--- kubectl get nodes (compute)"
kubectl get nodes --context "$CLUSTER_COMPUTE" 2>/dev/null \
  || echo "    (cluster may still be initialising — retry in a few minutes)"

echo ""
echo "=== Post-deploy complete ================================"
