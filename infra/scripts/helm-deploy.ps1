#Requires -Version 7.0
<#
.SYNOPSIS
    Automates Steps 10-15 of the Forge deployment runbook: cluster bootstraps + all Helm
    chart deployments (Spark Operator, HMS, Spark Connect, Trino).

.DESCRIPTION
    Idempotent — safe to re-run at any point. Uses `helm upgrade --install` throughout.
    Prerequisites (Steps 1-9) must be complete before running this script:
      - Bicep deployment (forge-dev) must be in Succeeded state
      - AKS credentials must be fetched (Step 8)
      - ACR images and Helm charts must be built/imported (Steps 3-7)

.PARAMETER Env
    Target environment. Default: dev

.PARAMETER Alias
    Engineer alias used in resource naming. Default: prproddu

.PARAMETER Sub
    Azure subscription ID. If omitted, uses the current `az account` subscription.

.EXAMPLE
    # Standard dev deployment
    ./infra/scripts/helm-deploy.ps1 --env dev --alias prproddu

.EXAMPLE
    # With an explicit subscription
    ./infra/scripts/helm-deploy.ps1 --env dev --alias prproddu --sub 00000000-0000-0000-0000-000000000000
#>

param(
    [string]$Env   = "dev",
    [string]$Alias = "prproddu",
    [string]$Sub   = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ============================================================
# Helpers
# ============================================================

function Write-Section([string]$Title) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
}

function Write-Step([string]$Msg) {
    Write-Host "  --> $Msg" -ForegroundColor Yellow
}

function Write-OK([string]$Msg) {
    Write-Host "  [OK] $Msg" -ForegroundColor Green
}

# ============================================================
# Step 1 — Subscription + Derived Names
# ============================================================
Write-Section "Step 1 — Set Subscription and Derive Resource Names"

if ($Sub -ne "") {
    Write-Step "Setting subscription to $Sub"
    az account set --subscription $Sub | Out-Null
}

$CURRENT_SUB = az account show --query id -o tsv
Write-OK "Subscription: $CURRENT_SUB"

# Resource names
$ACR              = "forgeacr${Alias}"
$ACR_FQDN         = "${ACR}.azurecr.io"
$RG               = "rg-forge-${Alias}-${Env}"
$DEPLOYMENT_NAME  = "forge-${Env}"
$TRINO_FQDN       = "trino-forge-${Alias}-${Env}.northcentralus.cloudapp.azure.com"

# AKS kubeconfig context names (actual names assigned by `az aks get-credentials`)
$COMPUTE_CTX = "aks-forge-compute-${Alias}-${Env}"
$ORCH_CTX    = "aks-forge-orchestration-${Alias}-${Env}"

Write-OK "ACR:          $ACR_FQDN"
Write-OK "Resource Group: $RG"
Write-OK "Compute context: $COMPUTE_CTX"
Write-OK "Orch context:    $ORCH_CTX"
Write-OK "Trino FQDN:      $TRINO_FQDN"

# ============================================================
# Step 2 — Load Bicep Deployment Outputs
# ============================================================
Write-Section "Step 2 — Load Deployment Outputs from Bicep"

Write-Step "Querying deployment '$DEPLOYMENT_NAME'..."
$IDS = az deployment sub show `
    --name $DEPLOYMENT_NAME `
    --query properties.outputs.workloadIdentities.value `
    -o json | ConvertFrom-Json

$POSTGRES_HOST = az deployment sub show `
    --name $DEPLOYMENT_NAME `
    --query properties.outputs.postgresServerFqdn.value `
    -o tsv

