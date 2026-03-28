# Step 04 — Deploy Compute Cluster

> **Prerequisite:** Step 03 complete. Both AKS clusters are running. All images are in ACR.
> **Cluster context:** `aks-forge-compute-{env}`

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io)

---

## Overview

The compute cluster hosts Spark (Operator + Connect server) and Trino. Both environments deploy the same components — the difference is scale:

| Component | Dev | Prod |
|---|---|---|
| **Spark Connect** | VS Code exploration, DAG dev/testing | VS Code exploration by platform team |
| **Spark Operator** | Airflow dev DAG testing | All production Airflow batch jobs |
| **Node type** | D16s_v5 (16 vCPUs / 64 GiB) | Standard_E96_v5 (96 vCPUs / 672 GiB) |
| **Node pool** | 2–5 nodes | 10–100 nodes (autoscale) |

Deploy in order:

```
1. Hive Metastore          ← required by Trino and Spark for Delta catalog
2. Spark Operator          ← CRD controller that manages SparkApplication resources
3. Spark Connect Server    ← persistent gRPC endpoint for VS Code PySpark extension
4. Trino                   ← federated SQL engine
```

Set your kubectl context before running any command in this step:
```bash
az aks get-credentials \
  --resource-group rg-forge-{alias}-{env} \
  --name aks-forge-compute-{alias}-{env} \
  --overwrite-existing

kubectl config current-context   # verify
kubectl get nodes                 # verify all nodes Ready
```

---

## 4.1 Hive Metastore

Trino and Spark both use the Hive Metastore (HMS) to look up Delta table schemas by name. HMS stores table metadata (location, schema, partition info) in PostgreSQL.

### Deploy

HMS uses AAD authentication — no password. The HMS managed identity (`id-forge-hms-{env}`) authenticates against PostgreSQL via workload identity token exchange.

```bash
kubectl create namespace hive-metastore --dry-run=client -o yaml | kubectl apply -f -

HMS_HOST=$(az keyvault secret show \
  --vault-name kv-forge-{alias}-{env} \
  --name hms-postgres-host --query value -o tsv)

WI_CLIENT_ID=$(az identity show \
  -g rg-forge-{alias}-{env} \
  -n id-forge-hms-{env} \
  --query clientId -o tsv)

helm upgrade --install hive-metastore \
  infra/helm/compute/hive-metastore \
  --namespace hive-metastore \
  --set image.repository=forgeacr{alias}.azurecr.io/hive-metastore \
  --set image.tag=3.1.3 \
  --set db.host="${HMS_HOST}" \
  --set db.user="id-forge-hms-{env}" \
  --set adls.account=forgeadls{alias}{env} \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"="${WI_CLIENT_ID}" \
  --wait --timeout 5m
```

### Verify

```bash
kubectl get pods -n hive-metastore
# NAME                             READY   STATUS    RESTARTS
# hive-metastore-xxx               1/1     Running   0

# Check HMS is accepting Thrift connections
kubectl exec -n hive-metastore deploy/hive-metastore -- \
  /opt/hive/bin/hive --service metatool -listFSRoot
```

---

## 4.2 Spark Operator

The Spark Operator watches the `spark-jobs` namespace for `SparkApplication` CRDs and launches driver and executor pods.

### Deploy

```bash
# Helm chart is pre-imported to ACR (see Step 02 §6 — no public Helm repo access)
helm upgrade --install spark-operator \
  oci://forgeacr{alias}.azurecr.io/helm/spark-operator \
  --version 2.5.0 \
  --namespace spark-system \
  --create-namespace \
  --values infra/helm/compute/spark-operator/values.yaml \
  --set image.repository=forgeacr{alias}.azurecr.io/spark-operator \
  --set image.tag=2.5.0 \
  --wait --timeout 5m
```

Key values in `infra/helm/compute/spark-operator/values.yaml`:
```yaml
# Watch only the spark-jobs namespace (not cluster-wide)
sparkJobNamespace: spark-jobs

# Webhook for mutating SparkApplication pods (injects workload identity, node affinity)
webhook:
  enable: true
  namespaceSelector: "kubernetes.io/metadata.name=spark-jobs"

# Prometheus-format metrics endpoint (scraped by Azure Monitor Agent)
metrics:
  enable: true
  port: 10254
  portName: metrics
  endpoint: /metrics

# Resource limits for the operator itself
resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi
```

