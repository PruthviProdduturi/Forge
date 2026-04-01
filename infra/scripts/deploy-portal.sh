#!/usr/bin/env bash
# =============================================================================
# deploy-portal.sh — Deploy Forge Developer Portal to the Orchestration Cluster
#
# What this script does:
#   1. Resolves ACR name, cluster names, and managed identity client IDs
#   2. Builds portal-api and portal-web images and pushes to ACR
#   3. Installs / upgrades the NGINX ingress controller (gets a public IP)
#   4. Waits for public IP to be allocated and prints the URL
#   5. Deploys the portal Helm chart (api + web + ingress + RBAC)
#
# Usage:
#   bash infra/scripts/deploy-portal.sh --env dev --alias prproddu
#
# Optional flags:
#   --skip-build     Skip ACR image builds (use existing images)
#   --api-tag 1.1    Override portal-api image tag (default: 1.0)
#   --web-tag 1.1    Override portal-web image tag (default: 1.0)
#
# Prerequisites:
#   - az login done, correct subscription set
#   - kubectl context for the orchestration cluster available
#   - cluster-bootstrap applied (portal namespace + portal-api SA exist)
# =============================================================================

set -euo pipefail

# Fix az CLI unicode crash on Windows terminals (colorama charmap issue)
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
ENV=""
ALIAS=""
SKIP_BUILD=false
API_TAG="1.0"
WEB_TAG="1.0"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --env)     ENV="$2";      shift 2 ;;
    --alias)   ALIAS="$2";   shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --api-tag) API_TAG="$2"; shift 2 ;;
    --web-tag) WEB_TAG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]]   && { echo "ERROR: --env required";   exit 1; }
[[ -z "$ALIAS" ]] && { echo "ERROR: --alias required"; exit 1; }

# ---------------------------------------------------------------------------
# Derived names
# ---------------------------------------------------------------------------
ACR="forgeacr${ALIAS}"
RESOURCE_GROUP="rg-forge-${ALIAS}-${ENV}"
ORCH_CLUSTER="aks-forge-orchestration-${ALIAS}-${ENV}"
COMPUTE_CLUSTER="aks-forge-compute-${ALIAS}-${ENV}"
DNS_LABEL="forge-portal-${ALIAS}-${ENV}"
LOCATION=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$ORCH_CLUSTER" \
  --query location -o tsv 2>/dev/null || echo "northcentralus")
NODE_RG=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$ORCH_CLUSTER" \
  --query nodeResourceGroup -o tsv 2>/dev/null || echo "")
PUBLIC_HOST="${DNS_LABEL}.${LOCATION}.cloudapp.azure.com"
KUBE_CONTEXT="aks-forge-orchestration-${ALIAS}-${ENV}"

ADLS_ACCOUNT="forgeadls${ALIAS//-/}${ENV}"   # strip hyphens from alias for storage name
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
KV_NAME="kv-forge-${ALIAS}-${ENV}"
KV_URL="https://${KV_NAME}.vault.azure.net/"

echo ""
echo "============================================================"
echo " Forge Portal Deploy"
echo "  env:              $ENV"
echo "  alias:            $ALIAS"
echo "  ACR:              ${ACR}.azurecr.io"
echo "  orchestration:    $ORCH_CLUSTER"
echo "  compute:          $COMPUTE_CLUSTER"
echo "  public URL:       http://$PUBLIC_HOST"
echo "  key vault:        $KV_URL"
echo "============================================================"
echo ""

# ---------------------------------------------------------------------------
# Step 1 — Get workload identity client ID for portal
# ---------------------------------------------------------------------------
echo "[1/5] Resolving portal managed identity client ID..."

PORTAL_MI_NAME="id-forge-portal-${ALIAS}-${ENV}"
PORTAL_CLIENT_ID=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PORTAL_MI_NAME" \
  --query clientId -o tsv 2>/dev/null || echo "")

if [[ -z "$PORTAL_CLIENT_ID" ]]; then
  echo "  WARN: managed identity $PORTAL_MI_NAME not found — portal workload identity will not be configured"
fi

# ---------------------------------------------------------------------------
# Step 1b — Seed auth-config secrets in Key Vault (idempotent)
#
# These secrets drive the auth provider decision at runtime:
#   forge-portal-auth-provider   → "local"   (start with local; switch to azure_ad from Settings UI)
#   forge-portal-aad-client-id   → ""        (fill in when enabling Azure SSO)
#   forge-portal-aad-tenant-id   → ""        (fill in when enabling Azure SSO)
#
# Once seeded, changes are made from the portal Settings page by an Admin user.
# ---------------------------------------------------------------------------
echo ""
echo "[1b/5] Seeding auth-config secrets in Key Vault ($KV_NAME)..."

_seed_secret() {
  local name="$1" value="$2"
  # Only set if the secret doesn't exist or has no value — preserves existing config
  local existing
  existing=$(az keyvault secret show --vault-name "$KV_NAME" --name "$name" \
    --query value -o tsv 2>/dev/null || echo "")
  if [[ -z "$existing" ]]; then
    az keyvault secret set --vault-name "$KV_NAME" --name "$name" --value "$value" --output none
    echo "  Created: $name"
  else
    echo "  Exists:  $name (not overwritten)"
  fi
}

