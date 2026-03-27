# Forge — AKS Cluster Setup Guide

> **Document:** 03 — AKS Cluster Provisioning and Bootstrap
> **Version:** 1.0
> **Status:** Production
> **Audience:** Platform engineers
> **Last updated:** 2026-03-24

[![Bicep](https://img.shields.io/badge/Bicep-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/) [![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io)

---

## Table of Contents

- [Part 1 — Prerequisites](#part-1--prerequisites)
- [Part 2 — Bicep Provisioning](#part-2--bicep-provisioning)
- [Part 3 — Compute Cluster Bootstrap](#part-3--compute-cluster-bootstrap)
- [Part 4 — Orchestration Cluster Bootstrap](#part-4--orchestration-cluster-bootstrap)
- [Part 5 — Cross-Cluster Validation](#part-5--cross-cluster-validation)

---

## Part 1 — Prerequisites

### 1.1 Azure CLI Extensions

```bash
# Update CLI itself first
az upgrade --yes

# k8s-extension is needed for Container Insights and Azure Policy add-ons
az extension add --name k8s-extension --upgrade

# Verify
az extension list --query "[?name=='k8s-extension'].{name:name, version:version}" -o table
```

> **Note:** Do NOT install `aks-preview`. It has a known bug where `az aks command invoke` returns
> `Operation returned an invalid status 'OK'` and breaks other AKS commands. The clusters are public
> — no preview features are required.

### 1.2 Provider Registration

Register the required resource providers. This is a one-time operation per subscription.

```bash
az provider register --namespace Microsoft.ContainerService
az provider register --namespace Microsoft.Network
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.KeyVault
az provider register --namespace Microsoft.ManagedIdentity
```

### 1.3 Subscription-Level vCPU Quota Verification

The Forge clusters use `Standard_E8s_v5` (Spark node pool) and `Standard_E16s_v5` (Trino node pool) in the primary region. Verify the subscription has sufficient quota before attempting cluster creation — insufficient quota causes silent failures or partial scale-up.

```bash
LOCATION="northcentralus"

# Check Standard Esv5 Family quota
az vm list-usage \
  --location "${LOCATION}" \
  --query "[?name.value=='standardESv5Family'].{name:name.localizedValue, current:currentValue, limit:limit}" \
  -o table

# Check Standard DSv5 Family quota (system and airflow node pools)
az vm list-usage \
  --location "${LOCATION}" \
  --query "[?name.value=='standardDSv5Family'].{name:name.localizedValue, current:currentValue, limit:limit}" \
  -o table

# Check total regional vCPU limit
az vm list-usage \
  --location "${LOCATION}" \
  --query "[?name.value=='cores'].{name:name.localizedValue, current:currentValue, limit:limit}" \
  -o table
```

**Required minimums:**

| VM Family | Node Pool | Max nodes | vCPUs/node | vCPUs required |
|-----------|-----------|-----------|------------|----------------|
| Standard_E8s_v5 | sparkpool (compute) | 5 (dev) / 20 (prod) | 8 | 40 dev / 160 prod |
| Standard_D4s_v5 | trinopool (compute) | 3 (dev) / 10 (prod) | 4 | 12 dev / 40 prod |
| Standard_D4s_v5 | systempool (both clusters) | 2 per cluster | 4 | 16 |
| Standard_D4s_v5 | workerpool (orch) | 3 (dev) / 10 (prod) | 4 | 12 dev / 40 prod |

Total: approximately 408 vCPUs in `StandardESv5Family` + `StandardDSv5Family` combined, plus buffer.

If the quota is insufficient, raise a support request:

```bash
az support tickets create \
  --ticket-name "Forge platform vCPU quota increase ${LOCATION}" \
  --title "vCPU quota increase request for Forge data platform" \
  --description "Requesting Standard ESv5 Family quota increase to 200 vCPUs and Standard DSv5 to 150 vCPUs in East US for the Forge data platform deployment." \
  --problem-classification "/providers/Microsoft.Support/services/quota/problemClassifications/CoresQuotaIncrease" \
  --severity "moderate" \
  --contact-first-name "Platform" \
  --contact-last-name "Engineering" \
  --contact-email "platform@yourorg.com" \
  --contact-country "USA" \
  --contact-phone "555-0100" \
  --contact-timezone "Pacific Standard Time"
```

### 1.4 Tool Versions on the Operator Workstation

```bash
# Verify all tools are present
kubectl version --client  # >= 1.29
helm version              # >= 3.14
kubelogin --version       # >= 0.1.3 (required for AAD auth on AKS)
```

Install `kubelogin` if missing:

```bash
az aks install-cli
```

---

## Part 2 — Bicep Provisioning

### 2.1 Repository Layout

The Forge Bicep configuration is in `infra/bicep/`. The relevant files are:

```
infra/bicep/
├── environments/
│   ├── dev/
│   │   ├── main.bicep
│   │   └── dev.parameters.json
│   └── prod/
│       ├── main.bicep
│       └── dev.parameters.json
└── modules/
    ├── networking.bicep
    ├── identity.bicep
    ├── storage.bicep
    ├── keyvault.bicep
    └── aks.bicep
```

The root template (`main.bicep`) is subscription-scoped and orchestrates all modules in dependency order. A single deployment provisions all resource groups and resources — no manual ordering required.

### 2.2 Parameter File

Edit `infra/bicep/environments/{env}/dev.parameters.json` with your values. All parameters are in this single file — `main.bicep` has no hardcoded environment values.

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "environment":                { "value": "dev" },
    "location":                   { "value": "northcentralus" },
    "tenantId":                   { "value": "<your-tenant-id>" },
    "adminGroupObjectIds":        { "value": ["<aks-admin-group-object-id>"] },
    "platformAdminGroupObjectId": { "value": "<platform-admin-group-object-id>" },
    "ownerAlias":                 { "value": "<your-alias>" },
    "logRetentionDays":           { "value": 90 },
    "kubernetesVersion":          { "value": "1.32" },
    "storageReplicationType":     { "value": "LRS" },
    "tags":                       { "value": { "owner": "platform-team" } },
    "computeSystemVmSize":        { "value": "Standard_D4s_v5" },
    "computeSystemNodeCount":     { "value": 1 },
    "sparkVmSize":                { "value": "Standard_E8s_v5" },
    "sparkMaxNodes":              { "value": 5 },
    "trinoVmSize":                { "value": "Standard_D4s_v5" },
    "trinoMaxNodes":              { "value": 3 },
    "orchSystemVmSize":           { "value": "Standard_D4s_v5" },
    "orchSystemNodeCount":        { "value": 1 },
    "orchWorkerVmSize":           { "value": "Standard_D4s_v5" },
    "orchWorkerMaxNodes":         { "value": 3 }
  }
}
```

### 2.3 Validate — `az bicep build`

Validate the template compiles cleanly before deploying:

```bash
ENV="prod"

az bicep build --file infra/bicep/environments/${ENV}/main.bicep
```

No output means the template is valid. Errors appear inline with line numbers.

### 2.4 What-If — Review Changes Before Applying

Run a what-if to see exactly what will be created or modified:

```bash
az deployment sub what-if \
  --location northcentralus \
  --template-file infra/bicep/environments/${ENV}/main.bicep \
  --parameters @infra/bicep/environments/${ENV}/dev.parameters.json \
  --name forge-${ENV}
```

Before approving the output, review:

**Networking** — verify subnet CIDRs match the documented topology (`10.1.0.0/16` compute, `10.2.0.0/16` orchestration, `10.3.0.0/24` private endpoints). Any deviation means a parameter was set incorrectly.

**Identity** — confirm each workload managed identity is created with federated credentials pointing to the correct AKS OIDC issuer.

**Storage** — confirm ADLS Gen2 account has HNS enabled, public network access disabled, and the correct containers: `bronze`, `silver`, `gold`, `code`, `checkpoints`.

**Key Vault** — confirm purge protection enabled, soft-delete retention 90 days, default action Deny.

**AKS clusters** — confirm public cluster (`enablePrivateCluster: false`), workload identity enabled, OIDC issuer enabled, node pool VM sizes and counts match the architecture document. Note: `enablePrivateCluster` is immutable — if it needs changing, the cluster must be deleted and recreated.

### 2.5 Deploy

A single command deploys all resources. Bicep resolves inter-module dependencies automatically.

```bash
az deployment sub create \
  --location northcentralus \
  --template-file infra/bicep/environments/${ENV}/main.bicep \
  --parameters @infra/bicep/environments/${ENV}/dev.parameters.json \
  --name forge-${ENV} \
  --verbose
```

This step takes 20–30 minutes. AKS cluster provisioning is the longest step.

If a module fails mid-deployment, re-run the same command after fixing the problem. Bicep deployments are idempotent — resources that already exist in the expected state are skipped.

### 2.6 Expected Outputs After Deployment

```bash
az deployment sub show \
  --name forge-${ENV} \
  --query properties.outputs \
  -o yaml
```

Expected output (values will differ by environment):

```yaml
computeClusterName:
  value: aks-forge-compute-prod
computeOidcIssuerUrl:
  value: https://northcentralus.oic.prod-aks.azure.com/<tenant-id>/<cluster-id>/
orchClusterName:
  value: aks-forge-orchestration-prod
orchOidcIssuerUrl:
  value: https://northcentralus.oic.prod-aks.azure.com/<tenant-id>/<cluster-id-2>/
storageAccountName:
  value: forgeadlsprod
keyVaultUri:
  value: https://kv-forge-prod.vault.azure.net/
workloadIdentities:
  value:
    spark:
      clientId: <guid>
    trino:
      clientId: <guid>
    airflow:
      clientId: <guid>
    portal:
      clientId: <guid>
```

Store these values — you will need them throughout the cluster bootstrap sections.

---

## Part 3 — Compute Cluster Bootstrap

All commands in this section target the **compute cluster** (`aks-forge-compute-{env}`).

### 3.1 Get kubeconfig

```bash
ENV="prod"

ALIAS="prproddu"   # set to your ownerAlias, or empty for shared envs

az aks get-credentials \
  --name "aks-forge-compute-${ALIAS}-${ENV}" \
  --resource-group "rg-forge-${ALIAS}-${ENV}" \
  --context "forge-compute-${ENV}" \
  --overwrite-existing

# Convert to kubelogin format (required for AAD auth on AKS)
kubelogin convert-kubeconfig \
  --login azurecli \
  --context "forge-compute-${ENV}"
```

### 3.2 Verify Connectivity

```bash
kubectl --context "forge-compute-${ENV}" get nodes -o wide
```

Expected output shows nodes in `Ready` state:

```
NAME                              STATUS   ROLES    AGE   VERSION    INTERNAL-IP   OS-IMAGE
aks-systempool-00000000-vmss000000    Ready    <none>   8m    v1.32.x    10.1.1.4      Azure Linux
aks-systempool-00000000-vmss000001    Ready    <none>   8m    v1.32.x    10.1.1.5      Azure Linux
```

The spark and trino node pools start with 0 nodes (autoscaler manages them) so only system pool nodes appear initially.

Set the context for the rest of Part 3:

```bash
kubectl config use-context "forge-compute-${ENV}"
# For brevity, remaining commands in Part 3 omit --context
```

### 3.3 Install CSI Secrets Store Driver and Azure Key Vault Provider

```bash
helm repo add secrets-store-csi-driver \
  https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm repo update

helm upgrade --install csi-secrets-store \
  secrets-store-csi-driver/secrets-store-csi-driver \
  --namespace kube-system \
  --version 1.4.4 \
  --set syncSecret.enabled=true \
  --set enableSecretRotation=true \
  --set rotationPollInterval=2m \
  --set nodeSelector."kubernetes\\.io/os"=linux \
  --wait

# Azure Key Vault provider
helm repo add csi-secrets-store-provider-azure \
  https://azure.github.io/secrets-store-csi-driver-provider-azure/charts
helm repo update

helm upgrade --install csi-azure-kv \
  csi-secrets-store-provider-azure/csi-secrets-store-provider-azure \
  --namespace kube-system \
  --version 1.5.3 \
  --set linux.enabled=true \
  --set windows.enabled=false \
  --wait
```

Verify:

```bash
kubectl get pods -n kube-system \
  -l app=secrets-store-csi-driver

kubectl get pods -n kube-system \
  -l app=csi-secrets-store-provider-azure
```

Both should show all pods `Running`.

### 3.4 Install Azure Workload Identity Webhook

The workload identity webhook mutates pods annotated with `azure.workload.identity/use: "true"` to inject the OIDC token volume and environment variables that the Azure SDK picks up automatically.

```bash
helm repo add azure-workload-identity \
  https://azure.github.io/azure-workload-identity/charts
helm repo update

TENANT_ID=$(az account show --query tenantId -o tsv)

helm upgrade --install workload-identity-webhook \
  azure-workload-identity/workload-identity-webhook \
  --namespace azure-workload-identity-system \
  --create-namespace \
  --version 1.3.0 \
  --set azureTenantID="${TENANT_ID}" \
  --wait
```

Verify:

```bash
kubectl get pods -n azure-workload-identity-system
```

Expected: `azure-wi-webhook-controller-manager-*` pods in `Running` state.

### 3.5 Install Calico Network Policies

If the AKS cluster was provisioned with `networkPolicy: calico` in Bicep (which is the Forge default), Calico is already installed. Verify:

```bash
kubectl get pods -n kube-system -l k8s-app=calico-node
```

If not installed (e.g., networking module used `azure` CNI without network policy), install manually:

```bash
kubectl apply -f \
  https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml

# Wait for Calico pods to become ready
kubectl rollout status daemonset/calico-node -n kube-system --timeout=120s
```

### 3.6 Bootstrap Namespaces and Service Accounts

All namespaces and workload identity service accounts are created by the `cluster-bootstrap` Helm chart. This is idempotent — safe to re-run.

```bash
# Retrieve workload identity client IDs from Bicep deployment outputs
$IDS = az deployment sub show --name forge-${ENV} `
  --query properties.outputs.workloadIdentities.value -o json | ConvertFrom-Json

helm upgrade --install cluster-bootstrap infra/helm/compute/cluster-bootstrap `
  --create-namespace --namespace kube-system `
  --set workloadIdentity.spark.clientId=$IDS.spark.clientId `
  --set workloadIdentity.trino.clientId=$IDS.trino.clientId `
  --set workloadIdentity.hms.clientId=$IDS.hms.clientId

# Verify
kubectl get namespaces | grep -E "spark|trino|hive"
kubectl get serviceaccounts -n spark-jobs
kubectl get serviceaccounts -n trino
kubectl get serviceaccounts -n hive-metastore
```

### 3.7 Apply ResourceQuota and LimitRange for spark-jobs

The `spark-jobs` namespace is where Spark driver and executor pods run. ResourceQuota and LimitRange prevent a runaway job from consuming the entire cluster and ensure pods always declare resource requests (required for the scheduler to make correct placement decisions).

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: ResourceQuota
metadata:
  name: spark-jobs-quota
  namespace: spark-jobs
spec:
  hard:
    requests.cpu: "160"
    requests.memory: "640Gi"
    limits.cpu: "200"
    limits.memory: "800Gi"
    pods: "220"
    persistentvolumeclaims: "50"
EOF

cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: LimitRange
metadata:
  name: spark-jobs-limits
  namespace: spark-jobs
spec:
  limits:
  - type: Container
    default:
      cpu: "2"
      memory: "4Gi"
    defaultRequest:
      cpu: "500m"
      memory: "1Gi"
    max:
      cpu: "16"
      memory: "128Gi"
    min:
      cpu: "100m"
      memory: "256Mi"
  - type: Pod
    max:
      cpu: "32"
      memory: "256Gi"
EOF
```

### 3.8 Service Accounts

Service accounts are created by the `cluster-bootstrap` Helm chart in §3.6 above — no manual step required.

### 3.9 Create SecretProviderClass for Each Workload

SecretProviderClass tells the CSI driver which Key Vault secrets to mount into a pod. Create one per workload.

```bash
KV_NAME="kv-forge-${ENV}"
TENANT_ID=$(az account show --query tenantId -o tsv)

# Spark SecretProviderClass
cat <<EOF | kubectl apply -f -
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: spark-secrets
  namespace: spark-jobs
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    useVMManagedIdentity: "false"
    clientID: "${SPARK_MI_CLIENT_ID}"
    keyvaultName: "${KV_NAME}"
    tenantId: "${TENANT_ID}"
    objects: |
      array:
        - |
          objectName: spark-adls-account-name
          objectType: secret
          objectVersion: ""
        - |
          objectName: spark-adls-container-bronze
          objectType: secret
          objectVersion: ""
        - |
          objectName: spark-adls-container-silver
          objectType: secret
          objectVersion: ""
        - |
          objectName: spark-adls-container-gold
          objectType: secret
          objectVersion: ""
  secretObjects:
  - secretName: spark-adls-config
    type: Opaque
    data:
    - objectName: spark-adls-account-name
      key: accountName
    - objectName: spark-adls-container-bronze
      key: bronzeContainer
    - objectName: spark-adls-container-silver
      key: silverContainer
    - objectName: spark-adls-container-gold
      key: goldContainer
EOF

# Trino SecretProviderClass
cat <<EOF | kubectl apply -f -
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: trino-secrets
  namespace: trino
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    useVMManagedIdentity: "false"
    clientID: "${TRINO_MI_CLIENT_ID}"
    keyvaultName: "${KV_NAME}"
    tenantId: "${TENANT_ID}"
    objects: |
      array:
        - |
          objectName: trino-hive-metastore-uri
          objectType: secret
          objectVersion: ""
        - |
          objectName: trino-adls-account-name
          objectType: secret
          objectVersion: ""
  secretObjects:
  - secretName: trino-config
    type: Opaque
    data:
    - objectName: trino-hive-metastore-uri
      key: hiveMetastoreUri
    - objectName: trino-adls-account-name
      key: adlsAccountName
EOF
```

### 3.10 Verify Workload Identity — Test Pod

Before installing workloads, verify that a pod annotated with the spark identity can authenticate to ADLS.

```bash
ADLS_ACCOUNT=$(az deployment sub show --name forge-${ENV} \
  --query "properties.outputs.storageAccountName.value" -o tsv)

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: wi-test-spark
  namespace: spark-jobs
  labels:
    azure.workload.identity/use: "true"
spec:
  serviceAccountName: spark
  containers:
  - name: test
    image: "forgeacr${ALIAS}.azurecr.io/spark:4.1.1"
    command:
    - /bin/bash
    - -c
    - |
      python3 -c "
      from azure.identity import WorkloadIdentityCredential
      from azure.storage.filedatalake import DataLakeServiceClient

      cred = WorkloadIdentityCredential()
      token = cred.get_token('https://storage.azure.com/.default')
      print('Token acquired, expires:', token.expires_on)

      client = DataLakeServiceClient(
          account_url='https://${ADLS_ACCOUNT}.dfs.core.windows.net',
          credential=cred
      )
      fs = client.get_file_system_client('bronze')
      props = fs.get_file_system_properties()
      print('ADLS bronze container accessible, etag:', props['etag'])
      print('WORKLOAD IDENTITY TEST: PASSED')
      "
    resources:
      requests:
        cpu: "200m"
        memory: "256Mi"
  restartPolicy: Never
  nodeSelector:
    agentpool: spark
  tolerations:
  - key: "workload"
    operator: "Equal"
    value: "spark"
    effect: "NoSchedule"
EOF

# Wait for pod to complete
kubectl wait pod/wi-test-spark \
  --namespace spark-jobs \
  --for=condition=Ready \
  --timeout=120s

kubectl logs wi-test-spark -n spark-jobs --follow

# Clean up
kubectl delete pod wi-test-spark -n spark-jobs
```

Expected log output ends with `WORKLOAD IDENTITY TEST: PASSED`. If the test fails:
- Check the federated credential on the managed identity matches this cluster's OIDC issuer URL
- Check the ServiceAccount name and namespace match the federated credential subject (`system:serviceaccount:spark-jobs:spark`)
- Check the managed identity has `Storage Blob Data Contributor` on the ADLS account

### 3.11 Install Spark Operator

```bash
helm repo add spark-operator \
  https://kubeflow.github.io/spark-operator
helm repo update

ACR_SERVER="forgeacr${ALIAS}.azurecr.io"

helm upgrade --install spark-operator \
  spark-operator/spark-operator \
  --namespace spark-system \
  --create-namespace \
  --version 1.4.6 \
  --set image.repository="${ACR_SERVER}/spark-operator" \
  --set image.tag="1.4.6" \
  --set webhook.enable=true \
  --set webhook.port=8080 \
  --set metrics.enable=true \
  --set metrics.port=10254 \
  --set metrics.endpoint=/metrics \
  --set metrics.prefix=forge_spark \
  --set sparkJobNamespace=spark-jobs \
  --set serviceAccounts.spark.name=spark \
  --set serviceAccounts.spark.create=false \
  --set serviceAccounts.sparkoperator.name=spark-operator \
  --set serviceAccounts.sparkoperator.create=false \
  --set controllerThreads=10 \
  --set resyncInterval=30 \
  --set logLevel=2 \
  --set nodeSelector.agentpool=system \
  --wait \
  --timeout=5m
```

**Key values explained:**

- `sparkJobNamespace=spark-jobs` — Operator only watches for SparkApplication CRDs in this namespace. Jobs submitted to other namespaces are ignored.
- `serviceAccounts.spark.create=false` — We created `spark` manually with workload identity annotations. If the operator creates a new SA without those annotations, workload identity will not work.
- `metrics.enable=true` — Exposes a Prometheus-compatible `/metrics` endpoint. The Azure Monitor Agent (AMA) scrapes this endpoint via the custom scrape ConfigMap.
- `webhook.enable=true` — Required for the operator to mutate SparkApplication specs (injecting node affinity, tolerations, and workload identity annotations on driver/executor pods).

### 3.12 Verify Spark Operator

```bash
kubectl get pods -n spark-system

# Expected:
# NAME                                        READY   STATUS    RESTARTS
# spark-operator-<hash>                       1/1     Running   0
# spark-operator-webhook-<hash>               1/1     Running   0

# Verify CRD was installed
kubectl get crd sparkapplications.sparkoperator.k8s.io
kubectl get crd scheduledsparkapplications.sparkoperator.k8s.io

# Verify webhook is registered
kubectl get mutatingwebhookconfigurations \
  -l app.kubernetes.io/name=spark-operator
```

### 3.13 Apply Calico Network Policies for Compute Cluster

```bash
# Allow spark-jobs pods to egress to ADLS, Key Vault, and ACR via private endpoints
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: spark-jobs-egress
  namespace: spark-jobs
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  # Allow DNS
  - ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
  # Allow egress to private endpoints subnet (ADLS, KV, ACR)
  - to:
    - ipBlock:
        cidr: 10.3.0.0/24
  # Allow inter-pod communication within spark-jobs (driver <-> executor)
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: spark-jobs
  # Allow to Kubernetes API server (public endpoint)
  - to:
    - ipBlock:
        cidr: 10.3.0.11/32
    ports:
    - protocol: TCP
      port: 443
EOF

# Allow trino pods to egress to ADLS and Hive Metastore
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: trino-egress
  namespace: trino
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
  - to:
    - ipBlock:
        cidr: 10.3.0.0/24
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: trino
EOF

# Allow orchestration cluster to reach compute cluster API server
# (Airflow submits SparkApplication CRDs from the orchestration cluster)
cat <<'EOF' | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-orch-cluster-api-access
  namespace: spark-jobs
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - ipBlock:
        cidr: 10.2.0.0/16
    ports:
    - protocol: TCP
      port: 443
EOF
```

---

## Part 4 — Orchestration Cluster Bootstrap

All commands in this section target the **orchestration cluster** (`aks-forge-orchestration-{alias}-{env}`).

### 4.1 Get kubeconfig

```bash
az aks get-credentials \
  --name "aks-forge-orchestration-${ALIAS}-${ENV}" \
  --resource-group "rg-forge-${ALIAS}-${ENV}" \
  --context "forge-orch-${ENV}" \
  --overwrite-existing

kubelogin convert-kubeconfig \
  --login azurecli \
  --context "forge-orch-${ENV}"

kubectl config use-context "forge-orch-${ENV}"
```

Verify:

```bash
kubectl get nodes -o wide
```

### 4.2 Install CSI Secrets Store Driver and Workload Identity Webhook

Run the same commands as in sections 3.3 and 3.4, but targeting the orchestration cluster context. Since `kubectl config use-context` is already set to `forge-orch-${ENV}`, the commands are identical:

```bash
helm upgrade --install csi-secrets-store \
  secrets-store-csi-driver/secrets-store-csi-driver \
  --namespace kube-system \
  --version 1.4.4 \
  --set syncSecret.enabled=true \
  --set enableSecretRotation=true \
  --set rotationPollInterval=2m \
  --set nodeSelector."kubernetes\\.io/os"=linux \
  --wait

helm upgrade --install csi-azure-kv \
  csi-secrets-store-provider-azure/csi-secrets-store-provider-azure \
  --namespace kube-system \
  --version 1.5.3 \
  --set linux.enabled=true \
  --set windows.enabled=false \
  --wait

helm upgrade --install workload-identity-webhook \
  azure-workload-identity/workload-identity-webhook \
  --namespace azure-workload-identity-system \
  --create-namespace \
  --version 1.3.0 \
  --set azureTenantID="${TENANT_ID}" \
  --wait
```

### 4.3 Bootstrap Namespaces and Service Accounts

```bash
$IDS = az deployment sub show --name forge-${ENV} `
  --query properties.outputs.workloadIdentities.value -o json | ConvertFrom-Json

helm upgrade --install cluster-bootstrap infra/helm/orchestration/cluster-bootstrap `
  --create-namespace --namespace kube-system `
  --set workloadIdentity.airflow.clientId=$IDS.airflow.clientId `
  --set workloadIdentity.dq.clientId=$IDS.dq.clientId `
  --set workloadIdentity.portal.clientId=$IDS.portal.clientId

# Verify
kubectl get namespaces | grep -E "airflow|dq|portal|monitoring"
kubectl get serviceaccounts -n airflow
kubectl get serviceaccounts -n portal
```

### 4.4 Service Accounts

Service accounts are created by the `cluster-bootstrap` Helm chart in §4.3 above — no manual step required.

### 4.5 Create SecretProviderClasses

```bash
KV_NAME="kv-forge-${ENV}"

# Airflow SecretProviderClass
cat <<EOF | kubectl apply -f -
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: airflow-secrets
  namespace: airflow
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    useVMManagedIdentity: "false"
    clientID: "${AIRFLOW_MI_CLIENT_ID}"
    keyvaultName: "${KV_NAME}"
    tenantId: "${TENANT_ID}"
    objects: |
      array:
        - |
          objectName: airflow-db-connection-string
          objectType: secret
          objectVersion: ""
        - |
          objectName: airflow-fernet-key
          objectType: secret
          objectVersion: ""
        - |
          objectName: airflow-webserver-secret-key
          objectType: secret
          objectVersion: ""
        - |
          objectName: airflow-git-sync-ssh-key
          objectType: secret
          objectVersion: ""
  secretObjects:
  - secretName: airflow-config-secrets
    type: Opaque
    data:
    - objectName: airflow-db-connection-string
      key: connectionString
    - objectName: airflow-fernet-key
      key: fernetKey
    - objectName: airflow-webserver-secret-key
      key: webserverSecretKey
    - objectName: airflow-git-sync-ssh-key
      key: gitSyncSshKey
EOF

# Portal SecretProviderClass
cat <<EOF | kubectl apply -f -
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: portal-secrets
  namespace: portal
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    useVMManagedIdentity: "false"
    clientID: "${PORTAL_MI_CLIENT_ID}"
    keyvaultName: "${KV_NAME}"
    tenantId: "${TENANT_ID}"
    objects: |
      array:
        - |
          objectName: portal-aad-client-id
          objectType: secret
          objectVersion: ""
        - |
          objectName: portal-aad-client-secret
          objectType: secret
          objectVersion: ""
  secretObjects:
  - secretName: portal-aad-config
    type: Opaque
    data:
    - objectName: portal-aad-client-id
      key: clientId
    - objectName: portal-aad-client-secret
      key: clientSecret
EOF
```

### 4.6 Store Compute Cluster kubeconfig in Key Vault

Airflow uses the `SparkKubernetesOperator` to submit `SparkApplication` CRDs to the compute cluster. To do this, it needs a kubeconfig for the compute cluster's API server. Store it in Key Vault so it is never in plaintext in a ConfigMap or environment variable.

```bash
# Get the compute cluster kubeconfig (not the kubelogin-converted one — the raw one)
az aks get-credentials \
  --name "aks-forge-compute-${ALIAS}-${ENV}" \
  --resource-group "rg-forge-${ALIAS}-${ENV}" \
  --file /tmp/compute-kubeconfig.yaml \
  --overwrite-existing

# Verify it points to the public API server FQDN:
cat /tmp/compute-kubeconfig.yaml | grep server

# Store in Key Vault
az keyvault secret set \
  --vault-name "${KV_NAME}" \
  --name "compute-cluster-kubeconfig" \
  --file /tmp/compute-kubeconfig.yaml

# Securely delete the local copy
shred -u /tmp/compute-kubeconfig.yaml
```

Airflow retrieves this secret at runtime via the Key Vault secrets backend. The `KubernetesHook` in Airflow is configured to use this connection:

```python
# In Airflow, connection ID: compute_cluster_k8s
# Connection type: Kubernetes
# Extra: {"kube_config": "{{ conn.compute_cluster_kubeconfig.password }}" }
```

### 4.7 Enable Container Insights Add-on (Azure Monitor / Container Insights)

The Container Insights add-on installs the Azure Monitor Agent (AMA) as a DaemonSet and wires both clusters to the Azure Monitor Workspace and Log Analytics Workspace. No Helm chart, no PVC, no self-hosted pods.

```bash
# Enable Container Insights on the orchestration cluster
az aks enable-addons \
  --resource-group rg-forge-prod \
  --name aks-forge-orchestration-prod \
  --addons monitoring \
  --workspace-resource-id "/subscriptions/${SUB_ID}/resourceGroups/rg-forge-platform-prod/providers/Microsoft.OperationalInsights/workspaces/law-forge-prod"

# Enable Container Insights on the compute cluster
az aks enable-addons \
  --resource-group rg-forge-prod \
  --name aks-forge-compute-prod \
  --addons monitoring \
  --workspace-resource-id "/subscriptions/${SUB_ID}/resourceGroups/rg-forge-platform-prod/providers/Microsoft.OperationalInsights/workspaces/law-forge-prod"
```

Configure the AMA to scrape custom Prometheus-compatible `/metrics` endpoints (Spark, Trino, Airflow, Portal) via a ConfigMap:

```bash
kubectl apply -f - <<'EOF'
kind: ConfigMap
apiVersion: v1
metadata:
  name: ama-metrics-prometheus-config
  namespace: kube-system
data:
  prometheus-config: |
    global:
      scrape_interval: 15s
    scrape_configs:
      - job_name: spark-operator
        static_configs:
          - targets: ['spark-operator.spark-system.svc.cluster.local:10254']
      - job_name: kubernetes-pods
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
            action: keep
            regex: true
EOF
```

Verify the AMA DaemonSet is running:

```bash
kubectl get pods -n kube-system -l component=ama-metrics
# ama-metrics-xxx   2/2   Running  (one per node)

# Verify metrics are flowing to Azure Monitor
az monitor metrics list \
  --resource "/subscriptions/${SUB_ID}/resourceGroups/rg-forge-prod/providers/Microsoft.ContainerService/managedClusters/aks-forge-orchestration-prod" \
  --metric "node_cpu_usage_percentage" \
  --output table
```

### 4.8 Provision Azure Managed Grafana

Azure Managed Grafana is provisioned via Bicep (not Helm). This step verifies it is accessible.

```bash
# Get the Managed Grafana endpoint
GRAFANA_URL=$(az grafana show \
  --name "grafana-forge-${ENV}" \
  --resource-group "rg-forge-platform-${ENV}" \
  --query properties.endpoint -o tsv)
echo "Grafana URL: ${GRAFANA_URL}"

# Verify the Managed Grafana instance is active
az grafana show \
  --name grafana-forge-prod \
  --resource-group rg-forge-platform-prod \
  --query "properties.provisioningState" -o tsv
# Expected: Succeeded

# Open in browser (authenticates via Azure AD)
echo "Open: ${GRAFANA_URL}"
```

### 4.9 Install Airflow

```bash
helm repo add apache-airflow https://airflow.apache.org
helm repo update

AIRFLOW_DB_CONN=$(az keyvault secret show \
  --vault-name "${KV_NAME}" \
  --name "airflow-db-connection-string" \
  --query value -o tsv)

AIRFLOW_FERNET_KEY=$(az keyvault secret show \
  --vault-name "${KV_NAME}" \
  --name "airflow-fernet-key" \
  --query value -o tsv)

AIRFLOW_WS_SECRET=$(az keyvault secret show \
  --vault-name "${KV_NAME}" \
  --name "airflow-webserver-secret-key" \
  --query value -o tsv)

cat <<EOF > /tmp/airflow-values.yaml
airflowVersion: "3.1.8"

images:
  airflow:
    repository: "forgeacr${ALIAS}.azurecr.io/airflow"
    tag: "3.1.8"
    pullPolicy: Always
  gitSync:
    repository: "registry.k8s.io/git-sync/git-sync"
    tag: "v4.2.1"

executor: KubernetesExecutor

data:
  metadataConnection:
    protocol: postgresql
    host: ""  # host comes from connection string below

config:
  core:
    dags_folder: /opt/airflow/dags
    load_examples: "False"
    parallelism: "64"
    max_active_tasks_per_dag: "32"
    max_active_runs_per_dag: "8"
  kubernetes:
    namespace: airflow
    worker_container_repository: "forgeacr${ALIAS}.azurecr.io/airflow"
    worker_container_tag: "3.1.8"
    delete_worker_pods: "True"
    delete_worker_pods_on_failure: "False"
    worker_service_account_name: airflow-sa
  secrets:
    backend: airflow.providers.microsoft.azure.secrets.key_vault.AzureKeyVaultBackend
    backend_kwargs: '{"connections_prefix": "airflow-conn", "variables_prefix": "airflow-var", "vault_url": "https://${KV_NAME}.vault.azure.net/"}'
  logging:
    remote_logging: "True"
    remote_log_conn_id: azure_data_lake_default
    remote_base_log_folder: "abfss://checkpoint@${ADLS_ACCOUNT}.dfs.core.windows.net/airflow-logs"
    encrypt_s3_logs: "False"

env:
- name: AIRFLOW__DATABASE__SQL_ALCHEMY_CONN
  valueFrom:
    secretKeyRef:
      name: airflow-config-secrets
      key: connectionString
- name: AIRFLOW__CORE__FERNET_KEY
  valueFrom:
    secretKeyRef:
      name: airflow-config-secrets
      key: fernetKey
- name: AIRFLOW__WEBSERVER__SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: airflow-config-secrets
      key: webserverSecretKey

scheduler:
  replicas: 2
  serviceAccount:
    create: false
    name: airflow-sa
  nodeSelector:
    agentpool: airflow
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"

webserver:
  replicas: 2
  serviceAccount:
    create: false
    name: airflow-sa
  nodeSelector:
    agentpool: platform
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "1"
      memory: "2Gi"
  service:
    type: ClusterIP
  authBackend: airflow.auth.managers.fab.fab_auth_manager.FabAuthManager
  defaultUser:
    enabled: false

triggerer:
  enabled: true
  replicas: 1
  serviceAccount:
    create: false
    name: airflow-sa
  nodeSelector:
    agentpool: airflow

workers:
  serviceAccount:
    create: false
    name: airflow-sa

dags:
  gitSync:
    enabled: true
    repo: "git@ssh.dev.azure.com:v3/yourorg/forge/dags"
    branch: main
    subPath: "dags/"
    sshKeySecret: airflow-config-secrets
    period: 60s

volumeMounts:
- name: airflow-secrets
  mountPath: /mnt/secrets
  readOnly: true

volumes:
- name: airflow-secrets
  csi:
    driver: secrets-store.csi.k8s.io
    readOnly: true
    volumeAttributes:
      secretProviderClass: airflow-secrets

serviceAccount:
  create: false
  name: airflow-sa

podAnnotations:
  azure.workload.identity/use: "true"
EOF

helm upgrade --install airflow \
  apache-airflow/airflow \
  --namespace airflow \
  --version 1.13.1 \
  --values /tmp/airflow-values.yaml \
  --wait \
  --timeout=15m
```

Verify Airflow is running:

```bash
kubectl get pods -n airflow

# Expected:
# airflow-scheduler-0                         2/2     Running
# airflow-scheduler-1                         2/2     Running
# airflow-triggerer-0                         2/2     Running
# airflow-webserver-<hash>-<hash>             1/1     Running
# airflow-webserver-<hash>-<hash>             1/1     Running
```

### 4.10 Verify Purview OpenLineage Connectivity

Microsoft Purview is a managed service — there is no Helm chart or pod to install. The orchestration step for lineage is to verify that the `id-forge-read-{env}` managed identity has the **Purview Data Curator** role assigned on the Purview collection, and that the Purview OpenLineage endpoint is reachable from within the orchestration cluster.

Verify connectivity from within the cluster:

```bash
# Test the Purview endpoint from within the airflow-scheduler pod
kubectl --context forge-orchestration-${ENV} exec -n airflow deploy/airflow-scheduler -- \
  curl -s -o /dev/null -w "%{http_code}" \
  "https://purview-forge-${ENV}.purview.azure.com/dataMap/openlineage/namespaces/forge-${ENV}/events"
# Expected: 200 or 405 (endpoint exists; 405 = GET not allowed, POST required)
# 401 = Purview Data Curator role is missing — see docs/implementation/05-deploy-orchestration.md section 5.2
```

### 4.11 Verify Airflow Webserver is Accessible

Port-forward to the Airflow webserver to confirm the UI loads before the Ingress is configured:

```bash
kubectl port-forward svc/airflow-webserver -n airflow 8080:8080 &
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health
kill %1
```

Expected HTTP status: `200`

---

## Part 5 — Cross-Cluster Validation

### 5.1 Test: Airflow Submits a SparkApplication to the Compute Cluster

This test verifies the full orchestration-to-compute path. It creates a minimal SparkApplication CRD in the compute cluster through Airflow's SparkKubernetesOperator.

**Step 1: Create a test DAG**

Create `/tmp/test_spark_submit.py`:

```python
from datetime import datetime
from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)
from airflow.providers.cncf.kubernetes.sensors.spark_kubernetes import (
    SparkKubernetesSensor,
)

ENV = "prod"
ACR = f"forgeacr-{ENV}.azurecr.io"

with DAG(
    dag_id="forge_cross_cluster_test",
    start_date=datetime(2026, 3, 24),
    schedule=None,
    catchup=False,
    tags=["test", "platform"],
) as dag:

    submit = SparkKubernetesOperator(
        task_id="submit_spark_pi",
        application_file="yaml",
        application=f"""
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: pi-test-{{{{ ts_nodash | lower }}}}
  namespace: spark-jobs
spec:
  type: Scala
  mode: cluster
  image: "{ACR}/spark:4.1.1"
  imagePullPolicy: Always
  mainClass: org.apache.spark.examples.SparkPi
  mainApplicationFile: "local:///opt/spark/examples/jars/spark-examples_2.13-4.1.1.jar"
  arguments:
    - "100"
  sparkVersion: "4.1.1"
  restartPolicy:
    type: Never
  driver:
    cores: 1
    memory: "1g"
    serviceAccount: spark
    annotations:
      azure.workload.identity/use: "true"
    nodeSelector:
      agentpool: spark
    tolerations:
    - key: workload
      operator: Equal
      value: spark
      effect: NoSchedule
  executor:
    cores: 1
    instances: 2
    memory: "1g"
    nodeSelector:
      agentpool: spark
    tolerations:
    - key: workload
      operator: Equal
      value: spark
      effect: NoSchedule
    - key: kubernetes.azure.com/scalesetpriority
      operator: Equal
      value: spot
      effect: NoSchedule
""",
        kubernetes_conn_id="compute_cluster_k8s",
        namespace="spark-jobs",
    )

    monitor = SparkKubernetesSensor(
        task_id="monitor_spark_pi",
        application_name=f"pi-test-{{{{ ts_nodash | lower }}}}",
        namespace="spark-jobs",
        kubernetes_conn_id="compute_cluster_k8s",
        attach_log=True,
    )

    submit >> monitor
```

**Step 2: Copy the DAG to the git-sync repo**

```bash
cp /tmp/test_spark_submit.py path/to/dags/test_spark_submit.py
git add path/to/dags/test_spark_submit.py
git commit -m "chore: add cross-cluster validation DAG"
git push origin main
```

Wait for git-sync (up to 60 seconds) then verify the DAG appears:

```bash
kubectl port-forward svc/airflow-webserver -n airflow 8080:8080 &
curl -s http://localhost:8080/api/v1/dags/forge_cross_cluster_test \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('DAG found:', d['dag_id'], '- paused:', d['is_paused'])"
kill %1
```

**Step 3: Trigger the DAG**

```bash
# Unpause and trigger via Airflow REST API (from inside the cluster or via port-forward)
curl -X PATCH http://localhost:8080/api/v1/dags/forge_cross_cluster_test \
  -H "Content-Type: application/json" \
  -d '{"is_paused": false}' \
  -u admin:$(kubectl get secret airflow-webserver-secret -n airflow -o jsonpath='{.data.webserver-secret-key}' | base64 -d)

curl -X POST http://localhost:8080/api/v1/dags/forge_cross_cluster_test/dagRuns \
  -H "Content-Type: application/json" \
  -d '{"dag_run_id": "cross_cluster_test_01"}' \
  -u admin:$(kubectl get secret airflow-webserver-secret -n airflow -o jsonpath='{.data.webserver-secret-key}' | base64 -d)
```

**Step 4: Watch the SparkApplication on the compute cluster**

Switch to the compute cluster context and watch:

```bash
kubectl config use-context "forge-compute-${ENV}"

kubectl get sparkapplication -n spark-jobs --watch
```

Expected progression:

```
NAME                           STATUS      ATTEMPTS   START                  FINISH   AGE
pi-test-20260324t120000        SUBMITTED   1                                          5s
pi-test-20260324t120000        RUNNING     1          2026-03-24T12:00:05Z            15s
pi-test-20260324t120000        SUCCEEDED   1          2026-03-24T12:00:05Z   ...      90s
```

**Step 5: Return to orchestration cluster**

```bash
kubectl config use-context "forge-orch-${ENV}"
```

Verify the Airflow task succeeded:

```bash
curl -s http://localhost:8080/api/v1/dags/forge_cross_cluster_test/dagRuns/cross_cluster_test_01/taskInstances \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for ti in data['task_instances']:
    print(ti['task_id'], '->', ti['state'])
"
```

Expected:
```
submit_spark_pi -> success
monitor_spark_pi -> success
```

### 5.2 Test: Purview Receives an OpenLineage Event

When Airflow runs a task with the `openlineage-airflow` integration installed, it emits `START` and `COMPLETE` OpenLineage events to the Purview OpenLineage endpoint automatically. The test DAG above triggers this.

Verify events arrived in Purview by checking the Airflow scheduler log for successful transport:

```bash
kubectl --context forge-orchestration-${ENV} \
  logs -n airflow deploy/airflow-scheduler \
  --tail=200 | grep -i openlineage
# Expected: no ERROR lines; INFO lines confirming events were sent
```

Then verify the asset appeared in the Purview Data Map:

```bash
ACCESS_TOKEN=$(az account get-access-token \
  --resource "https://purview.azure.com" --query accessToken -o tsv)

curl -s -X POST \
  "https://purview-forge-${ENV}.purview.azure.com/catalog/api/search/query?api-version=2022-03-01-preview" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"keywords": "forge_cross_cluster_test", "limit": 5}' \
  | python3 -m json.tool | grep -A3 "displayText"
```

Expected: at least one asset entry for the `forge_cross_cluster_test` job visible in the Purview Data Map.

### 5.3 Test: Metrics Appear in Azure Managed Grafana

**Step 1: Verify Azure Monitor is receiving metrics**

```bash
# Check that Airflow metrics are arriving in Log Analytics
az monitor log-analytics query \
  --workspace "/subscriptions/${SUB_ID}/resourceGroups/rg-forge-platform-prod/providers/Microsoft.OperationalInsights/workspaces/law-forge-prod" \
  --analytics-query "InsightsMetrics | where Name startswith 'airflow' | take 5 | project TimeGenerated, Name, Val" \
  --output table

# Check Spark Operator metrics
az monitor log-analytics query \
  --workspace "/subscriptions/${SUB_ID}/resourceGroups/rg-forge-platform-prod/providers/Microsoft.OperationalInsights/workspaces/law-forge-prod" \
  --analytics-query "InsightsMetrics | where Name startswith 'spark' | take 5 | project TimeGenerated, Name, Val" \
  --output table
```

**Step 2: Access Azure Managed Grafana and check the Forge Platform dashboard**

```bash
GRAFANA_URL=$(az grafana show \
  --name "grafana-forge-${ENV}" \
  --resource-group "rg-forge-platform-${ENV}" \
  --query properties.endpoint -o tsv)
echo "Open: ${GRAFANA_URL}"
```

Open the Grafana URL in a browser. Log in with Azure AD. Navigate to **Dashboards > Forge > Platform Overview**. Verify:
- Cluster node counts appear
- Airflow scheduler heartbeat is green
- Spark Operator pod is shown as Running
- No critical alerts are firing

**Step 3: Verify logs are flowing to Azure Log Analytics**

In Azure Managed Grafana, navigate to **Explore**, select the **Azure Monitor Logs** data source, choose the Log Analytics Workspace, and run this query:

```kql
ContainerLogV2
| where Namespace == "airflow" and PodName startswith "airflow-scheduler"
| order by TimeGenerated desc
| take 20
| project TimeGenerated, PodName, LogMessage
```

Expected: recent log lines from the Airflow scheduler. If no logs appear, check:
- AMA DaemonSet pods are Running on all nodes: `kubectl get pods -n kube-system -l component=ama-logs`
- Container Insights add-on is enabled: `az aks show --name aks-forge-orchestration-prod --resource-group rg-forge-prod --query "addonProfiles.omsagent.enabled"`

### 5.4 Full Green-Light Checklist

Do not declare the platform ready for pipeline onboarding until every item below is checked.

**ACR**
- [ ] `az acr login` succeeds from inside VNet
- [ ] All required images are present in ACR (verify with `az acr repository list`)
- [ ] Defender for Containers shows no CRITICAL findings on platform images
- [ ] Public network access is Disabled

**Networking**
- [ ] `nslookup forgeacr${ALIAS}.azurecr.io` from any cluster pod returns a private IP
- [ ] `nslookup ${ADLS_ACCOUNT}.dfs.core.windows.net` returns a private IP
- [ ] `nslookup ${KV_NAME}.vault.azure.net` returns a private IP
- [ ] Compute cluster API server is reachable (public endpoint, AAD-gated)
- [ ] Orchestration cluster API server is reachable (public endpoint, AAD-gated)

**Compute Cluster**
- [ ] All system node pool nodes are `Ready`
- [ ] Spark node pool autoscales from 0 to at least 1 node when a SparkApplication is submitted
- [ ] Trino node pool shows correct node count
- [ ] CSI Secrets Store Driver pods are Running
- [ ] Workload identity webhook pods are Running
- [ ] Calico network policies are installed
- [ ] `spark` ServiceAccount exists in `spark-jobs` with correct workload identity annotation
- [ ] `trino-sa` ServiceAccount exists in `trino` with correct workload identity annotation
- [ ] Workload identity test pod (Section 3.10) passed
- [ ] Spark Operator pods are Running
- [ ] Spark Operator CRDs are installed
- [ ] Spark Operator webhook is registered

**Orchestration Cluster**
- [ ] All system node pool nodes are `Ready`
- [ ] CSI Secrets Store Driver pods are Running
- [ ] Workload identity webhook pods are Running
- [ ] `airflow-sa`, `portal-sa` ServiceAccounts exist with correct annotations
- [ ] All SecretProviderClasses resolve secrets without error
- [ ] Compute cluster kubeconfig is stored in Key Vault as `compute-cluster-kubeconfig`
- [ ] Container Insights add-on is enabled on both clusters
- [ ] Azure Monitor Agent (AMA) DaemonSet pods are Running on all nodes
- [ ] Azure Monitor metrics query returns data for both clusters
- [ ] Azure Managed Grafana instance is accessible and shows Forge dashboards
- [ ] Airflow scheduler pods (2 replicas) show `2/2 Running`
- [ ] Airflow webserver pods are Running and return HTTP 200 on `/health`
- [ ] Airflow triggerer pod is Running
- [ ] Purview OpenLineage endpoint returns 200/405 from within the orchestration cluster

**Cross-Cluster Validation**
- [ ] Airflow `forge_cross_cluster_test` DAG triggered and reached state `success`
- [ ] SparkApplication `pi-test-*` reached state `SUCCEEDED` on the compute cluster
- [ ] Purview received OpenLineage events from the test DAG run (asset visible in Purview Data Map)
- [ ] Azure Managed Grafana shows metrics from both clusters
- [ ] Azure Log Analytics shows logs from both clusters
- [ ] No network policy violations logged by Calico during the test run

**Security**
- [ ] Zero pods running as `root` (check with `kubectl get pods -A -o json | jq '.items[].spec.containers[].securityContext.runAsUser'`)
- [ ] Zero pods have `hostNetwork: true`
- [ ] Zero static secrets in ConfigMaps or environment variables (all secrets are in Key Vault or projected by CSI driver)
- [ ] Workload identity federated credentials match the correct OIDC issuer URL for each cluster
- [ ] Microsoft Defender for Cloud shows no high-severity recommendations on the resource groups

---

*Once all items are checked, the platform clusters are ready for the first production pipeline onboarding. Proceed to document `04-pipeline-onboarding.md`.*
