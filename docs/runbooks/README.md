# Forge — Operational Runbooks

Step-by-step incident response guides for the Forge platform. Each runbook covers symptoms, diagnosis steps, and remediation paths for a specific failure class.

---

| Runbook | Severity | Description |
|---|---|---|
| [Post-Deploy Verification](04-post-deploy-verification.md) | — | 8-step checklist after forge-up.sh: Postgres grants, pod health, ADLS, Trino, Airflow, smoke test, portal, Spark Connect |
| [Airflow Down / DAGs Not Running](01-airflow-down.md) | P1/P2 | Scheduler crash, DB connectivity, git-sync failures, SparkKubernetesOperator failures |
| [DQ Failure — Pipeline Blocked](02-dq-failure.md) | P2/P3 | Critical DQ rule failures blocking writes, threshold calibration, emergency bypass |
| [ADLS Connectivity Failures](03-adls-connectivity.md) | P1 | 403 errors, missing role assignments, workload identity issues, firewall rules |

---

## General First Steps

Before diving into a specific runbook:

```bash
# 1. Check overall cluster health
kubectl get nodes --context forge-compute-dev
kubectl get nodes --context forge-orch-dev

# 2. Check for any failing pods across all namespaces
kubectl get pods -A --context forge-compute-dev | grep -v Running | grep -v Completed
kubectl get pods -A --context forge-orch-dev   | grep -v Running | grep -v Completed

# 3. Check portal health API
curl http://forge-portal-prproddu-dev.northcentralus.cloudapp.azure.com/api/health
curl http://forge-portal-prproddu-dev.northcentralus.cloudapp.azure.com/api/status
```

## Accessing Logs

| Component | Command |
|---|---|
| Airflow scheduler | `kubectl logs -n airflow -l component=scheduler --context forge-orch-dev` |
| Airflow webserver | `kubectl logs -n airflow -l component=webserver --context forge-orch-dev` |
| Spark driver (last job) | `kubectl logs -n spark-jobs -l spark-role=driver --context forge-compute-dev` |
| Trino coordinator | `kubectl logs -n trino -l app=trino-coordinator --context forge-compute-dev` |
| Hive Metastore | `kubectl logs -n hive -l app=hive-metastore --context forge-compute-dev` |
| Portal API | `kubectl logs -n portal -l app=portal-api --context forge-orch-dev` |

## Key Resource Names (dev)

| Resource | Name |
|---|---|
| Compute cluster | `aks-forge-compute-prproddu-dev` |
| Orchestration cluster | `aks-forge-orchestration-prproddu-dev` |
| Resource group | `rg-forge-prproddu-dev` |
| Storage account | `forgestoragedev` |
| Key Vault | `kv-forge-prproddu-dev` |
| ACR | `forgeacrprproddu` |
| Postgres | `pg-forge-prproddu-dev` |
