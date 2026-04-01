# =============================================================================
# deploy-portal.ps1 — Deploy Forge Developer Portal to the Orchestration Cluster
#
# Usage:
#   .\infra\scripts\deploy-portal.ps1 --env dev --alias prproddu
#
# Optional:
#   --SkipBuild      Skip ACR image builds
#   --ApiTag 1.1     Override portal-api image tag (default: 1.0)
#   --WebTag 1.1     Override portal-web image tag (default: 1.0)
# =============================================================================

param(
    [Parameter(Mandatory)][string]$Env,
    [Parameter(Mandatory)][string]$Alias,
    [switch]$SkipBuild,
    [string]$ApiTag = "1.0",
    [string]$WebTag = "1.0"
)

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Resolve-Path "$ScriptDir\..\.."

# ---------------------------------------------------------------------------
# Derived names
# ---------------------------------------------------------------------------
$Acr            = "forgeacr${Alias}"
$ResourceGroup  = "rg-forge-${Env}"
$OrchCluster    = "aks-forge-orchestration-${Alias}-${Env}"
$ComputeCluster = "aks-forge-compute-${Alias}-${Env}"
$DnsLabel       = "forge-portal-${Alias}-${Env}"
$KubeContext    = "aks-forge-orchestration-${Alias}-${Env}"

try {
    $Location = (az aks show --resource-group $ResourceGroup --name $OrchCluster --query location -o tsv 2>$null)
} catch { $Location = "northcentralus" }
if (-not $Location) { $Location = "northcentralus" }

$PublicHost     = "${DnsLabel}.${Location}.cloudapp.azure.com"
$AdlsAccount    = "forgeadls$($Alias -replace '-','')${Env}"
$SubscriptionId = (az account show --query id -o tsv)
$KvName         = "kv-forge-${Alias}-${Env}"
$KvUrl          = "https://${KvName}.vault.azure.net/"

Write-Host ""
Write-Host "============================================================"
Write-Host " Forge Portal Deploy"
Write-Host "  env:          $Env"
Write-Host "  alias:        $Alias"
Write-Host "  ACR:          ${Acr}.azurecr.io"
Write-Host "  orchestration: $OrchCluster"
Write-Host "  public URL:   http://$PublicHost"
Write-Host "============================================================"
Write-Host ""

# ---------------------------------------------------------------------------
# Step 1 — Get portal managed identity client ID
# ---------------------------------------------------------------------------
Write-Host "[1/5] Resolving portal managed identity..."

$PortalMiName  = "id-forge-portal-${Alias}-${Env}"
$PortalClientId = ""
try {
    $PortalClientId = (az identity show --resource-group $ResourceGroup --name $PortalMiName --query clientId -o tsv 2>$null)
} catch {}
if (-not $PortalClientId) {
    Write-Warning "  Managed identity $PortalMiName not found — workload identity skipped"
}

# ---------------------------------------------------------------------------
# Step 1b — Seed auth-config secrets in Key Vault (idempotent)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "[1b/5] Seeding auth-config secrets in Key Vault ($KvName)..."

function Seed-KvSecret($Name, $Value) {
    $existing = (az keyvault secret show --vault-name $KvName --name $Name --query value -o tsv 2>$null)
    if (-not $existing) {
        az keyvault secret set --vault-name $KvName --name $Name --value $Value --output none
        Write-Host "  Created: $Name"
    } else {
        Write-Host "  Exists:  $Name (not overwritten)"
    }
}

Seed-KvSecret "forge-portal-auth-provider" "local"
Seed-KvSecret "forge-portal-aad-client-id" ""
Seed-KvSecret "forge-portal-aad-tenant-id" ""