### Verify

```bash
kubectl get pods -n spark-system
# NAME                              READY   STATUS    RESTARTS
# spark-operator-xxx                1/1     Running   0

# CRDs should be installed
kubectl get crd | grep spark
# scheduledsparkapplications.sparkoperator.k8s.io
# sparkapplications.sparkoperator.k8s.io

# Submit a quick test SparkApplication
kubectl apply -f - <<EOF
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: spark-pi-test
  namespace: spark-jobs
spec:
  type: Python
  pythonVersion: "3"
  mode: cluster
  image: "forgeacr{alias}.azurecr.io/spark:4.1.1"
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
EOF

# Watch until Completed
kubectl get sparkapplication spark-pi-test -n spark-jobs -w
# Expected final state: COMPLETED

# Clean up
kubectl delete sparkapplication spark-pi-test -n spark-jobs
```

---

## 4.3 Spark Connect Server

One shared Spark Connect server per environment. The entire team connects to the same driver. Executors are shared and scale dynamically with actual query load.

| | Dev | Prod |
|---|---|---|
| Driver | 2 cores / 4g | 8 cores / 28g |
| Executor | 2 cores / 8g | 4 cores / 28g |
| Max executors | 4 | 40 |
| Node fit | — | 22 executors per E96_v5 node |
| Values file | `values.yaml` + `values-dev.yaml` | `values.yaml` |

### Deploy (dev)

```bash
WI_CLIENT_ID=$(az identity show \
  -g rg-forge-{alias}-dev \
  -n id-forge-spark-dev \
  --query clientId -o tsv)

helm upgrade --install spark-connect \
  infra/helm/compute/spark-connect \
  --namespace spark-system \
  --values infra/helm/compute/spark-connect/values.yaml \
  --values infra/helm/compute/spark-connect/values-dev.yaml \
  --set image.repository=forgeacr{alias}.azurecr.io/spark \
  --set image.tag=4.1.1 \
  --set adls.account=forgeadls{alias}dev \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"=${WI_CLIENT_ID} \
  --wait --timeout 5m
```

### Deploy (prod)

```bash
WI_CLIENT_ID=$(az identity show \
  -g rg-forge-{alias}-prod \
  -n id-forge-spark-prod \
  --query clientId -o tsv)

helm upgrade --install spark-connect \
  infra/helm/compute/spark-connect \
  --namespace spark-system \
  --values infra/helm/compute/spark-connect/values.yaml \
  --set image.repository=forgeacr{alias}.azurecr.io/spark \
  --set image.tag=4.1.1 \
  --set adls.account=forgeadls{alias}prod \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"=${WI_CLIENT_ID} \
  --wait --timeout 5m
```

### Get the Spark Connect Endpoint

The service is an internal Azure Load Balancer (VNet-only). Since the AKS API server is public, developers reach it via `kubectl port-forward` from their laptops — no VPN required.

```bash
kubectl get svc -n spark-system spark-connect-lb
# NAME                TYPE           CLUSTER-IP    EXTERNAL-IP   PORT(S)
# spark-connect-lb    LoadBalancer   10.100.1.50   10.4.0.10     15002:...

SC_HOST=$(kubectl get svc -n spark-system spark-connect-lb \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Store the internal IP in Key Vault (used when connecting from within the cluster)
az keyvault secret set --vault-name kv-forge-{alias}-{env} \
  --name spark-connect-endpoint --value "sc://${SC_HOST}:15002"
```

### Developer Access via Port-Forward

Each developer runs this once in a terminal before opening VS Code:
```bash
kubectl port-forward svc/spark-connect-lb 15002:15002 -n spark-system
# Forwarding from 127.0.0.1:15002 -> 15002
```

Then connect from VS Code / notebook:
```python
from pyspark.sql import SparkSession

spark = SparkSession.builder.remote("sc://localhost:15002").getOrCreate()
print(spark.version)  # should print 4.1.1
spark.sql("SELECT 1 AS test").show()
```

