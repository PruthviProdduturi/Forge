# Step 05 — Deploy Orchestration Cluster

> **Prerequisite:** Step 04 complete. Compute cluster is fully operational.
> **Cluster context:** `aks-forge-orch-{env}`

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org)

---

## Overview

The orchestration cluster hosts Airflow, the observability stack, and the Developer Portal. Lineage is handled by Microsoft Purview — a managed service, no in-cluster deployment required. Deploy in this order:

```
1. PostgreSQL setup                   ← metadata DB for Airflow (Azure managed)
2. Container Insights add-on          ← Azure Monitor / Container Insights (AKS built-in, already enabled in Step 03)
3. Azure Managed Grafana              ← provisioned via Bicep (already done in Step 03)
4. Airflow                            ← orchestrator (depends on PostgreSQL)
5. Purview OpenLineage integration    ← configure OPENLINEAGE_TRANSPORT in Airflow Helm values
6. Developer Portal                   ← frontend + backend (depends on Airflow + Purview)
```

Set your kubectl context:
```bash
az aks get-credentials \
  --resource-group rg-forge-compute-{env} \
  --name aks-forge-orch-{env} \
  --overwrite-existing

kubectl config current-context   # verify
kubectl get nodes                 # verify all nodes Ready
```

---

## 5.1 PostgreSQL — Airflow Metadata Database

Airflow needs a PostgreSQL database. This is hosted on **Azure Database for PostgreSQL Flexible Server** (provisioned by Bicep in Step 03). This step creates the database and user.

Note: There is no longer a separate lineage database — Microsoft Purview is the lineage backend and is a managed service.

```bash
# Get the PostgreSQL host from Key Vault
PG_HOST=$(az keyvault secret show \
  --vault-name kv-forge-{env} \
  --name postgres-host \
  --query value -o tsv)

PG_ADMIN_PASS=$(az keyvault secret show \
  --vault-name kv-forge-{env} \
  --name postgres-admin-password \
  --query value -o tsv)

# Create Airflow database and user (run once)
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "CREATE DATABASE airflow;"
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "CREATE USER airflow WITH PASSWORD '$(openssl rand -base64 32)';"
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "GRANT ALL PRIVILEGES ON DATABASE airflow TO airflow;"

# Store password in Key Vault
az keyvault secret set --vault-name kv-forge-{env} --name airflow-db-password --value "<airflow-password>"
```

---

## 5.2 Purview OpenLineage Integration

Microsoft Purview is the lineage backend. No in-cluster deployment is required — Purview is a managed Azure service provisioned via Bicep (Step 03). This step:

1. Verifies the Purview account is reachable from the orchestration cluster
2. Grants `id-forge-read-{env}` the **Purview Data Curator** role on the Purview collection
3. Configures the `OPENLINEAGE_TRANSPORT` environment variable in Airflow Helm values

### 5.2.1 Assign Purview Data Curator Role

The `id-forge-read-{env}` managed identity must have the **Purview Data Curator** collection role. This is a Purview-internal role (not Azure RBAC) and must be assigned via the Purview governance portal or the Purview REST API.

```bash
# Get the Purview account principal ID
PURVIEW_ACCOUNT="purview-forge-{env}"

# Assign Data Curator role via Azure CLI (Purview collection role)
az purview account add-root-collection-admin \
  --account-name "${PURVIEW_ACCOUNT}" \
  --resource-group rg-forge-platform-{env} \
  --object-id "$(az identity show \
    --name id-forge-read-{env} \
    --resource-group rg-forge-platform-{env} \
    --query principalId -o tsv)"
```

Alternatively, in the Purview governance portal:
1. Open `https://purview-forge-{env}.purview.azure.com`
2. Go to **Data Map** → **Collections** → select the root collection
3. Go to the **Role assignments** tab
4. Add `id-forge-read-{env}` to the **Data Curators** role

### 5.2.2 Verify Purview Endpoint Connectivity

