param(
    [string]$Env   = "dev",
    [string]$Alias = "prproddu",
    [string]$Tag   = "1.2",
    [string]$Sub   = ""
)

# Auth model: IMDS managed identity token as client_assertion
# Access: kubectl port-forward svc/trino-auth-proxy 8080:8080 -n trino
# No public IP, no TLS — Azure AD allows http://localhost redirect URIs natively.

$ACR        = "forgeacr${Alias}"
$ACR_RG     = "rg-forge-acr-${Alias}"
$RG         = "rg-forge-${Alias}-${Env}"
$CONTEXT    = "aks-forge-compute-${Alias}-${Env}"
$NAMESPACE  = "trino"
$TENANT_ID  = "72f988bf-86f1-41af-91ab-2d7cd011db47"
$CLIENT_ID  = "f21cd19e-5e8b-4739-b0fb-1ebd13b8c036"
$REDIRECT   = "http://localhost:8080/oauth2/callback"
$MI_NAME    = "id-forge-trino-${Env}"
$IMAGE_REPO = "${ACR}.azurecr.io/trino-auth-proxy"

if ($Sub) { az account set --subscription $Sub }

$REPO_ROOT = (Get-Item "$PSScriptRoot\..\..").FullName

Write-Host ""
Write-Host "=== Trino Auth Proxy Deploy ===" -ForegroundColor Cyan
Write-Host "  ACR       : $ACR"
Write-Host "  Context   : $CONTEXT"
Write-Host "  Image     : ${IMAGE_REPO}:${Tag}"
Write-Host "  Auth model: IMDS managed identity as client_assertion"
Write-Host "  Redirect  : $REDIRECT"
Write-Host ""

# ---------------------------------------------------------------------------
# 1. Build and push image
# ---------------------------------------------------------------------------
Write-Host "--- Step 1: Build auth-proxy image" -ForegroundColor Yellow
$DOCKERFILE = "$REPO_ROOT\infra\docker\trino-auth-proxy\Dockerfile"
$CONTEXT_DIR = "$REPO_ROOT\infra\docker\trino-auth-proxy"
az acr build --registry $ACR --resource-group $ACR_RG `
    --image "trino-auth-proxy:${Tag}" `
    --file $DOCKERFILE $CONTEXT_DIR
Write-Host "    Image pushed: ${IMAGE_REPO}:${Tag}" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 2. Get kubeconfig
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 2: Fetch kubeconfig" -ForegroundColor Yellow
az aks get-credentials --resource-group $RG --name "aks-forge-compute-${Alias}-${Env}" --overwrite-existing --output none

# ---------------------------------------------------------------------------
# 3. Resolve managed identity
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 3: Resolve managed identity" -ForegroundColor Yellow
$WI_CLIENT_ID   = az identity show --resource-group $RG --name $MI_NAME --query clientId -o tsv
$MI_PRINCIPAL   = az identity show --resource-group $RG --name $MI_NAME --query principalId -o tsv
Write-Host "    MI client ID    : $WI_CLIENT_ID"
Write-Host "    MI principal ID : $MI_PRINCIPAL"

# ---------------------------------------------------------------------------
# 4. Federated credential — IMDS approach (idempotent)
#
# Issuer: login.microsoftonline.com (Microsoft's own AAD issuer — allowed by
# tenant policy 538f1913 which blocks AKS OIDC issuers and client secrets).
# Subject: managed identity principalId.
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 4: Federated credential on app registration" -ForegroundColor Yellow

$APP_OBJECT_ID = az ad app show --id $CLIENT_ID --query id -o tsv
$FC_ISSUER     = "https://login.microsoftonline.com/${TENANT_ID}/v2.0"

$EXISTING = az rest --method GET `
    --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJECT_ID}/federatedIdentityCredentials" `
    --query "value[?subject=='${MI_PRINCIPAL}'].id" -o tsv 2>$null

if ($EXISTING) {
    Write-Host "    Federated credential already exists — skipping" -ForegroundColor Yellow
} else {
    $FC_BODY = @{
        name        = "forge-trino-mi-federation"
        issuer      = $FC_ISSUER
        subject     = $MI_PRINCIPAL
        audiences   = @("api://AzureADTokenExchange")
        description = "MI token as client assertion"
    } | ConvertTo-Json -Compress
    az rest --method POST `
        --url "https://graph.microsoft.com/v1.0/applications/${APP_OBJECT_ID}/federatedIdentityCredentials" `
        --body $FC_BODY --output none
    Write-Host "    Federated credential created" -ForegroundColor Green
    Write-Host "      issuer : $FC_ISSUER"
    Write-Host "      subject: $MI_PRINCIPAL"
}

