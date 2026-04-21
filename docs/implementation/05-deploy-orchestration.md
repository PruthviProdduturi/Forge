# Step 05 — Deploy Orchestration Cluster

> **Prerequisite:** Step 04 complete. Compute cluster is fully operational.
> **Cluster context:** `aks-forge-orchestration-{alias}-{env}`

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org)

---

> **Automated:** `forge-up.sh` phase **[7/8]** handles all orchestration cluster deployments
> automatically (ingress-nginx, Airflow, Portal).
> Run `bash infra/scripts/forge-up.sh --env dev --alias prproddu --skip-infra --git-pat <pat>` to
> deploy (or re-deploy) all orchestration components in one step.
>
> This document is a reference for the individual components, access instructions, and
> troubleshooting. You do not need to run these commands manually unless debugging a specific
> component.

---

## Overview

The orchestration cluster hosts Airflow and the Developer Portal. Lineage is handled by Microsoft
Purview — a managed service, no in-cluster deployment required. Deploy in this order:

```
1. PostgreSQL setup       ← metadata DB for Airflow (Azure managed, configured by forge-up.sh [3/7])
2. ingress-nginx          ← NGINX ingress controller with Azure public LoadBalancer
3. Airflow                ← orchestrator (depends on PostgreSQL)
4. Portal                 ← frontend + backend (depends on Airflow)
```

---

## 5.1 PostgreSQL — Airflow Metadata Database

`forge-up.sh` phase [3/7] creates the `airflow` database and user on the Azure Flexible Server
(`psql-forge-{alias}-{env}`). The DB password is seeded to Key Vault in phase [2/7].

Manual setup (if needed):
```bash
PG_HOST=$(az postgres flexible-server show \
  --resource-group rg-forge-{alias}-{env} \
  --name psql-forge-{alias}-{env} \
  --query fullyQualifiedDomainName -o tsv)

PG_PASS="<admin-password>"

psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require password=${PG_PASS}" \
  -c "CREATE DATABASE airflow;"

AIRFLOW_DB_PASS=$(openssl rand -base64 32)
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require password=${PG_PASS}" \
  -c "CREATE USER airflow WITH PASSWORD '${AIRFLOW_DB_PASS}';"
psql "host=${PG_HOST} dbname=postgres user=forgeadmin sslmode=require password=${PG_PASS}" \
  -c "GRANT ALL PRIVILEGES ON DATABASE airflow TO airflow;"

az keyvault secret set \
  --vault-name kv-forge-{alias}-{env} \
  --name airflow-db-password \
  --value "${AIRFLOW_DB_PASS}"
```

---

## 5.2 Apache Airflow

### Deployed configuration

| Property | Value |
|----------|-------|
| Helm chart | `oci://forgeacrprproddu.azurecr.io/helm/airflow:1.20.0` |
| Image | `forgeacrprproddu.azurecr.io/airflow:3.1.8` |
| Executor | `LocalExecutor` (dev) / `KubernetesExecutor` (prod) |
| Postgres DB | `psql-forge-prproddu-dev` → database `airflow` |
| DAG delivery (dev) | ADLS `code/dags/` + dag-restore init container (git-sync disabled) |
| DAG delivery (prod) | git-sync from Azure DevOps main branch |
| Values file | `infra/helm/orchestration/airflow/values.yaml` |
| Compute K8s connection | `kubernetes_compute_cluster` → compute cluster kubeconfig |

### Access

```bash
# Webserver (UI) port-forward
kubectl port-forward svc/airflow-webserver 8081:8080 \
  -n airflow \
  --context aks-forge-orchestration-prproddu-dev
# Open: http://localhost:8081
# Login: Azure AD OAuth2 (AAD group membership determines Airflow role)

# API server port-forward (REST API /api/v2/*)
kubectl port-forward svc/airflow-api-server 8082:8080 \
  -n airflow \
  --context aks-forge-orchestration-prproddu-dev
# POST http://localhost:8082/auth/token  → JWT
# GET  http://localhost:8082/api/v2/dags → list DAGs
```

### Verify

```bash
kubectl get pods -n airflow --context aks-forge-orchestration-prproddu-dev
# NAME                                    READY   STATUS    RESTARTS
# airflow-dag-processor-xxx               1/1     Running   0
# airflow-scheduler-xxx                   1/1     Running   0
# airflow-webserver-xxx                   1/1     Running   0
# airflow-triggerer-xxx                   1/1     Running   0

# Check dag-restore init container ran successfully (on pod start)
kubectl logs -n airflow <dag-processor-pod> -c dag-restore \
  --context aks-forge-orchestration-prproddu-dev
# Should show: dag-restore: N DAG(s) restored from forgeadlsdsengdev/code/dags/

# Check DAGs are loaded
kubectl exec -n airflow <dag-processor-pod> -c dag-processor \
  --context aks-forge-orchestration-prproddu-dev \
  -- ls /opt/airflow/dags/
```

