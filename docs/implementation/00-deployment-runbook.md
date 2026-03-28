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

**Verify:**
```powershell
az acr show --name forgeacrprproddu --query provisioningState -o tsv
# Expected: Succeeded
```

---

## Step 2 — Deploy Everything Else

> Steps 3–7 (ACR image builds) can run in a second terminal while this is in progress.

```powershell
az deployment sub create `
  --location northcentralus `
  --template-file infra/bicep/environments/dev/main.bicep `
  --parameters @infra/bicep/environments/dev/dev.parameters.json `
  --name forge-dev
```

This takes 20–30 minutes. Creates: networking, AKS clusters, ADLS, managed identities, Key Vault, PostgreSQL.

**Verify:**
```powershell
az deployment sub show --name forge-dev --query properties.provisioningState -o tsv
# Expected: Succeeded

# Confirm all key resources exist
az aks show --resource-group rg-forge-prproddu-dev --name aks-forge-compute-prproddu-dev --query provisioningState -o tsv
az aks show --resource-group rg-forge-prproddu-dev --name aks-forge-orchestration-prproddu-dev --query provisioningState -o tsv
az storage account show --resource-group rg-forge-prproddu-dev --name forgeadlsprproddudev --query provisioningState -o tsv
az postgres flexible-server show --resource-group rg-forge-prproddu-dev --name psql-forge-prproddu-dev --query state -o tsv
# Expected: Succeeded / Ready
```

---

## Step 3 — Enable ACR Public Access for Builds

> Run in parallel with Step 2 once Step 1 is complete.

```powershell
$ACR = "forgeacrprproddu"
az acr update --name $ACR --allow-exports true
az acr update --name $ACR --public-network-enabled true
az acr update --name $ACR --default-action Allow
```

**Verify:**
```powershell
az acr show --name $ACR --query publicNetworkAccess -o tsv
# Expected: Enabled
```

---

## Step 4 — Build Custom Images

```powershell
# Hive Metastore
az acr build --registry $ACR --image "hive-metastore:3.1.3" --file infra/docker/hive-metastore/Dockerfile .

# Spark
az acr build --registry $ACR --image "spark:4.1.1" --file infra/docker/spark/Dockerfile .

# Trino
az acr build --registry $ACR --image "trino:468" --file infra/docker/trino/Dockerfile infra/docker/trino/

# Airflow
az acr build --registry $ACR --image "airflow:3.1.8" --file infra/docker/airflow/Dockerfile infra/docker/airflow/
```

**Verify:**
```powershell
az acr repository list --name $ACR -o table
# Expected: airflow, hive-metastore, spark, trino all listed

az acr repository show-tags --name $ACR --repository hive-metastore -o table  # Expected: 3.1.3
az acr repository show-tags --name $ACR --repository spark            -o table  # Expected: 4.1.1
az acr repository show-tags --name $ACR --repository trino            -o table  # Expected: 468
az acr repository show-tags --name $ACR --repository airflow          -o table  # Expected: 3.1.8
```

---

## Step 5 — Import Third-Party Images

Spark Operator 2.x uses two separate images — controller and kubectl must both be imported:

```powershell
az acr import --name $ACR --source ghcr.io/kubeflow/spark-operator/controller:2.5.0 --image spark-operator-controller:2.5.0
az acr import --name $ACR --source ghcr.io/kubeflow/spark-operator/kubectl:2.5.0    --image spark-operator-kubectl:2.5.0
```

**Verify:**
```powershell
az acr repository show-tags --name $ACR --repository spark-operator-controller -o table
az acr repository show-tags --name $ACR --repository spark-operator-kubectl    -o table
# Expected: 2.5.0 in both
```

---

## Step 6 — Import Helm Charts into ACR

