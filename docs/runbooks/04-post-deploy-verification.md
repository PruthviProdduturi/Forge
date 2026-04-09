# Runbook: Post-Deploy Verification

> **When to use:** After `forge-up.sh` completes successfully for the first time, or after a full re-deploy.
> **Time required:** ~20 minutes
> **Audience:** Platform engineer running the dev environment

---

## Overview

Run these steps in order. Each step gates the next — don't skip ahead if something is red.

```
Step 1 — Postgres grants         (one-time, required for Airflow)
Step 2 — Pod health checks       (all services running)
Step 3 — ADLS connectivity       (storage accessible from cluster)
Step 4 — Trino query             (Delta tables readable)
Step 5 — Airflow DAGs            (git-sync pulling, scheduler running)
Step 6 — Smoke test              (end-to-end bronze→silver→gold→Trino)
Step 7 — Portal                  (UI accessible, health checks green)
Step 8 — Spark Connect           (reachable from laptop)
```

---

## Step 1 — Postgres Schema Grants (one-time)

> Skip if you did NOT use `--skip-pg-grants` during forge-up.sh.
> Only needs to run once per environment — grants persist in Postgres.

Get the Airflow managed identity name:
```bash
az identity show \
  --resource-group rg-forge-prproddu-dev \
  --name id-forge-airflow-dev \
  --query name -o tsv
# Expected: id-forge-airflow-dev
```

Spin up a Postgres client pod inside the orchestration cluster:
```bash
kubectl run pg-grants --rm -it --restart=Never \
  --image=bitnami/postgresql:16 \
  --namespace airflow \
  --context aks-forge-orchestration-prproddu-dev \
  -- bash
```

Inside the pod, fetch an AAD token and run the grants:
```bash
# Inside the pod — fetch token for Postgres AAD auth
TOKEN=$(curl -s \
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://ossrdbms-aad.database.windows.net" \
  -H "Metadata: true" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

PG_HOST="psql-forge-prproddu-dev.postgres.database.azure.com"
MI_NAME="id-forge-airflow-dev"

# Grant database-level access
PGPASSWORD="$TOKEN" psql \
  "host=${PG_HOST} port=5432 dbname=postgres user=${MI_NAME} sslmode=require" \
  -c "GRANT ALL PRIVILEGES ON DATABASE airflow TO \"${MI_NAME}\";"

# Grant schema-level access
PGPASSWORD="$TOKEN" psql \
  "host=${PG_HOST} port=5432 dbname=airflow user=${MI_NAME} sslmode=require" \
  -c "GRANT ALL ON SCHEMA public TO \"${MI_NAME}\";"

PGPASSWORD="$TOKEN" psql \
  "host=${PG_HOST} port=5432 dbname=airflow user=${MI_NAME} sslmode=require" \
  -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO \"${MI_NAME}\";"

echo "Grants complete"
exit
```

**Expected:** All 3 commands return `GRANT` with no errors.

---

## Step 2 — Pod Health Checks

Check every namespace on both clusters. All pods should be `Running` or `Completed`.

### Compute cluster (`aks-forge-compute-prproddu-dev`)

```bash
# Spark Operator
kubectl get pods -n spark-operator --context aks-forge-compute-prproddu-dev
# Expected: spark-operator-controller-* Running

# Spark Connect
kubectl get pods -n spark-connect --context aks-forge-compute-prproddu-dev
# Expected: spark-connect-* Running

# Hive Metastore
kubectl get pods -n hive --context aks-forge-compute-prproddu-dev
# Expected: hive-metastore-* Running

# Trino
kubectl get pods -n trino --context aks-forge-compute-prproddu-dev
# Expected: trino-coordinator-* Running, trino-worker-* Running, trino-auth-proxy-* Running
```

### Orchestration cluster (`aks-forge-orchestration-prproddu-dev`)

```bash
# Airflow
kubectl get pods -n airflow --context aks-forge-orchestration-prproddu-dev
# Expected: airflow-scheduler-* Running, airflow-webserver-* Running, airflow-triggerer-* Running

# Portal
kubectl get pods -n portal --context aks-forge-orchestration-prproddu-dev
# Expected: forge-portal-api-* Running, forge-portal-web-* Running

# Ingress
kubectl get pods -n ingress-nginx --context aks-forge-orchestration-prproddu-dev
# Expected: ingress-nginx-controller-* Running
```

**If a pod is CrashLoopBackOff or Pending:**
```bash
kubectl describe pod <pod-name> -n <namespace> --context <cluster>
kubectl logs <pod-name> -n <namespace> --context <cluster> --previous
```

---

## Step 3 — ADLS Connectivity

Verify the compute cluster can reach ADLS Gen2:

```bash
kubectl run adls-check --rm -it --restart=Never \
  --image=mcr.microsoft.com/azure-cli \
  --namespace spark-jobs \
  --context aks-forge-compute-prproddu-dev \
  -- bash -c "
    az login --identity --allow-no-subscriptions
    az storage container list \
      --account-name forgeadlsprproddudev \
      --auth-mode login \
      --query '[].name' -o tsv
  "
```