### DAG locations (dev)

DAGs are stored in ADLS and synced manually. There is no directory structure — each DAG is a single flat `.py` file.

| What | Where |
|------|-------|
| DAG files (durable) | ADLS `code/dags/{job_name}_dag.py` |
| DAG files (live) | dag-processor pod `/opt/airflow/dags/` |
| Restored on restart | `dag-restore` init container pulls from ADLS |

### SDK Distribution

`forge_sdk` and `forge_dq` are proper pip packages baked into the Spark Docker image at build time — no runtime ADLS download, no `spark.submit.pyFiles`. When the SDK changes, rebuild the Spark image via `forge-up.sh` Phase 5 (or `--skip-infra --skip-sync` to rebuild images only).

### Deploying updated pipelines

```bash
# Sync one pipeline (--job is required; there is no bulk sync mode)
FORGE_ENV="dev" OWNER_ALIAS="DSEng" bash infra/scripts/sync-jobs.sh --job <job_name>

# Dry-run to preview what would change
FORGE_ENV="dev" OWNER_ALIAS="DSEng" bash infra/scripts/sync-jobs.sh --job <job_name> --dry-run
```

`sync-jobs.sh`:
1. Runs `forge generate` for the named job
2. Uploads Spark job to `ADLS code/spark/jobs/`
3. Uploads DQ rules to `ADLS code/dq/rules/`
4. **Uploads DAG to `ADLS code/dags/`** — durable, survives pod restarts
5. **kubectl execs Python inside dag-processor** to pull the DAG from ADLS into `/opt/airflow/dags/` immediately — no pod restart needed, dag-processor rescans every 30s

On pod restart, the `dag-restore` init container automatically restores all DAGs from `ADLS code/dags/`. No manual re-sync is needed after a cluster redeployment.

### Airflow values (key sections)

```yaml
# infra/helm/orchestration/airflow/values.yaml (excerpt)
executor: KubernetesExecutor

dags:
  gitSync:
    enabled: false   # dev: DAGs delivered via sync-jobs.sh → ADLS → dag-restore init container

dagProcessor:
  podLabels:
    azure.workload.identity/use: "true"
  extraVolumes:
    - name: dags
      emptyDir: {}
  extraVolumeMounts:
    - name: dags
      mountPath: /opt/airflow/dags
  extraInitContainers:
    - name: dag-restore
      # Image set by forge-up.sh --set to forge-airflow ACR image
      image: "apache/airflow:3.1.8-python3.11"
      command: [python3, "-c", "..."]  # downloads code/dags/*.py from ADLS via workload identity
      envFrom:
        - configMapRef:
            name: forge-platform-config  # provides FORGE_STORAGE_ACCOUNT
      volumeMounts:
        - name: dags
          mountPath: /opt/airflow/dags

webserver:
  service:
    type: ClusterIP

env:
  - name: AIRFLOW__SECRETS__BACKEND
    value: "airflow.providers.microsoft.azure.secrets.key_vault.AzureKeyVaultBackend"
```

---

## 5.3 Developer Portal

### Deployed configuration

| Property | Value |
|----------|-------|
| URL | `https://forge-portal-prproddu-dev.westcentralus.cloudapp.azure.com` |
| Auth mode | Azure AD OAuth2 via `portal-auth-proxy` (Flask + MSAL ConfidentialClientApp) |
| TLS | cert-manager / Let's Encrypt (ACME HTTP-01 on NGINX ingress) |
| Values file | `infra/helm/orchestration/portal/values.yaml` |

### Access

The portal is available publicly at:
```
https://forge-portal-prproddu-dev.westcentralus.cloudapp.azure.com
```

**Portal endpoints:**

| Path | What |
|---|---|
| `/` | Developer portal (Next.js UI) |
| `/api/health` | API health check (unauthenticated) |
| `/api/pipelines` | List all DAGs + last run state |
| `/api/status` | Cluster health (both clusters) |
| `/api/docs` | FastAPI auto-docs (Swagger UI) |

### Access without the public URL (port-forward)

```bash
# Option 1 — port-forward the NGINX ingress controller (full portal with API routing)
kubectl port-forward svc/ingress-nginx-controller 8080:80 \
  -n ingress-nginx \
  --context aks-forge-orchestration-prproddu-dev
# Open: http://localhost:8080

# Option 2 — port-forward directly to portal-web (UI only)
kubectl port-forward svc/portal-web 3001:3001 \
  -n portal \
  --context aks-forge-orchestration-prproddu-dev
# Open: http://localhost:3001  (note: /api/* won't work — use Option 1 for full access)

# Option 3 — port-forward directly to portal-api (API only)
kubectl port-forward svc/portal-api 8080:8080 \
  -n portal \
  --context aks-forge-orchestration-prproddu-dev
# Open: http://localhost:8080/api/health
#        http://localhost:8080/api/docs
```