# ---------------------------------------------------------------------------
# Step 2 — Build images
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "[2/5] Building portal-api:${ApiTag} ..."
    az acr build `
        --registry $Acr `
        --image "portal-api:${ApiTag}" `
        --file "$RepoRoot\infra\docker\portal-api\Dockerfile" `
        "$RepoRoot\portal\backend\"

    Write-Host ""
    Write-Host "[2/5] Building portal-web:${WebTag} ..."
    az acr build `
        --registry $Acr `
        --image "portal-web:${WebTag}" `
        --file "$RepoRoot\infra\docker\portal-web\Dockerfile" `
        --build-arg "API_URL=" `
        --build-arg "WEB_URL=http://${PublicHost}" `
        "$RepoRoot\portal\frontend\"
} else {
    Write-Host "[2/5] Skipping image builds (--SkipBuild)"
}

# ---------------------------------------------------------------------------
# Step 3 — NGINX ingress controller
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "[3/5] Installing / upgrading ingress-nginx controller..."

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update 2>$null
helm repo update ingress-nginx 2>$null

helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx `
    --namespace ingress-nginx --create-namespace `
    --kube-context $KubeContext `
    --values "$RepoRoot\infra\helm\orchestration\ingress-nginx\values.yaml" `
    --set "controller.service.annotations.service\.beta\.kubernetes\.io/azure-dns-label-name=${DnsLabel}" `
    --wait --timeout 5m

# ---------------------------------------------------------------------------
# Step 4 — Wait for public IP
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "[4/5] Waiting for public IP (DNS: $DnsLabel)..."

$ExternalIp = ""
for ($i = 1; $i -le 30; $i++) {
    $ExternalIp = (kubectl get svc ingress-nginx-controller `
        --namespace ingress-nginx `
        --context $KubeContext `
        --output jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null)
    if ($ExternalIp) {
        Write-Host "  Public IP: $ExternalIp"
        Write-Host "  Public URL: http://$PublicHost"
        break
    }
    Write-Host "  Waiting... ($i/30)"
    Start-Sleep 10
}

if (-not $ExternalIp) {
    Write-Warning "  External IP not yet assigned — accessible once Azure allocates it"
}

# ---------------------------------------------------------------------------
# Step 5 — Deploy portal Helm chart
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "[5/5] Deploying forge-portal Helm chart..."

$HelmArgs = @(
    "upgrade", "--install", "forge-portal",
    "$RepoRoot\infra\helm\orchestration\portal",
    "--namespace", "portal",
    "--kube-context", $KubeContext,
    "--set", "api.image.repository=${Acr}.azurecr.io/portal-api",
    "--set", "api.image.tag=${ApiTag}",
    "--set", "web.image.repository=${Acr}.azurecr.io/portal-web",
    "--set", "web.image.tag=${WebTag}",
    "--set", "api.env.forgeEnv=${Env}",
    "--set", "api.env.adlsAccount=${AdlsAccount}",
    "--set", "api.env.subscriptionId=${SubscriptionId}",
    "--set", "api.env.resourceGroup=${ResourceGroup}",
    "--set", "api.env.ownerAlias=${Alias}",
    "--set", "api.env.computeClusterName=${ComputeCluster}",
    "--set", "api.env.orchClusterName=${OrchCluster}",
    "--set", "ingress.host=${PublicHost}",
    "--set", "api.env.keyVaultUrl=${KvUrl}",
    "--wait", "--timeout", "5m"
)

if ($PortalClientId) {
    $HelmArgs += "--set"
    $HelmArgs += "api.env.azureClientId=${PortalClientId}"
}

& helm @HelmArgs

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================"
Write-Host " Forge Portal deployed successfully"
Write-Host ""
Write-Host "  URL:  http://$PublicHost"
Write-Host "  API:  http://$PublicHost/api/health"
Write-Host ""
Write-Host "  Default login (local auth):"
Write-Host "    username: admin"
Write-Host "    password: admin"
Write-Host ""
Write-Host "  To watch pods:"
Write-Host "    kubectl get pods -n portal --context $KubeContext -w"
Write-Host "============================================================"