```powershell
$TOKEN = az acr login --name $ACR --expose-token --output tsv --query accessToken
$TOKEN | helm registry login "${ACR}.azurecr.io" --username 00000000-0000-0000-0000-000000000000 --password-stdin

helm pull spark-operator/spark-operator --version 2.5.0  --repo https://kubeflow.github.io/spark-operator
helm pull trino/trino                   --version 1.36.0 --repo https://trinodb.github.io/charts
helm pull apache-airflow/airflow        --version 1.20.0 --repo https://airflow.apache.org

helm push spark-operator-2.5.0.tgz oci://${ACR}.azurecr.io/helm
helm push trino-1.36.0.tgz          oci://${ACR}.azurecr.io/helm
helm push airflow-1.20.0.tgz        oci://${ACR}.azurecr.io/helm

Remove-Item spark-operator-*.tgz, trino-*.tgz, airflow-*.tgz
```

**Verify:**
```powershell
az acr repository list --name $ACR -o table
# Expected: helm/spark-operator, helm/trino, helm/airflow listed
```

---

## Step 7 — Lock ACR Back Down

```powershell
az acr update --name $ACR --default-action Deny
az acr update --name $ACR --public-network-enabled false
az acr update --name $ACR --allow-exports false
```

**Verify:**
```powershell
az acr show --name $ACR --query publicNetworkAccess -o tsv
# Expected: Disabled
```

---

## Step 8 — Get AKS Credentials

> Requires Step 2 complete.

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

**Verify:**
```powershell
kubectl get nodes --context forge-compute-dev
kubectl get nodes --context forge-orch-dev
# Expected: all nodes in Ready state
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

**Verify:**
```powershell
Write-Host "POSTGRES_HOST: $POSTGRES_HOST"
Write-Host "ADLS_ACCOUNT:  $ADLS_ACCOUNT"
Write-Host "HMS_NAME:      $HMS_NAME"
Write-Host "HMS_CLIENT_ID: $HMS_CLIENT_ID"
# Expected: all values non-empty
```

---

## Step 10 — Bootstrap Compute Cluster

Creates namespaces and workload identity service accounts:

```powershell
helm upgrade --install cluster-bootstrap infra/helm/compute/cluster-bootstrap `
  --create-namespace `
  --set workloadIdentity.spark.clientId=$SPARK_CLIENT_ID `
  --set workloadIdentity.trino.clientId=$TRINO_CLIENT_ID `
  --set workloadIdentity.hms.clientId=$HMS_CLIENT_ID `
  --kube-context forge-compute-dev
```

**Verify:**
```powershell
kubectl get namespaces --context forge-compute-dev
# Expected: spark-jobs, spark-system, trino, hive-metastore all present

kubectl get serviceaccounts -A --context forge-compute-dev | Select-String "spark|trino|hive"
# Expected: spark (spark-jobs), trino (trino), hive-metastore (hive-metastore)
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

**Verify:**
```powershell
kubectl get namespaces --context forge-orch-dev
# Expected: airflow, dq, portal, monitoring all present

kubectl get serviceaccounts -A --context forge-orch-dev | Select-String "airflow|dq|portal"
# Expected: airflow (airflow), dq-runner (dq), portal-api (portal)
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

**Verify:**
```powershell
kubectl get pods -n hive-metastore --context forge-compute-dev
# Expected: 1/1 Running

# Confirm HMS is accepting Thrift connections on port 9083
kubectl exec -n hive-metastore deploy/hive-metastore --context forge-compute-dev -- `
  /opt/hive/bin/hive --service metatool -listFSRoot
# Expected: prints warehouse root path, no errors
```

---

## Step 13 — Deploy Spark Operator

Images are pre-configured in `values.yaml` (dual-image 2.x architecture — no `--set image.*` needed):

```powershell
helm upgrade --install spark-operator `
  oci://${ACR}.azurecr.io/helm/spark-operator `
  --version 2.5.0 `
  --namespace spark-system `
  --values infra/helm/compute/spark-operator/values.yaml `
  --kube-context forge-compute-dev
```

