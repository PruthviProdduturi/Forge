# Runbook: Create a New Pipeline

End-to-end steps to add a new data pipeline to Forge — from manifest to running in dev.

---

## Overview

All pipelines follow the same pattern:

```
.forge.ts manifest
    └── forge generate → DAG + Spark job skeleton
        └── sync-jobs.sh → ADLS + dag-processor + Airflow
            └── Portal: pipeline visible, triggerable
```

Do not write DAG files by hand. The generator produces them and will overwrite manual edits.

---

## Step 1: Create a feature branch

```bash
git checkout -b feature/<pipeline-name>
# Example: feature/ingest-sales-orders
```

---

## Step 2: Write the manifest

Create `sources/dev/CoreData/src/<domain>/<PipelineName>/.forge.ts`:

```typescript
import { defineForgeJob } from "@forge/sdk";

export default defineForgeJob({
  name: "sales_orders_bronze",        // snake_case — becomes the dag_id
  description: "Ingest raw sales orders from ERP export",
  layer: "bronze",
  schedule: "0 2 * * *",             // cron — UTC
  startDate: "2024-01-01",
  endDate: "2024-12-31",             // omit for open-ended pipelines
  catchup: true,

  // Omit triggeredBy for bronze (no upstream dependency)
  // triggeredBy: "upstream_dag_id", // adds ExternalTaskSensor for silver/gold

  spark: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 2 },
  },

  dq: {
    rules: "dq/rules/sales_orders_bronze.yaml",
  },

  envVars: {
    SOURCE_CONTAINER: "raw",
    PARTITION_DATE: "{{ ds }}",
  },
});
```

**Key manifest fields:**

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Becomes `dag_id`. Must be unique across all pipelines. |
| `layer` | Yes | `bronze`, `silver`, or `gold` |
| `schedule` | Yes | Cron expression (UTC) |
| `startDate` | Yes | ISO date — Airflow `start_date` |
| `endDate` | No | Set for bounded backfills. Without it, `catchup=True` runs indefinitely. |
| `catchup` | No | Default `true`. Set `false` for real-time/streaming jobs. |
| `triggeredBy` | No | Upstream `dag_id`. Generates an `ExternalTaskSensor`. |
| `spark` | Yes | Driver + executor resource sizing |
| `dq.rules` | No | Path to DQ rules YAML relative to project root. Required for data-quality gate. |

---

## Step 3: Write the Spark job

Create `sources/dev/CoreData/src/<domain>/<PipelineName>/jobs/<name>.py`:

```python
import os
from pyspark.sql import SparkSession
from forge_sdk import forge_connect

spark = forge_connect()

partition_date = os.environ["PARTITION_DATE"]
source_container = os.environ.get("SOURCE_CONTAINER", "raw")
adls_account = os.environ["FORGE_STORAGE_ACCOUNT"]

# Read source
df = spark.read.parquet(
    f"abfss://{source_container}@{adls_account}.dfs.core.windows.net/sales/orders/{partition_date}/"
)

# Transform
df_clean = df.dropDuplicates(["order_id"]).filter("order_status != 'CANCELLED'")

# Write to bronze Delta table
df_clean.write.format("delta") \
    .mode("overwrite") \
    .option("replaceWhere", f"partition_date = '{partition_date}'") \
    .save(f"abfss://bronze@{adls_account}.dfs.core.windows.net/sales/orders/")

print(f"Wrote {df_clean.count()} rows for {partition_date}")
```

---

## Step 4: Write DQ rules (if applicable)

Create `sources/dev/CoreData/src/<domain>/<PipelineName>/dq/<name>.yaml`:

```yaml
dataset: bronze/sales_orders
pipeline: sales_orders_bronze

rules:
  - name: no_nulls_order_id
    type: not_null
    column: order_id
    severity: critical       # critical = blocks the pipeline on failure

  - name: valid_order_status
    type: accepted_values
    column: order_status
    values: [OPEN, SHIPPED, DELIVERED, RETURNED]
    severity: warning        # warning = logged but does not block

  - name: row_count_not_zero
    type: row_count
    min: 1
    severity: critical

  - name: amount_non_negative
    type: expression
    expr: "order_amount >= 0"
    severity: critical
```