### Airflow access via portal

The portal provides a link to the Airflow UI. The Airflow webserver is ClusterIP — use the
port-forward from Section 5.2 directly, or access it through the portal's proxy.

### Verify

```bash
kubectl get pods -n portal --context aks-forge-orchestration-prproddu-dev
# NAME                    READY   STATUS    RESTARTS
# portal-api-xxx          1/1     Running   0
# portal-web-xxx          1/1     Running   0

curl -s https://forge-portal-prproddu-dev.westcentralus.cloudapp.azure.com/api/health
# Expected: {"status": "ok", ...}
```

### Portal internals — Airflow connectivity

The portal API calls Airflow inside the orchestration cluster via:
```
http://airflow-webserver.airflow.svc.cluster.local:8080
```
This is a cluster-internal DNS name — both pods are on the same cluster.

### Portal internals — Compute cluster connectivity

Trino and Spark Connect run on the compute cluster. The portal probes these via internal
LoadBalancer IPs on the shared VNet:

```bash
# Get Trino internal LB IP (set after compute cluster is deployed)
kubectl get svc trino -n trino \
  --context aks-forge-compute-prproddu-dev \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

---

## 5.4 ADLS Path Schema

Job manifests (`.forge.ts`) use a structured path schema for all source and output references:

```
abfss://{container}@{storage}/{category}/{entity}/{audience}/{metricsCohort}/{assetName}/{version}/{name}
```

Example in a `.forge.ts` manifest:
```typescript
source: {
  name: "TlcYellowTrip",
  version: 1,
  path: {
    container: "raw",
    category: "Transport",
    entity: "Trip",
    audience: "Public",
    metricsCohort: "Rideshare",
    assetName: "NycTlc",
  },
  format: "parquet",
},
output: {
  name: "NycTaxiBronze",
  version: 1,
  path: {
    container: "bronze",
    category: "Transport",
    entity: "Trip",
    audience: "Internal",
    metricsCohort: "Rideshare",
    assetName: "NycTaxi",
  },
}
```

---

## 5.5 Purview OpenLineage Integration

Microsoft Purview is the lineage backend — a managed Azure service provisioned via Bicep (Step 03).
No in-cluster deployment is required. Airflow emits OpenLineage events automatically via the
`openlineage-airflow` provider.

### Assign Purview Data Curator role

```bash
PURVIEW_ACCOUNT="purview-forge-{env}"

az purview account add-root-collection-admin \
  --account-name "${PURVIEW_ACCOUNT}" \
  --resource-group rg-forge-platform-{env} \
  --object-id "$(az identity show \
    --name id-forge-read-{env} \
    --resource-group rg-forge-platform-{env} \
    --query principalId -o tsv)"
```

Or in the Purview governance portal:
1. Open `https://purview-forge-{env}.purview.azure.com`
2. Go to **Data Map** → **Collections** → root collection → **Role assignments**
3. Add `id-forge-read-{env}` to the **Data Curators** role

### Airflow values for OpenLineage

```yaml
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

---

## 5.6 Orchestration Cluster Readiness Checklist

```
[ ] PostgreSQL airflow database created
[ ] Airflow dag-processor pod Running:     kubectl get pods -n airflow
[ ] Airflow scheduler pod Running
[ ] Airflow webserver pod Running
[ ] Airflow triggerer pod Running
[ ] forge-platform-config ConfigMap present: kubectl get cm forge-platform-config -n airflow
[ ] dag-restore init container logs show DAGs restored (kubectl logs <pod> -c dag-restore)
[ ] Airflow DAGs listed: kubectl exec <dag-processor-pod> -c dag-processor -- ls /opt/airflow/dags/
[ ] kubernetes_compute_cluster connection configured
[ ] Portal API pod Running:                kubectl get pods -n portal
[ ] Portal Web pod Running
[ ] ingress-nginx controller Running:      kubectl get pods -n ingress-nginx
[ ] Portal accessible at https://forge-portal-prproddu-dev.westcentralus.cloudapp.azure.com
[ ] Portal login: Azure AD OAuth2 (redirects to AAD on first visit)
[ ] Portal /api/health returns 200
[ ] Portal /api/pipelines lists DAGs from Airflow
[ ] Portal /api/status shows both cluster states
[ ] Purview account reachable from cluster (non-000 HTTP status)
[ ] id-forge-read-{env} has Purview Data Curator role
```

All green → proceed to Step 06 (CI/CD pipeline configuration).
