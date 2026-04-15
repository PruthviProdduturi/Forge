# Examples — Pipeline Source of Truth

All Forge pipeline artifacts live here. Engineers write and edit everything in `examples/src/`.
`sync-jobs.sh` handles deployment: it generates scaffolding, copies DAGs to `orchestration/`, and uploads Spark jobs + DQ rules to ADLS.

## Directory layout

```
examples/src/
  spark/jobs/
    nyc_taxi_bronze.forge.ts   # manifest — schedule, params, resources
    nyc_taxi_bronze.py         # Spark job (business logic block is user-editable)
    nyc_taxi_silver.forge.ts
    nyc_taxi_silver.py
    nyc_taxi_gold.forge.ts
    nyc_taxi_gold.py
  airflow/dags/
    ingestion/
      nyc_taxi_init_dag.py     # @once — registers data source on deploy
      nyc_taxi_bronze_dag.py   # daily at 02:00, catchup from 2025-01-01
    transformation/
      nyc_taxi_silver_dag.py   # triggered by bronze
      nyc_taxi_gold_dag.py     # triggered by silver (4 parallel aggregations)
  dq/rules/
    nyc_taxi_silver.yaml       # 12 DQ rules applied after silver transform
```

## Workflow

```
1. Edit .forge.ts manifest      examples/src/spark/jobs/
2. forge generate               re-scaffolds .py job, _dag.py, .yaml (business logic preserved)
3. sync-jobs.sh                 copies DAGs → orchestration/, uploads .py + .yaml → ADLS
4. Airflow git-sync             picks up DAGs from orchestration/ within 30s
```

```bash
# Regenerate one job from its manifest
forge generate --job nyc_taxi_bronze

# Sync changed manifests to Airflow + ADLS
OWNER_ALIAS=DSEng FORGE_ENV=dev bash infra/scripts/sync-jobs.sh

# Sync a single job
OWNER_ALIAS=DSEng FORGE_ENV=dev bash infra/scripts/sync-jobs.sh --job nyc_taxi_bronze
```

## NYC Taxi pipeline

| DAG | Schedule | Source |
|-----|----------|--------|
| `nyc_taxi_bronze` | `0 2 * * *` (catchup from 2025-01-01) | Azure Open Datasets — `wasbs://nyctlc@azureopendatastorage.blob.core.windows.net/yellow/` |
| `nyc_taxi_silver` | triggered by bronze | `lakehouse.bronze.nyctaxi` |
| `nyc_taxi_gold` | triggered by silver | `lakehouse.silver.nyctaxi` → 4 aggregation tables |

Data source registered automatically by `nyc_taxi_init_dag` (`@once`) on first deploy.

## SparkKubernetesOperator pattern

Every DAG uses `SparkKubernetesOperator` with:
- `kubernetes_conn_id="kubernetes_compute_cluster"` — cross-cluster connection to compute AKS
- `namespace="spark-jobs"` — where SparkApplication CRDs land
- `application_file` — inline SparkApplication YAML referencing the ADLS job script

## Accessing Airflow

```bash
kubectl port-forward svc/airflow-webserver 8081:8080 -n airflow \
  --context aks-forge-orchestration-{alias}-{env}
# open http://localhost:8081
```