**Severity levels:**

| Level | Effect |
|---|---|
| `critical` | Task fails → pipeline blocked → downstream DAGs wait |
| `warning` | Recorded in DQ metrics, pipeline continues |

---

## Step 5: Generate the DAG

```bash
cd sources/dev/CoreData
forge generate --job sales_orders_bronze
```

This produces:
- `dags/sales_orders_bronze_dag.py` — managed DAG (do not edit)

Inspect the generated DAG to confirm the structure is correct (tasks, sensor, schedule).

---

## Step 6: Sync to dev

```bash
FORGE_ENV="dev" OWNER_ALIAS="DSEng" \
  bash infra/scripts/sync-jobs.sh --job sales_orders_bronze
```

`sync-jobs.sh` does all of this in one step:

```
sync-jobs.sh --job sales_orders_bronze
  │
  ├── forge generate → dags/sales_orders_bronze_dag.py
  ├── ADLS upload    → code/spark/jobs/sales_orders_bronze.py
  ├── ADLS upload    → code/dq/rules/sales_orders_bronze.yaml
  ├── ADLS upload    → code/dags/sales_orders_bronze_dag.py
  ├── kubectl exec   → dag-processor:/opt/airflow/dags/   (immediate)
  ├── kubectl patch  → airflow-task-dags ConfigMap        (task pods)
  └── POST /api/pipelines/register                        (portal)
```

Wait ~30 seconds, then confirm the DAG is visible in Airflow:

```bash
kubectl exec -n airflow --context aks-forge-orchestration-DSEng-dev \
  deploy/airflow-api-server -- airflow dags list | grep sales_orders_bronze
```

---

## Step 7: Trigger a test run

Use the portal **Pipelines** page → select the pipeline → **Restate** or **Trigger**, or via CLI:

```bash
kubectl exec -n airflow --context aks-forge-orchestration-DSEng-dev \
  deploy/airflow-api-server -- \
  airflow dags trigger sales_orders_bronze \
    --conf '{"run_date": "2024-01-01"}'
```

Monitor in the portal: task graph updates live, click any task to see logs.

---

## Step 8: Open a PR

Once the test run passes end-to-end:

```bash
git add sources/dev/CoreData/src/<domain>/
git commit -m "feat: add sales orders bronze pipeline"
git push origin feature/sales-orders-bronze

gh pr create \
  --title "feat: sales orders bronze ingestion pipeline" \
  --body "Adds daily bronze ingestion for ERP sales orders export with DQ gate."
```

After merge to `main`, prod picks it up automatically via git-sync (no `sync-jobs.sh` needed in prod).

---

## Troubleshooting

| Symptom | Check |
|---|---|
| DAG not appearing in Airflow after sync | `kubectl logs -n airflow -l component=dag-processor --context aks-forge-orchestration-DSEng-dev` — look for import errors |
| Spark job fails with `ModuleNotFoundError` | Library not in Spark image — add to `infra/docker/spark/Dockerfile` and redeploy with `--redeploy` |
| DQ gate fails with `TABLE_OR_VIEW_NOT_FOUND` | Table name in DQ rules doesn't match Hive Metastore name — check `bronze.<tablename>` casing |
| Pipeline shows in Airflow but not in Portal | Re-run `sync-jobs.sh` — the `POST /api/pipelines/register` call may have failed |
| `catchup=True` creating hundreds of runs | Set `endDate` in the manifest to bound the backfill range |
| Silver/gold DAG running before bronze completes | Ensure `triggeredBy` is set to the upstream `dag_id` in the manifest |

---

## Useful References

- [DAG Development — Developer Experience Guide](../guides/developer-experience.md#4-airflow-dag-development)
- [DQ Framework Architecture](../architecture/09-dq-framework.md)
- [Restatement Guide](../architecture/13-restatement.md)
- [Post-Deploy Verification](04-post-deploy-verification.md)