$ADLS_ACCOUNT = az deployment sub show `
    --name $DEPLOYMENT_NAME `
    --query properties.outputs.storageAccountName.value `
    -o tsv

$HMS_NAME        = $IDS.hms.name
$HMS_CLIENT_ID   = $IDS.hms.clientId
$SPARK_CLIENT_ID = $IDS.spark.clientId
$TRINO_CLIENT_ID = $IDS.trino.clientId
$AIRFLOW_CLIENT_ID = $IDS.airflow.clientId
$DQ_CLIENT_ID    = $IDS.dq.clientId
$PORTAL_CLIENT_ID = $IDS.portal.clientId

if (-not $POSTGRES_HOST) { throw "POSTGRES_HOST is empty — is the Bicep deployment in Succeeded state?" }
if (-not $ADLS_ACCOUNT)  { throw "ADLS_ACCOUNT is empty — is the Bicep deployment in Succeeded state?" }
if (-not $HMS_CLIENT_ID) { throw "HMS_CLIENT_ID is empty — check workloadIdentities output in Bicep" }

Write-OK "POSTGRES_HOST:   $POSTGRES_HOST"
Write-OK "ADLS_ACCOUNT:    $ADLS_ACCOUNT"
Write-OK "HMS_NAME:        $HMS_NAME"
Write-OK "HMS_CLIENT_ID:   $HMS_CLIENT_ID"
Write-OK "SPARK_CLIENT_ID: $SPARK_CLIENT_ID"
Write-OK "TRINO_CLIENT_ID: $TRINO_CLIENT_ID"

# ============================================================
# Step 3 — ACR Login for Helm OCI
# ============================================================
Write-Section "Step 3 — ACR Login for Helm OCI (expose-token, no Docker required)"

Write-Step "Fetching ACR token for $ACR_FQDN..."
$ACR_TOKEN = az acr login --name $ACR --expose-token --query accessToken -o tsv

Write-Step "Logging Helm into $ACR_FQDN..."
helm registry login $ACR_FQDN `
    --username "00000000-0000-0000-0000-000000000000" `
    --password $ACR_TOKEN

Write-OK "Helm OCI registry login succeeded"

# ============================================================
# Step 4 — Bootstrap Compute Cluster
# ============================================================
Write-Section "Step 4 — Bootstrap Compute Cluster (namespaces + workload identity service accounts)"

Write-Step "Running cluster-bootstrap on $COMPUTE_CTX..."
helm upgrade --install cluster-bootstrap infra/helm/compute/cluster-bootstrap `
    --create-namespace `
    --set workloadIdentity.spark.clientId=$SPARK_CLIENT_ID `
    --set workloadIdentity.trino.clientId=$TRINO_CLIENT_ID `
    --set workloadIdentity.hms.clientId=$HMS_CLIENT_ID `
    --kube-context $COMPUTE_CTX

Write-OK "Compute cluster-bootstrap complete"

Write-Step "Verifying namespaces on $COMPUTE_CTX..."
$NS = kubectl get namespaces --context $COMPUTE_CTX -o jsonpath='{.items[*].metadata.name}'
foreach ($expected in @("spark-jobs", "spark-system", "trino", "hive-metastore")) {
    if ($NS -match $expected) {
        Write-OK "Namespace '$expected' present"
    } else {
        Write-Host "  [WARN] Namespace '$expected' not found — bootstrap may have failed" -ForegroundColor Red
    }
}

# ============================================================
# Step 5 — Bootstrap Orchestration Cluster
# ============================================================
Write-Section "Step 5 — Bootstrap Orchestration Cluster (namespaces + workload identity service accounts)"

Write-Step "Running cluster-bootstrap on $ORCH_CTX..."
helm upgrade --install cluster-bootstrap infra/helm/orchestration/cluster-bootstrap `
    --create-namespace `
    --set workloadIdentity.airflow.clientId=$AIRFLOW_CLIENT_ID `
    --set workloadIdentity.dq.clientId=$DQ_CLIENT_ID `
    --set workloadIdentity.portal.clientId=$PORTAL_CLIENT_ID `
    --kube-context $ORCH_CTX

Write-OK "Orchestration cluster-bootstrap complete"

Write-Step "Verifying namespaces on $ORCH_CTX..."
$NS_ORCH = kubectl get namespaces --context $ORCH_CTX -o jsonpath='{.items[*].metadata.name}'
foreach ($expected in @("airflow", "dq", "portal", "monitoring")) {
    if ($NS_ORCH -match $expected) {
        Write-OK "Namespace '$expected' present"
    } else {
        Write-Host "  [WARN] Namespace '$expected' not found — bootstrap may have failed" -ForegroundColor Red
    }
}

# ============================================================
# Step 6 — Deploy Spark Operator (from ACR OCI)
# ============================================================
Write-Section "Step 6 — Deploy Spark Operator"

Write-Step "Installing spark-operator from oci://${ACR_FQDN}/helm/spark-operator..."
helm upgrade --install spark-operator `
    "oci://${ACR_FQDN}/helm/spark-operator" `
    --version 2.5.0 `
    --namespace spark-system `
    --values infra/helm/compute/spark-operator/values.yaml `
    --kube-context $COMPUTE_CTX

Write-OK "Spark Operator deployed"

# ============================================================
# Step 7 — Deploy Hive Metastore
# ============================================================
Write-Section "Step 7 — Deploy Hive Metastore"