Verify the Purview OpenLineage endpoint is reachable from the orchestration cluster (via private endpoint):

```bash
# Test from within the cluster
kubectl run ol-connectivity-test \
  --image=curlimages/curl:latest \
  --restart=Never \
  --rm -it \
  -- curl -s -o /dev/null -w "%{http_code}" \
  "https://purview-forge-{env}.purview.azure.com/dataMap/openlineage/namespaces/forge-{env}/events" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"eventType":"START","eventTime":"2026-01-01T00:00:00Z","run":{"runId":"00000000-0000-0000-0000-000000000000"},"job":{"namespace":"forge-{env}","name":"connectivity-test"},"inputs":[],"outputs":[]}'
# Expected: 401 (unauthorized — but reachable). 000 means unreachable.
```

If the result is `000`, check the private endpoint for `privatelink.purview.azure.com` in the `private-endpoints-subnet`.

### 5.2.3 Configure OpenLineage Transport in Airflow

The `OPENLINEAGE_TRANSPORT` environment variable is set in `infra/helm/orchestration/airflow/values.yaml`. Ensure it points to the Purview endpoint for this environment:

```yaml
# infra/helm/orchestration/airflow/values.yaml (excerpt)
env:
  - name: AIRFLOW__LINEAGE__BACKEND
    value: "openlineage.airflow.OpenLineageBackend"
  - name: OPENLINEAGE_URL
    value: "https://purview-forge-{env}.purview.azure.com"
  - name: OPENLINEAGE_TRANSPORT
    value: >-
      {"type":"http",
       "url":"https://purview-forge-{env}.purview.azure.com/dataMap/openlineage/namespaces/forge-{env}/events",
       "auth":{"type":"azure_identity"}}
  - name: OPENLINEAGE_NAMESPACE
    value: "forge-{env}"
```

The `azure_identity` auth type instructs the OpenLineage HTTP transport to obtain an Azure AD Bearer token from the pod's workload identity (OIDC) before each POST. No static credentials are required.

After updating the Helm values, re-deploy Airflow to apply (see Section 5.4 below).

---

## 5.3 Azure Monitor / Container Insights and Azure Managed Grafana

The Container Insights add-on and Azure Managed Grafana were provisioned in Step 03 via `az aks enable-addons` and Bicep. This step verifies they are healthy and configured correctly.

```bash
# Verify Container Insights add-on is enabled on the orchestration cluster
az aks show \
  --name aks-forge-orch-{env} \
  --resource-group rg-forge-compute-{env} \
  --query "addonProfiles.omsagent.enabled" -o tsv
# Expected: true

# Verify AMA DaemonSet pods are Running
kubectl get pods -n kube-system -l component=ama-metrics
# ama-metrics-xxx   2/2   Running  (one per node)

# Verify metrics are arriving in Log Analytics
az monitor log-analytics query \
  --workspace "/subscriptions/${SUB_ID}/resourceGroups/rg-forge-platform-{env}/providers/Microsoft.OperationalInsights/workspaces/law-forge-{env}" \
  --analytics-query "Perf | where ObjectName == 'K8SNode' | take 5" \
  --output table
# Expected: rows with node performance data
```

### Verify Azure Managed Grafana

```bash
# Get Managed Grafana endpoint
GRAFANA_URL=$(az grafana show \
  --name "grafana-forge-{env}" \
  --resource-group "rg-forge-platform-{env}" \
  --query properties.endpoint -o tsv)

# Verify it is accessible (requires Azure AD login in browser)
echo "Open: ${GRAFANA_URL}"
# Should see Forge dashboards after Azure AD authentication
```

---

## 5.4 Log Aggregation (Azure Log Analytics)

Log aggregation is handled by **Azure Log Analytics Workspace**, enabled automatically via the Container Insights add-on provisioned in Step 03. The Azure Monitor Agent (AMA) DaemonSet on both clusters tails `/var/log/containers/*` and forwards all pod logs to the workspace — no separate deployment required.

