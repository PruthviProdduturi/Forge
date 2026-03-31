#!/usr/bin/env bash
# =============================================================================
# deploy-auth-proxy.sh — Build and deploy Trino Auth Proxy (IMDS approach)
#
# Auth model:
#   - Pod calls IMDS to get managed identity token; uses it as client_assertion
#   - Federated credential on app registration: issuer = Microsoft's own AAD issuer,
#     subject = managed identity principalId (bypasses AKS OIDC issuer policy)
#   - Access via: kubectl port-forward svc/trino-auth-proxy 8080:8080 -n trino
#   - Redirect URI: http://localhost:8080/oauth2/callback (no TLS needed)
#
# What it does:
#   1. Builds the auth-proxy Docker image and pushes to ACR
#   2. Adds a federated credential to the app registration (IMDS approach, idempotent)
#   3. Creates the session secret (if not present)
#   4. Deploys the Helm chart with all required env vars
#   5. Prints port-forward command
#
# Usage:
#   bash infra/scripts/deploy-auth-proxy.sh \
#     [--env dev] [--alias prproddu] [--sub <subscription-id>] [--tag 1.2]
#
# Prerequisites:
#   - az login done, correct subscription active
#   - kubectl configured for the compute cluster
#   - Trino already deployed (trino namespace exists)
#   - App registration f21cd19e-5e8b-4739-b0fb-1ebd13b8c036 exists in AAD
# =============================================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if command -v cygpath &>/dev/null; then
  REPO_ROOT_WIN="$(cygpath -w "$REPO_ROOT")"
else
  REPO_ROOT_WIN="$REPO_ROOT"
fi

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
ENVIRONMENT="dev"
OWNER_ALIAS="prproddu"
SUBSCRIPTION=""
IMAGE_TAG="1.2"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)   ENVIRONMENT="$2";   shift 2 ;;
    --alias) OWNER_ALIAS="$2";   shift 2 ;;
    --sub)   SUBSCRIPTION="$2";  shift 2 ;;
    --tag)   IMAGE_TAG="$2";     shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$SUBSCRIPTION" ]]; then
  SUBSCRIPTION=$(az account show --query id -o tsv)
fi
az account set --subscription "$SUBSCRIPTION"

# ---------------------------------------------------------------------------
# Derived names — must match main.bicep / identity.bicep conventions
# ---------------------------------------------------------------------------
ACR_NAME="forgeacr${OWNER_ALIAS}"
ACR_RG="rg-forge-acr-${OWNER_ALIAS}"
RG_COMPUTE="rg-forge-${OWNER_ALIAS}-${ENVIRONMENT}"
CLUSTER_COMPUTE="aks-forge-compute-${OWNER_ALIAS}-${ENVIRONMENT}"
WI_MI_NAME="id-forge-trino-${ENVIRONMENT}"   # managed identity for trino workload

# Azure AD app registration (Trino OAuth2 client — pre-existing)
APP_CLIENT_ID="f21cd19e-5e8b-4739-b0fb-1ebd13b8c036"
TENANT_ID="72f988bf-86f1-41af-91ab-2d7cd011db47"
ALLOWED_DOMAIN="microsoft.com"
NAMESPACE="trino"

# Port-forward access — no public IP, no TLS
REDIRECT_URI="http://localhost:8080/oauth2/callback"
IMAGE_REPO="${ACR_NAME}.azurecr.io/trino-auth-proxy"

echo ""
echo "=== Trino Auth Proxy Deployment ========================="
echo "  subscription : $SUBSCRIPTION"
echo "  environment  : $ENVIRONMENT"
echo "  alias        : $OWNER_ALIAS"
echo "  ACR          : $ACR_NAME"
echo "  cluster      : $CLUSTER_COMPUTE"
echo "  image        : ${IMAGE_REPO}:${IMAGE_TAG}"
echo "  redirect URI : $REDIRECT_URI"
echo "  auth model   : IMDS managed identity as client_assertion"
echo "========================================================="
echo ""

