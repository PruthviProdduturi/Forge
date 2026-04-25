# Forge — Operational Runbooks

Step-by-step incident response guides for the Forge platform. Each runbook covers symptoms, diagnosis steps, and remediation paths for a specific failure class.

---

| Runbook | Severity | Description |
|---|---|---|
| [Create a New Pipeline](05-create-pipeline.md) | — | End-to-end: manifest → generate → sync → dev test → PR |
| [Post-Deploy Verification](04-post-deploy-verification.md) | — | 8-step checklist after forge-up.sh: Postgres grants, pod health, ADLS, Trino, Airflow, smoke test, portal, Spark Connect |
| [Airflow Down / DAGs Not Running](01-airflow-down.md) | P1/P2 | Scheduler crash, DB connectivity, git-sync failures, SparkKubernetesOperator failures |
| [DQ Failure — Pipeline Blocked](02-dq-failure.md) | P2/P3 | Critical DQ rule failures blocking writes, threshold calibration, emergency bypass |
| [ADLS Connectivity Failures](03-adls-connectivity.md) | P1 | 403 errors, missing role assignments, workload identity issues, firewall rules |

---

## General First Steps

Before diving into a specific runbook:

```bash
# Set context shortcuts (adjust alias if not {alias})
COMPUTE="aks-forge-compute-{alias}-dev"
ORCH="aks-forge-orchestration-{alias}-dev"

# 1. Check overall cluster health
kubectl get nodes --context "$COMPUTE"
kubectl get nodes --context "$ORCH"

# 2. Check for any failing pods across all namespaces
kubectl get pods -A --context "$COMPUTE" | grep -v Running | grep -v Completed
kubectl get pods -A --context "$ORCH"    | grep -v Running | grep -v Completed

# 3. Check portal health API (unauthenticated endpoint)
curl https://forge-portal-{alias}-dev.northcentralus.cloudapp.azure.com/api/health
curl https://forge-portal-{alias}-dev.northcentralus.cloudapp.azure.com/api/status
```

## Accessing Logs

| Component | Command |
|---|---|
| Airflow scheduler | `kubectl logs -n airflow -l component=scheduler --context aks-forge-orchestration-{alias}-dev` |
| Airflow webserver | `kubectl logs -n airflow -l component=webserver --context aks-forge-orchestration-{alias}-dev` |
| Spark driver (last job) | `kubectl logs -n spark-jobs -l spark-role=driver --context aks-forge-compute-{alias}-dev` |
| Trino coordinator | `kubectl logs -n trino -l app=trino-coordinator --context aks-forge-compute-{alias}-dev` |
| Hive Metastore | `kubectl logs -n hive -l app=hive-metastore --context aks-forge-compute-{alias}-dev` |
| Portal API | `kubectl logs -n portal -l app=portal-api --context aks-forge-orchestration-{alias}-dev` |

## Key Resource Names (dev — alias {alias})

| Resource | Name |
|---|---|
| Compute cluster | `aks-forge-compute-{alias}-dev` |
| Orchestration cluster | `aks-forge-orchestration-{alias}-dev` |
| Resource group | `rg-forge-{alias}-dev` (alias) / `rg-forge-dev` (shared/no-alias) |
| Storage account | `forgeadls{alias}dev` |
| Key Vault | `kv-forge-{alias}-dev` (alias) / `kv-forge-eaa4a83d-dev` (shared) |
| ACR | `forgeacr{alias}` (alias) / `forgeacreaa4a83d` (shared) |
| Postgres | `psql-forge-{alias}-dev` (alias) / `psql-forge-eaa4a83d-dev` (shared) |
