# Step 04 — Deploy Compute Cluster

> **Prerequisite:** Step 03 complete. Both AKS clusters are running. All images are in ACR.
> **Cluster context:** `aks-forge-compute-{env}`

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io)

---

## Overview

The compute cluster hosts Spark (Operator + Connect server) and Trino. This step deploys them in order:

```
1. Hive Metastore          ← required by Trino and Spark for Delta catalog
2. Spark Operator          ← CRD controller that manages SparkApplication resources
3. Spark Connect Server    ← persistent server for interactive development
4. Trino                   ← federated SQL engine
```

Set your kubectl context before running any command in this step:
```bash
az aks get-credentials \
  --resource-group rg-forge-compute-{env} \
  --name aks-forge-compute-{env} \
  --overwrite-existing

kubectl config current-context   # verify
kubectl get nodes                 # verify all nodes Ready
```

---

## 4.1 Hive Metastore

Trino and Spark both use the Hive Metastore (HMS) to look up Delta table schemas by name. HMS stores table metadata (location, schema, partition info) in PostgreSQL.

### Deploy

```bash
kubectl create namespace hive-metastore --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install hive-metastore \
  infra/helm/compute/hive-metastore \
  --namespace hive-metastore \
  --set image.repository=forgeacr{alias}.azurecr.io/hive-metastore \
  --set image.tag=3.1.3 \
  --set db.host=$(az keyvault secret show --vault-name kv-forge-{env} --name hms-postgres-host --query value -o tsv) \
  --set db.password="" \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"=$(az identity show -g rg-forge-platform-{env} -n id-forge-compute-{env} --query clientId -o tsv) \
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
  --version 1.4.6 \
  --namespace spark-system \
  --create-namespace \
  --values infra/helm/compute/spark-operator/values.yaml \
  --set image.repository=forgeacr{alias}.azurecr.io/spark-operator \
  --set image.tag=1.4.6 \
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

The Spark Connect server provides a persistent gRPC endpoint for remote PySpark development via VS Code.

**Capacity planning (team of 15, Standard_E96_v5 nodes):**
- Each driver supports ~10 concurrent active sessions
- Deploy **2 instances**: `spark-connect-a` (primary) and `spark-connect-b` (overflow)
- Executors: 8 cores / 48 GiB each — up to 20 executors per instance (dynamic allocation)
- E96_v5 (96 vCPUs / 672 GiB RAM) fits ~8 executors per node — executors scale across the pool

### Deploy

```bash
WI_CLIENT_ID=$(az identity show \
  -g rg-forge-platform-{alias}-{env} \
  -n id-forge-compute-{alias}-{env} \
  --query clientId -o tsv)

# Primary instance
helm upgrade --install spark-connect-a \
  infra/helm/compute/spark-connect \
  --namespace spark-system \
  --set nameOverride=spark-connect-a \
  --set image.repository=forgeacr{alias}.azurecr.io/spark \
  --set image.tag=4.1.1 \
  --set adls.account=forgeadls{alias}{env} \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"=${WI_CLIENT_ID} \
  --wait --timeout 5m

# Overflow / standby instance
helm upgrade --install spark-connect-b \
  infra/helm/compute/spark-connect \
  --namespace spark-system \
  --set nameOverride=spark-connect-b \
  --set image.repository=forgeacr{alias}.azurecr.io/spark \
  --set image.tag=4.1.1 \
  --set adls.account=forgeadls{alias}{env} \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"=${WI_CLIENT_ID} \
  --wait --timeout 5m
```

### Get the Spark Connect Endpoints

Each instance gets its own internal Azure Load Balancer IP (VNet / VPN only):

```bash
kubectl get svc -n spark-system -l app.kubernetes.io/managed-by=Helm
# NAME                  TYPE           CLUSTER-IP    EXTERNAL-IP    PORT(S)
# spark-connect-a-lb    LoadBalancer   10.100.1.50   10.4.0.10      15002:...
# spark-connect-b-lb    LoadBalancer   10.100.1.51   10.4.0.11      15002:...

SC_A=$(kubectl get svc -n spark-system spark-connect-a-lb \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
SC_B=$(kubectl get svc -n spark-system spark-connect-b-lb \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

echo "Primary:  sc://${SC_A}:15002"
echo "Overflow: sc://${SC_B}:15002"
```

Store in Key Vault for developer distribution:
```bash
az keyvault secret set --vault-name kv-forge-{alias}-{env} \
  --name spark-connect-primary   --value "sc://${SC_A}:15002"
az keyvault secret set --vault-name kv-forge-{alias}-{env} \
  --name spark-connect-overflow  --value "sc://${SC_B}:15002"
```

### Verify from VS Code / Notebook

```python
from pyspark.sql import SparkSession

# Use the primary endpoint (retrieve from Key Vault or ask platform team)
CONNECT_URL = "sc://10.4.0.10:15002"

spark = SparkSession.builder.remote(CONNECT_URL).getOrCreate()
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
helm upgrade --install trino \
  oci://forgeacr{alias}.azurecr.io/helm/trino \
  --version 0.31.0 \
  --namespace trino \
  --create-namespace \
  --values infra/helm/compute/trino/values.yaml \
  --set image.repository=forgeacr{alias}.azurecr.io/trino \
  --set image.tag=438 \
  --set serviceAccount.annotations."azure\.workload\.identity/client-id"=$(az identity show -g rg-forge-platform-{env} -n id-forge-read-{env} --query clientId -o tsv) \
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
[ ] Spark Connect a+b LB IPs assigned:      kubectl get svc -n spark-system
[ ] Spark Connect endpoints in Key Vault:   az keyvault secret show --name spark-connect-primary
[ ] Trino coordinator + 2 workers Running:  kubectl get pods -n trino
[ ] Trino test query returns results:       curl port-forward test above
[ ] Workload identity test passed:          test pod reads from ADLS bronze/ container
```

All green → proceed to Step 05.