```bash
# Verify AMA DaemonSet is running on the orchestration cluster
kubectl get daemonset ama-logs -n kube-system

# Confirm logs are flowing — query from Azure CLI
az monitor log-analytics query \
  --workspace "${LOG_ANALYTICS_WORKSPACE_ID}" \
  --analytics-query "ContainerLog | limit 10" \
  --output table
```

---

## 5.5 Apache Airflow

Airflow needs access to the compute cluster kubeconfig (to submit SparkApplications). This is stored in Key Vault and mounted via CSI.

### Pre-flight: Store Compute Cluster Kubeconfig in Key Vault

```bash
# Get compute cluster kubeconfig
az aks get-credentials \
  --resource-group rg-forge-compute-{env} \
  --name aks-forge-compute-{env} \
  --file /tmp/compute-kubeconfig

# Store in Key Vault
az keyvault secret set \
  --vault-name kv-forge-{env} \
  --name compute-cluster-kubeconfig \
  --file /tmp/compute-kubeconfig

# Clean up local file
rm /tmp/compute-kubeconfig

# Switch back to orchestration cluster context
az aks get-credentials \
  --resource-group rg-forge-compute-{env} \
  --name aks-forge-orch-{env} \
  --overwrite-existing
```

### Deploy Airflow

```bash
kubectl create namespace airflow --dry-run=client -o yaml | kubectl apply -f -

# Helm chart is pre-imported to ACR (see Step 02 §6 — no public Helm repo access)
helm upgrade --install airflow \
  oci://forgeacr-{env}.azurecr.io/helm/airflow \
  --version 1.15.0 \
  --namespace airflow \
  --values infra/helm/orchestration/airflow/values.yaml \
  --set images.airflow.repository=forgeacr-{env}.azurecr.io/airflow \
  --set images.airflow.tag=3.1.0 \
  --set data.metadataConnection.host=$(az keyvault secret show --vault-name kv-forge-{env} --name postgres-host --query value -o tsv) \
  --set data.metadataConnection.db=airflow \
  --set data.metadataConnection.user=airflow \
  --set data.metadataConnection.pass="" \
  --set config.core.executor=KubernetesExecutor \
  --wait --timeout 10m
```

Key sections in `infra/helm/orchestration/airflow/values.yaml`:
```yaml
executor: KubernetesExecutor

dags:
  gitSync:
    enabled: true
    repo: https://dev.azure.com/{org}/Forge/_git/Forge
    branch: main
    subPath: orchestration/airflow/dags
    credentialsSecret: airflow-git-credentials
    period: 30s

webserver:
  service:
    type: ClusterIP
  extraEnv:
    - name: AIRFLOW__WEBSERVER__AUTHENTICATE
      value: "True"
    - name: AIRFLOW__WEBSERVER__AUTH_BACKEND
      value: airflow.providers.microsoft.azure.auth_backend.aad_auth

scheduler:
  replicas: 2   # HA: two schedulers with row-level locking

triggerer:
  enabled: true
  replicas: 1

extraEnvFrom:
  - secretRef:
      name: airflow-openlineage-config

env:
  - name: AIRFLOW__SECRETS__BACKEND
    value: "airflow.providers.microsoft.azure.secrets.key_vault.AzureKeyVaultBackend"
  - name: AIRFLOW__SECRETS__BACKEND_KWARGS
    value: '{"vault_url": "https://kv-forge-{env}.vault.azure.net", "connections_prefix": "airflow-connections", "variables_prefix": "airflow-variables"}'
  - name: AIRFLOW__LINEAGE__BACKEND
    value: "openlineage.airflow.OpenLineageBackend"
  - name: OPENLINEAGE_URL
    value: "https://purview-forge-{env}.purview.azure.com"
  - name: OPENLINEAGE_TRANSPORT
    value: >-
      {"type":"http",
       "url":"https://purview-forge-{env}.purview.azure.com/dataMap/openlineage/namespaces/forge-{env}/events",
       "auth":{"type":"azure_identity"}}
  - name: OPENLINEAGE_NAMESPACE
    value: "forge-{env}"
```

