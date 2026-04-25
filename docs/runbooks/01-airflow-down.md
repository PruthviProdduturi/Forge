# Runbook: Airflow Down / DAGs Not Running

> **Severity:** P1 (DAGs stopped running) / P2 (UI inaccessible, DAGs still running via scheduler)
> **Audience:** On-call platform engineer

---

## Quick Diagnosis

```bash
# 1. Check all Airflow pods
kubectl get pods -n airflow --context forge-orch-dev

# Expected: scheduler, webserver, dag-processor all Running
# NAME                              READY   STATUS    RESTARTS
# airflow-scheduler-xxx             1/1     Running   0
# airflow-webserver-xxx             1/1     Running   0
# airflow-dag-processor-xxx         1/1     Running   0
# airflow-triggerer-xxx             1/1     Running   0

# 2. Check recent events
kubectl get events -n airflow --sort-by='.lastTimestamp' --context forge-orch-dev | tail -20

# 3. Check scheduler logs (last 100 lines)
kubectl logs -n airflow --context forge-orch-dev \
  -l component=scheduler --tail=100
```

---

## Scenario 1: Scheduler CrashLoopBackOff

**Symptom:** `airflow-scheduler` pod status is `CrashLoopBackOff` or `Error`.

```bash
# Inspect the crash
kubectl describe pod -n airflow --context forge-orch-dev \
  -l component=scheduler

kubectl logs -n airflow --context forge-orch-dev \
  -l component=scheduler --previous
```

**Common causes:**

| Error in logs | Cause | Fix |
|---|---|---|
| `could not connect to server: Connection refused` | Postgres DB unreachable | See [Postgres connectivity](#postgres-connectivity) |
| `Invalid configuration. The executor ... is not registered` | Wrong executor config | Check `AIRFLOW__CORE__EXECUTOR` in ConfigMap |
| `KeyError: 'AIRFLOW__CORE__FERNET_KEY'` | Missing secret | Recreate `airflow-webserver-secret` (see forge-up.sh Phase 4) |
| `dag-processor not running` | DAG processor pod crashed independently | Restart dag-processor deployment |

```bash
# Restart a specific component
kubectl rollout restart deployment airflow-scheduler -n airflow --context forge-orch-dev
kubectl rollout restart deployment airflow-webserver -n airflow --context forge-orch-dev
kubectl rollout restart deployment airflow-dag-processor -n airflow --context forge-orch-dev
```

---

## Scenario 2: Postgres Connectivity

**Symptom:** Scheduler logs show `could not connect to server` or `FATAL: password authentication failed`.

```bash
# Check the DB credentials secret
kubectl get secret airflow-db-credentials -n airflow --context forge-orch-dev -o yaml

# Test connectivity from inside the cluster (spin up a debug pod)
kubectl run psql-debug --rm -it --image=postgres:15 \
  --restart=Never -n airflow --context forge-orch-dev \
  -- psql "$(kubectl get secret airflow-db-credentials -n airflow \
    -o jsonpath='{.data.connection}' | base64 -d)"
```

**Fix — re-seed credentials:**

```bash
# The postgres password is in Key Vault
FORGE_PG_PASS=$(az keyvault secret show \
  --vault-name kv-forge-{alias}-dev \
  --name forge-airflow-db-password \
  --query value -o tsv)

# Recreate the secret
kubectl delete secret airflow-db-credentials -n airflow --context forge-orch-dev
kubectl create secret generic airflow-db-credentials \
  -n airflow --context forge-orch-dev \
  --from-literal=connection="postgresql://airflow:${FORGE_PG_PASS}@pg-forge-{alias}-dev.postgres.database.azure.com:5432/airflow"

kubectl rollout restart deployment airflow-scheduler -n airflow --context forge-orch-dev
```

---

## Scenario 3: DAG Processor Not Picking Up New DAGs

**Symptom:** New DAGs committed to git are not appearing in the UI after >5 minutes.

```bash
# Check git-sync sidecar
kubectl logs -n airflow --context forge-orch-dev \
  -l component=scheduler \
  -c git-sync --tail=50

# Expected: "level=info msg="syncing git" ... success=true"
# Problem: "level=error ... authentication required" or "repository not found"
```

**Fix — PAT expired or wrong credentials:**

```bash
# Rotate the PAT in Azure DevOps, then update the secret
kubectl delete secret airflow-git-credentials -n airflow --context forge-orch-dev
kubectl create secret generic airflow-git-credentials \
  -n airflow --context forge-orch-dev \
  --from-literal=GIT_SYNC_USERNAME="<ado-username>" \
  --from-literal=GIT_SYNC_PASSWORD="<new-pat>"

kubectl rollout restart deployment airflow-scheduler -n airflow --context forge-orch-dev
kubectl rollout restart deployment airflow-dag-processor -n airflow --context forge-orch-dev
```

**Fix — DAG has a parse error (blocking all DAGs from loading):**

```bash
# List dag parse errors
kubectl exec -n airflow --context forge-orch-dev \
  deployment/airflow-scheduler \
  -- airflow dags list-import-errors

# Common output:
# dag_id            | filepath                  | error
# ------------------|---------------------------|------------------------------
# bad_dag           | /opt/airflow/dags/bad.py  | SyntaxError: invalid syntax
```

Fix the syntax error in the DAG file, commit, push, and wait for git-sync (up to 30s).

---

## Scenario 4: SparkApplication Jobs Not Submitting

**Symptom:** DAG tasks using `SparkKubernetesOperator` are failing with `kubernetes.client.exceptions.ApiException`.

```bash
# Check the airflow-compute-kubeconfig secret
kubectl get secret airflow-compute-kubeconfig -n airflow --context forge-orch-dev

# Verify the kubeconfig inside is valid
kubectl get secret airflow-compute-kubeconfig -n airflow --context forge-orch-dev \
  -o jsonpath='{.data.config}' | base64 -d | \
  KUBECONFIG=/dev/stdin kubectl get nodes --context aks-forge-compute-{alias}-dev
```

**Fix — kubeconfig expired (AKS credential rotation):**

```bash
# Re-fetch compute cluster kubeconfig
az aks get-credentials \
  --resource-group rg-forge-{alias}-dev \
  --name aks-forge-compute-{alias}-dev \
  --file /tmp/compute-kubeconfig \
  --overwrite-existing

# Recreate the secret
kubectl delete secret airflow-compute-kubeconfig -n airflow --context forge-orch-dev
kubectl create secret generic airflow-compute-kubeconfig \
  -n airflow --context forge-orch-dev \
  --from-file=config=/tmp/compute-kubeconfig

kubectl rollout restart deployment airflow-scheduler -n airflow --context forge-orch-dev
```

---

## Escalation

If none of the above resolves the issue:

1. Capture all pod logs: `kubectl logs -n airflow --context forge-orch-dev -l release=airflow --all-containers=true > /tmp/airflow-logs.txt`
2. Capture pod describe output: `kubectl describe pods -n airflow --context forge-orch-dev > /tmp/airflow-describe.txt`
3. Check AKS node health: `kubectl get nodes --context forge-orch-dev`
4. Check AKS events at the node level: `kubectl get events -A --sort-by='.lastTimestamp' --context forge-orch-dev | grep -i "warn\|error\|fail" | tail -30`
5. Escalate with both files attached.