_seed_secret "forge-portal-auth-provider"  "local"
_seed_secret "forge-portal-aad-client-id"  ""
_seed_secret "forge-portal-aad-tenant-id"  ""

# ---------------------------------------------------------------------------
# Step 2 — Build and push images
# ---------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo ""
  echo "[2/5] Building portal-api:${API_TAG} ..."
  az acr build \
    --registry "$ACR" \
    --image "portal-api:${API_TAG}" \
    --file "${REPO_ROOT}/infra/docker/portal-api/Dockerfile" \
    "${REPO_ROOT}/portal/backend/"

  echo ""
  echo "[2/5] Building portal-web:${WEB_TAG} ..."
  # API_URL is empty — frontend uses relative /api/* paths (same-origin via ingress)
  az acr build \
    --registry "$ACR" \
    --image "portal-web:${WEB_TAG}" \
    --file "${REPO_ROOT}/infra/docker/portal-web/Dockerfile" \
    --build-arg "API_URL=" \
    --build-arg "WEB_URL=http://${PUBLIC_HOST}" \
    "${REPO_ROOT}/portal/frontend/"
else
  echo "[2/5] Skipping image builds (--skip-build)"
fi

# ---------------------------------------------------------------------------
# Step 3 — Install / upgrade NGINX ingress controller
# ---------------------------------------------------------------------------
echo ""
echo "[3/5] Installing / upgrading ingress-nginx controller..."

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update 2>/dev/null || true
helm repo update ingress-nginx 2>/dev/null || true

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --kube-context "$KUBE_CONTEXT" \
  --values "${REPO_ROOT}/infra/helm/orchestration/ingress-nginx/values.yaml" \
  --set "controller.service.annotations.service\.beta\.kubernetes\.io/azure-dns-label-name=${DNS_LABEL}" \
  --wait --timeout 5m

# ---------------------------------------------------------------------------
# Step 4 — Wait for public IP
# ---------------------------------------------------------------------------
echo ""
echo "[4/5] Waiting for public IP assignment (DNS label: ${DNS_LABEL})..."

EXTERNAL_IP=""
for i in $(seq 1 30); do
  EXTERNAL_IP=$(kubectl get svc ingress-nginx-controller \
    --namespace ingress-nginx \
    --context "$KUBE_CONTEXT" \
    --output jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  if [[ -n "$EXTERNAL_IP" ]]; then
    echo "  Public IP: $EXTERNAL_IP"
    echo "  Public URL: http://${PUBLIC_HOST}"
    break
  fi
  echo "  Waiting... ($i/30)"
  sleep 10
done

if [[ -z "$EXTERNAL_IP" ]]; then
  echo "  WARN: external IP not yet assigned — portal will be accessible once Azure allocates the IP"
fi

# Set DNS label directly on the Azure public IP resource.
# The Helm annotation requests this label but Azure sometimes doesn't apply it
# automatically — setting it explicitly ensures the FQDN resolves.
if [[ -n "$EXTERNAL_IP" && -n "$NODE_RG" ]]; then
  PIP_NAME=$(az network public-ip list \
    --resource-group "$NODE_RG" \
    --query "[?ipAddress=='${EXTERNAL_IP}'].name" -o tsv 2>/dev/null || echo "")
  if [[ -n "$PIP_NAME" ]]; then
    echo "  Setting DNS label on public IP: $PIP_NAME"
    az network public-ip update \
      --resource-group "$NODE_RG" \
      --name "$PIP_NAME" \
      --dns-name "$DNS_LABEL" \
      --output none
    echo "  ✓ FQDN: ${PUBLIC_HOST}"
  fi
fi

# ---------------------------------------------------------------------------
# Step 5 — Deploy portal Helm chart
# ---------------------------------------------------------------------------
echo ""
echo "[5/5] Deploying forge-portal Helm chart..."

helm upgrade --install forge-portal \
  "${REPO_ROOT}/infra/helm/orchestration/portal" \
  --namespace portal \
  --kube-context "$KUBE_CONTEXT" \
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
  --set "ingress.host=${PUBLIC_HOST}" \
  --set "api.env.keyVaultUrl=${KV_URL}" \
  ${PORTAL_CLIENT_ID:+--set "api.env.azureClientId=${PORTAL_CLIENT_ID}"} \
  --wait --timeout 5m

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo " Forge Portal deployed successfully"
echo ""
echo "  URL:  http://${PUBLIC_HOST}"
echo "  API:  http://${PUBLIC_HOST}/api/health"
echo "  Docs: http://${PUBLIC_HOST}/docs (FastAPI auto-docs via /api/)"
echo ""
echo "  Default login (local auth):"
echo "    username: admin"
echo "    password: admin"
echo ""
echo "  To watch pods:"
echo "    kubectl get pods -n portal --context $KUBE_CONTEXT -w"
echo "============================================================"