# ---------------------------------------------------------------------------
# 1. Build and push image to ACR
# ---------------------------------------------------------------------------
echo "--- Step 1: Build auth-proxy image in ACR"
az acr build \
  --registry "$ACR_NAME" \
  --resource-group "$ACR_RG" \
  --image "trino-auth-proxy:${IMAGE_TAG}" \
  --file "${REPO_ROOT_WIN}\\infra\\docker\\trino-auth-proxy\\Dockerfile" \
  "${REPO_ROOT_WIN}\\infra\\docker\\trino-auth-proxy\\"
echo "    Image pushed: ${IMAGE_REPO}:${IMAGE_TAG}"

# ---------------------------------------------------------------------------
# 2. Get kubeconfig
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 2: Fetch kubeconfig"
az aks get-credentials \
  --resource-group "$RG_COMPUTE" \
  --name "$CLUSTER_COMPUTE" \
  --overwrite-existing \
  --output none

# ---------------------------------------------------------------------------
# 3. Resolve managed identity IDs
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 3: Resolve managed identity"

WI_CLIENT_ID=$(az identity show \
  --resource-group "$RG_COMPUTE" \
  --name "$WI_MI_NAME" \
  --query clientId -o tsv 2>/dev/null || true)
if [[ -z "$WI_CLIENT_ID" ]]; then
  echo "    WARNING: managed identity $WI_MI_NAME not found in $RG_COMPUTE"
  echo "    Proceeding — serviceAccount annotation must be set manually."
fi

MI_PRINCIPAL_ID=$(az identity show \
  --resource-group "$RG_COMPUTE" \
  --name "$WI_MI_NAME" \
  --query principalId -o tsv 2>/dev/null || true)
echo "    MI client ID    : $WI_CLIENT_ID"
echo "    MI principal ID : $MI_PRINCIPAL_ID"

# ---------------------------------------------------------------------------
# 4. Federated credential — IMDS approach (idempotent)
#
# Uses login.microsoftonline.com as issuer (Microsoft's own — allowed by
# tenant policy 538f1913 which blocks AKS OIDC issuers).
# Subject is the managed identity's principalId.
# The pod calls IMDS to get a token for resource=api://AzureADTokenExchange
# and uses it as client_assertion in MSAL.
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 4: Add federated credential to app registration (IMDS approach)"

APP_OBJECT_ID=$(az ad app show --id "$APP_CLIENT_ID" --query id -o tsv)

EXISTING_FED=$(MSYS_NO_PATHCONV=1 az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJECT_ID}/federatedIdentityCredentials" \
  --query "value[?subject=='${MI_PRINCIPAL_ID}'].id" -o tsv 2>/dev/null || echo "")

FC_ISSUER="https://login.microsoftonline.com/${TENANT_ID}/v2.0"
FED_BODY="{\"name\":\"forge-trino-mi-federation\",\"issuer\":\"${FC_ISSUER}\",\"subject\":\"${MI_PRINCIPAL_ID}\",\"audiences\":[\"api://AzureADTokenExchange\"],\"description\":\"MI token as client assertion — bypasses AKS OIDC issuer policy\"}"

if [[ -z "$EXISTING_FED" ]]; then
  MSYS_NO_PATHCONV=1 az rest --method POST \
    --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJECT_ID}/federatedIdentityCredentials" \
    --body "$FED_BODY" --output none \
    || { echo "    ERROR: Failed to create federated credential"; exit 1; }
  echo "    Created federated credential"
  echo "      issuer : $FC_ISSUER"
  echo "      subject: $MI_PRINCIPAL_ID"
else
  echo "    Federated credential already exists — skipping"
fi

# ---------------------------------------------------------------------------
# 4b. Attach managed identity to trino node pool VMSS (required for IMDS)
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 4b: Attach managed identity to node pool VMSS"

NODE_RG=$(az aks show --resource-group "$RG_COMPUTE" --name "$CLUSTER_COMPUTE" --query nodeResourceGroup -o tsv)
VMSS_NAME=$(az vmss list --resource-group "$NODE_RG" --query "[?contains(name,'trino')].name" -o tsv 2>/dev/null || \
            az vmss list --resource-group "$NODE_RG" --query "[0].name" -o tsv 2>/dev/null)