# ---------------------------------------------------------------------------
# 4b. Attach managed identity to trino node pool VMSS (required for IMDS)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 4b: Attach managed identity to node pool VMSS" -ForegroundColor Yellow

$NODE_RG   = az aks show --resource-group $RG --name "aks-forge-compute-${Alias}-${Env}" --query nodeResourceGroup -o tsv
$VMSS_NAME = az vmss list --resource-group $NODE_RG --query "[?contains(name,'trino')].name" -o tsv
if (-not $VMSS_NAME) { $VMSS_NAME = az vmss list --resource-group $NODE_RG --query "[0].name" -o tsv }

$SUB       = az account show --query id -o tsv
$MI_ID     = "/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${MI_NAME}"
$EXISTING_MI = az vmss identity show --resource-group $NODE_RG --name $VMSS_NAME --query "userAssignedIdentities.`"$MI_ID`"" -o tsv 2>$null

if ($EXISTING_MI) {
    Write-Host "    MI already attached to VMSS — skipping" -ForegroundColor Yellow
} else {
    az vmss identity assign --resource-group $NODE_RG --name $VMSS_NAME --identities $MI_ID --output none
    az vmss update-instances --resource-group $NODE_RG --name $VMSS_NAME --instance-ids "*" --output none
    Write-Host "    Attached and propagated: $MI_NAME → $VMSS_NAME" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 4c. Register redirect URI on app registration (idempotent)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 4c: Register redirect URI on app registration" -ForegroundColor Yellow

$EXISTING_URIS = az ad app show --id $CLIENT_ID --query "web.redirectUris" -o json 2>$null | ConvertFrom-Json
if ($EXISTING_URIS -contains $REDIRECT) {
    Write-Host "    Redirect URI already registered — skipping" -ForegroundColor Yellow
} else {
    $ALL_URIS = (@($EXISTING_URIS) + @($REDIRECT)) | Where-Object { $_ } | Select-Object -Unique
    az ad app update --id $CLIENT_ID --web-redirect-uris @ALL_URIS --output none
    Write-Host "    Registered: $REDIRECT" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 5. Session secret
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 5: Session secret" -ForegroundColor Yellow

$existing = kubectl get secret proxy-session-secret -n $NAMESPACE --context $CONTEXT 2>$null
if ($existing) {
    Write-Host "    proxy-session-secret already exists — skipping" -ForegroundColor Yellow
} else {
    $SESSION_KEY = [System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
    kubectl create secret generic proxy-session-secret `
        --from-literal="session-secret=$SESSION_KEY" `
        -n $NAMESPACE --context $CONTEXT
    Write-Host "    Created proxy-session-secret" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 6. Helm deploy
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 6: Deploy Helm chart" -ForegroundColor Yellow

$TOKEN = az acr login --name $ACR --expose-token --query accessToken -o tsv
helm registry login "${ACR}.azurecr.io" --username "00000000-0000-0000-0000-000000000000" --password $TOKEN

helm upgrade --install trino-auth-proxy "$REPO_ROOT\infra\helm\compute\trino-auth-proxy" `
    --namespace $NAMESPACE `
    --kube-context $CONTEXT `
    --set "image.repository=${IMAGE_REPO}" `
    --set "image.tag=${Tag}" `
    --set "env.tenantId=${TENANT_ID}" `
    --set "env.clientId=${CLIENT_ID}" `
    --set "env.redirectUri=${REDIRECT}" `
    --set "env.allowedDomain=microsoft.com" `
    --set "env.trinoBackend=trino:8080" `
    --set "env.managedIdentityClientId=${WI_CLIENT_ID}"

Write-Host "    Helm deploy complete" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host ""
Write-Host "  Access Trino UI:"
Write-Host "    kubectl port-forward svc/trino-auth-proxy 8080:8080 -n $NAMESPACE --context $CONTEXT" -ForegroundColor Cyan
Write-Host "    Then open: http://localhost:8080" -ForegroundColor Cyan
Write-Host ""
Write-Host "  CLI access:"
Write-Host "    `$TOKEN = az account get-access-token --resource $CLIENT_ID --query accessToken -o tsv"
Write-Host "    trino --server http://localhost:8080 --access-token `$TOKEN"
Write-Host ""
Write-Host "  IMPORTANT: Register this redirect URI in the Azure AD app registration:"
Write-Host "  $REDIRECT" -ForegroundColor Cyan
Write-Host "  Portal: https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/Authentication/appId/$CLIENT_ID"