Write-Step "Installing hive-metastore..."
helm upgrade --install hive-metastore infra/helm/compute/hive-metastore `
    --namespace hive-metastore `
    --set "image.repository=${ACR_FQDN}/hive-metastore" `
    --set image.tag=3.1.3 `
    --set db.host=$POSTGRES_HOST `
    --set db.user=$HMS_NAME `
    --set adls.account=$ADLS_ACCOUNT `
    --set "serviceAccount.annotations.azure\.workload\.identity/client-id=$HMS_CLIENT_ID" `
    --kube-context $COMPUTE_CTX

Write-OK "Hive Metastore deployed"

# ============================================================
# Step 8 — Deploy Spark Connect (no --wait; internal LB spurious error)
# ============================================================
Write-Section "Step 8 — Deploy Spark Connect"

# NOTE: --wait is intentionally omitted. The internal LB service (spark-connect-lb)
# triggers a spurious "services 'spark-connect-lb' not found" error if --wait is used.
# Verify pod readiness manually after deploy.
Write-Step "Installing spark-connect (without --wait to avoid internal LB false error)..."
helm upgrade --install spark-connect infra/helm/compute/spark-connect `
    --namespace spark-system `
    --values infra/helm/compute/spark-connect/values.yaml `
    --values infra/helm/compute/spark-connect/values-dev.yaml `
    --set "image.repository=${ACR_FQDN}/spark" `
    --set image.tag=4.1.1 `
    --set adls.account=$ADLS_ACCOUNT `
    --set "serviceAccount.annotations.azure\.workload\.identity/client-id=$SPARK_CLIENT_ID" `
    --kube-context $COMPUTE_CTX

Write-OK "Spark Connect deployed (verify pod status manually — see verification note below)"
Write-Host "  To verify: kubectl get pods -n spark-system --context $COMPUTE_CTX" -ForegroundColor Gray

# ============================================================
# Step 9 — Trino TLS Pre-Setup
# ============================================================
Write-Section "Step 9 — Trino TLS Pre-Setup (self-signed cert -> K8s secret)"

$KEYSTORE_PASS = "trino123"
$CERT_SUBJECT  = "CN=$TRINO_FQDN"
$PFX_PATH      = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.pfx'
$SECURE_PASS   = ConvertTo-SecureString -String $KEYSTORE_PASS -Force -AsPlainText

Write-Step "Generating self-signed certificate for CN=$TRINO_FQDN..."
$Cert = New-SelfSignedCertificate `
    -DnsName $TRINO_FQDN `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -Subject $CERT_SUBJECT `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -NotAfter (Get-Date).AddYears(2)

Write-Step "Exporting certificate to PFX: $PFX_PATH"
Export-PfxCertificate -Cert $Cert -FilePath $PFX_PATH -Password $SECURE_PASS | Out-Null

Write-Step "Creating K8s secret 'trino-tls' in namespace 'trino' on $COMPUTE_CTX (idempotent)..."
# Pipe through dry-run + apply for idempotency (avoids "already exists" error on re-run)
kubectl create secret generic trino-tls `
    --namespace trino `
    --from-file="keystore.p12=$PFX_PATH" `
    --from-literal="keystore-password=$KEYSTORE_PASS" `
    --dry-run=client -o yaml `
    --context $COMPUTE_CTX `
    | kubectl apply -f - --context $COMPUTE_CTX

Write-OK "trino-tls secret applied in namespace 'trino'"

# Clean up temp PFX file
Remove-Item $PFX_PATH -ErrorAction SilentlyContinue
Write-OK "Temporary PFX file removed"

# ============================================================
# Step 10 — Deploy Trino (from ACR OCI)
# ============================================================
Write-Section "Step 10 — Deploy Trino (HTTPS + Azure AD OAuth2)"

# The values.yaml already contains:
#   - HTTPS on port 8443 with keystore at /etc/trino/tls/keystore.p12
#   - Azure AD OAuth2 with client ID f21cd19e-5e8b-4739-b0fb-1ebd13b8c036
#   - Volume mount for the trino-tls secret
#   - Public LoadBalancer service (no internal LB annotations)
Write-Step "Installing trino from oci://${ACR_FQDN}/helm/trino..."
helm upgrade --install trino `
    "oci://${ACR_FQDN}/helm/trino" `
    --version 1.36.0 `
    --namespace trino `
    --values infra/helm/compute/trino/values.yaml `
    --set "image.repository=${ACR_FQDN}/trino" `
    --set image.tag=468 `
    --set "serviceAccount.annotations.azure\.workload\.identity/client-id=$TRINO_CLIENT_ID" `
    --kube-context $COMPUTE_CTX

Write-OK "Trino deployed"

# ============================================================
# Step 11 — Trino Post-Setup: DNS Label + Instructions
# ============================================================
Write-Section "Step 11 — Trino Post-Setup: Wait for Public IP + Set DNS Label"

Write-Step "Waiting for Trino LoadBalancer service to receive a public IP (up to 5 minutes)..."
$TRINO_PUBLIC_IP = ""
$Attempts = 0
$MaxAttempts = 30   # 30 x 10s = 5 minutes

while ($TRINO_PUBLIC_IP -eq "" -and $Attempts -lt $MaxAttempts) {
    $Attempts++
    $TRINO_PUBLIC_IP = kubectl get svc trino `
        --namespace trino `
        --context $COMPUTE_CTX `
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
    if ($TRINO_PUBLIC_IP -eq "") {
        Write-Host "  ... waiting for IP (attempt $Attempts/$MaxAttempts)..." -ForegroundColor Gray
        Start-Sleep -Seconds 10
    }
}

