# Forge — Full Deployment Runbook

> **Platform:** Windows / PowerShell 7+
> **Audience:** Platform engineers performing a full environment deployment
> **Run from:** `D:\Repos\DSEngCoreInfra\Forge` (repo root)

All commands are in order. Each step must complete before starting the next unless noted otherwise.

---

## Prerequisites

- Azure CLI logged in: `az login`
- Correct subscription set: `az account set --subscription <subscription-id>`
- `helm`, `kubectl`, `kubelogin` installed
- kubelogin PATH fix (run once per session in admin PowerShell):
  ```powershell
  kubelogin convert-kubeconfig --login azurecli
  ```

---

## Step 1 — Deploy ACR (shared, run once)

```powershell
az deployment sub create `
  --location northcentralus `
  --template-file infra/bicep/environments/shared/main.bicep `
  --parameters @infra/bicep/environments/shared/shared.parameters.json `
  --name forge-shared
```

Wait for `provisioningState: Succeeded` before proceeding.

---

## Step 2 — Deploy Everything Else

```powershell
az deployment sub create `
  --location northcentralus `
  --template-file infra/bicep/environments/dev/main.bicep `
  --parameters @infra/bicep/environments/dev/dev.parameters.json `
  --name forge-dev
```

This takes 20–30 minutes. Creates: networking, AKS clusters, ADLS, managed identities, Key Vault, PostgreSQL.

---

## Step 3 — Enable ACR Public Access for Builds

```powershell
$ACR = "forgeacrprproddu"
az acr update --name $ACR --allow-exports true
az acr update --name $ACR --public-network-enabled true
```

---

## Step 4 — Build Custom Images

```powershell
# Hive Metastore
az acr build --registry $ACR --image "hive-metastore:3.1.3" --file infra/docker/hive-metastore/Dockerfile .

# Spark
az acr build --registry $ACR --image "spark:4.1.1" --file infra/docker/spark/Dockerfile .

# Trino
az acr build --registry $ACR --image "trino:438" --file infra/docker/trino/Dockerfile infra/docker/trino/

# Airflow
az acr build --registry $ACR --image "airflow:3.1.8" --file infra/docker/airflow/Dockerfile infra/docker/airflow/
```

---

## Step 5 — Import Third-Party Images

```powershell
az acr import --name $ACR --source ghcr.io/kubeflow/spark-operator:v2.1.1 --image spark-operator:2.1.1
```

---

## Step 6 — Import Helm Charts into ACR

```powershell
$TOKEN = az acr login --name $ACR --expose-token --output tsv --query accessToken
$TOKEN | helm registry login "${ACR}.azurecr.io" --username 00000000-0000-0000-0000-000000000000 --password-stdin

helm pull spark-operator/spark-operator --version 2.1.1  --repo https://kubeflow.github.io/spark-operator
helm pull trino/trino                   --version 0.31.0 --repo https://trinodb.github.io/charts
helm pull apache-airflow/airflow        --version 1.15.0 --repo https://airflow.apache.org

helm push spark-operator-2.1.1.tgz oci://${ACR}.azurecr.io/helm
helm push trino-0.31.0.tgz         oci://${ACR}.azurecr.io/helm
helm push airflow-1.15.0.tgz       oci://${ACR}.azurecr.io/helm

Remove-Item spark-operator-*.tgz, trino-*.tgz, airflow-*.tgz
```

---

## Step 7 — Lock ACR Back Down

```powershell
az acr update --name $ACR --public-network-enabled false
az acr update --name $ACR --allow-exports false
```

---

## Step 8 — Get AKS Credentials

```powershell
az aks get-credentials `
  --resource-group rg-forge-prproddu-dev `
  --name aks-forge-compute-prproddu-dev `
  --context forge-compute-dev `
  --overwrite-existing

az aks get-credentials `
  --resource-group rg-forge-prproddu-dev `
  --name aks-forge-orchestration-prproddu-dev `
  --context forge-orch-dev `
  --overwrite-existing

kubelogin convert-kubeconfig --login azurecli
```

---

## Step 9 — Load Deployment Outputs

Run once — used in all subsequent steps:

```powershell
$IDS           = az deployment sub show --name forge-dev --query properties.outputs.workloadIdentities.value -o json | ConvertFrom-Json
$POSTGRES_HOST = az deployment sub show --name forge-dev --query properties.outputs.postgresServerFqdn.value -o tsv
$ADLS_ACCOUNT  = az deployment sub show --name forge-dev --query properties.outputs.storageAccountName.value -o tsv

$HMS_NAME        = $IDS.hms.name
$HMS_CLIENT_ID   = $IDS.hms.clientId
$SPARK_CLIENT_ID = $IDS.spark.clientId
$TRINO_CLIENT_ID = $IDS.trino.clientId
```

---

