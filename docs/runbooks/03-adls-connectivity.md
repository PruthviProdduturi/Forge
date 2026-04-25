# Runbook: ADLS Connectivity Failures

> **Severity:** P1 (all pipelines failing, no data can be read or written)
> **Audience:** On-call platform engineer

---

## Overview

ADLS Gen2 connectivity issues typically manifest as one of:
- Spark jobs failing with `StorageException` or `403 Forbidden` reading/writing data
- Trino queries returning `No such file or directory` or `Access Denied`
- Portal health check showing ADLS as degraded

The most common causes are: workload identity misconfiguration, RBAC role assignment propagation delay, storage firewall rules, or a disruption to the AKS OIDC issuer.

---

## Quick Diagnosis

### 1. Check which layer is failing

```bash
# Run from inside the compute cluster — spin up a debug pod with managed identity
kubectl run adls-debug --rm -it \
  --image=mcr.microsoft.com/azure-cli \
  --restart=Never -n spark-jobs \
  --context forge-compute-dev \
  -- bash

# Inside the pod:
az login --identity
az storage blob list \
  --account-name forgestoragedev \
  --container-name bronze \
  --auth-mode login \
  --output table
```

If this fails with `403`, the managed identity does not have access to ADLS — likely a missing role assignment.

If this succeeds but Spark still fails, the issue is in the Spark/Delta layer, not identity.

---

### 2. Check workload identity binding

```bash
# Verify the service account has the workload identity annotation
kubectl get serviceaccount spark -n spark-jobs \
  --context forge-compute-dev \
  -o jsonpath='{.metadata.annotations}'
# Expected: {"azure.workload.identity/client-id": "<managed-identity-client-id>"}

# Verify the pod has the projected service account token
kubectl describe pod <spark-driver-pod> -n spark-jobs --context forge-compute-dev | \
  grep -A5 "projected"
# Expected: azure-identity-token volume present

# Verify the managed identity exists and has the right client ID
az identity show \
  --resource-group rg-forge-{alias}-dev \
  --name id-forge-spark-{alias}-dev \
  --query "{clientId: clientId, principalId: principalId}" \
  -o table
```

---

### 3. Check RBAC role assignments on the storage account

```bash
STORAGE_ID=$(az storage account show \
  --name forgestoragedev \
  --resource-group rg-forge-{alias}-dev \
  --query id -o tsv)

IDENTITY_PRINCIPAL=$(az identity show \
  --resource-group rg-forge-{alias}-dev \
  --name id-forge-spark-{alias}-dev \
  --query principalId -o tsv)

# Check if the managed identity has Storage Blob Data Contributor
az role assignment list \
  --assignee "$IDENTITY_PRINCIPAL" \
  --scope "$STORAGE_ID" \
  --query "[].{role:roleDefinitionName, scope:scope}" \
  -o table

# Expected output:
# Role                          Scope
# ----------------------------  ------------------------------------------------
# Storage Blob Data Contributor /subscriptions/.../storageAccounts/forgestoragedev
```

---

## Scenario 1: Missing Role Assignment

**Symptom:** Pod can authenticate (az login --identity succeeds) but storage operations return `403`.

**Fix:**

```bash
STORAGE_ID=$(az storage account show \
  --name forgestoragedev \
  --resource-group rg-forge-{alias}-dev \
  --query id -o tsv)

IDENTITY_PRINCIPAL=$(az identity show \
  --resource-group rg-forge-{alias}-dev \
  --name id-forge-spark-{alias}-dev \
  --query principalId -o tsv)

az role assignment create \
  --role "Storage Blob Data Contributor" \
  --assignee "$IDENTITY_PRINCIPAL" \
  --scope "$STORAGE_ID"
```

> Role assignments can take 5–15 minutes to propagate. Wait and retry.

---

## Scenario 2: Workload Identity Token Not Projected