**Expected output:**
```
bronze
code
gold
sandbox
silver
```

If you see `403 Forbidden` → check RBAC role assignments on the storage account (see [03-adls-connectivity.md](./03-adls-connectivity.md)).

---

## Step 4 — Trino Query

Port-forward the Trino auth proxy and run a test query:

```bash
# Terminal 1 — leave running
kubectl port-forward svc/trino-auth-proxy 8080:8080 \
  -n trino --context aks-forge-compute-prproddu-dev
```

```bash
# Terminal 2
curl -s http://localhost:8080/v1/statement \
  -H "X-Trino-User: prproddu" \
  -H "X-Trino-Catalog: system" \
  -H "X-Trino-Schema: runtime" \
  -d "SELECT node_id, state FROM system.runtime.nodes" \
  | python3 -m json.tool | grep -E "nodeId|state"
```

**Expected:** One coordinator node `state: active`.

---

## Step 5 — Airflow DAGs

```bash
# Check git-sync is pulling DAGs
kubectl logs -n airflow --context aks-forge-orchestration-prproddu-dev \
  -l component=scheduler --tail=50 | grep -i "dag\|sync\|error"

# List DAGs via Airflow CLI
kubectl exec -n airflow --context aks-forge-orchestration-prproddu-dev \
  deploy/airflow-scheduler \
  -- airflow dags list
```

**Expected:** `nyc_taxi_bronze`, `nyc_taxi_silver`, `nyc_taxi_gold`, `forge_demo` listed.

If DAGs are missing — check git-sync secret:
```bash
kubectl get secret airflow-git-credentials -n airflow \
  --context aks-forge-orchestration-prproddu-dev
```

---

## Step 6 — Smoke Test (end-to-end)

Triggers the full bronze→silver→gold pipeline using NYC TLC test data and verifies output in Trino.

```bash
bash infra/scripts/forge-up.sh \
  --env dev \
  --skip-infra \
  --skip-build \
  --skip-pg-grants \
  --skip-sync \
  --run-test \
  --test-date 2023-01-15
```

**What it does:**
1. Seeds raw NYC TLC Parquet data into `bronze/nyc/taxi/trips/2023-01-15/`
2. Triggers `nyc_taxi_bronze` DAG → ingests to Delta bronze table
3. Triggers `nyc_taxi_silver` DAG → cleans + DQ validates → silver Delta table
4. Triggers `nyc_taxi_gold` DAG → aggregates → gold Delta table
5. Queries Trino: `SELECT COUNT(*) FROM lakehouse.gold.nyc_taxi_trips WHERE date = '2023-01-15'`
6. Asserts count > 0

**Expected:** `✓ Smoke test passed — {n} rows in gold`

---

## Step 7 — Portal

Open in browser:
```
https://forge-portal-prproddu-dev.westcentralus.cloudapp.azure.com
```

Check:
- [ ] Page loads (not 502/504) — redirects to Azure AD login if not authenticated
- [ ] After AAD login, platform status panel shows all components
- [ ] Spark, Trino, Airflow show as healthy (green)
- [ ] ADLS storage account shown
- [ ] No errors in browser console

Check API directly (unauthenticated — health endpoint is public):
```bash
curl -s https://forge-portal-prproddu-dev.westcentralus.cloudapp.azure.com/api/health \
  | python3 -m json.tool
```

**Expected:** JSON with `status: healthy` for each component.

---

## Step 8 — Spark Connect from Laptop

```bash
# Port-forward Spark Connect
kubectl port-forward svc/spark-connect 15002:15002 \
  -n spark-connect --context aks-forge-compute-prproddu-dev
```

In a Python session or notebook:
```python
from forge_sdk import forge_connect

spark = forge_connect()  # connects to localhost:15002

# Basic test
spark.sql("SELECT 1 AS test").show()

# Read from ADLS via the cluster
df = spark.read.format("delta").load(
    "abfss://gold@forgeadlsprproddudev.dfs.core.windows.net/nyc/taxi/trips"
)
print(f"Gold row count: {df.count()}")
```

**Expected:** Row count matches Trino result from Step 6.

---

## All Green — Update Status

Once all 8 steps pass, update `STATUS.md`:

```bash
# Mark these as Done in STATUS.md:
# - Deployed to Azure (dev)
# - All images built and pushed to ACR
# - Charts deployed to clusters
# - forge-up.sh end-to-end successful run
# - Spark Connect deployed and reachable
# - Trino queryable
# - Hive Metastore connected
# - Airflow deployed + git-sync pulling DAGs
# - DAG run end-to-end
# - Portal deployed
# - Smoke test passed
```

---

## Related

- [03-adls-connectivity.md](./03-adls-connectivity.md) — ADLS access failures
- [01-airflow-down.md](./01-airflow-down.md) — Airflow pod issues
- [forge-up.sh guide](./00-forge-up.md) — Re-deploy flags
