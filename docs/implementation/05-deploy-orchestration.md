# Step 05 — Deploy Orchestration Cluster

> **Prerequisite:** Step 04 complete. Compute cluster is fully operational.
> **Cluster context:** `aks-forge-orch-{env}`

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org)

---

## Overview

The orchestration cluster hosts Airflow, Marquez, the observability stack, and the Developer Portal. Deploy in this order:

```
1. PostgreSQL setup          ← metadata DB for Airflow and Marquez (Azure managed)
2. Marquez                   ← lineage backend must be running before Airflow emits events
3. Container Insights add-on ← Azure Monitor / Container Insights (AKS built-in, already enabled in Step 03)
4. Azure Managed Grafana     ← provisioned via Bicep (already done in Step 03)
5. Airflow                   ← orchestrator (depends on PostgreSQL + Marquez endpoint)
6. Developer Portal          ← frontend + backend (depends on Airflow + Marquez)
```

Set your kubectl context:
```bash
az aks get-credentials \
  --resource-group rg-forge-{env} \
  --name aks-forge-orch-{env} \
  --overwrite-existing

kubectl config current-context   # verify
kubectl get nodes                 # verify all nodes Ready
```

---

## 5.1 PostgreSQL — Metadata Databases

Airflow and Marquez each need a PostgreSQL database. These are hosted on **Azure Database for PostgreSQL Flexible Server** (provisioned by Bicep in Step 03). This step creates the databases and users.

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

# Create databases and users (run once)
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "CREATE DATABASE airflow;"
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "CREATE DATABASE marquez;"
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "CREATE USER airflow WITH PASSWORD '$(openssl rand -base64 32)';"
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "GRANT ALL PRIVILEGES ON DATABASE airflow TO airflow;"
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "CREATE USER marquez WITH PASSWORD '$(openssl rand -base64 32)';"
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require" \
  -c "GRANT ALL PRIVILEGES ON DATABASE marquez TO marquez;"

# Store passwords in Key Vault
az keyvault secret set --vault-name kv-forge-{env} --name airflow-db-password --value "<airflow-password>"
az keyvault secret set --vault-name kv-forge-{env} --name marquez-db-password --value "<marquez-password>"
```

---

## 5.2 Marquez (OpenLineage Backend)

Marquez must be running before Airflow starts, so OpenLineage events have a destination.

```bash
kubectl create namespace lineage --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install marquez \
  infra/helm/orchestration/marquez \
  --namespace lineage \
  --set api.image.repository=forgeacr-{env}.azurecr.io/marquez-api \
  --set api.image.tag=0.47.0 \
  --set web.image.repository=forgeacr-{env}.azurecr.io/marquez-web \
  --set web.image.tag=0.47.0 \
  --set db.host=$(az keyvault secret show --vault-name kv-forge-{env} --name postgres-host --query value -o tsv) \
  --set db.port=5432 \
  --set db.name=marquez \
  --set db.user=marquez \
  --set db.password="" \
  --wait --timeout 5m
```

### Verify

```bash
kubectl get pods -n lineage
# NAME                   READY   STATUS    RESTARTS
# marquez-api-xxx        1/1     Running   0
# marquez-web-xxx        1/1     Running   0

# Test the API (internal)
kubectl port-forward -n lineage svc/marquez-api 5000:5000 &
curl -s http://localhost:5000/api/v1/namespaces | jq .
kill %1
```

Store Marquez API URL in Key Vault:
```bash
az keyvault secret set \
  --vault-name kv-forge-{env} \
  --name marquez-api-url \
  --value "http://marquez-api.lineage.svc.cluster.local:5000"
```

---

## 5.3 Azure Monitor / Container Insights and Azure Managed Grafana

The Container Insights add-on and Azure Managed Grafana were provisioned in Step 03 via `az aks enable-addons` and Bicep. This step verifies they are healthy and configured correctly.

```bash
# Verify Container Insights add-on is enabled on the orchestration cluster
az aks show \
  --name aks-forge-orch-{env} \
  --resource-group rg-forge-{env} \
  --query "addonProfiles.omsagent.enabled" -o tsv
# Expected: true

# Verify AMA DaemonSet pods are Running
kubectl get pods -n kube-system -l component=ama-metrics
# ama-metrics-xxx   2/2   Running  (one per node)

# Verify metrics are arriving in Log Analytics
az monitor log-analytics query \
  --workspace "/subscriptions/${SUB_ID}/resourceGroups/rg-forge-{env}/providers/Microsoft.OperationalInsights/workspaces/law-forge-{env}" \
  --analytics-query "Perf | where ObjectName == 'K8SNode' | take 5" \
  --output table
# Expected: rows with node performance data
```

### Verify Azure Managed Grafana

```bash
# Get Managed Grafana endpoint
GRAFANA_URL=$(az grafana show \
  --name "grafana-forge-{env}" \
  --resource-group "rg-forge-orchestration-{env}" \
  --query properties.endpoint -o tsv)

# Verify it is accessible (requires Azure AD login in browser)
echo "Open: ${GRAFANA_URL}"
# Should see Forge dashboards after Azure AD authentication
```

---

## 5.4 (Skipped — no Loki stack)

Log aggregation is handled by Azure Log Analytics Workspace (enabled via Container Insights add-on in Step 03). No separate Loki or Promtail deployment is required.

---

## 5.5 Apache Airflow

Airflow needs access to the compute cluster kubeconfig (to submit SparkApplications). This is stored in Key Vault and mounted via CSI.

### Pre-flight: Store Compute Cluster Kubeconfig in Key Vault

```bash
# Get compute cluster kubeconfig
az aks get-credentials \
  --resource-group rg-forge-{env} \
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
  --resource-group rg-forge-{env} \
  --name aks-forge-orch-{env} \
  --overwrite-existing
```

### Deploy Airflow

```bash
helm repo add apache-airflow https://airflow.apache.org
helm repo update

kubectl create namespace airflow --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install airflow \
  apache-airflow/airflow \
  --namespace airflow \
  --values infra/helm/orchestration/airflow/values.yaml \
  --set images.airflow.repository=forgeacr-{env}.azurecr.io/airflow \
  --set images.airflow.tag=2.9.3 \
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
    value: "http://marquez-api.lineage.svc.cluster.local:5000"
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
            - name: MARQUEZ_URL
              value: "http://marquez-api.lineage.svc.cluster.local:5000"
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
[ ] PostgreSQL databases created:            airflow, marquez databases exist
[ ] Marquez API pod Running:                 kubectl get pods -n lineage
[ ] Marquez API responds to /api/v1/namespaces
[ ] Container Insights add-on enabled on orchestration cluster
[ ] Azure Monitor Agent (AMA) DaemonSet pods Running on all nodes
[ ] Azure Log Analytics receiving logs from orchestration cluster
[ ] Azure Managed Grafana accessible and Forge dashboards loaded
[ ] Airflow scheduler pods Running (x2 HA):  kubectl get pods -n airflow
[ ] Airflow webserver Running
[ ] Airflow git-sync pulling DAGs from repo
[ ] Airflow DAGs listed in scheduler
[ ] Airflow Key Vault secrets backend working: test connection lookup
[ ] Portal API pod Running:                   kubectl get pods -n portal
[ ] Portal Web pod Running
[ ] Portal accessible via Application Gateway
```

All green → proceed to Step 06 validation.
