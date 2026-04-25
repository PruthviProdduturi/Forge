# Forge — Developer Experience Guide

> **Version:** 1.0
> **Status:** Production
> **Audience:** Data engineers, platform engineers, on-call engineers

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [VS Code Setup](#2-vs-code-setup)
3. [Spark Connect Development](#3-spark-connect-development)
4. [Airflow DAG Development](#4-airflow-dag-development)
5. [DQ Rule Authoring](#5-dq-rule-authoring)
6. [End-to-End Pipeline Workflow](#6-end-to-end-pipeline-workflow)
7. [Git Branching Model](#7-git-branching-model)
8. [Debugging Guide](#8-debugging-guide)
9. [Environment Parity](#9-environment-parity)
10. [forge-cli Reference](#10-forge-cli-reference)
11. [Restatement & Backfill](#11-restatement--backfill)

---

## 1. Prerequisites

Before you start, make sure you have the following. Contact the platform team if anything is missing.

| What you need | How to get it |
|---|---|
| Azure CLI (`az`) 2.50+ | [Install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) — run `az login` with your corporate account |
| Portal access | Browse to `https://forge-portal-{alias}-dev.northcentralus.cloudapp.azure.com` — sign in with your corporate account. If you get a 403, ask the platform team to add you to the `forge-data-engineer` AD group. |
| Spark Connect URL | Ask the platform team or run `forge job spark-connect-url` once the CLI is set up (§2) |
| Git access to this repo | Standard ADO access — clone `DSEngCoreInfra` and `DSEngCoreData` |

That's it. You don't need `kubectl`, cluster credentials, or any Azure infra access to build and run pipelines. The portal and `sync-jobs.sh` handle everything.

> **Platform team only:** Cluster access setup (kubelogin, AKS RBAC, kubeconfig) is documented in the [Post-Deploy Verification runbook](../runbooks/04-post-deploy-verification.md).

---

## 2. VS Code Setup

### Recommended Extensions

Install these extensions before working on Forge. The repository includes a `.vscode/extensions.json` that will prompt VS Code to install them automatically when you open the workspace.

| Extension | ID | Purpose |
|-----------|-----|---------|
| Python | `ms-python.python` | Python language support, environment management |
| Pylance | `ms-python.vscode-pylance` | Type checking, IntelliSense, import resolution |
| Jupyter | `ms-toolsai.jupyter` | Run notebooks inline in VS Code against Spark Connect |
| Kubernetes | `ms-kubernetes-tools.vscode-kubernetes-tools` | Browse cluster resources (optional — platform team use) |
| REST Client | `humao.rest-client` | Test portal API endpoints directly from `.http` files |
| YAML | `redhat.vscode-yaml` | Schema validation for DQ rulesets and Helm values |
| GitLens | `eamodio.gitlens` | Inline blame, commit history, branch comparison |
| Ruff | `charliermarsh.ruff` | Python linting and formatting (matches CI) |
| Even Better TOML | `tamasfe.even-better-toml` | Edit `pyproject.toml`, `Cargo.toml` config files |
| Docker | `ms-azuretools.vscode-docker` | Browse images, inspect Dockerfiles |

### Workspace `settings.json`

The repository ships with `D:/Repos/Forge/.vscode/settings.json`. This is committed and should not be overridden locally without a team discussion:

```json
{
  "python.defaultInterpreterPath": "${workspaceFolder}/.venv/bin/python",
  "python.analysis.typeCheckingMode": "basic",
  "python.analysis.extraPaths": [
    "${workspaceFolder}/sdk/python",
    "${workspaceFolder}/orchestration/airflow"
  ],
  "editor.formatOnSave": true,
  "[python]": {
    "editor.defaultFormatter": "charliermarsh.ruff",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
      "source.fixAll.ruff": "explicit",
      "source.organizeImports.ruff": "explicit"
    }
  },
  "ruff.lint.args": ["--config=${workspaceFolder}/pyproject.toml"],
  "yaml.schemas": {
    "${workspaceFolder}/orchestration/dq/schema/ruleset.schema.json": [
      "orchestration/dq/rules/**/*.yaml"
    ]
  },
  "files.associations": {
    "*.http": "http"
  },
  "jupyter.kernelPickerType": "mru",
  "jupyter.notebookFileRoot": "${workspaceFolder}",
  "editor.rulers": [100],
  "files.exclude": {
    "**/__pycache__": true,
    "**/.pytest_cache": true,
    "**/*.egg-info": true
  }
}
```

Key settings to understand:

- `python.analysis.extraPaths` adds the Airflow DAG directory to the Pylance import resolver so DAG imports resolve correctly in VS Code (only relevant if you set up the Python venv for DAG tests).
- `yaml.schemas` wires DQ ruleset YAML files to the JSON Schema for real-time validation. If you reference a non-existent rule type or misspell a severity level, VS Code underlines it immediately.
- `ruff.lint.args` points to the project `pyproject.toml` which defines consistent linting rules shared with CI.

### Install the Forge CLI

The `forge` CLI is a TypeScript package in `sdk/cli/`. Install it once after cloning:

```bash
# From repo root
npm install
```

Verify:

```bash
forge --version
# forge-cli 1.0.0
```

> **Running DAG unit tests?** You also need a Python venv:
> ```bash
> python -m venv .venv
> source .venv/bin/activate          # Linux/macOS / WSL
> # .\.venv\Scripts\Activate.ps1    # Windows PowerShell
> pip install -r orchestration/airflow/requirements-dev.txt
> ```
> This installs `apache-airflow`, `pytest`, and mock libraries for local structure tests. The Python SDK itself (`forge_sdk`, `forge_dq`) runs on the cluster — you don't install it locally.

---

## 3. Spark Connect Development

### What is Spark Connect?

Spark Connect is a client-server protocol introduced in Spark 3.4 that separates the Spark driver from the client process. Instead of running a local Spark driver in your Python process, your code sends a serialized logical plan over gRPC to a remote Spark Connect Server, which executes it on the real cluster and streams results back.

This means:
- You write PySpark in VS Code exactly as you would in production
- The code runs against real ADLS data with real cluster resources
- No local Spark installation needed — just `pyspark` (the Python client)
- No SSH, no port-forward to the driver, no cluster credentials in your laptop

The Spark Connect server runs as a persistent pod on the `forge-compute` cluster. It is accessible from the corporate network via the internal load balancer.

### Connecting VS Code to the Spark Connect Server

**Step 1: Get the Spark Connect server address**

```bash
forge job spark-connect-url
```

This prints the Spark Connect endpoint, e.g. `sc://10.1.42.100:15002`. If you don't have the CLI set up yet, ask the platform team for the URL.

**Step 2: Create a notebook**

Create a new notebook at the repo root (or in your feature branch):

```bash
touch notebooks/explore_sales_orders.ipynb
code notebooks/explore_sales_orders.ipynb
```

VS Code opens the notebook in Jupyter mode. Select the `.venv` kernel (it appears in the kernel picker because it has `pyspark` and `ipykernel` installed).

**Step 3: Create the SparkSession**

The first cell of every notebook should establish the session:

```python
from pyspark.sql import SparkSession
import os

SPARK_CONNECT_URL = os.environ.get("SPARK_CONNECT_URL", "sc://10.1.42.100:15002")

spark = SparkSession.builder \
    .remote(SPARK_CONNECT_URL) \
    .appName("notebook-explore-sales-orders") \
    .getOrCreate()

print(f"Spark version: {spark.version}")
print(f"Active session: {spark.sparkContext.applicationId if hasattr(spark, 'sparkContext') else 'Connect mode'}")
```

Set `SPARK_CONNECT_URL` in your shell (or in `.env` at the repo root, which VS Code loads via the Python extension):

```bash
export SPARK_CONNECT_URL="sc://10.1.42.100:15002"
```

**Step 4: Read data**

```python
ADLS_ACCOUNT = "forgeadlsdsengdev"   # dev account — ask platform team if unsure

df = spark.read.format("delta").load(
    f"abfss://gold@{ADLS_ACCOUNT}.dfs.core.windows.net/sales/orders"
)

print(f"Schema:")
df.printSchema()

print(f"\nRow count: {df.count():,}")
print(f"\nSample rows:")
df.limit(10).toPandas()
```

When you run this cell, VS Code sends the logical plan to the remote Spark Connect server. The server reads from ADLS using the cluster's workload identity — no credentials are needed on your laptop. Results are streamed back as Arrow batches and materialized as a Pandas DataFrame in VS Code.

**Step 5: Write PySpark against real data**

With the session established, all standard PySpark DataFrame operations work:

```python
from pyspark.sql import functions as F
from pyspark.sql.window import Window
from delta.tables import DeltaTable

# Explore sales orders
orders_df = spark.read.format("delta").load(
    f"abfss://silver@{ADLS_ACCOUNT}.dfs.core.windows.net/sales/orders"
)

# Daily order volume trend
daily_volume = (
    orders_df
    .filter(F.col("status") != "cancelled")
    .withColumn("order_date", F.to_date("order_ts"))
    .groupBy("order_date")
    .agg(
        F.count("*").alias("order_count"),
        F.sum("order_total_usd").alias("gmv_usd"),
        F.countDistinct("customer_id").alias("unique_customers")
    )
    .orderBy("order_date", ascending=False)
)

daily_volume.limit(30).toPandas()
```

### Debugging a Slow Query

When a cell runs slowly, the most useful signals are:

| Symptom | Likely Cause | Fix |
|--------------------|--------------|-----|
| One stage runs much longer than others | Data skew — one partition is huge | Repartition by a different key: `df.repartition(200, "order_date")` |
| Many small tasks (< 1 MB each) | Too many small partitions after a filter | Coalesce: `df.coalesce(20)` after the filter |
| Long shuffle stage | Large join or groupBy | Check join type — consider `broadcast()` if one side is small |
| `OutOfMemoryError` on executor | Insufficient executor memory | Ask the platform team to increase executor memory in the Spark Connect server config |

For deeper profiling (Spark UI, stage breakdown, physical plan), contact the platform team — they can access the Spark UI via the cluster directly.

### Moving from Notebook to a Production Spark Job

Once your notebook logic is validated, extract it into a standalone Python file:

**1. Create the job file**

```bash
# Job files live in the DSEngCoreData repo under sources/dev/CoreData/src/<domain>/
# Example:
touch D:/Repos/DSEngCoreData/sources/dev/CoreData/src/sales/transform_sales_orders.py
```

**2. Structure the production job**

```python
# sources/dev/CoreData/src/sales/transform_sales_orders.py  (in DSEngCoreData repo)

import sys
import logging
from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from delta.tables import DeltaTable

logger = logging.getLogger(__name__)


def get_session(app_name: str) -> SparkSession:
    """Build SparkSession for cluster-mode execution (no .remote() — Spark Operator sets this)."""
    return SparkSession.builder.appName(app_name).getOrCreate()


def transform(spark: SparkSession, adls_account: str, run_date: str) -> int:
    """Transform raw sales orders into the curated Delta table. Returns rows merged."""
    raw_path = f"abfss://bronze@{adls_account}.dfs.core.windows.net/sales/orders/{run_date}/"
    curated_path = f"abfss://silver@{adls_account}.dfs.core.windows.net/sales/orders"

    raw_df = spark.read.parquet(raw_path)

    transformed_df = (
        raw_df
        .withColumn("order_id",        F.col("id").cast("string"))
        .withColumn("order_ts",        F.to_timestamp("created_at", "yyyy-MM-dd'T'HH:mm:ss"))
        .withColumn("order_total_usd", F.col("total_amount").cast("decimal(18,2)"))
        .withColumn("status",          F.lower(F.trim(F.col("status"))))
        .withColumn("_ingestion_date", F.lit(run_date))
        .select("order_id", "customer_id", "order_ts", "order_total_usd", "status", "_ingestion_date")
        .dropDuplicates(["order_id"])
    )

    target_table = DeltaTable.forPath(spark, curated_path)

    (
        target_table.alias("target")
        .merge(
            source=transformed_df.alias("source"),
            condition="target.order_id = source.order_id"
        )
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute()
    )

    rows_merged = spark.read.format("delta").load(curated_path).count()
    logger.info(f"Transform complete. Total rows in curated table: {rows_merged:,}")
    return rows_merged


def main() -> None:
    adls_account = sys.argv[1]
    run_date     = sys.argv[2]  # YYYY-MM-DD

    spark = get_session("transform-sales-orders")
    try:
        rows = transform(spark, adls_account, run_date)
        logger.info(f"Job complete. rows_merged={rows}")
    finally:
        spark.stop()


if __name__ == "__main__":
    main()
```

**3. Key differences between notebook and production job**

| Aspect | Notebook | Production job |
|--------|---------|----------------|
| SparkSession | `.remote("sc://...")` | `.builder.appName(...)` — Spark Operator injects cluster config |
| Parameters | Hardcoded cell variables | `sys.argv` or environment variables |
| Output | `.toPandas()` for display | Write to Delta table — no `.toPandas()` |
| Error handling | Cell-level exceptions | `try/finally` with `spark.stop()` |
| Logging | `print()` | `logging.getLogger()` — output captured by Spark log driver |
| Testing | Interactive | Unit tests with `pytest` using local SparkSession fixture |

**4. Deploy the job**

Use `sync-jobs.sh` from the `DSEngCoreInfra` repo — it handles DAG generation, ADLS upload, dag-processor injection, and portal registration in one step:

```bash
FORGE_ENV="dev" OWNER_ALIAS="DSEng" \
  bash infra/scripts/sync-jobs.sh --job transform_sales_orders \
  --data-repo D:/Repos/DSEngCoreData
```

---

### 3.5 Trino CLI

Trino is exposed over HTTPS via the Trino auth proxy. The proxy validates your Azure AD Bearer token, extracts your email, and injects `X-Trino-User` for all queries — no separate username needed.

#### Prerequisites

- [Trino CLI](https://trino.io/docs/current/client/cli.html) (`trino` on PATH)
- Azure CLI logged in (`az login`)

#### Connect

```powershell
# 1. Get a Bearer token (uses your existing az login session — no extra consent needed)
$token = az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv

# 2. Connect
trino --server=https://forge-compute-{alias}-dev.northcentralus.cloudapp.azure.com `
      --access-token="$token" `
      --catalog=hive
```

```bash
# bash / WSL
TOKEN=$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv)
trino --server=https://forge-compute-{alias}-dev.northcentralus.cloudapp.azure.com \
      --access-token="$TOKEN" \
      --catalog=hive
```

> **Why ARM token?** The auth proxy validates tenant + domain only (`verify_aud: False`). Any valid Azure AD token from your corporate account works. The `api://d0ce7c35-...` resource also works once admin consent is granted.

#### Query examples

```sql
-- List catalogs
SHOW CATALOGS;

-- List schemas in hive catalog
SHOW SCHEMAS IN hive;

-- Query a Delta table
SELECT * FROM hive.gold.sales_orders LIMIT 10;

-- Check cluster nodes
SELECT node_id, state FROM system.runtime.nodes;

-- Running queries
SELECT query_id, state, query FROM system.runtime.queries WHERE state = 'RUNNING';
```

#### Token refresh

ARM tokens expire after ~1 hour. Re-run the `az account get-access-token` command and reconnect.

#### Trino UI

The web UI is accessible at:
```
https://forge-compute-{alias}-dev.northcentralus.cloudapp.azure.com/ui/
```

Sign in with your corporate account via the OAuth2 flow. The UI shows `trino-user` in the top-right (cosmetic only) — queries are attributed to your actual username via `X-Trino-User`.

---

## 4. Airflow DAG Development

> **New pipeline?** Follow the step-by-step runbook: [Create a New Pipeline](../runbooks/05-create-pipeline.md) — manifest → generate → sync → dev test → PR.

### Authoring a DAG — Codegen First

DAG files in `orchestration/airflow/dags/` are **generated by `forge generate`** from a `.forge.ts` manifest. Do not write DAG files directly for platform-managed pipelines — the generator produces them and will overwrite any manual edits on the next `forge generate` run.

The manifest controls: schedule, `start_date`, `end_date` (for bounded runs), `triggeredBy` (upstream DAG dependency), DQ rules, Spark resources, and partition strategy. The generator emits a DAG that imports `ForgeSparkOperator` and `ForgeDqGateOperator` from the `forge_airflow` plugin.

**DAG tags stamped by the generator** — the following tags are written to every generated DAG and consumed by the portal:

| Tag | Example | Portal use |
|-----|---------|------------|
| `layer:<layer>` | `layer:bronze` | Layer badge in pipeline activity table |
| `source:<name>` | `source:TlcYellowTrip` | Internal source dataset name |
| `output:<name>` | `output:NycTaxiBronze` | Output dataset shown in pipeline activity table |
| `executors:<n>` | `executors:2` | Executor count shown in pipeline activity (e.g. `2×4c 8g`) |
| `exec_cores:<n>` | `exec_cores:4` | Cores per executor (hover tooltip: "2 executor instances · 4 cores each · 8g memory") |
| `exec_mem:<m>` | `exec_mem:8g` | Memory per executor |

These tags are read-only to application code — do not add or remove them manually, they are regenerated on every `forge generate` run.

**Generated DAG structure — bronze (no upstream dependency):**

```python
from forge_airflow import ForgeSparkOperator, ForgeDqGateOperator
from datetime import datetime

with DAG(dag_id="nyc_taxi_bronze", schedule="0 2 * * *",
         start_date=datetime(2024, 1, 1), end_date=datetime(2024, 12, 31),
         catchup=True, max_active_runs=10) as dag:

    ingest_task = ForgeSparkOperator(
        task_id="ingest_taxi_bronze", job="nyc_taxi_bronze", layer="bronze",
        env_vars={"TAXI_TYPE": "yellow", "PARTITION_DATE": "{{ ds }}", "PARTITION_HOUR": "0"},
        driver={"cores": 2, "memory": "4g"},
        executor={"cores": 4, "memory": "8g", "instances": 2},
    )
    dq_task = ForgeDqGateOperator(
        task_id="dq_gate_bronze", job="nyc_taxi_bronze", layer="bronze", table="bronze.nyctaxi",
    )
    ingest_task >> dq_task
```

**Generated DAG structure — silver (with `triggeredBy`):**

```python
from airflow.sensors.external_task import ExternalTaskSensor
from forge_airflow import ForgeSparkOperator, ForgeDqGateOperator
from datetime import datetime, timedelta

with DAG(dag_id="nyc_taxi_silver", schedule="0 2 * * *",
         start_date=datetime(2024, 1, 1), end_date=datetime(2024, 12, 31),
         catchup=True, max_active_runs=10) as dag:

    wait_for_nyc_taxi_bronze = ExternalTaskSensor(
        task_id="wait_for_nyc_taxi_bronze", external_dag_id="nyc_taxi_bronze",
        external_task_id=None, mode="reschedule", timeout=timedelta(hours=8), poke_interval=120,
    )
    ingest_task = ForgeSparkOperator(
        task_id="transform_silver", job="nyc_taxi_silver", layer="silver",
        env_vars={"PARTITION_DATE": "{{ ds }}", "PARTITION_HOUR": "0"},
        driver={"cores": 2, "memory": "4g"},
        executor={"cores": 4, "memory": "8g", "instances": 3},
    )
    dq_task = ForgeDqGateOperator(
        task_id="dq_gate_silver", job="nyc_taxi_silver", layer="silver", table="silver.nyctaxi",
    )
    wait_for_nyc_taxi_bronze >> ingest_task >> dq_task
```

`ForgeSparkOperator` builds the `SparkApplication` YAML internally — no YAML is visible in the DAG. Platform config (Spark image, storage account, tenant ID, MI client ID) is read from Airflow Variables at parse time.

`ForgeDqGateOperator` submits the `forge_dq_gate` platform Spark job, passing `RULES_PATH` pointing to the pipeline's YAML in ADLS. The job applies partition-aware filtering and fails the task on any critical rule violation.

`ExternalTaskSensor` (generated when `triggeredBy` is set) waits for the upstream DAG's run for the same logical date to reach `success`, then proceeds. The upstream DAG does not need to know about its consumers. `mode="reschedule"` is mandatory — it frees the task pod between checks, avoiding pod exhaustion under KubernetesExecutor.

### Testing a DAG

DAG testing happens in two stages: **structure tests** run locally with pytest (no Airflow process needed), and **execution tests** run on the **dev cluster** — there is no local Airflow instance.

Running a local Airflow instance (Standalone, Docker Compose, etc.) is explicitly discouraged because:
- It uses `LocalExecutor` or `SequentialExecutor`, not `KubernetesExecutor` — tasks behave differently
- It has no access to ADLS, Key Vault, Spark Connect, or any Azure service
- Results from local execution do not predict dev/prod behaviour

**Step 1: Write DAG unit tests**

DAG unit tests (in `orchestration/airflow/tests/`) validate DAG structure and wiring without running any tasks or starting any Airflow process:

```python
# orchestration/airflow/tests/sales/test_transform_sales_orders.py

import pytest
from airflow.models import DagBag


@pytest.fixture(scope="module")
def dagbag():
    return DagBag(dag_folder="orchestration/airflow/dags", include_examples=False)


def test_dag_loads_without_errors(dagbag):
    """DAG must import with zero errors."""
    assert "transform_sales_orders" in dagbag.dags
    assert len(dagbag.import_errors) == 0, f"Import errors: {dagbag.import_errors}"


def test_dag_has_expected_tasks(dagbag):
    dag = dagbag.get_dag("transform_sales_orders")
    task_ids = {task.task_id for task in dag.tasks}
    assert task_ids == {
        "spark_transform_curated",
        "wait_for_transform",
        "validate_dq",
        "publish_serving",
    }


def test_dag_task_dependencies(dagbag):
    dag = dagbag.get_dag("transform_sales_orders")
    spark_task = dag.get_task("spark_transform_curated")
    wait_task  = dag.get_task("wait_for_transform")
    dq_task    = dag.get_task("validate_dq")
    publish    = dag.get_task("publish_serving")

    assert wait_task.upstream_task_ids   == {"spark_transform_curated"}
    assert dq_task.upstream_task_ids     == {"wait_for_transform"}
    assert publish.upstream_task_ids     == {"validate_dq"}


def test_dag_schedule(dagbag):
    dag = dagbag.get_dag("transform_sales_orders")
    assert dag.schedule_interval == "0 6 * * *"
    assert dag.catchup is False


def test_dag_owner_set(dagbag):
    dag = dagbag.get_dag("transform_sales_orders")
    for task in dag.tasks:
        assert task.owner not in ("airflow", ""), f"Task {task.task_id} has no owner"
```

Run tests:

```bash
pytest orchestration/airflow/tests/ -v --tb=short
```

This runs in under 5 seconds — no Airflow process, no database, no Azure credentials.

**Step 2: Test execution on dev**

Once structure tests pass, sync the pipeline to dev using `sync-jobs.sh`:

```bash
# Sync the job — generates DAG, uploads to ADLS, pulls into dag-processor
FORGE_ENV="dev" OWNER_ALIAS="DSEng" \
  bash infra/scripts/sync-jobs.sh --job transform_sales_orders --data-repo <path-to-data-repo>
```

The DAG appears in Airflow within ~30 seconds. Then trigger it:

```bash
forge dag trigger transform_sales_orders --env dev --conf '{"run_date": "2026-03-24"}'
```

Or use the portal: **Pipelines → transform_sales_orders → Trigger**.

The dev cluster runs `KubernetesExecutor` — tasks execute as pods with real access to ADLS, Key Vault, Spark Connect, and ACR. This is the only reliable way to test actual task execution.

### Deploying a DAG to Dev

In dev, there is no git-sync. DAGs are delivered explicitly via `sync-jobs.sh`:

```
sync-jobs.sh --job <name>
  │
  ├── forge generate → {project}/dags/{name}_dag.py
  ├── ADLS upload    → code/spark/jobs/{name}.py      (Spark job)
  ├── ADLS upload    → code/dq/rules/{name}.yaml      (DQ rules)
  ├── ADLS upload    → code/dags/{name}_dag.py        (DAG — durable)
  └── kubectl exec   → dag-processor:/opt/airflow/dags/  (immediate pull)
```

DAGs stored in ADLS survive pod restarts — the `dag-restore` init container restores them automatically when the dag-processor pod starts.

**To update a DAG:** re-run `sync-jobs.sh --job <name>`. The new file overwrites the ADLS blob and is immediately pulled into the running pod.

**To remove a DAG:**
```bash
# Delete from ADLS — prevents it being restored on next pod restart
az storage blob delete \
  --account-name forgeadlsdsengdev --container-name code \
  --name dags/<name>_dag.py --auth-mode login
```
The DAG will disappear from Airflow the next time the dag-processor pod restarts. For immediate removal, ask the platform team.

### Triggering a Test Run in the Dev Environment

To trigger a test run in the dev environment without waiting for the schedule:

```bash
forge dag trigger transform_sales_orders --env dev --conf '{"run_date": "2026-03-24"}'
```

Monitor in the portal: **Pipelines → transform_sales_orders → [run] → task graph**. Or via CLI:

```bash
forge dag status transform_sales_orders --latest
```

---

## 5. DQ Rule Authoring

### Writing a YAML Ruleset

DQ rulesets are YAML files stored in `orchestration/dq/rules/`. Each file corresponds to one dataset. The VS Code YAML extension validates against the JSON Schema at `orchestration/dq/schema/ruleset.schema.json`.

A complete ruleset example:

```yaml
# orchestration/dq/rules/sales/orders.yaml

dataset:
  namespace: curated
  name: sales/orders
  description: "Curated sales orders table — validated before serving publish"

rules:

  # ─── SCHEMA ──────────────────────────────────────────────────────────────────

  - id: schema_order_id_not_null
    type: schema
    check: not_null
    column: order_id
    severity: CRITICAL
    description: "order_id must never be null — it is the business key"

  - id: schema_status_values
    type: schema
    check: accepted_values
    column: status
    values: ["open", "fulfilled", "cancelled", "refunded"]
    severity: CRITICAL
    description: "status must be one of the four accepted values"

  - id: schema_order_total_non_negative
    type: schema
    check: range
    column: order_total_usd
    min: 0.0
    max: 999999.99
    severity: WARNING
    description: "order totals should be non-negative and below $1M"

  # ─── CONTENT ─────────────────────────────────────────────────────────────────

  - id: content_customer_id_null_rate
    type: content
    check: null_rate
    column: customer_id
    threshold: 0.01      # max 1% nulls
    severity: CRITICAL
    description: "customer_id null rate must be below 1% — indicates ingestion issue"

  - id: content_order_id_unique
    type: content
    check: uniqueness
    column: order_id
    threshold: 1.0       # 100% unique (duplicate rate must be 0)
    severity: CRITICAL
    description: "order_id must be globally unique — duplicates indicate MERGE key issue"

  - id: content_order_ts_not_future
    type: content
    check: not_future
    column: order_ts
    tolerance_hours: 1   # allow up to 1 hour in the future (clock skew)
    severity: WARNING
    description: "order timestamps should not be in the future"

  # ─── VOLUME ──────────────────────────────────────────────────────────────────

  - id: volume_minimum_rows
    type: volume
    check: row_count_min
    min: 10000
    severity: CRITICAL
    description: "curated orders table must have at least 10,000 rows"

  - id: volume_daily_delta
    type: volume
    check: row_count_delta
    max_pct_change: 0.30  # max 30% change from previous run
    severity: WARNING
    description: "row count should not change by more than 30% between runs"

  # ─── FRESHNESS ───────────────────────────────────────────────────────────────

  - id: freshness_latest_partition
    type: freshness
    check: max_partition_age
    partition_column: _ingestion_date
    max_age_hours: 26     # daily pipeline + 2h tolerance
    severity: CRITICAL
    description: "latest partition must be less than 26 hours old"
```

### Testing a Ruleset Against a DataFrame in a Notebook

Before adding the ruleset to the production DAG, validate it against real data in a notebook:

```python
# Cell 1: Establish session
import os
from pyspark.sql import SparkSession
spark = SparkSession.builder \
    .remote(os.environ["SPARK_CONNECT_URL"]) \
    .getOrCreate()

# Cell 2: Read the dataset
df = spark.read.format("delta").load(
    "abfss://silver@forgeadlsdsengdev.dfs.core.windows.net/sales/orders"
)
print(f"Row count: {df.count():,}")
df.printSchema()

# Cell 3: Load and run the ruleset
from forge.dq.sdk import DQRunner, load_ruleset

ruleset = load_ruleset("orchestration/dq/rules/sales/orders.yaml")
runner = DQRunner(spark=spark, ruleset=ruleset)
report = runner.run(df)

# Cell 4: Inspect results
print(f"Overall: {'PASSED' if report.passed else 'FAILED'}")
print(f"Total rules: {report.summary.total}")
print(f"Passed:      {report.summary.passed}")
print(f"Failed:      {report.summary.failed}")
print(f"  CRITICAL:  {report.summary.critical_failures}")
print(f"  WARNING:   {report.summary.warning_failures}")

# Cell 5: See detail for failing rules
for result in report.rule_results:
    if not result.passed:
        print(f"\n[{result.severity}] FAILED: {result.rule_id}")
        print(f"  Check:    {result.check_type}")
        print(f"  Observed: {result.observed_value}")
        print(f"  Threshold:{result.threshold}")
        print(f"  Message:  {result.message}")
```

If a rule fails unexpectedly, one of three things is true:

1. **The data has a genuine quality issue** — investigate the upstream ingestion and fix the source
2. **The threshold is too tight** — review the threshold against historical data distribution and adjust the YAML
3. **The rule logic is wrong** — the rule expression doesn't match the intent, fix the YAML

Only add the ruleset to the production DAG once every rule either passes or is understood to be a WARNING (acknowledged and acceptable for this data).

### Validating Before Adding to Production DAG

The DQ SDK includes a dry-run mode that validates the ruleset YAML structure without executing against data:

```bash
forge dq validate orchestration/dq/rules/sales/orders.yaml
```

This checks:
- YAML syntax is valid
- All required fields are present (`id`, `type`, `check`, `severity`)
- Check types match their required parameters (e.g., `null_rate` needs `threshold`, `accepted_values` needs `values`)
- `severity` values are one of `CRITICAL`, `WARNING`, `INFO`
- No duplicate rule IDs in the file

The validate command exits `0` on success and `1` with a descriptive error message on failure. It is run in the CI pipeline on every PR that touches files in `orchestration/dq/rules/`.

---

## 6. End-to-End Pipeline Workflow

This section walks through the complete journey from "I have a new data source" to "data is in the Gold layer and queryable by consumers." Every step is exact — commands and code, not summaries.

---

### Scenario

A new data source has arrived: a daily CSV export of supplier invoices placed in an Azure Blob Storage account by an external finance system. The data needs to be:
1. Ingested into the Bronze layer
2. Transformed into a curated Delta table
3. DQ validated
4. Published to the Gold layer where the finance team's Trino queries can reach it

---

### Step 0: Register the External Data Source (if needed)

If your pipeline reads from an **external** source (Azure Open Datasets, an external storage account, a partner ADLS container), register it in the portal before writing the manifest. This gives the manifest a named slug to reference instead of a raw ABFS path.

1. Open the portal → **Data Sources** → **Add Source**
2. Fill in the connection details (account, container, base path, auth type)
3. Click **Test** to verify connectivity, then **Save**
4. Note the slug (the `name` field, e.g. `nyc-taxi-yellow`)

In the manifest, use `registeredSource` instead of `rawPath`:

```typescript
source: {
  registeredSource: "nyc-taxi-yellow",   // slug from the portal Data Sources page
  sourcePath: "puYear={_year}/puMonth={_month}/*.parquet",  // appended after basePath
  name: "TlcYellowTrip",
  version: 1,
  format: "parquet",
  options: { mergeSchema: "true" },
},
```

`forge generate` calls the portal API at codegen time to resolve `registeredSource` → `account` + `container` + `basePath`, then constructs the full ABFS path. The resolved path is baked into the generated job — the runtime Spark job does not call the portal API.

> **Internal sources** (data already in your Forge ADLS — e.g. bronze → silver) use `path` (internal ADLS path spec) instead. Only external sources need `registeredSource`.

> **Duplicate detection:** The portal rejects registration of a source with the same `account` + `container` + `base_path` as an existing source (returns 409 with the conflicting source name). Use `PUT /api/v1/datasources/{id}` to update an existing source.

---

### Step 1: Branch and Scaffold

Forge pipelines span two repos: Spark jobs live in **DSEngCoreData**, everything else (DAG tests, DQ rules) in **DSEngCoreInfra**.

```bash
# In DSEngCoreData — Spark job source
cd D:/Repos/DSEngCoreData
git checkout main && git pull
git checkout -b feature/ingest-supplier-invoices
mkdir -p sources/dev/CoreData/src/finance/IngestSupplierInvoices/jobs
mkdir -p sources/dev/CoreData/src/finance/IngestSupplierInvoices/dq

# In DSEngCoreInfra — DAG tests
cd D:/Repos/DSEngCoreInfra/Forge
git checkout main && git pull
git checkout -b feature/ingest-supplier-invoices
mkdir -p orchestration/airflow/tests/finance
```

### Step 2: Write the Raw Ingestion Spark Job

```python
# sources/dev/CoreData/src/finance/IngestSupplierInvoices/jobs/ingest_raw_supplier_invoices.py  (DSEngCoreData repo)

import sys
import logging
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

logger = logging.getLogger(__name__)


def main() -> None:
    adls_account  = sys.argv[1]
    source_account = sys.argv[2]    # source blob storage account name
    ingestion_date = sys.argv[3]    # YYYY-MM-DD

    spark = SparkSession.builder \
        .appName(f"ingest-raw-supplier-invoices-{ingestion_date}") \
        .getOrCreate()

    try:
        # Read source CSV (daily drop, semicolon-delimited, UTF-8 with BOM)
        raw_df = spark.read \
            .option("header", "true") \
            .option("sep", ";") \
            .option("encoding", "UTF-8-BOM") \
            .option("inferSchema", "false") \
            .csv(
                f"abfss://invoices@{source_account}.dfs.core.windows.net/daily/{ingestion_date}/*.csv"
            )

        # Add platform columns — no business logic here
        enriched_df = raw_df \
            .withColumn("_ingestion_ts",     F.current_timestamp()) \
            .withColumn("_ingestion_date",   F.lit(ingestion_date)) \
            .withColumn("_source_system",    F.lit("finance-erp"))

        target_path = (
            f"abfss://bronze@{adls_account}.dfs.core.windows.net/"
            f"finance/supplier_invoices/{ingestion_date}/"
        )

        enriched_df.write \
            .mode("overwrite") \
            .partitionBy("_ingestion_date") \
            .parquet(target_path)

        row_count = enriched_df.count()
        logger.info(f"Ingested {row_count:,} rows to {target_path}")

    finally:
        spark.stop()


if __name__ == "__main__":
    main()
```

### Step 3: Write the Curated Transform Spark Job

```python
# sources/dev/CoreData/src/finance/IngestSupplierInvoices/jobs/transform_curated_supplier_invoices.py  (DSEngCoreData repo)

import sys
import logging
from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from delta.tables import DeltaTable

logger = logging.getLogger(__name__)


def main() -> None:
    adls_account   = sys.argv[1]
    ingestion_date = sys.argv[2]

    spark = SparkSession.builder \
        .appName(f"transform-curated-supplier-invoices-{ingestion_date}") \
        .getOrCreate()

    try:
        raw_path = (
            f"abfss://bronze@{adls_account}.dfs.core.windows.net/"
            f"finance/supplier_invoices/{ingestion_date}/"
        )
        curated_path = (
            f"abfss://silver@{adls_account}.dfs.core.windows.net/"
            f"finance/supplier_invoices"
        )

        raw_df = spark.read.parquet(raw_path)

        transformed_df = raw_df \
            .withColumn("invoice_id",       F.col("InvoiceID").cast("string")) \
            .withColumn("supplier_id",      F.col("SupplierID").cast("string")) \
            .withColumn("invoice_date",     F.to_date(F.col("InvoiceDate"), "dd/MM/yyyy")) \
            .withColumn("amount_gbp",       F.col("GrossAmount").cast("decimal(18,2)")) \
            .withColumn("vat_gbp",          F.col("VATAmount").cast("decimal(18,2)")) \
            .withColumn("status",           F.lower(F.trim(F.col("Status")))) \
            .withColumn("_ingestion_date",  F.lit(ingestion_date)) \
            .select(
                "invoice_id", "supplier_id", "invoice_date",
                "amount_gbp", "vat_gbp", "status", "_ingestion_date"
            ) \
            .dropDuplicates(["invoice_id"])

        # MERGE into curated Delta table
        if DeltaTable.isDeltaTable(spark, curated_path):
            target = DeltaTable.forPath(spark, curated_path)
            (
                target.alias("t")
                .merge(
                    source=transformed_df.alias("s"),
                    condition="t.invoice_id = s.invoice_id"
                )
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute()
            )
        else:
            # First run: create the table
            transformed_df.write \
                .format("delta") \
                .mode("overwrite") \
                .partitionBy("_ingestion_date") \
                .save(curated_path)

        logger.info(f"Transform complete for {ingestion_date}")

    finally:
        spark.stop()


if __name__ == "__main__":
    main()
```

### Step 4: Write the DQ Ruleset

```yaml
# sources/dev/CoreData/src/finance/IngestSupplierInvoices/dq/supplier_invoices.yaml  (DSEngCoreData repo)

dataset:
  namespace: curated
  name: finance/supplier_invoices

rules:

  - id: schema_invoice_id_not_null
    type: schema
    check: not_null
    column: invoice_id
    severity: CRITICAL

  - id: schema_invoice_id_unique
    type: content
    check: uniqueness
    column: invoice_id
    threshold: 1.0
    severity: CRITICAL

  - id: schema_status_values
    type: schema
    check: accepted_values
    column: status
    values: ["pending", "approved", "paid", "disputed", "cancelled"]
    severity: CRITICAL

  - id: content_amount_non_negative
    type: schema
    check: range
    column: amount_gbp
    min: 0.01
    severity: WARNING

  - id: volume_minimum_rows
    type: volume
    check: row_count_min
    min: 1
    severity: CRITICAL
    description: "At least one invoice must be ingested"

  - id: freshness_check
    type: freshness
    check: max_partition_age
    partition_column: _ingestion_date
    max_age_hours: 26
    severity: CRITICAL
```

Validate the ruleset:

```bash
forge dq validate sources/dev/CoreData/src/finance/IngestSupplierInvoices/dq/supplier_invoices.yaml
# Output: ✓ Ruleset valid (6 rules, 0 errors)
```

### Step 5: Test the Ruleset Against Sampled Data in a Notebook

```python
# In VS Code notebook, connected to Spark Connect (dev environment):
import os
from pyspark.sql import SparkSession
from forge.dq.sdk import DQRunner, load_ruleset

spark = SparkSession.builder \
    .remote(os.environ["SPARK_CONNECT_URL"]) \
    .getOrCreate()

# Read the dev curated table (after Step 6 syncs and runs once)
df = spark.read.format("delta").load(
    "abfss://silver@forgeadlsdsengdev.dfs.core.windows.net/finance/supplier_invoices"
)

ruleset = load_ruleset("sources/dev/CoreData/src/finance/IngestSupplierInvoices/dq/supplier_invoices.yaml")
runner = DQRunner(spark=spark, ruleset=ruleset)
report = runner.run(df)

assert report.passed, f"DQ failed in dev: {report.critical_summary()}"
print("All DQ rules passed on dev data — ready to sync and open a PR")
```

### Step 6: Sync to Dev and Test

`sync-jobs.sh` does everything in one step: generates the DAG, uploads Spark job + DQ rules + DAG to ADLS, injects the DAG into the running dag-processor pod, and registers the pipeline in the portal.

```bash
FORGE_ENV="dev" OWNER_ALIAS="DSEng" \
  bash infra/scripts/sync-jobs.sh --job ingest_supplier_invoices --data-repo <path-to-data-repo>
```

Wait ~30 seconds, then trigger a test run:

```bash
forge dag trigger ingest_supplier_invoices --env dev --conf '{"run_date": "2026-04-01"}'
```

Monitor progress in the portal: **Pipelines → ingest_supplier_invoices → [run] → task graph**.

### Step 7: Run Tests, Open PR, and Merge

```bash
# DAG unit tests (in DSEngCoreInfra repo)
pytest orchestration/airflow/tests/finance/ -v

# DQ ruleset validation (in DSEngCoreData repo)
forge dq validate sources/dev/CoreData/src/finance/IngestSupplierInvoices/dq/supplier_invoices.yaml

# Commit and push — two repos, two PRs
# DSEngCoreData (Spark jobs + DQ rules):
cd D:/Repos/DSEngCoreData
git add sources/dev/CoreData/src/finance/
git commit -m "feat: add supplier invoices ingestion pipeline"
git push origin feature/ingest-supplier-invoices
gh pr create --title "feat: supplier invoices ingestion pipeline" \
  --body "Adds raw ingestion, curated transform, and DQ rules for the daily supplier invoices export."

# DSEngCoreInfra (DAG tests):
cd D:/Repos/DSEngCoreInfra/Forge
git add orchestration/airflow/tests/finance/
git commit -m "feat: add DAG tests for supplier invoices pipeline"
git push origin feature/ingest-supplier-invoices
gh pr create --title "test: DAG unit tests for supplier invoices pipeline"
```

After both PRs merge, the pipeline is live in dev — visible in the portal under **Pipelines**, queryable via Trino at `hive.silver.supplier_invoices`.

---

## 7. Git Branching Model

### Branch Structure

```
main  (production-ready, protected)
  │
  ├── feature/ingest-supplier-invoices      ← new pipeline
  ├── feature/add-dq-rules-orders           ← ruleset update
  ├── fix/spark-job-oom-curated-orders      ← bug fix
  └── chore/upgrade-airflow-3.1.0           ← dependency upgrade
```

There is one long-lived branch: `main`. Every change arrives via a short-lived feature branch and a Pull Request. Merge commits are used (no squash, no rebase) to preserve individual commit history.

### Branch Naming Conventions

| Prefix | Usage |
|--------|-------|
| `feature/` | New pipeline, new dataset, new platform capability |
| `fix/` | Bug fix in existing pipeline or platform code |
| `chore/` | Dependency upgrades, tooling changes, refactoring |
| `docs/` | Documentation updates only |

### Pull Request Requirements

All PRs to `main` require:

1. **CI passes** — all linting, unit tests, and DQ ruleset validation must be green
2. **At least 1 approval** from a code owner (CODEOWNERS file defines owners per directory)
3. **No unresolved review comments**

CODEOWNERS assignments:
- `orchestration/airflow/dags/` → assigned to the DAG's `owner` field (enforced by a CI check)
- `orchestration/dq/rules/` → assigned to the dataset owner (same enforcement)
- `portal/` → platform team
- `infra/` → platform team
- `sdk/` → platform team

### ADO Pipeline Automatic Deploy to Dev

When a PR merges to `main`, the ADO release pipeline triggers automatically and deploys the updated Helm charts to the `dev` environment:

```
GitHub / Azure DevOps                      forge-orchestration-dev
     │                                              │
     │  PR merged to main                          │
     │                                             │
     │  ADO Pipeline triggered (webhook on merge)  │
     ├──────────────────────────────────────────── │
     │                                             │
     │  ADO Pipeline runs helm upgrade             │
     │  (new DAG is in git-sync volume)            │
     │  (new portal image tag → rolling update)    │
     │                                             │
     └──────────────────────────────────────────── ▶  dev updated automatically
```

Git-synced resources (DAG files, DQ rules) appear in dev within 60–90 seconds of merge. Kubernetes resources (new pod images, config map changes) are updated by ADO Pipeline within minutes.

> **Production promotion** is handled by the platform team via git tags after your PR merges and is validated in dev. You don't need to do anything — open your PR, get it reviewed, and the platform team handles the rest.

---

## 8. Debugging Guide

### Debugging a Failed Spark Job

**Symptom:** Airflow task `spark_transform_curated` failed. The Airflow run shows `FAILED` state.

**Step 1: Read the Airflow task log**

In the Developer Portal: navigate to **Pipelines → transform_sales_orders → [run] → spark_transform_curated → Logs**.

The Airflow task log for a `SparkKubernetesOperator` task shows:
- The `SparkApplication` CRD that was submitted
- The pod name that was created
- The final state reported by the Spark Operator

Look for the line: `SparkApplication <name> terminated with state: FAILED`. This tells you the Spark job itself failed (as opposed to Airflow infrastructure failing before it could even submit).

Alternatively via CLI:

```bash
forge dag logs transform_sales_orders --task spark_transform_curated --run-id scheduled__2026-03-24T06:00:00
```

**Step 2: Read the Spark driver log**

The driver log contains the actual Python traceback. Get it via the portal (click the task → **Logs**) or via the forge CLI:

```bash
forge dag logs transform_sales_orders \
  --task spark_transform_curated \
  --run-id scheduled__2026-03-24T06:00:00
```

Common errors:

| Error | Cause |
|-------|-------|
| `AnalysisException: Path does not exist` | Raw partition for this date doesn't exist — check the ingestion task upstream |
| `AnalysisException: Cannot write incompatible data to Delta table` | Schema evolution attempted without ALTER TABLE — run `ALTER TABLE ADD COLUMN` first |
| `java.lang.OutOfMemoryError: Java heap space` | Executor memory exhausted — increase `spec.executor.memory` in SparkApplication CRD |
| `org.apache.spark.SparkException: Job aborted due to stage failure` | Task-level failure — look at executor logs for the specific task error |
| `DeltaConcurrentModificationException` | Two jobs wrote to the same Delta table simultaneously — fix the pipeline scheduling to serialise writes |

**Step 3: Deeper debugging (executor logs, Spark UI)**

If the driver log says "stage aborted" without a clear Python error, the failure is inside an executor. This requires cluster access — contact the platform team with the run ID and they can pull executor logs and Spark UI details for you.

### Debugging a Failed Airflow Task (Non-Spark)

**Symptom:** A `PythonOperator` task (e.g., `validate_dq`) failed.

In the Developer Portal, navigate to **Pipelines → [dag] → [run] → [task] → Logs**. The Python operator runs in a KubernetesExecutor pod; the full Python traceback is in the task log.

Common causes for DQ task failure:
- `DQ CRITICAL failures: ...` — a CRITICAL DQ rule failed; see next section
- `ConnectionRefusedError` connecting to Trino — check Trino status in the portal (**Platform → Services → Trino**) or contact the platform team
- `FileNotFoundError` for the DQ rules YAML — the git-sync did not pick up the new file yet (wait 60s and retry)

To retry a failed task without re-running the full DAG:

```bash
forge dag retry transform_sales_orders \
  --task validate_dq \
  --run-id scheduled__2026-03-24T06:00:00
```

### Debugging a DQ Failure

**Symptom:** The portal shows dataset `silver/sales/orders` with DQ status `FAILED`. The Gold layer is not updated (stale data).

**Step 1: Go to the DQ dashboard**

In the Developer Portal: **DQ → silver/sales/orders → [latest run]**.

The DQ run detail shows every rule, its result, and for failing rules: the observed value vs threshold.

**Step 2: Investigate the failing rule**

Example: `content_customer_id_null_rate` is failing with observed value `0.042` (4.2% null rate) against threshold `0.01` (1%).

- Open the dataset detail page: **Datasets → curated → sales/orders → Preview**
- Filter to rows where `customer_id IS NULL` (use the preview filter)
- Check the `_ingestion_date` of those rows — are they all from today's partition?

If the nulls are concentrated in today's partition, the upstream ingestion had a problem with today's source file. Check:

```bash
# Check the raw partition for today
forge dataset preview bronze/sales/orders \
  --filter "_ingestion_date = '2026-03-24'" \
  --columns "order_id,customer_id" \
  --limit 20
```

If `customer_id` is null in the raw partition, the problem is in the source data — contact the source system team. If `customer_id` is populated in raw but null in curated, the problem is in the transform job logic (look at the column mapping in `transform_sales_orders.py`).

**Step 3: Fix and re-run**

After fixing the root cause (source data redelivered, or transform job fixed and redeployed):

```bash
# Re-run from the DQ validation task (Spark transform has already succeeded)
forge dag retry transform_sales_orders \
  --task validate_dq \
  --run-id scheduled__2026-03-24T06:00:00
```

If DQ passes on retry, Airflow continues to `publish_serving` automatically.

### Debugging Missing Lineage

**Symptom:** The lineage graph for `silver/sales/orders` is missing upstream or downstream nodes.

Check the portal: **Lineage → silver/sales/orders → [job node] → Run detail → Events**. Each job run should show both a START and a COMPLETE event. If only START is present, the Spark job crashed before the OpenLineage event was sent — fix the underlying job failure first and the lineage will be emitted on the next successful run.

If the graph is incomplete after a successful run, check that the DAG was generated with the correct `source:` and `output:` tags (regenerate with `forge generate` if needed, then re-sync). The portal lineage API uses these tags to build the graph — it does not use OpenLineage or Purview.

---

## 9. Environment Parity

### How Spark Connect Ensures Dev/Prod Parity

The critical source of "it worked in dev but failed in prod" in traditional data engineering is configuration drift: different Spark versions, different ADLS credentials, different catalog configurations, different Python dependencies.

Spark Connect eliminates this because your VS Code notebook runs code **on the actual cluster**. When you connect to the dev Spark Connect server, you are executing on a Spark cluster that is configured identically to production — same container image, same Spark configuration, same ADLS access via workload identity, same Delta Lake version, same OpenLineage integration.

There is one source of potential divergence: Python client-side code (the code you write in VS Code) vs the code that runs in the Spark Operator driver pod. Spark Connect executes your Python code on the remote driver, so if your notebook imports a library that is not installed in the Spark image, it will fail on the remote driver — and this failure manifests the same in dev as in prod.

### What Differs Between Dev and Prod Clusters

Exactly one thing is different between the dev and prod clusters: **sizing**. Everything else is identical.

| Configuration | Dev | Prod |
|--------------|-----|------|
| Spark container image tag | `spark:4.1.0` (same) | `spark:4.1.0` (same) |
| Spark configuration (JVM, shuffle, memory fractions) | Identical | Identical |
| Delta Lake version | 4.0.0 (same) | 4.0.0 (same) |
| ADLS access method | Workload identity (same) | Workload identity (same) |
| Lineage | DAG `source:`/`output:` tags (same) | DAG `source:`/`output:` tags (same) |
| Airflow configuration | `KubernetesExecutor` (same) | `KubernetesExecutor` (same) |
| Node pool sizes | `spark`: 0–5 nodes, `E4s_v5` | `spark`: 0–20 nodes, `E8s_v5` |
| Data | Dev ADLS account (subset of prod data) | Prod ADLS account |

The dev `spark` node pool uses smaller VMs (4 cores / 32 GB vs 8 cores / 64 GB). This means a job that works in dev might run slower in prod on large datasets (more resources), or — in rare cases — behave slightly differently if the executor parallelism changes in a way that interacts with data skew. However, because the Spark and Delta configuration is identical, the correctness of the job is guaranteed to be the same.

The dev ADLS account contains a representative sample of production data (approximately the most recent 30 days), refreshed weekly. This is sufficient for testing schema, transform logic, and DQ rules. Volume checks in DQ rulesets use lower thresholds in dev (configurable per-environment via Airflow variables).

### Dev Guardrails — What the Platform Enforces on Your DAGs

Dev is a shared environment. The Forge platform enforces the following rules automatically via the `forge_dev_policy` Airflow plugin. These run at DAG parse time and **cannot be overridden in your DAG file**.

| Rule | Value | What happens if you violate it |
|------|-------|-------------------------------|
| Max DAGs per user | **5** | Parse error — 6th DAG is rejected until you delete one |
| Max schedule window | **5 days** | `end_date` is silently capped to `start_date + 5 days` |
| Catchup | **Disabled** | Missed runs are never backfilled, regardless of DAG setting |
| Max start_date lookback | **30 days** | Parse error if `start_date` is older than 30 days |
| Max concurrent runs per DAG | **2** | Hard cap — additional runs queue |

**Why the 5-day auto-expire?** It forces you to be intentional about what is running. If your DAG goes quiet after 5 days, it stops on its own — no orphaned schedules consuming cluster resources. To keep a DAG running beyond 5 days, update its `start_date` and re-sync.

**Why the 5-DAG limit?** Dev is shared across the team. The limit ensures the orchestration cluster stays within its cost budget and no single engineer monopolises the scheduler.

**To add a new DAG when you're at the limit:**
```bash
# 1. Delete the old DAG from ADLS (prevents restore on restart)
az storage blob delete \
  --account-name forgeadlsdsengdev --container-name code \
  --name dags/<old_dag_name>_dag.py --auth-mode login

# 2. Sync the new DAG (old one disappears on next dag-processor restart)
FORGE_ENV="dev" OWNER_ALIAS="DSEng" \
  bash infra/scripts/sync-jobs.sh --job <new_job_name> --data-repo D:/Repos/DSEngCoreData
```
If you need the old DAG gone immediately (not waiting for a restart), ask the platform team.

None of these rules apply in prod.

### Dev and Prod Use the Same Executor

Both dev and prod run `KubernetesExecutor` — every task spawns a dedicated pod. There is no local Airflow executor. This means:

- Task isolation is identical between dev and prod — each task starts fresh, no shared state
- All tasks have access to the same Azure services (ADLS, Key Vault, ACR) via workload identity
- A task that passes in dev will behave the same way in prod (modulo data volume and VM size)

Always write tasks as stateless functions that communicate only via XCom or shared storage — this is enforced by the executor, not just a convention.

The DAG unit tests (described in Section 4) do not test task execution — they test DAG structure. Actual task execution is tested in the dev environment using the `forge dag trigger` workflow.

---

## 10. forge-cli Reference

The `forge-cli` is a Python CLI tool installed as part of the `sdk/python` package. It is the primary command-line interface for developers interacting with the Forge platform. Install it with the SDK:

```bash
pip install -e "sdk/python[dev]"

# Verify:
forge --version
# forge-cli 1.0.0
```

Authentication uses the developer's Azure AD identity via `az login`. The CLI reads the active Azure CLI credential and calls the portal API with a scoped Bearer token.

```bash
# Authenticate (one-time per session):
az login
# forge-cli picks up the credential automatically via DefaultAzureCredential
```

---

### `forge job submit`

Submit a Spark job to the compute cluster by applying a `SparkApplication` CRD.

```
USAGE:
  forge job submit <crd-file> [options]

OPTIONS:
  --wait          Block until job completes or fails (default: false)
  --timeout       Max wait time in seconds (default: 3600)
  --param KEY=VAL Override SparkApplication spec fields (repeatable)

EXAMPLES:

  # Submit a job and return immediately
  forge job submit sources/dev/CoreData/src/finance/IngestSupplierInvoices/jobs/ingest_raw_supplier_invoices.yaml

  # Submit and wait for completion
  forge job submit sources/dev/CoreData/src/sales/transform_sales_orders.yaml --wait

  # Override the ADLS account parameter
  forge job submit sources/dev/CoreData/src/sales/transform_sales_orders.yaml \
    --param "spec.arguments[0]=forgeadlsdsengdev" \
    --wait

OUTPUT (--wait):
  Submitting SparkApplication transform-sales-orders-20260324-1...
  Status: SUBMITTED → RUNNING (driver started)
  Status: RUNNING (executors: 3/8)
  Status: RUNNING (executors: 8/8)
  Status: SUCCEEDING
  Status: COMPLETED
  Duration: 4m 32s
  Driver pod: transform-sales-orders-abc123-driver
```

---

### `forge dq run`

Run a DQ ruleset against a dataset and print the report. Does not write results to the DQ store (use `--store` to persist).

```
USAGE:
  forge dq run <ruleset-file> [options]

OPTIONS:
  --namespace     Dataset namespace (default: curated)
  --store         Write results to DQ Delta table (default: false)
  --spark-url     Spark Connect URL (default: $SPARK_CONNECT_URL)
  --fail          Exit non-zero if any CRITICAL rule fails (default: true)

EXAMPLES:

  # Run DQ rules on dev data, print report, do not store
  forge dq run orchestration/dq/rules/sales/orders.yaml \
    --spark-url "sc://10.1.42.100:15002"

  # Run and store results (for a manual re-validation)
  forge dq run orchestration/dq/rules/sales/orders.yaml \
    --store \
    --spark-url "sc://10.1.42.100:15002"

  # Validate only (check YAML structure, no data access)
  forge dq validate orchestration/dq/rules/sales/orders.yaml

OUTPUT:
  DQ Run: silver/sales/orders
  ─────────────────────────────────────────
  [✓] schema_order_id_not_null         CRITICAL  PASSED
  [✓] content_customer_id_null_rate    CRITICAL  PASSED  (observed: 0.003)
  [✓] content_order_id_unique          CRITICAL  PASSED
  [✗] content_order_ts_not_future      WARNING   FAILED  (observed: 42 rows, threshold: 0)
  [✓] volume_minimum_rows              CRITICAL  PASSED  (observed: 2,104,881)
  [✓] freshness_latest_partition       CRITICAL  PASSED  (age: 4.2h)
  ─────────────────────────────────────────
  Result: WARNING (1 warning, 0 critical failures)
  Exit code: 0  (no CRITICAL failures)
```

---

### `forge lineage get`

Fetch and display the lineage graph for a dataset or job.

```
USAGE:
  forge lineage get <namespace>/<name> [options]

OPTIONS:
  --type       "dataset" or "job" (default: dataset)
  --depth      Graph traversal depth (default: 3, max: 5)
  --direction  "both", "upstream", "downstream" (default: both)
  --format     "tree" (default) or "json"
  --impact     Show downstream impact list instead of graph

EXAMPLES:

  # Show lineage graph for silver/sales/orders
  forge lineage get silver/sales/orders

  # Show only downstream graph (impact from this dataset)
  forge lineage get silver/sales/orders --direction downstream

  # Get impact list (which datasets are downstream)
  forge lineage get silver/sales/orders --impact

  # Output as JSON (for scripting)
  forge lineage get silver/sales/orders --format json > lineage.json

OUTPUT (tree):
  silver/sales/orders
  ├── [upstream] bronze/sales/orders/{date}
  │       └── [job] ingest_raw_orders (airflow) — last run: ✓ 6h ago
  │               └── [input] source:erp/sales_order_extract
  └── [downstream] gold/sales/orders
          └── [job] publish_serving_orders (airflow) — last run: ✓ 5h ago
```

---

### `forge dataset preview`

Preview rows from a dataset using Trino.

```
USAGE:
  forge dataset preview <namespace>/<name> [options]

OPTIONS:
  --limit      Number of rows to return (default: 20, max: 100)
  --columns    Comma-separated column list (default: all)
  --filter     SQL WHERE clause (e.g. "status = 'open'")
  --format     "table" (default) or "csv" or "json"

EXAMPLES:

  # Preview first 20 rows of the serving orders table
  forge dataset preview gold/sales/orders

  # Preview specific columns with a filter
  forge dataset preview silver/sales/orders \
    --columns "order_id,customer_id,order_total_usd,status" \
    --filter "status = 'open' AND order_total_usd > 1000" \
    --limit 10

  # Output as CSV for piping to a file
  forge dataset preview gold/sales/orders --format csv > sample.csv

OUTPUT:
  Previewing: gold/sales/orders  (via Trino, serving catalog)
  ──────────────────────────────────────────────────────────────
   order_id     │ customer_id │ order_total_usd │ status
  ──────────────┼─────────────┼─────────────────┼──────────
   ORD-10042331 │ CUST-00891  │       1,249.99  │ fulfilled
   ORD-10042330 │ CUST-01203  │         89.50   │ open
   ...
  ──────────────────────────────────────────────────────────────
  Showing 20 of 2,104,881 rows
```

---

### `forge dag trigger`

Trigger a manual Airflow DAG run.

```
USAGE:
  forge dag trigger <dag_id> [options]

OPTIONS:
  --env      Environment: "dev" or "prod" (default: dev)
  --conf     JSON config string passed to DAG as run conf
  --wait     Block until run completes (default: false)
  --timeout  Max wait in seconds if --wait (default: 7200)

EXAMPLES:

  # Trigger a dev run with a specific run date
  forge dag trigger transform_sales_orders \
    --env dev \
    --conf '{"run_date": "2026-03-24"}'

  # Watch run status (without --wait)
  forge dag status transform_sales_orders --latest

OUTPUT (--wait):
  Triggered: transform_sales_orders
  Run ID:    manual__portal__u.smith__20260324T143201
  Env:       dev
  Tracking:  https://portal.forge.internal/pipelines/transform_sales_orders/runs/manual__...

  Tasks:
    spark_transform_curated   QUEUED → RUNNING → SUCCESS  (2m 14s)
    wait_for_transform        SUCCESS                      (0s)
    validate_dq               RUNNING → SUCCESS            (45s)
    publish_serving           RUNNING → SUCCESS            (1m 02s)

  Run complete: SUCCESS (total: 3m 01s)
```

---

## 11. Restatement & Backfill

Restatement is how you re-run a pipeline over historical data — to fix a bug, apply a logic change, or correct data that was delivered with errors. Every Forge pipeline is idempotent: re-running it for the same partition produces the same result. The **partition tracker** (`_SUCCESS.json`) is the mechanism that makes this safe.

### How Trackers Work

After every successful pipeline run, the SDK writes a `_SUCCESS.json` tracker file under the partition path:

```
silver/sales/orders/v1/
  delta/year=2024/month=01/day=01/hour=00/   ← data
    part-0000.parquet
  _tracker/year=2024/month=01/day=01/hour=00/
    _SUCCESS.json                              ← "this partition is done"
  _dq/year=2024/month=01/day=01/hour=00/
    dq_result_abc123_20240101060000.json       ← DQ results
```

When the pipeline starts, it checks for the tracker first:
- **Tracker present** → skip (already processed, no re-work)
- **Tracker missing** → process, write data, write tracker

Restatement works by **deleting the trackers** for a date range, then triggering an Airflow backfill. The pipeline finds no trackers and reprocesses those partitions.

### Triggering a Restatement from the Portal

1. Navigate to **Datasets** → your dataset → click **"Restate"**
   *(or Pipeline → your pipeline → "Backfill / Restate")*

2. Fill in the form:
   - **Date range** — start and end date (inclusive)
   - **Layers** — Silver only, or Silver + Gold
   - **Cascade** — optionally include downstream datasets (portal shows lineage graph)
   - **Reason** — required text for audit trail

3. Review the confirmation screen — it shows how many trackers will be deleted and which partitions are affected.

4. Click **Confirm Restatement**. The portal:
   - Deletes the trackers for the selected partitions
   - Triggers Airflow backfill runs (one per partition per layer)
   - Shows a live progress screen

5. Monitor progress from the portal. Each partition shows as it completes. DQ re-runs automatically on each restated partition.

### Triggering a Backfill via CLI

```bash
# Restate sales.orders for a 7-day range
forge restate sales.orders \
  --start 2024-01-01 \
  --end   2024-01-07 \
  --layers silver,gold \
  --reason "Source redelivered corrected January data"

# Restate with cascade (restates downstream datasets too)
forge restate sales.orders \
  --start 2024-01-01 \
  --end   2024-01-07 \
  --cascade full \
  --reason "Bug fix in orders transformation"

# Check restatement status
forge restatement status rst-7f3a9c2b

# List recent restatements for a dataset
forge restatement list --dataset sales.orders --limit 10
```

### Writing Idempotent Pipelines

All generated pipelines use `ForgeSparkOperator`, which submits a Spark job built on the `ForgeJob` base class. `ForgeJob` handles tracker checking and writing automatically — no manual tracker calls needed.

At job startup, `ForgeJob.setup()` checks for `_tracker/{date_key}/tracker.json` in ADLS:
- **Tracker present** → `SystemExit(0)` (clean exit, Airflow task marked done, no reprocessing)
- **Tracker absent** → proceed to read, transform, and write

After the Delta write completes, the job writes:
```json
{
  "version": "v1",
  "job": "nyc_taxi_silver",
  "table": "silver.nyctaxi",
  "partition": {"date": "01_04_2026_00"},
  "status": "success",
  "rows_written": 847291,
  "completed_at": "2026-04-01T03:12:45+00:00",
  "forge_env": "dev"
}
```

**Never write trackers or data manually** (e.g. via `az storage` CLI, Azure Storage Explorer, or direct ADLS SDK calls outside a pipeline). Manual writes bypass lineage, DQ, and the tracker protocol — the platform has no record of them. All data writes must go through a Forge pipeline so the tracker, lineage event, and DQ report are all produced atomically.

### Restatement History

Every restatement is recorded in the **Restatement Registry** (a Delta table queryable via Trino):

```sql
SELECT
  restatement_id,
  triggered_by,
  date_range_start,
  date_range_end,
  reason,
  status,
  rows_after - rows_before AS row_delta
FROM gold._platform.restatement_registry
WHERE dataset_id = 'sales.orders'
ORDER BY triggered_at DESC;
```

The portal's **Datasets → [dataset] → Restatements tab** shows the same history with a visual row delta chart.

### Rules and Limits

| Rule | Detail |
|------|--------|
| Max range via portal | 90 days. Larger ranges require `forge restate --force` run by the platform team. |
| Concurrency | Only one active restatement per dataset at a time. |
| DQ | DQ re-runs automatically on every restated partition. A DQ failure marks the partition `DQ_FAILED` and fires an alert. |
| Bronze | Bronze has no trackers. To re-ingest bronze data, re-deliver from the source system. |
| Cancellation | An in-progress restatement can be cancelled. Completed partitions keep their new data; remaining partitions will be reprocessed on the next regular Airflow run. |

See [Restatement Architecture](../architecture/13-restatement.md) for the full technical design.