MI_RESOURCE_ID="/subscriptions/${SUBSCRIPTION}/resourceGroups/${RG_COMPUTE}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${WI_MI_NAME}"

EXISTING_MI=$(az vmss identity show \
  --resource-group "$NODE_RG" \
  --name "$VMSS_NAME" \
  --query "userAssignedIdentities.\"${MI_RESOURCE_ID}\"" -o tsv 2>/dev/null || echo "")

if [[ -n "$EXISTING_MI" ]]; then
  echo "    MI already attached to VMSS — skipping"
else
  MSYS_NO_PATHCONV=1 az vmss identity assign \
    --resource-group "$NODE_RG" \
    --name "$VMSS_NAME" \
    --identities "$MI_RESOURCE_ID" \
    --output none
  az vmss update-instances \
    --resource-group "$NODE_RG" \
    --name "$VMSS_NAME" \
    --instance-ids "*" \
    --output none
  echo "    Attached and propagated: $WI_MI_NAME → $VMSS_NAME"
fi

# ---------------------------------------------------------------------------
# 4c. Register redirect URI on app registration (idempotent)
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 4c: Register redirect URI on app registration"

EXISTING_URIS=$(az ad app show --id "$APP_CLIENT_ID" --query "web.redirectUris" -o tsv 2>/dev/null || echo "")
if echo "$EXISTING_URIS" | grep -qF "$REDIRECT_URI"; then
  echo "    Redirect URI already registered — skipping"
else
  # Merge with any existing URIs
  NEW_URIS=$(echo "$EXISTING_URIS $REDIRECT_URI" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ' | xargs)
  az ad app update --id "$APP_CLIENT_ID" --web-redirect-uris $NEW_URIS --output none
  echo "    Registered: $REDIRECT_URI"
fi

# ---------------------------------------------------------------------------
# 5. Create K8s session secret (idempotent)
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 5: Create K8s session secret"

if kubectl get secret proxy-session-secret -n "$NAMESPACE" &>/dev/null; then
  echo "    proxy-session-secret already exists — skipping"
else
  SESSION_KEY=$(openssl rand -hex 32)
  kubectl create secret generic proxy-session-secret \
    --from-literal="session-secret=$SESSION_KEY" \
    -n "$NAMESPACE"
  echo "    Created proxy-session-secret"
fi

# ---------------------------------------------------------------------------
# 6. Deploy Helm chart
# ---------------------------------------------------------------------------
echo ""
echo "--- Step 6: Deploy trino-auth-proxy Helm chart"

HELM_ARGS=(
  upgrade --install trino-auth-proxy
  "$REPO_ROOT/infra/helm/compute/trino-auth-proxy"
  --namespace "$NAMESPACE"
  --set "image.repository=${IMAGE_REPO}"
  --set "image.tag=${IMAGE_TAG}"
  --set "env.tenantId=${TENANT_ID}"
  --set "env.clientId=${APP_CLIENT_ID}"
  --set "env.redirectUri=${REDIRECT_URI}"
  --set "env.allowedDomain=${ALLOWED_DOMAIN}"
  --set "env.trinoBackend=trino:8080"
  --set "env.managedIdentityClientId=${WI_CLIENT_ID}"
)

helm "${HELM_ARGS[@]}"
echo "    Helm deploy complete"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Auth Proxy Deployment Complete ======================"
echo ""
echo "  Access Trino UI:"
echo "    kubectl port-forward svc/trino-auth-proxy 8080:8080 -n $NAMESPACE \\"
echo "      --context $CLUSTER_COMPUTE"
echo "    Then open: http://localhost:8080"
echo ""
echo "  CLI access (Trino CLI):"
echo "    TOKEN=\$(az account get-access-token --resource $APP_CLIENT_ID --query accessToken -o tsv)"
echo "    trino --server http://localhost:8080 --access-token \$TOKEN"
echo ""
echo "  IMPORTANT: Ensure the following redirect URI is registered in the Azure AD app:"
echo "    $REDIRECT_URI"
echo "    Portal → App registrations → $APP_CLIENT_ID → Authentication → Web"
echo "========================================================="