---

## 4.4 Trino

Trino runs a coordinator (always-on) and workers (autoscaled 2–8 based on active query count).

### Prepare Catalog Configs as Secrets

Trino catalog properties reference Key Vault secrets. Create the Kubernetes secret from Key Vault values:

```bash
# The CSI SecretProviderClass handles this — verify it exists:
kubectl get secretproviderclass -n trino trino-catalog-secrets
```

### Deploy

```bash
# Helm chart is pre-imported to ACR (see Step 02 §6 — no public Helm repo access)
WI_CLIENT_ID=$(az identity show \
  -g rg-forge-{alias}-{env} \
  -n id-forge-trino-{env} \
  --query clientId -o tsv)

helm upgrade --install trino \
  oci://forgeacr{alias}.azurecr.io/helm/trino \
  --version 1.36.0 \
  --namespace trino \
  --create-namespace \
  --values infra/helm/compute/trino/values.yaml \
  --set image.repository=forgeacr{alias}.azurecr.io/trino \
  --set image.tag=468 \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"=${WI_CLIENT_ID} \
  --wait --timeout 10m
```

Key sections in `infra/helm/compute/trino/values.yaml`:
```yaml
coordinator:
  jvm:
    maxHeapSize: "24G"
  resources:
    requests: { cpu: "4", memory: "28Gi" }
    limits:   { cpu: "8", memory: "28Gi" }
  nodeSelector:
    agentpool: trino

worker:
  replicas: 2        # initial; HPA scales to 8
  jvm:
    maxHeapSize: "48G"
  resources:
    requests: { cpu: "8",  memory: "56Gi" }
    limits:   { cpu: "16", memory: "56Gi" }
  nodeSelector:
    agentpool: trino

additionalCatalogs:
  lakehouse: |
    connector.name=delta_lake
    hive.metastore.uri=thrift://hive-metastore.hive-metastore.svc.cluster.local:9083
    delta.hive-catalog-name=hive
    fs.native-azure.enabled=true
    azure.auth-type=MANAGED_IDENTITY

  hive: |
    connector.name=hive
    hive.metastore.uri=thrift://hive-metastore.hive-metastore.svc.cluster.local:9083
    fs.native-azure.enabled=true
    azure.auth-type=MANAGED_IDENTITY

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 8
  targetCPUUtilizationPercentage: 60
```

### Verify

```bash
kubectl get pods -n trino
# NAME                    READY   STATUS    RESTARTS
# trino-coordinator-xxx   1/1     Running   0
# trino-worker-xxx-0      1/1     Running   0
# trino-worker-xxx-1      1/1     Running   0

# Port-forward coordinator and run a test query
kubectl port-forward -n trino svc/trino 8080:8080 &
sleep 2

# Using trino CLI (or curl)
curl -s -X POST http://localhost:8080/v1/statement \
  -H "X-Trino-User: platform-test" \
  -H "X-Trino-Catalog: tpch" \
  -H "X-Trino-Schema: tiny" \
  -d "SELECT count(*) FROM orders" | jq .

# Kill port-forward
kill %1
```

---

## 4.5 Compute Cluster Readiness Checklist

Before proceeding to Step 05:

```
[ ] All nodes in Ready state:               kubectl get nodes
[ ] Hive Metastore pod Running:             kubectl get pods -n hive-metastore
[ ] Spark Operator pod Running:             kubectl get pods -n spark-system
[ ] Spark CRDs installed:                   kubectl get crd | grep spark
[ ] spark-pi-test SparkApplication COMPLETED (ran and cleaned up)
[ ] Spark Connect LB IP assigned:           kubectl get svc -n spark-system spark-connect-lb
[ ] Spark Connect endpoint in Key Vault:    az keyvault secret show --name spark-connect-endpoint
[ ] Trino coordinator + 2 workers Running:  kubectl get pods -n trino
[ ] Trino test query returns results:       curl port-forward test above
[ ] Workload identity test passed:          test pod reads from ADLS bronze/ container
```

All green → proceed to Step 05.