if ($TRINO_PUBLIC_IP -eq "") {
    Write-Host "  [WARN] Trino service did not receive a public IP within 5 minutes." -ForegroundColor Red
    Write-Host "         Check: kubectl get svc trino -n trino --context $COMPUTE_CTX" -ForegroundColor Red
    Write-Host "         Run the DNS label step manually once the IP is assigned." -ForegroundColor Red
} else {
    Write-OK "Trino public IP: $TRINO_PUBLIC_IP"

    # Find the public IP resource in the AKS MC_ resource group and set the DNS label
    Write-Step "Locating AKS node resource group..."
    $MC_RG = az aks show `
        --resource-group $RG `
        --name "aks-forge-compute-${Alias}-${Env}" `
        --query nodeResourceGroup -o tsv

    Write-Step "Searching for public IP $TRINO_PUBLIC_IP in resource group $MC_RG..."
    $IP_RESOURCE_ID = az network public-ip list `
        --resource-group $MC_RG `
        --query "[?ipAddress=='$TRINO_PUBLIC_IP'].id" -o tsv

    if (-not $IP_RESOURCE_ID) {
        Write-Host "  [WARN] Could not find public IP resource for $TRINO_PUBLIC_IP in $MC_RG" -ForegroundColor Red
        Write-Host "         Set the DNS label manually:" -ForegroundColor Red
        Write-Host "         az network public-ip update --dns-name trino-forge-${Alias}-${Env} --ids <ip-resource-id>" -ForegroundColor Red
    } else {
        Write-Step "Setting DNS label 'trino-forge-${Alias}-${Env}' on IP resource..."
        az network public-ip update `
            --ids $IP_RESOURCE_ID `
            --dns-name "trino-forge-${Alias}-${Env}" | Out-Null

        Write-OK "DNS label set. Trino is accessible at:"
        Write-Host "    https://${TRINO_FQDN}:8443" -ForegroundColor White
    }
}

# ============================================================
# Summary + Next Actions
# ============================================================
Write-Section "Deployment Complete — Next Actions"

Write-Host ""
Write-Host "  Spark Operator" -ForegroundColor White
Write-Host "    kubectl get pods -n spark-system --context $COMPUTE_CTX"
Write-Host "    kubectl get crd --context $COMPUTE_CTX | Select-String spark"
Write-Host ""
Write-Host "  Hive Metastore" -ForegroundColor White
Write-Host "    kubectl get pods -n hive-metastore --context $COMPUTE_CTX"
Write-Host ""
Write-Host "  Spark Connect" -ForegroundColor White
Write-Host "    kubectl get pods -n spark-system --context $COMPUTE_CTX"
Write-Host "    kubectl get svc spark-connect-lb -n spark-system --context $COMPUTE_CTX"
Write-Host ""
Write-Host "  Trino" -ForegroundColor White
Write-Host "    kubectl get pods -n trino --context $COMPUTE_CTX"
Write-Host "    Browse: https://${TRINO_FQDN}:8443  (accept self-signed cert warning)"
Write-Host ""
Write-Host "  Azure AD App Registration — configure redirect URI:" -ForegroundColor White
Write-Host "    App: f21cd19e-5e8b-4739-b0fb-1ebd13b8c036"
Write-Host "    Add redirect URI: https://${TRINO_FQDN}:8443/oauth2/callback"
Write-Host "    Portal: https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/Authentication/appId/f21cd19e-5e8b-4739-b0fb-1ebd13b8c036"
Write-Host ""
