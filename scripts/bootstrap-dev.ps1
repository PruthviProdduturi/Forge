# =============================================================================
# Forge — Dev Environment Bootstrap Script
#
# Runs the full platform deployment from zero in order:
#   1. Bicep infrastructure (networking, AKS, ADLS, KV, identity, postgres)
#   2. HMS Docker image build (ACR Tasks)
#   3. Compute cluster bootstrap (namespaces, service accounts, Helm deploys)
#
# Prerequisites:
#   - az login --tenant <tenant-id> && az account set --subscription <sub-id>
#   - kubectl, helm installed
#   - Run from repo root: D:\Repos\DSEngCoreInfra\Forge
#
# Usage:
#   .\scripts\bootstrap-dev.ps1
#   .\scripts\bootstrap-dev.ps1 -SkipBicep      # skip infra (already deployed)
#   .\scripts\bootstrap-dev.ps1 -SkipImageBuild  # skip HMS image build
# =============================================================================

param(
    [switch]$SkipBicep,
    [switch]$SkipImageBuild
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Config — edit these for your environment
# ---------------------------------------------------------------------------
$ALIAS       = "prproddu"
$ENV         = "dev"
$LOCATION    = "northcentralus"
$ACR         = "forgeacr${ALIAS}"
$RG          = "rg-forge-${ALIAS}-${ENV}"
$RG_PLATFORM = "rg-forge-platform-${ALIAS}-${ENV}"
$COMPUTE_CLUSTER = "aks-forge-compute-${ALIAS}-${ENV}"
$ORCH_CLUSTER    = "aks-forge-orchestration-${ALIAS}-${ENV}"
$KV          = "kv-forge-${ALIAS}-${ENV}"
$ADLS        = "forgeadls${ALIAS}${ENV}"

# ---------------------------------------------------------------------------
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# Step 1 — Bicep infrastructure
# ---------------------------------------------------------------------------
if (-not $SkipBicep) {
    Write-Step "Deploying Bicep infrastructure..."
    az deployment sub create `
        --location $LOCATION `
        --template-file infra/bicep/environments/dev/main.bicep `
        --parameters "@infra/bicep/environments/dev/dev.parameters.json" `
        --name "forge-${ENV}"
    Write-Ok "Bicep deployment complete"
} else {
    Write-Warn "Skipping Bicep (--SkipBicep)"
}

# ---------------------------------------------------------------------------
# Step 2 — Build HMS Docker image
# ---------------------------------------------------------------------------
if (-not $SkipImageBuild) {
    Write-Step "Building hive-metastore:3.1.3 image via ACR Tasks..."
    az acr update --name $ACR --public-network-enabled true | Out-Null
    az acr build `
        --registry $ACR `
        --image "hive-metastore:3.1.3" `
        --file infra/docker/hive-metastore/Dockerfile `
        .
    az acr update --name $ACR --public-network-enabled false | Out-Null
    Write-Ok "HMS image built and pushed to ACR"
} else {
    Write-Warn "Skipping image build (--SkipImageBuild)"
}

# ---------------------------------------------------------------------------
# Step 3 — Fetch workload identity client IDs
# ---------------------------------------------------------------------------
Write-Step "Fetching workload identity client IDs..."
$WI_SPARK    = az identity show -g $RG -n "id-forge-spark-${ENV}"    --query clientId -o tsv
$WI_TRINO    = az identity show -g $RG -n "id-forge-trino-${ENV}"    --query clientId -o tsv
$WI_AIRFLOW  = az identity show -g $RG -n "id-forge-airflow-${ENV}"  --query clientId -o tsv
$WI_DQ       = az identity show -g $RG -n "id-forge-dq-${ENV}"       --query clientId -o tsv
$WI_PORTAL   = az identity show -g $RG -n "id-forge-portal-${ENV}"   --query clientId -o tsv
$WI_HMS      = az identity show -g $RG -n "id-forge-hms-${ENV}"      --query clientId -o tsv
Write-Ok "Client IDs fetched"

# ---------------------------------------------------------------------------
# Step 4 — Compute cluster bootstrap
# ---------------------------------------------------------------------------
Write-Step "Getting compute cluster credentials..."
az aks get-credentials `
    --resource-group $RG `
    --name $COMPUTE_CLUSTER `
    --overwrite-existing
Write-Ok "kubectl context set to $COMPUTE_CLUSTER"

Write-Step "Creating compute cluster namespaces and service accounts..."

# spark-jobs — Spark Operator jobs
kubectl create namespace spark-jobs --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount spark -n spark-jobs --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate serviceaccount spark -n spark-jobs "azure.workload.identity/client-id=${WI_SPARK}" --overwrite

# spark-system — Spark Operator + Spark Connect
kubectl create namespace spark-system --dry-run=client -o yaml | kubectl apply -f -

# trino
kubectl create namespace trino --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount trino -n trino --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate serviceaccount trino -n trino "azure.workload.identity/client-id=${WI_TRINO}" --overwrite

# hive-metastore
kubectl create namespace hive-metastore --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount hive-metastore -n hive-metastore --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate serviceaccount hive-metastore -n hive-metastore "azure.workload.identity/client-id=${WI_HMS}" --overwrite

Write-Ok "Compute namespaces and service accounts ready"

# ---------------------------------------------------------------------------
# Step 5 — Deploy Hive Metastore
# ---------------------------------------------------------------------------
Write-Step "Deploying Hive Metastore..."
$HMS_HOST = az keyvault secret show --vault-name $KV --name hms-postgres-host --query value -o tsv

helm upgrade --install hive-metastore infra/helm/compute/hive-metastore `
    --namespace hive-metastore `
    --set "image.repository=${ACR}.azurecr.io/hive-metastore" `
    --set "image.tag=3.1.3" `
    --set "db.host=${HMS_HOST}" `
    --set "db.user=id-forge-hms-${ENV}" `
    --set "adls.account=${ADLS}" `
    --set "serviceAccount.annotations.azure\.workload\.identity/client-id=${WI_HMS}" `
    --wait --timeout 5m
Write-Ok "Hive Metastore deployed"

# ---------------------------------------------------------------------------
# Step 6 — Deploy Spark Operator
# ---------------------------------------------------------------------------
Write-Step "Deploying Spark Operator..."
helm upgrade --install spark-operator `
    "oci://${ACR}.azurecr.io/helm/spark-operator" `
    --version 2.1.1 `
    --namespace spark-system `
    --create-namespace `
    --values infra/helm/compute/spark-operator/values.yaml `
    --set "image.repository=${ACR}.azurecr.io/spark-operator" `
    --set "image.tag=2.1.1" `
    --wait --timeout 5m
Write-Ok "Spark Operator deployed"

# ---------------------------------------------------------------------------
# Step 7 — Deploy Spark Connect
# ---------------------------------------------------------------------------
Write-Step "Deploying Spark Connect..."
helm upgrade --install spark-connect infra/helm/compute/spark-connect `
    --namespace spark-system `
    --values infra/helm/compute/spark-connect/values.yaml `
    --values infra/helm/compute/spark-connect/values-dev.yaml `
    --set "image.repository=${ACR}.azurecr.io/spark" `
    --set "image.tag=4.1.1" `
    --set "adls.account=${ADLS}" `
    --set "serviceAccount.annotations.azure\.workload\.identity/client-id=${WI_SPARK}" `
    --wait --timeout 5m
Write-Ok "Spark Connect deployed"

# ---------------------------------------------------------------------------
# Step 8 — Deploy Trino
# ---------------------------------------------------------------------------
Write-Step "Deploying Trino..."
helm upgrade --install trino `
    "oci://${ACR}.azurecr.io/helm/trino" `
    --version 0.31.0 `
    --namespace trino `
    --create-namespace `
    --values infra/helm/compute/trino/values.yaml `
    --set "image.repository=${ACR}.azurecr.io/trino" `
    --set "image.tag=438" `
    --set "serviceAccount.annotations.azure\.workload\.identity/client-id=${WI_TRINO}" `
    --wait --timeout 10m
Write-Ok "Trino deployed"

# ---------------------------------------------------------------------------
# Step 9 — Orchestration cluster bootstrap (namespaces + service accounts)
# ---------------------------------------------------------------------------
Write-Step "Getting orchestration cluster credentials..."
az aks get-credentials `
    --resource-group $RG `
    --name $ORCH_CLUSTER `
    --overwrite-existing
Write-Ok "kubectl context set to $ORCH_CLUSTER"

Write-Step "Creating orchestration cluster namespaces and service accounts..."

kubectl create namespace airflow --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount airflow -n airflow --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate serviceaccount airflow -n airflow "azure.workload.identity/client-id=${WI_AIRFLOW}" --overwrite

kubectl create namespace dq --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount dq-runner -n dq --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate serviceaccount dq-runner -n dq "azure.workload.identity/client-id=${WI_DQ}" --overwrite

kubectl create namespace portal --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount portal-api -n portal --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate serviceaccount portal-api -n portal "azure.workload.identity/client-id=${WI_PORTAL}" --overwrite

kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

Write-Ok "Orchestration namespaces and service accounts ready"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host "`n==> Compute cluster fully deployed." -ForegroundColor Green
Write-Host "    Next: run Step 05 to deploy Airflow, Observability, and Portal." -ForegroundColor Green
Write-Host "`n    Spark Connect endpoint (port-forward to access):" -ForegroundColor Cyan

az aks get-credentials `
    --resource-group $RG `
    --name $COMPUTE_CLUSTER `
    --overwrite-existing | Out-Null

$SC_IP = kubectl get svc spark-connect-lb -n spark-system -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>$null
if ($SC_IP) {
    Write-Host "    kubectl port-forward svc/spark-connect-lb 15002:15002 -n spark-system" -ForegroundColor Yellow
    Write-Host "    Then connect VS Code to: sc://localhost:15002" -ForegroundColor Yellow
}
