# Forge — Developer Experience Guide

> **Version:** 1.0
> **Status:** Production
> **Audience:** Data engineers, platform engineers, on-call engineers

---

## Table of Contents

1. [VS Code Setup](#1-vs-code-setup)
2. [Spark Connect Development](#2-spark-connect-development)
3. [Airflow DAG Development](#3-airflow-dag-development)
4. [DQ Rule Authoring](#4-dq-rule-authoring)
5. [End-to-End Pipeline Workflow](#5-end-to-end-pipeline-workflow)
6. [Git Branching Model](#6-git-branching-model)
7. [Debugging Guide](#7-debugging-guide)
8. [Environment Parity](#8-environment-parity)
9. [forge-cli Reference](#9-forge-cli-reference)

---

## 1. VS Code Setup

### Recommended Extensions

Install these extensions before working on Forge. The repository includes a `.vscode/extensions.json` that will prompt VS Code to install them automatically when you open the workspace.

| Extension | ID | Purpose |
|-----------|-----|---------|
| Python | `ms-python.python` | Python language support, environment management |
| Pylance | `ms-python.vscode-pylance` | Type checking, IntelliSense, import resolution |
| Jupyter | `ms-toolsai.jupyter` | Run notebooks inline in VS Code against Spark Connect |
| Kubernetes | `ms-kubernetes-tools.vscode-kubernetes-tools` | Browse cluster resources, port-forward, view logs |
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
  "vs-kubernetes": {
    "vs-kubernetes.kubectl-path": "/usr/local/bin/kubectl",
    "vs-kubernetes.kubeconfig": "${env:KUBECONFIG}"
  },
  "editor.rulers": [100],
  "files.exclude": {
    "**/__pycache__": true,
    "**/.pytest_cache": true,
    "**/*.egg-info": true
  }
}
```

Key settings to understand:

- `python.analysis.extraPaths` adds the SDK and Airflow DAG directories to the Pylance import resolver. This means `from forge.dq.sdk import DQRunner` resolves correctly in VS Code without installing the package in editable mode each time.
- `yaml.schemas` wires DQ ruleset YAML files to the JSON Schema for real-time validation. If you reference a non-existent rule type or misspell a severity level, VS Code underlines it immediately.
- `ruff.lint.args` points to the project `pyproject.toml` which defines consistent linting rules shared with CI.

### Python Virtual Environment

Create the virtual environment once after cloning:

```bash
# From repo root
python -m venv .venv
source .venv/bin/activate                    # Linux/macOS
# .\.venv\Scripts\Activate.ps1              # Windows PowerShell

pip install -e "sdk/python[dev]"             # installs forge SDK + dev deps
pip install -r orchestration/airflow/requirements-dev.txt
```

The SDK installs `pyspark`, `delta-spark`, `openlineage-python`, and the `forge-cli` entry point. The Airflow dev requirements install `apache-airflow` (matching the production version), `pytest`, `coverage`, and mock libraries.

After the venv is set up, VS Code detects `.venv/bin/python` automatically (matching `python.defaultInterpreterPath`) and Pylance uses it for type checking.

---

## 2. Spark Connect Development

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
# Using forge-cli (recommended)
forge job spark-connect-url

# Or directly:
kubectl --context forge-compute-dev \
  get svc spark-connect \
  -n spark-system \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

The output is the internal IP of the Spark Connect load balancer service, e.g. `10.1.42.100`. The gRPC port is always `15002`.

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
ADLS_ACCOUNT = "forgestorageprod"

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

### Debugging a Slow Query Using Spark UI

When a cell runs slowly, use the Spark UI to understand what is happening.

**Step 1: Port-forward to the Spark Connect server's Spark UI**

```bash
# Find the Spark Connect server pod
kubectl --context forge-compute-dev \
  get pods -n spark-system \
  -l app=spark-connect

# Port-forward the Spark UI (port 4040 is the default)
kubectl --context forge-compute-dev \
  port-forward -n spark-system \
  pod/spark-connect-server-0 4040:4040
```

Open `http://localhost:4040` in your browser. The Spark UI shows the active Spark application running the Connect server.

**Step 2: Find your query in the Spark UI**

Navigate to the **SQL / DataFrame** tab. You should see your recent queries listed by description. Each query shows:

- Duration
- Number of stages and tasks
- Whether it read from cache or disk
- The physical plan

Click into a query to see the stage breakdown. Common problems to spot:

| Symptom in Spark UI | Likely Cause | Fix |
|--------------------|--------------|-----|
| One stage has 1 task, all others have 200 tasks | Data skew — one partition is huge | Repartition by a different key: `df.repartition(200, "order_date")` |
| Many small tasks (< 1 MB each) | Too many small partitions (common after filter) | Coalesce: `df.coalesce(20)` after the filter |
| Long shuffle stage | Large join or groupBy creating network IO | Check join type — consider `broadcast()` if one side is small |
| Spill to disk (shown in stage metrics) | Insufficient executor memory for operation | Increase `spark.executor.memory` or reduce parallelism |

**Step 3: Read the physical plan**

In the SQL tab, click **Details** on any query to see the full Spark physical plan. Look for:

- `FileScan delta` — confirms Delta file pruning is working (check `PushedFilters` — if your filter column is a partition column, it should be there)
- `BroadcastHashJoin` vs `SortMergeJoin` — BroadcastHashJoin is faster for joins where one side fits in memory
- `Exchange` nodes — these are shuffle boundaries, each one is expensive

### Moving from Notebook to a Production Spark Job

Once your notebook logic is validated, extract it into a standalone Python file:

**1. Create the job file**

```bash
# Job files live in orchestration/spark/jobs/
touch orchestration/spark/jobs/transform_sales_orders.py
```

**2. Structure the production job**

```python
# orchestration/spark/jobs/transform_sales_orders.py

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

**4. Upload the job file and define the SparkApplication CRD**

```bash
# Upload job to ADLS code container
az storage blob upload \
  --account-name "forgestoragedev" \
  --container-name "code" \
  --name "jobs/transform_sales_orders.py" \
  --file "orchestration/spark/jobs/transform_sales_orders.py" \
  --auth-mode login
```

The Airflow DAG references this path directly in the `SparkApplication` CRD definition (see DAG Development section).

---

## 3. Airflow DAG Development

### Authoring a DAG

DAGs live in `orchestration/airflow/dags/`. The platform provides base templates for common patterns. For a new pipeline, start from the standard four-stage template:

```python
# orchestration/airflow/dags/sales/transform_sales_orders.py

from datetime import datetime, timedelta
from airflow.decorators import dag, task
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import SparkKubernetesOperator
from airflow.providers.cncf.kubernetes.sensors.spark_kubernetes import SparkKubernetesSensor
from airflow.operators.python import PythonOperator
from forge.dq.sdk import DQRunner, load_ruleset
from forge.lineage.hooks import emit_serving_event

ADLS_ACCOUNT = "{{ var.value.adls_account }}"   # Airflow variable, set per-env

default_args = {
    "owner": "jane.smith@company.com",
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "retry_exponential_backoff": True,
    "email_on_failure": True,
    "email": ["jane.smith@company.com"],
    "depends_on_past": False,
}


@dag(
    dag_id="transform_sales_orders",
    schedule="0 6 * * *",      # 06:00 UTC daily
    start_date=datetime(2026, 1, 1),
    catchup=False,
    tags=["sales", "curated", "sla-critical"],
    default_args=default_args,
    doc_md="""
    ## Transform Sales Orders

    Reads daily raw sales order partitions, applies canonical schema transforms,
    MERGEs into curated Delta table, validates with DQ rules, and publishes to serving.

    **SLA:** Gold layer updated by 08:00 UTC.
    **Owner:** jane.smith@company.com
    """,
)
def transform_sales_orders():

    # Stage 1: Spark transform — raw → curated
    spark_transform = SparkKubernetesOperator(
        task_id="spark_transform_curated",
        namespace="spark-jobs",
        application_file="orchestration/spark/crds/transform_sales_orders.yaml",
        kubernetes_conn_id="compute_cluster",
        do_xcom_push=True,
    )

    # Stage 2: Wait for Spark job to complete
    wait_for_transform = SparkKubernetesSensor(
        task_id="wait_for_transform",
        namespace="spark-jobs",
        application_name="{{ task_instance.xcom_pull('spark_transform_curated')['metadata']['name'] }}",
        kubernetes_conn_id="compute_cluster",
        timeout=3600,
        poke_interval=30,
    )

    # Stage 3: DQ validation
    @task(task_id="validate_dq")
    def validate_dq(**context):
        from pyspark.sql import SparkSession
        spark = SparkSession.builder.appName("dq-sales-orders").getOrCreate()
        try:
            df = spark.read.format("delta").load(
                f"abfss://silver@{ADLS_ACCOUNT}.dfs.core.windows.net/sales/orders"
            )
            ruleset = load_ruleset("orchestration/dq/rules/sales/orders.yaml")
            runner = DQRunner(spark=spark, ruleset=ruleset)
            report = runner.run(df)
            report.store(
                delta_path=f"abfss://silver@{ADLS_ACCOUNT}.dfs.core.windows.net/_platform/dq_results/",
                pipeline_run_id=context["run_id"],
            )
            if report.has_critical_failures:
                raise ValueError(f"DQ CRITICAL failures: {report.critical_summary()}")
            return {"dq_passed": True, "run_id": report.run_id}
        finally:
            spark.stop()

    # Stage 4: Publish to serving (Trino CTAS)
    @task(task_id="publish_serving")
    def publish_serving(**context):
        from airflow.providers.trino.hooks.trino import TrinoHook
        hook = TrinoHook(trino_conn_id="trino_lakehouse")
        hook.run("""
            CREATE OR REPLACE TABLE serving.sales.orders
            WITH (
                format = 'DELTA',
                location = 'abfss://gold@{account}.dfs.core.windows.net/sales/orders'
            )
            AS SELECT * FROM curated.sales.orders
            WHERE status != 'test'
        """.format(account=ADLS_ACCOUNT))
        emit_serving_event(
            namespace="serving",
            dataset="sales/orders",
            pipeline_run_id=context["run_id"],
        )
        return {"published": True}

    # Define task dependencies
    spark_transform >> wait_for_transform >> validate_dq() >> publish_serving()


dag = transform_sales_orders()
```

### Testing a DAG Locally

The platform uses Airflow Standalone (single process, SQLite backend) for fast local unit testing of DAG structure and task logic.

**Step 1: Start Airflow Standalone**

```bash
# From repo root, with .venv active
export AIRFLOW_HOME="${PWD}/.airflow-local"
export AIRFLOW__CORE__DAGS_FOLDER="${PWD}/orchestration/airflow/dags"
export AIRFLOW__CORE__EXECUTOR=LocalExecutor
export AIRFLOW__DATABASE__SQL_ALCHEMY_CONN="sqlite:///${PWD}/.airflow-local/airflow.db"
export AIRFLOW__CORE__LOAD_EXAMPLES=False

airflow db init
airflow standalone
```

Airflow Standalone starts the scheduler, webserver (at `http://localhost:8080`), and triggerer in a single process. The SQLite backend is fine for local testing — never use it in production.

**Step 2: Write DAG unit tests**

DAG unit tests (in `orchestration/airflow/tests/`) test DAG structure, not execution:

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

This runs in under 5 seconds — no Airflow scheduler needed, no database.

### Pushing to Git and Watching it Appear in Airflow

Once the DAG is authored and tests pass, push to a feature branch (see Git Branching Model section). Airflow picks up new DAGs via the `git-sync` sidecar on the scheduler and webserver pods.

`git-sync` is configured to sync from the main branch of the Forge repository every 60 seconds. It mounts the synced DAG directory as a shared volume into the Airflow scheduler and webserver containers.

After your PR merges to `main`:

1. Within 60 seconds, `git-sync` pulls the new commit on the orchestration cluster
2. The Airflow scheduler's DAG processor detects the new file in the DAGs folder (file modification time changed)
3. The scheduler imports the new DAG and adds it to the active DAG list (this takes 10–30 seconds for the scheduler to process the import)
4. The DAG appears in the Airflow UI and in the Developer Portal's pipelines list

You do not need to restart any Airflow pod for new DAGs to appear.

### Triggering a Test Run in the Dev Environment

To trigger a test run in the dev environment without waiting for the schedule:

```bash
# Using forge-cli
forge dag trigger transform_sales_orders --env dev --conf '{"run_date": "2026-03-24"}'

# Or directly via Airflow CLI (on orchestration cluster):
kubectl --context forge-orchestration-dev \
  exec -n airflow deploy/airflow-scheduler \
  -- airflow dags trigger transform_sales_orders \
     --conf '{"run_date": "2026-03-24"}'
```

Monitor the run:

```bash
# Watch task state in terminal
forge dag status transform_sales_orders --run-id manual__...

# Or in the portal:
open https://portal.forge.internal/pipelines/transform_sales_orders
```

---

## 4. DQ Rule Authoring

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
from pyspark.sql import SparkSession
spark = SparkSession.builder.remote("sc://10.1.42.100:15002").getOrCreate()

# Cell 2: Read the dataset
df = spark.read.format("delta").load(
    "abfss://silver@forgestorageprod.dfs.core.windows.net/sales/orders"
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

## 5. End-to-End Pipeline Workflow

This section walks through the complete journey from "I have a new data source" to "data is in the Gold layer and queryable by consumers." Every step is exact — commands and code, not summaries.

---

### Scenario

A new data source has arrived: a daily CSV export of supplier invoices placed in an Azure Blob Storage account by an external finance system. The data needs to be:
1. Ingested into the Bronze layer
2. Transformed into a curated Delta table
3. DQ validated
4. Published to the Gold layer where the finance team's Trino queries can reach it

---

### Step 1: Branch and Scaffold

```bash
git checkout main && git pull
git checkout -b feature/ingest-supplier-invoices

# Create directories
mkdir -p orchestration/airflow/dags/finance
mkdir -p orchestration/airflow/tests/finance
mkdir -p orchestration/spark/jobs/finance
mkdir -p orchestration/spark/crds/finance
mkdir -p orchestration/dq/rules/finance
```

### Step 2: Write the Raw Ingestion Spark Job

```python
# orchestration/spark/jobs/finance/ingest_raw_supplier_invoices.py

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
# orchestration/spark/jobs/finance/transform_curated_supplier_invoices.py

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

### Step 4: Upload Job Files

```bash
# Upload both job files to the ADLS code container (dev environment)
for job in ingest_raw_supplier_invoices.py transform_curated_supplier_invoices.py; do
  az storage blob upload \
    --account-name "forgestoragedev" \
    --container-name "code" \
    --name "jobs/finance/${job}" \
    --file "orchestration/spark/jobs/finance/${job}" \
    --auth-mode login
done
```

### Step 5: Write the DQ Ruleset

```yaml
# orchestration/dq/rules/finance/supplier_invoices.yaml

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
forge dq validate orchestration/dq/rules/finance/supplier_invoices.yaml
# Output: ✓ Ruleset valid (6 rules, 0 errors)
```

### Step 6: Test the Ruleset Against Sampled Data in a Notebook

```python
# In VS Code notebook, connected to Spark Connect (dev environment):

from pyspark.sql import SparkSession
from forge.dq.sdk import DQRunner, load_ruleset

spark = SparkSession.builder.remote("sc://10.1.42.100:15002").getOrCreate()

# Read the dev curated table (assuming Step 3 was already run in dev)
df = spark.read.format("delta").load(
    "abfss://silver@forgestoragedev.dfs.core.windows.net/finance/supplier_invoices"
)

ruleset = load_ruleset("orchestration/dq/rules/finance/supplier_invoices.yaml")
runner = DQRunner(spark=spark, ruleset=ruleset)
report = runner.run(df)

assert report.passed, f"DQ failed in dev: {report.critical_summary()}"
print("All DQ rules passed on dev data — ready for production DAG")
```

### Step 7: Write the Airflow DAG

```python
# orchestration/airflow/dags/finance/ingest_supplier_invoices.py

from datetime import datetime, timedelta
from airflow.decorators import dag, task
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import SparkKubernetesOperator
from airflow.providers.cncf.kubernetes.sensors.spark_kubernetes import SparkKubernetesSensor

default_args = {
    "owner": "jane.smith@company.com",
    "retries": 2,
    "retry_delay": timedelta(minutes=10),
    "email_on_failure": True,
    "email": ["jane.smith@company.com", "finance-data@company.com"],
}

ADLS_ACCOUNT   = "{{ var.value.adls_account }}"
SOURCE_ACCOUNT = "{{ var.value.finance_erp_adls_account }}"


@dag(
    dag_id="ingest_supplier_invoices",
    schedule="0 5 * * *",        # 05:00 UTC — source file available by 04:30
    start_date=datetime(2026, 4, 1),
    catchup=False,
    tags=["finance", "raw", "curated", "serving"],
    default_args=default_args,
)
def ingest_supplier_invoices():

    ingest_raw = SparkKubernetesOperator(
        task_id="ingest_raw",
        namespace="spark-jobs",
        application_file="orchestration/spark/crds/finance/ingest_raw_supplier_invoices.yaml",
        kubernetes_conn_id="compute_cluster",
    )

    wait_ingest = SparkKubernetesSensor(
        task_id="wait_ingest",
        namespace="spark-jobs",
        application_name="{{ task_instance.xcom_pull('ingest_raw')['metadata']['name'] }}",
        kubernetes_conn_id="compute_cluster",
        timeout=1800,
        poke_interval=30,
    )

    transform = SparkKubernetesOperator(
        task_id="transform_curated",
        namespace="spark-jobs",
        application_file="orchestration/spark/crds/finance/transform_curated_supplier_invoices.yaml",
        kubernetes_conn_id="compute_cluster",
    )

    wait_transform = SparkKubernetesSensor(
        task_id="wait_transform",
        namespace="spark-jobs",
        application_name="{{ task_instance.xcom_pull('transform_curated')['metadata']['name'] }}",
        kubernetes_conn_id="compute_cluster",
        timeout=3600,
        poke_interval=30,
    )

    @task(task_id="validate_dq")
    def validate_dq(**context):
        from pyspark.sql import SparkSession
        from forge.dq.sdk import DQRunner, load_ruleset
        spark = SparkSession.builder.appName("dq-supplier-invoices").getOrCreate()
        try:
            df = spark.read.format("delta").load(
                f"abfss://silver@{ADLS_ACCOUNT}.dfs.core.windows.net/finance/supplier_invoices"
            )
            ruleset = load_ruleset("orchestration/dq/rules/finance/supplier_invoices.yaml")
            report = DQRunner(spark=spark, ruleset=ruleset).run(df)
            report.store(
                delta_path=f"abfss://silver@{ADLS_ACCOUNT}.dfs.core.windows.net/_platform/dq_results/",
                pipeline_run_id=context["run_id"],
            )
            if report.has_critical_failures:
                raise ValueError(report.critical_summary())
        finally:
            spark.stop()

    @task(task_id="publish_serving")
    def publish_serving():
        from airflow.providers.trino.hooks.trino import TrinoHook
        hook = TrinoHook(trino_conn_id="trino_lakehouse")
        hook.run("""
            CREATE OR REPLACE TABLE serving.finance.supplier_invoices
            WITH (format = 'DELTA',
                  location = 'abfss://gold@{account}.dfs.core.windows.net/finance/supplier_invoices')
            AS SELECT * FROM curated.finance.supplier_invoices
        """.format(account=ADLS_ACCOUNT))

    ingest_raw >> wait_ingest >> transform >> wait_transform >> validate_dq() >> publish_serving()


dag = ingest_supplier_invoices()
```

### Step 8: Run Tests, Open PR, and Merge

```bash
# DAG unit tests
pytest orchestration/airflow/tests/finance/ -v

# DQ ruleset validation
forge dq validate orchestration/dq/rules/finance/supplier_invoices.yaml

# Push and open PR
git add orchestration/
git commit -m "feat: add supplier invoices ingestion pipeline"
git push origin feature/ingest-supplier-invoices
gh pr create --title "feat: supplier invoices ingestion pipeline" \
  --body "Adds raw ingestion, curated transform, DQ validation, and serving publish for the daily supplier invoices export from the finance ERP system."
```

After approval and merge to `main`:

1. ArgoCD syncs the DAG (via git-sync, within 60s)
2. Airflow scheduler picks it up and schedules for next execution
3. At 05:00 UTC the next day, the pipeline runs
4. By 07:00 UTC, `serving.finance.supplier_invoices` is queryable via Trino
5. The portal shows the pipeline, the dataset, the DQ results, and the lineage graph

---

## 6. Git Branching Model

### Branch Structure

```
main  (production-ready, protected)
  │
  ├── feature/ingest-supplier-invoices      ← new pipeline
  ├── feature/add-dq-rules-orders           ← ruleset update
  ├── fix/spark-job-oom-curated-orders      ← bug fix
  └── chore/upgrade-airflow-2.9.4           ← dependency upgrade
```

There is one long-lived branch: `main`. Every change arrives via a short-lived feature branch and a Pull Request. Merge commits are used (no squash, no rebase) to preserve individual commit history.

### Branch Naming Conventions

| Prefix | Usage |
|--------|-------|
| `feature/` | New pipeline, new dataset, new platform capability |
| `fix/` | Bug fix in existing pipeline or platform code |
| `chore/` | Dependency upgrades, tooling changes, refactoring |
| `docs/` | Documentation updates only |
| `hotfix/` | Emergency production fix (rare — goes through the same PR process, just expedited) |

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

### ArgoCD Automatic Sync to Dev

When a PR merges to `main`, ArgoCD (running on the orchestration cluster) detects the new commit within 3 minutes (ArgoCD polls the Git repository every 3 minutes). It automatically syncs the updated manifests to the `dev` environment:

```
GitHub / Azure DevOps                      forge-orchestration-dev
     │                                              │
     │  PR merged to main                          │
     │                                             │
     │  ArgoCD detects diff (3 min poll)           │
     ├──────────────────────────────────────────── │
     │                                             │
     │  ArgoCD applies Helm chart diff             │
     │  (new DAG is in git-sync volume)            │
     │  (new portal image tag → rolling update)    │
     │                                             │
     └──────────────────────────────────────────── ▶  dev updated automatically
```

Git-synced resources (DAG files, DQ rules) appear in dev within 60–90 seconds of merge. Kubernetes resources (new pod images, config map changes) are updated by ArgoCD within 3 minutes.

### Promoting to Production via Git Tag

Production is **not** automatically synced. Production deployments require an explicit Git tag:

```bash
# After validating the change in dev:
git tag prod-2026-03-24-001 -m "Deploy supplier invoices pipeline to prod"
git push origin prod-2026-03-24-001
```

ArgoCD's `forge-orchestration-prod` Application is configured to track `targetRevision: "prod-*"` (latest matching tag). On push, ArgoCD detects the new tag and syncs production within 3 minutes.

The tag convention is `prod-{date}-{seq}`, making it trivial to roll back:

```bash
# Rollback: tag the previous production commit
git tag prod-2026-03-23-003 <prev-sha> -m "Rollback: revert supplier invoices pipeline"
git push origin prod-2026-03-23-003
# ArgoCD syncs to the tagged commit — production returns to the prior state
```

---

## 7. Debugging Guide

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

The Spark driver log contains the actual Python traceback. The driver pod name appears in the Airflow task log:

```bash
# Get the driver pod name from the SparkApplication
kubectl --context forge-compute-prod \
  get sparkapplication -n spark-jobs \
  -l forge.io/pipeline=transform_sales_orders \
  --sort-by=.metadata.creationTimestamp | tail -1

# Read driver logs
kubectl --context forge-compute-prod \
  logs -n spark-jobs \
  transform-sales-orders-<sha>-driver \
  --tail=200
```

The driver log will show the Python traceback at the point of failure. Common errors:

| Error | Cause |
|-------|-------|
| `AnalysisException: Path does not exist` | Raw partition for this date doesn't exist — check the ingestion task upstream |
| `AnalysisException: Cannot write incompatible data to Delta table` | Schema evolution attempted without ALTER TABLE — run `ALTER TABLE ADD COLUMN` first |
| `java.lang.OutOfMemoryError: Java heap space` | Executor memory exhausted — increase `spec.executor.memory` in SparkApplication CRD |
| `org.apache.spark.SparkException: Job aborted due to stage failure` | Task-level failure — look at executor logs for the specific task error |
| `DeltaConcurrentModificationException` | Two jobs wrote to the same Delta table simultaneously — fix the pipeline scheduling to serialise writes |

**Step 3: Read executor logs (for task-level failures)**

When the driver log says "stage aborted" without a clear Python error, the problem is in an executor:

```bash
# List all pods from this Spark application (executor pods)
kubectl --context forge-compute-prod \
  get pods -n spark-jobs \
  -l spark-app-selector=<app-id> \
  --field-selector=status.phase=Failed

# Get logs from a failed executor pod
kubectl --context forge-compute-prod \
  logs -n spark-jobs \
  transform-sales-orders-<sha>-exec-5
```

Executor logs contain the exact UDF or serialization error if the failure happened inside a Spark task.

**Step 4: Use the Spark UI for slow-running jobs**

For jobs that run but are slow (timing out rather than failing with an exception):

```bash
# Port-forward the driver pod's Spark UI
kubectl --context forge-compute-prod \
  port-forward -n spark-jobs \
  transform-sales-orders-<sha>-driver 4040:4040
```

Open `http://localhost:4040`. Navigate to:
- **Stages** — find stages with very long durations or high task-level variation (data skew)
- **Executors** — check for heavy GC time (> 5% of executor time in GC = memory pressure)
- **SQL/DataFrame** — find the slowest query; check if partition pruning is happening

### Debugging a Failed Airflow Task (Non-Spark)

**Symptom:** A `PythonOperator` task (e.g., `validate_dq`) failed.

In the Developer Portal, navigate to **Pipelines → [dag] → [run] → [task] → Logs**. The Python operator runs in a KubernetesExecutor pod; the full Python traceback is in the task log.

Common causes for DQ task failure:
- `DQ CRITICAL failures: ...` — a CRITICAL DQ rule failed; see next section
- `ConnectionRefusedError` connecting to Trino — check Trino coordinator pod health: `kubectl get pods -n trino`
- `FileNotFoundError` for the DQ rules YAML — the git-sync did not pick up the new file yet (wait 60s and retry)

To retry a failed task without re-running the full DAG:

```bash
# Clear and re-run only the failed task
forge dag retry transform_sales_orders \
  --task validate_dq \
  --run-id scheduled__2026-03-24T06:00:00

# Or via Airflow CLI:
kubectl --context forge-orchestration-prod \
  exec -n airflow deploy/airflow-scheduler \
  -- airflow tasks clear transform_sales_orders \
     --task-regex validate_dq \
     --run-id scheduled__2026-03-24T06:00:00 \
     --yes
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

**Symptom:** The lineage graph for `silver/sales/orders` does not show the upstream `bronze/sales/orders` node, or the graph is incomplete.

**Step 1: Check whether OpenLineage events were emitted**

In Marquez: **portal → Lineage → silver/sales/orders → [job node] → Run detail → Events**.

Each job run should show START and COMPLETE (or FAIL) events. If only START is present with no COMPLETE, the OpenLineage library failed to emit the COMPLETE event (usually because the Spark job crashed before the event was sent).

Check the Marquez API log for ingestion errors:

```bash
kubectl --context forge-orchestration-prod \
  logs -n lineage deploy/marquez-api \
  --tail=100 | grep -i error
```

**Step 2: Check Airflow OpenLineage integration**

The OpenLineage Airflow integration emits events via the `openlineage-airflow` package installed in the Airflow image. If it is misconfigured, no events are sent.

Check the environment variables on the Airflow scheduler pod:

```bash
kubectl --context forge-orchestration-prod \
  exec -n airflow deploy/airflow-scheduler \
  -- env | grep OPENLINEAGE
# Expected:
# OPENLINEAGE_URL=http://marquez-api.lineage.svc.cluster.local:5000
# OPENLINEAGE_NAMESPACE=airflow
```

If `OPENLINEAGE_URL` is not set, the Airflow OpenLineage integration is silently disabled. Fix the Helm values and redeploy Airflow.

**Step 3: Manually replay a run's lineage**

If the events were missing due to a transient Marquez outage, you can replay them:

```bash
# Trigger the DAG with lineage_replay=true flag
forge dag trigger transform_sales_orders \
  --conf '{"lineage_replay": true, "run_date": "2026-03-24"}'
```

The `lineage_replay` flag causes the Airflow OpenLineage plugin to re-emit the START and COMPLETE events using the original run timestamps.

---

## 8. Environment Parity

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
| Delta Lake 4.0.0 (same) |
| ADLS access method | Workload identity (same) | Workload identity (same) |
| OpenLineage config | Points to dev Marquez | Points to prod Marquez |
| Airflow configuration | `LocalExecutor` vs `KubernetesExecutor` | `KubernetesExecutor` |
| Node pool sizes | `spark`: 0–5 nodes, `E4s_v5` | `spark`: 0–20 nodes, `E8s_v5` |
| Data | Dev ADLS account (subset of prod data) | Prod ADLS account |

The dev `spark` node pool uses smaller VMs (4 cores / 32 GB vs 8 cores / 64 GB). This means a job that works in dev might run slower in prod on large datasets (more resources), or — in rare cases — behave slightly differently if the executor parallelism changes in a way that interacts with data skew. However, because the Spark and Delta configuration is identical, the correctness of the job is guaranteed to be the same.

The dev ADLS account contains a representative sample of production data (approximately the most recent 30 days), refreshed weekly. This is sufficient for testing schema, transform logic, and DQ rules. Volume checks in DQ rulesets use lower thresholds in dev (configurable per-environment via Airflow variables).

### The LocalExecutor vs KubernetesExecutor Difference

In dev, Airflow uses `LocalExecutor` (all tasks run in the same process as the scheduler). In prod, `KubernetesExecutor` spawns a new pod per task.

This has one practical consequence for local testing: task isolation is different. With `LocalExecutor`, shared Python state between tasks is technically possible (but should never be relied on). With `KubernetesExecutor`, each task starts fresh with no shared state. Always write tasks as stateless functions that communicate only via XCom or shared storage.

The DAG unit tests (described in Section 3) do not test task execution — they test DAG structure. Actual task execution is tested in the dev environment using the `forge dag trigger` workflow.

---

## 9. forge-cli Reference

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
  --context       Kubernetes context (default: current context)
  --namespace     Namespace to submit into (default: spark-jobs)
  --wait          Block until job completes or fails (default: false)
  --timeout       Max wait time in seconds (default: 3600)
  --param KEY=VAL Override SparkApplication spec fields (repeatable)

EXAMPLES:

  # Submit a job and return immediately
  forge job submit orchestration/spark/crds/finance/ingest_raw_supplier_invoices.yaml

  # Submit and wait for completion
  forge job submit orchestration/spark/crds/transform_sales_orders.yaml --wait

  # Submit to dev cluster, overriding the ADLS account parameter
  forge job submit orchestration/spark/crds/transform_sales_orders.yaml \
    --context forge-compute-dev \
    --param "spec.arguments[0]=forgestoragedev" \
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

  # Trigger prod run and wait
  forge dag trigger transform_sales_orders \
    --env prod \
    --conf '{"run_date": "2026-03-24"}' \
    --wait

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
