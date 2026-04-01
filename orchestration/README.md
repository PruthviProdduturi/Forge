# Orchestration

Airflow DAGs that schedule and coordinate Spark jobs across the medallion lakehouse.

## Directory layout

```
orchestration/
  airflow/
    dags/
      ingestion/         # Bronze layer DAGs (one per bronze job)
      transformation/    # Silver + gold layer DAGs
```

## How DAGs get here

1. Engineer writes/edits a `.forge.ts` manifest in `examples/src/spark/jobs/`
2. `forge generate` produces the `.py` job and `_dag.py` in `examples/src/airflow/dags/`
3. `infra/scripts/sync-jobs.sh` copies DAGs to `orchestration/airflow/dags/`
4. Airflow git-sync polls this path every 30s and picks up new/changed DAGs

**Never edit DAG files directly.** They are fully generated from the manifest. Run `forge generate` then `sync-jobs.sh`.

## DAG naming

| Manifest `name` | DAG file | DAG id |
|---|---|---|
| `nyc_taxi_bronze` | `ingestion/nyc_taxi_bronze_dag.py` | `nyc_taxi_bronze` |
| `nyc_taxi_silver` | `transformation/nyc_taxi_silver_dag.py` | `nyc_taxi_silver` |

## SparkKubernetesOperator pattern

Every DAG uses `SparkKubernetesOperator` with:
- `kubernetes_conn_id="kubernetes_compute_cluster"` — cross-cluster connection to compute AKS
- `namespace="spark-jobs"` — where SparkApplication CRDs land
- `application_file` — inline SparkApplication YAML referencing the ADLS job script

## DAG dependencies

Defined in the manifest, not in the DAG file:

```typescript
triggeredBy: "nyc_taxi_bronze",  // upstream DAG that triggers this one
triggers: ["nyc_taxi_gold"],     // DAGs to trigger on this DAG's success
```

## Accessing Airflow UI

```bash
kubectl port-forward svc/airflow-webserver 8081:8080 -n airflow \
  --context aks-forge-orchestration-{alias}-{env}
# open http://localhost:8081   login: admin / admin
```

Or via the Developer Portal at `http://forge-portal-{alias}-{env}.{region}.cloudapp.azure.com`.

## git-sync config

`infra/helm/orchestration/airflow/values.yaml`:

```yaml
dags:
  gitSync:
    repo: "https://L1R@dev.azure.com/L1R/Data%20Science%20Engineering/_git/DSEng%20Core%20Infra"
    branch: "user/PrProddu/StarRocks"
    subPath: "Forge/orchestration/airflow/dags"
    period: 30s
```

## Further reading

- Architecture: `docs/architecture/07-orchestration.md`
- Deployment: `docs/implementation/05-deploy-orchestration.md`