**Verify:**
```powershell
kubectl get pods -n spark-system --context forge-compute-dev
# Expected: spark-operator-xxx 1/1 Running

kubectl get crd --context forge-compute-dev | Select-String "spark"
# Expected: sparkapplications, scheduledsparkapplications

# Submit a quick test job
kubectl apply --context forge-compute-dev -f - @"
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: spark-pi-test
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "${ACR}.azurecr.io/spark:4.1.1"
  imagePullPolicy: Always
  mainApplicationFile: "local:///opt/spark/examples/src/main/python/pi.py"
  sparkVersion: "4.1.1"
  restartPolicy:
    type: Never
  driver:
    cores: 1
    memory: "512m"
    serviceAccount: spark
  executor:
    cores: 1
    instances: 1
    memory: "512m"
"@

kubectl get sparkapplication spark-pi-test -n spark-jobs --context forge-compute-dev -w
# Expected final state: COMPLETED

kubectl delete sparkapplication spark-pi-test -n spark-jobs --context forge-compute-dev
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

**Verify:**
```powershell
kubectl get pods -n spark-system --context forge-compute-dev
# Expected: spark-connect-xxx 1/1 Running

kubectl get svc spark-connect-lb -n spark-system --context forge-compute-dev
# Expected: LoadBalancer with an EXTERNAL-IP assigned

# Test connection via port-forward (open a second terminal and leave running)
kubectl port-forward svc/spark-connect-lb 15002:15002 -n spark-system --context forge-compute-dev
```

Then in Python / notebook:
```python
from pyspark.sql import SparkSession
spark = SparkSession.builder.remote("sc://localhost:15002").getOrCreate()
spark.sql("SELECT 1 AS test").show()
# Expected: prints table with value 1
```

---

## Step 15 — Deploy Trino

```powershell
helm upgrade --install trino `
  oci://${ACR}.azurecr.io/helm/trino `
  --version 1.36.0 `
  --namespace trino `
  --values infra/helm/compute/trino/values.yaml `
  --set image.repository=${ACR}.azurecr.io/trino `
  --set image.tag=468 `
  --set "serviceAccount.annotations.azure\.workload\.identity/client-id=$TRINO_CLIENT_ID" `
  --kube-context forge-compute-dev
```

**Verify:**
```powershell
kubectl get pods -n trino --context forge-compute-dev
# Expected: coordinator 1/1 Running, 2x worker 1/1 Running

# Port-forward and run a test query
kubectl port-forward svc/trino 8080:8080 -n trino --context forge-compute-dev &
Start-Sleep 3

curl -s -X POST http://localhost:8080/v1/statement `
  -H "X-Trino-User: platform-test" `
  -H "X-Trino-Catalog: tpch" `
  -H "X-Trino-Schema: tiny" `
  -d "SELECT count(*) FROM orders"
# Expected: JSON response with queryId and data rows
```

---

## Readiness Checklist

Before proceeding to orchestration workloads (Airflow, DQ, Portal):

```
[ ] forge-shared: Succeeded
[ ] forge-dev: Succeeded
[ ] All custom images in ACR: hive-metastore:3.1.3, spark:4.1.1, trino:468, airflow:3.1.8
[ ] Spark Operator images in ACR: spark-operator-controller:2.5.0, spark-operator-kubectl:2.5.0
[ ] All 3 Helm charts in ACR: helm/spark-operator, helm/trino, helm/airflow
[ ] Both AKS clusters: all nodes Ready
[ ] Compute bootstrap: spark-jobs, spark-system, trino, hive-metastore namespaces present
[ ] Orch bootstrap: airflow, dq, portal, monitoring namespaces present
[ ] HMS pod: 1/1 Running, metatool listFSRoot succeeds
[ ] Spark Operator: Running, CRDs installed, spark-pi-test COMPLETED
[ ] Spark Connect: Running, port-forward SELECT 1 returns result
[ ] Trino: coordinator + 2 workers Running, tpch count(*) returns result
```

---

---

# Teardown Guide

Use these sections for test redeployments. Choose the scope that matches what needs to be reset.

---

## Teardown A — Helm Releases Only

Uninstall all workloads without touching ACR images or Azure infrastructure. Use this when you only need to redeploy Helm charts (Steps 10–15).