## Step 10 — Bootstrap Compute Cluster

Creates namespaces and workload identity service accounts:

```powershell
helm upgrade --install cluster-bootstrap infra/helm/compute/cluster-bootstrap `
  --create-namespace `
  --set workloadIdentity.spark.clientId=$IDS.spark.clientId `
  --set workloadIdentity.trino.clientId=$IDS.trino.clientId `
  --set workloadIdentity.hms.clientId=$IDS.hms.clientId `
  --kube-context forge-compute-dev
```

Verify:
```powershell
kubectl get namespaces --context forge-compute-dev
kubectl get serviceaccounts -A --context forge-compute-dev | Select-String "spark|trino|hive"
```

---

## Step 11 — Bootstrap Orchestration Cluster

```powershell
helm upgrade --install cluster-bootstrap infra/helm/orchestration/cluster-bootstrap `
  --create-namespace `
  --set workloadIdentity.airflow.clientId=$IDS.airflow.clientId `
  --set workloadIdentity.dq.clientId=$IDS.dq.clientId `
  --set workloadIdentity.portal.clientId=$IDS.portal.clientId `
  --kube-context forge-orch-dev
```

Verify:
```powershell
kubectl get namespaces --context forge-orch-dev
kubectl get serviceaccounts -A --context forge-orch-dev | Select-String "airflow|dq|portal"
```

---

## Step 12 — Deploy Hive Metastore

```powershell
helm upgrade --install hive-metastore infra/helm/compute/hive-metastore `
  --namespace hive-metastore `
  --set image.repository=${ACR}.azurecr.io/hive-metastore `
  --set image.tag=3.1.3 `
  --set db.host=$POSTGRES_HOST `
  --set db.user=$HMS_NAME `
  --set adls.account=$ADLS_ACCOUNT `
  --set "serviceAccount.annotations.azure\.workload\.identity/client-id=$HMS_CLIENT_ID" `
  --kube-context forge-compute-dev
```

Verify:
```powershell
kubectl get pods -n hive-metastore --context forge-compute-dev -w
# Expected: 1/1 Running
```

---

## Step 13 — Deploy Spark Operator

```powershell
helm upgrade --install spark-operator `
  oci://${ACR}.azurecr.io/helm/spark-operator `
  --version 2.1.1 `
  --namespace spark-system `
  --values infra/helm/compute/spark-operator/values.yaml `
  --set image.repository=${ACR}.azurecr.io/spark-operator `
  --set image.tag=2.1.1 `
  --kube-context forge-compute-dev
```

Verify:
```powershell
kubectl get pods -n spark-system --context forge-compute-dev
kubectl get crd --context forge-compute-dev | Select-String "spark"
```

---

## Step 14 — Deploy Spark Connect

```powershell
helm upgrade --install spark-connect infra/helm/compute/spark-connect `
  --namespace spark-system `
  --values infra/helm/compute/spark-connect/values.yaml `
  --values infra/helm/compute/spark-connect/values-dev.yaml `
  --set image.repository=${ACR}.azurecr.io/spark `
  --set image.tag=4.1.1 `
  --set adls.account=$ADLS_ACCOUNT `
  --set "serviceAccount.annotations.azure\.workload\.identity/client-id=$SPARK_CLIENT_ID" `
  --kube-context forge-compute-dev
```

Verify:
```powershell
kubectl get pods -n spark-system --context forge-compute-dev
kubectl get svc -n spark-system --context forge-compute-dev
```

---

## Step 15 — Deploy Trino

```powershell
helm upgrade --install trino `
  oci://${ACR}.azurecr.io/helm/trino `
  --version 0.31.0 `
  --namespace trino `
  --values infra/helm/compute/trino/values.yaml `
  --set image.repository=${ACR}.azurecr.io/trino `
  --set image.tag=438 `
  --set "serviceAccount.annotations.azure\.workload\.identity/client-id=$TRINO_CLIENT_ID" `
  --kube-context forge-compute-dev
```

Verify:
```powershell
kubectl get pods -n trino --context forge-compute-dev
# Expected: coordinator 1/1 Running, 2x worker 1/1 Running
```

---

## Readiness Checklist

Before proceeding to Step 05 (orchestration workloads):

```
[ ] forge-shared deployment: Succeeded
[ ] forge-dev deployment:    Succeeded
[ ] All ACR images present:  az acr repository list --name forgeacrprproddu -o table
[ ] HMS pod:                 kubectl get pods -n hive-metastore --context forge-compute-dev
[ ] Spark Operator pod:      kubectl get pods -n spark-system --context forge-compute-dev
[ ] Spark CRDs installed:    kubectl get crd --context forge-compute-dev | Select-String spark
[ ] Spark Connect pod:       kubectl get pods -n spark-system --context forge-compute-dev
[ ] Trino coordinator+workers running
```