**Symptom:** `az login --identity` fails inside the Spark pod with `AADSTS700016`.

```bash
# Check if workload identity webhook is running
kubectl get pods -n azure-workload-identity-system --context forge-compute-dev

# Check if the spark service account has the annotation
kubectl get sa spark -n spark-jobs --context forge-compute-dev -o yaml | grep azure.workload
```

**Fix — missing annotation on service account:**

```bash
kubectl annotate serviceaccount spark \
  -n spark-jobs \
  --context forge-compute-dev \
  azure.workload.identity/client-id="<managed-identity-client-id>"
```

Get the client ID:

```bash
az identity show \
  --resource-group rg-forge-{alias}-dev \
  --name id-forge-spark-{alias}-dev \
  --query clientId -o tsv
```

After annotating, any new pods will get the token. Existing running pods will not — re-trigger the Spark job.

---

## Scenario 3: Storage Firewall Blocking Access

**Symptom:** Intermittent `403` or `timeout` errors, especially from outside the VNet (e.g., your laptop via Spark Connect).

```bash
# Check storage firewall config
az storage account show \
  --name forgestoragedev \
  --resource-group rg-forge-{alias}-dev \
  --query networkRuleSet \
  -o json
```

If `defaultAction` is `Deny`, only the VNet subnets listed in `virtualNetworkRules` have access. AKS node pools should already be listed (Bicep sets this up). If a new node pool was added without a VNet rule, add it:

```bash
# Get the subnet ID for the AKS node pool
SUBNET_ID=$(az aks show \
  --resource-group rg-forge-{alias}-dev \
  --name aks-forge-compute-{alias}-dev \
  --query "agentPoolProfiles[0].vnetSubnetId" -o tsv)

az storage account network-rule add \
  --account-name forgestoragedev \
  --resource-group rg-forge-{alias}-dev \
  --subnet "$SUBNET_ID"
```

---

## Scenario 4: ADLS Container Does Not Exist

**Symptom:** Job fails with `BlobNotFound` or `ContainerNotFound` on a specific container (e.g., `bronze`, `silver`, `gold`, `raw`, `code`).

```bash
# List containers
az storage container list \
  --account-name forgestoragedev \
  --auth-mode login \
  --query "[].name" \
  -o tsv
```

**Required containers:** `bronze`, `silver`, `gold`, `sandbox`, `code`
> Checkpoints live under `code/checkpoints/<pipeline_id>/` — no separate container.

**Fix — recreate missing container:**

```bash
for container in bronze silver gold sandbox code; do
  az storage container create \
    --account-name forgestoragedev \
    --name "$container" \
    --auth-mode login
done
```

> Container creation is idempotent — running this on an existing container does nothing.

---

## Trino Cannot Read Delta Tables

If Trino queries fail but Spark succeeds, the issue is in Trino's HMS (Hive Metastore) or Delta connector, not ADLS access directly.

```bash
# Check HMS pod
kubectl get pods -n hive --context forge-compute-dev

# Check Trino coordinator logs
kubectl logs -n trino --context forge-compute-dev \
  -l app=trino-coordinator --tail=100 | grep -i "error\|exception\|failed"
```

Common cause: HMS lost the Delta table location after a storage restructure. Fix by re-registering the table:

```sql
-- In Trino: drop and recreate the external table registration
DROP TABLE IF EXISTS lakehouse.bronze.nyc_taxi_raw;

CREATE TABLE lakehouse.bronze.nyc_taxi_raw (
  -- columns ...
)
WITH (
  format = 'DELTA',
  location = 'abfss://bronze@forgestoragedev.dfs.core.windows.net/Transport/Trip/Internal/Rideshare/NycTaxi/1/NycTaxiBronze'
);
```

---

## Related Architecture

- [Storage Architecture](../architecture/03-storage.md) — ADLS layout, container roles, access patterns
- [Compute Architecture](../architecture/06-compute.md) — Workload identity setup for Spark