```powershell
# Compute cluster — workloads
helm uninstall trino          -n trino          --kube-context forge-compute-dev --ignore-not-found
helm uninstall spark-connect  -n spark-system   --kube-context forge-compute-dev --ignore-not-found
helm uninstall spark-operator -n spark-system   --kube-context forge-compute-dev --ignore-not-found
helm uninstall hive-metastore -n hive-metastore --kube-context forge-compute-dev --ignore-not-found

# Compute cluster — bootstrap (namespaces + service accounts)
helm uninstall cluster-bootstrap -n default --kube-context forge-compute-dev --ignore-not-found

# Orchestration cluster — bootstrap
helm uninstall cluster-bootstrap -n default --kube-context forge-orch-dev --ignore-not-found
```

**Verify:**
```powershell
kubectl get pods -A --context forge-compute-dev
# Expected: only kube-system pods remain

kubectl get namespaces --context forge-compute-dev
# spark-jobs, spark-system, trino, hive-metastore may persist (namespace deletion is separate)
```

To also delete the namespaces so bootstrap recreates them cleanly:
```powershell
kubectl delete namespace spark-jobs spark-system trino hive-metastore --context forge-compute-dev --ignore-not-found
kubectl delete namespace airflow dq portal monitoring               --context forge-orch-dev   --ignore-not-found
```

Resume from **Step 10**.

---

## Teardown B — ACR Images and Charts Only

Delete all repositories in ACR so Steps 4–7 run against a clean registry. Use this when you need to rebuild all images from scratch (e.g., version bump, Dockerfile fix).

```powershell
$ACR = "forgeacrprproddu"

# Open ACR for operations
az acr update --name $ACR --allow-exports true
az acr update --name $ACR --public-network-enabled true
az acr update --name $ACR --default-action Allow

# Delete every repository
az acr repository list --name $ACR -o tsv | ForEach-Object {
    Write-Host "Deleting $_"
    az acr repository delete --name $ACR --repository $_ --yes
}
```

**Verify:**
```powershell
az acr repository list --name $ACR -o table
# Expected: empty (no output)
```

Resume from **Step 4**. ACR is already open — skip Step 3.

---

## Teardown C — Full Environment (Keep ACR and Key Vault)

Delete both resource groups and redeploy all Azure infrastructure. ACR is shared and retained. Key Vault cannot be purged (purge protection enabled) — it soft-deletes but the name is reserved, so the Bicep redeploy will recover it.

> This takes 30–40 minutes total (delete + redeploy).

```powershell
# Delete resource groups (AKS, ADLS, PostgreSQL, identities, networking all go with them)
az group delete --name rg-forge-prproddu-dev --yes --no-wait
az group delete --name rg-forge-platform-prproddu-dev --yes --no-wait

# Monitor deletion progress
az group show --name rg-forge-prproddu-dev --query properties.provisioningState -o tsv
az group show --name rg-forge-platform-prproddu-dev --query properties.provisioningState -o tsv
# Wait until both return: ResourceGroupNotFound
```

Then resume from **Step 2** (skip Step 1 — ACR already exists).

If you also want a clean ACR, run **Teardown B** after the resource groups finish deleting, then resume from **Step 3**.

---

## Teardown D — Full Wipe Including ACR

Nuclear option — deletes everything. Only use this when you need to change the ACR name or subscription.

> Key Vault purge protection means the KV name will be reserved for 90 days after soft-delete.

```powershell
# Delete all environment resource groups
az group delete --name rg-forge-prproddu-dev          --yes --no-wait
az group delete --name rg-forge-platform-prproddu-dev --yes --no-wait

# Delete shared ACR resource group
az group delete --name rg-forge-acr-prproddu --yes --no-wait

# Monitor
az group list --query "[?starts_with(name,'rg-forge')].{name:name,state:properties.provisioningState}" -o table
# Wait until all groups are gone
```

Resume from **Step 1**.

---

## Quick Reference — What to Redo After Each Teardown

| Teardown | Redo Steps |
|----------|-----------|
| A — Helm only | 10 → 15 |
| B — ACR only | 4 → 7, then 10 → 15 |
| C — Infra (keep ACR) | 2, then 8 → 15 |
| C — Infra + ACR | 2, 3 → 7, then 8 → 15 |
| D — Full wipe | 1 → 15 |