### Verify

```bash
kubectl get pods -n airflow
# NAME                              READY   STATUS    RESTARTS
# airflow-scheduler-xxx             1/1     Running   0
# airflow-scheduler-xxx (HA)        1/1     Running   0
# airflow-webserver-xxx             1/1     Running   0
# airflow-triggerer-xxx             1/1     Running   0

# Check git-sync is working
kubectl logs -n airflow deploy/airflow-scheduler -c git-sync | tail -5
# Should show successful git pull

# Check DAGs are loaded
kubectl exec -n airflow deploy/airflow-scheduler -- airflow dags list | head -10
```

---

## 5.6 Developer Portal

The portal backend and frontend run as separate deployments in the `portal` namespace.

```bash
kubectl create namespace portal --dry-run=client -o yaml | kubectl apply -f -

# Deploy portal backend (FastAPI)
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: portal-api
  namespace: portal
spec:
  replicas: 2
  selector:
    matchLabels:
      app: portal-api
  template:
    metadata:
      labels:
        app: portal-api
        azure.workload.identity/use: "true"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: portal
      containers:
        - name: portal-api
          image: forgeacr-{env}.azurecr.io/portal-api:latest
          ports:
            - containerPort: 8080
          env:
            - name: AIRFLOW_URL
              value: "http://airflow-webserver.airflow.svc.cluster.local:8080"
            - name: PURVIEW_ACCOUNT
              value: "purview-forge-{env}"
            - name: PURVIEW_ENDPOINT
              value: "https://purview-forge-{env}.purview.azure.com"
            - name: ADLS_ACCOUNT
              value: "forgeadls{env}"
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
          resources:
            requests: { cpu: "250m", memory: "256Mi" }
            limits:   { cpu: "1",    memory: "1Gi"   }
EOF

# Deploy portal frontend (Next.js)
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: portal-web
  namespace: portal
spec:
  replicas: 2
  selector:
    matchLabels:
      app: portal-web
  template:
    metadata:
      labels:
        app: portal-web
    spec:
      containers:
        - name: portal-web
          image: forgeacr-{env}.azurecr.io/portal-web:latest
          ports:
            - containerPort: 3000
          env:
            - name: NEXT_PUBLIC_API_URL
              value: "/api"
            - name: NEXTAUTH_URL
              value: "https://portal.forge.{env}.internal"
          readinessProbe:
            httpGet:
              path: /api/health
              port: 3000
          resources:
            requests: { cpu: "250m", memory: "256Mi" }
            limits:   { cpu: "1",    memory: "512Mi"  }
EOF
```

---

## 5.7 Orchestration Cluster Readiness Checklist

```
[ ] PostgreSQL database created:             airflow database exists
[ ] Purview account reachable from cluster:  connectivity test returns non-000 HTTP status
[ ] id-forge-read-{env} has Purview Data Curator role on Purview collection
[ ] OPENLINEAGE_TRANSPORT env var set in Airflow Helm values (Purview endpoint)
[ ] Container Insights add-on enabled on orchestration cluster
[ ] Azure Monitor Agent (AMA) DaemonSet pods Running on all nodes
[ ] Azure Log Analytics receiving logs from orchestration cluster
[ ] Azure Managed Grafana accessible and Forge dashboards loaded
[ ] Airflow scheduler pods Running (x2 HA):  kubectl get pods -n airflow
[ ] Airflow webserver Running
[ ] Airflow git-sync pulling DAGs from repo
[ ] Airflow DAGs listed in scheduler
[ ] Airflow Key Vault secrets backend working: test connection lookup
[ ] Run a test DAG task and verify lineage appears in Purview (forge-{env} namespace)
[ ] Portal API pod Running:                   kubectl get pods -n portal
[ ] Portal Web pod Running
[ ] Portal accessible via Application Gateway
```

All green → proceed to Step 06 (CI/CD pipeline configuration).
