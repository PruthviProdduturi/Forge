# Forge — Data Quality Framework Architecture

> **Version:** 1.0
> **Status:** Production
> **Last updated:** 2026-03-26
> **Audience:** Platform engineers, data engineers

[![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Delta Lake](https://img.shields.io/badge/Delta%20Lake-003366?style=flat-square&logo=delta&logoColor=white)](https://delta.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org) [![Python](https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Package Architecture](#2-package-architecture)
3. [Layer 1: Automatic Profiling](#3-layer-1-automatic-profiling)
4. [Layer 2: Rule-Based Gates](#4-layer-2-rule-based-gates)
5. [Layer 3: Anomaly Detection](#5-layer-3-anomaly-detection)
6. [Storage Layout](#6-storage-layout)
7. [Querying Results](#7-querying-results)
8. [Airflow Integration](#8-airflow-integration)
9. [OpenLineage Integration](#9-openlineage-integration)
10. [Writing Custom Metrics](#10-writing-custom-metrics)
11. [Configuration Reference](#11-configuration-reference)
12. [Adding DQ to a New Dataset](#12-adding-dq-to-a-new-dataset)

---

## 1. Overview

### 3-Layer Design

The Forge DQ framework operates at three independent levels of depth, each building on the layer beneath it.

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 3: Anomaly Detection                                      │
│  Statistical process control (Z-score) against 30-day history.  │
│  Flags sudden deviations in row count and null rates.            │
├──────────────────────────────────────────────────────────────────┤
│  Layer 2: Rule-Based Gates                                       │
│  YAML-defined rules. Critical failures block the pipeline.       │
│  Rules live in Git — reviewed, versioned, environment-promoted.  │
├──────────────────────────────────────────────────────────────────┤
│  Layer 1: Automatic Profiling                                    │
│  Zero config. Every Spark write captures row count, schema,      │
│  null rates, distinct counts, min/max/mean/stddev, and timing.   │
└──────────────────────────────────────────────────────────────────┘
```

Every layer writes its results to a dedicated Delta table stored alongside the dataset in ADLS Gen2. All three tables are registered in the Hive Metastore under the `dq` database and are queryable via Trino. The DQ portal dashboard reads from those same tables.

### Why This Design

**Transparent, not a black box.** Every metric, Z-score, mean, and stddev used to reach a DQ verdict is stored in Delta and visible to any engineer with Trino access. There are no proprietary algorithms or vendor-managed scoring models.

**Git-versioned rules.** DQ rules are YAML files committed to the pipeline repository at `orchestration/dq/rules/{dataset}.yaml` (example rules live under `examples/orchestration/dq/rules/`). A rule exists only if it is in a committed file. Adding, modifying, or deleting a rule goes through a pull request — it is reviewed, attributed, and revertible. Rules travel through environments (dev → staging → prod) with the pipeline they guard.

**Pipeline-native enforcement.** DQ is not a post-hoc report run outside the pipeline. Layer 2 rules are blocking gates: a critical failure causes the Airflow task to fail, which blocks all downstream tasks. DQ is a first-class citizen of the DAG, not an optional side-car.

**In-VNet, no SaaS dependency.** All DQ computation runs inside the Forge AKS clusters. Results land in ADLS. No data leaves the virtual network to a third-party observability product. The `forge-dq` package (version 0.1.0) is installed directly into the Spark and Airflow images.

**Zero config for basic observability.** Layer 1 profiling requires no YAML, no configuration, no operator action. Every dataset written through the `@track` decorator or `DQOperator` is automatically profiled on every run. Data engineers get a rolling history of row counts, null rates, and schema snapshots from day one.

---

## 2. Package Architecture

### Package Location

The `forge-dq` Python package lives at `sdk/python/forge_dq/` in the repository. It is not published to PyPI. It is installed into the Spark executor image and the Airflow image at build time via `COPY` and `pip install -e .`.

**Version:** 0.1.0

### Package Structure

```
sdk/python/forge_dq/
├── __init__.py               ← exports: track, DQRunner, DQResult
├── track.py                  ← @track decorator
├── runner.py                 ← DQRunner — orchestrates all 3 layers
├── profiler.py               ← Layer 1: automatic profiling
├── rules/
│   ├── __init__.py
│   ├── engine.py             ← rule evaluation loop
│   ├── loader.py             ← YAML parser and validator
│   └── types/
│       ├── not_null.py
│       ├── value_range.py
│       ├── accepted_values.py
│       ├── unique_key.py
│       ├── row_count_delta.py
│       └── custom_sql.py
├── anomaly.py                ← Layer 3: Z-score SPC engine
├── writers.py                ← Delta table writers for all 3 outputs
├── lineage.py                ← OpenLineage DQ facet emitter
├── operators/
│   ├── __init__.py
│   └── dq_operator.py        ← Airflow DQOperator
└── config.py                 ← env var resolution
```

### Key Classes

| Class | Module | Responsibility |
|-------|--------|----------------|
| `DQRunner` | `runner.py` | Top-level orchestrator. Calls profiler → rule engine → anomaly engine → writers → lineage emitter in order. |
| `Profiler` | `profiler.py` | Computes Layer 1 metrics from a DataFrame. Returns a `ProfileResult`. |
| `RuleEngine` | `rules/engine.py` | Loads a YAML ruleset, evaluates each rule against the DataFrame, returns a list of `RuleResult`. Raises `CriticalDQFailure` on critical failures when `fail_on_critical=True`. |
| `AnomalyEngine` | `anomaly.py` | Reads 30-day metric history from the auto-profiling Delta table, computes Z-scores, returns a list of `AnomalyResult`. |
| `DQWriter` | `writers.py` | Writes all three result sets to their respective Delta tables in ADLS. Uses the Spark session provided by the calling job. |
| `DQOperator` | `operators/dq_operator.py` | Airflow operator that constructs a `DQRunner` and executes it as a standalone task. |

---

## 3. Layer 1: Automatic Profiling

### What Gets Captured

Layer 1 profiling fires automatically on every run that uses the `@track` decorator or `DQOperator`. It requires no YAML, no configuration, and no explicit invocation. The profiler receives the DataFrame that was written and computes the following metrics before returning control to the caller.

**Dataset-level metrics:**

| Metric | Description |
|--------|-------------|
| `rows_written` | Row count of the written DataFrame |
| `schema_json` | Full schema serialized as JSON (column names, types, nullable flags) |
| `write_duration_ms` | Wall-clock time to execute the write operation |
| `run_id` | Airflow run ID passed in by the decorator or operator |
| `pipeline_name` | Inferred from the calling DAG or passed explicitly |
| `partition_info` | Partition columns and values if the write was partitioned |

**Per-column metrics** (stored as a JSON array in `column_profiles`):

| Metric | Applies to |
|--------|------------|
| Null count | All columns |
| Null rate (null count / row count) | All columns |
| Approximate distinct count | All columns |
| Min value | All columns (lexicographic for strings) |
| Max value | All columns |
| Mean | Numeric columns |
| Standard deviation | Numeric columns |

### Output: Auto Metrics Delta Table

**Path:** `_dq/auto/{safe_dataset_name}/metrics/`

**Schema:**

```
run_id              STRING       NOT NULL
pipeline_name       STRING
dataset_path        STRING       NOT NULL
environment         STRING
run_timestamp       TIMESTAMP    NOT NULL
rows_written        LONG
schema_json         STRING       (full Spark schema as JSON)
column_profiles     STRING       (JSON array, one entry per column)
write_duration_ms   LONG
```

The table is append-only. Every run adds one row. The full history is retained, enabling row count trend analysis and providing the 30-day rolling window consumed by Layer 3.

### Example column_profiles entry

```json
[
  {
    "column": "order_id",
    "type": "StringType",
    "null_count": 0,
    "null_rate": 0.0,
    "approx_distinct": 142350,
    "min": "ORD-0000001",
    "max": "ORD-9999999"
  },
  {
    "column": "amount",
    "type": "DoubleType",
    "null_count": 0,
    "null_rate": 0.0,
    "approx_distinct": 38421,
    "min": 0.01,
    "max": 49999.99,
    "mean": 184.72,
    "stddev": 623.41
  }
]
```

---

## 4. Layer 2: Rule-Based Gates

### Overview

Layer 2 evaluates engineer-defined rules against the written dataset. Rules are declared in YAML at `orchestration/dq/rules/{dataset}.yaml`. They run after the write completes, using the same Spark session. On a `critical` failure, the Airflow task fails immediately, blocking all downstream tasks.

### YAML Schema Reference

```yaml
version: "v1"                           # required; must be exactly "v1"
dataset: silver/orders_cleaned          # logical dataset path (used as safe_dataset_name base)
description: "Quality rules for orders silver layer"
owner: "data-engineering"
tags: [crm, silver, daily]              # optional; used for portal filtering

rules:
  - name: <rule_name>                   # unique within the file; appears in DQ result records
    type: <rule_type>                   # one of: not_null, value_range, accepted_values,
                                        #         unique_key, row_count_delta, custom_sql
    # ... type-specific fields ...
    severity: critical | warning        # critical → pipeline-blocking; warning → logged only

anomaly_detection:
  enabled: true | false
  lookback_days: 90                     # rolling window for Z-score baseline
  z_score_threshold: 3.0
```

### Rule Types

#### `not_null`

Asserts that one or more columns contain no null values.

```yaml
- name: order_id_not_null
  type: not_null
  columns: [order_id, customer_id, amount]
  severity: critical
```

| Field | Required | Description |
|-------|----------|-------------|
| `columns` | Yes | List of column names that must have zero nulls |
| `severity` | Yes | `critical` or `warning` |

**Pass condition:** `COUNT(*) WHERE col IS NULL = 0` for every listed column.

#### `value_range`

Asserts that a numeric column's values fall within a defined min/max bound.

```yaml
- name: amount_non_negative
  type: value_range
  column: amount
  min: 0
  severity: critical
```

| Field | Required | Description |
|-------|----------|-------------|
| `column` | Yes | Single column name |
| `min` | No | Inclusive lower bound (numeric or date string) |
| `max` | No | Inclusive upper bound |
| `severity` | Yes | `critical` or `warning` |

**Pass condition:** `MIN(col) >= min AND MAX(col) <= max`. At least one of `min` or `max` must be specified.

#### `accepted_values`

Asserts that a column only contains values from a defined set.

```yaml
- name: status_accepted_values
  type: accepted_values
  column: status
  values: [open, closed, pending, cancelled, refunded]
  severity: critical
```

| Field | Required | Description |
|-------|----------|-------------|
| `column` | Yes | Single column name |
| `values` | Yes | List of permitted values (strings) |
| `severity` | Yes | `critical` or `warning` |

**Pass condition:** `COUNT(*) WHERE col NOT IN (values) = 0`.

#### `unique_key`

Asserts that the combination of one or more columns is unique across all rows (no duplicates).

```yaml
- name: no_duplicate_orders
  type: unique_key
  columns: [order_id]
  severity: critical
```

| Field | Required | Description |
|-------|----------|-------------|
| `columns` | Yes | One or more columns that form the unique key |
| `severity` | Yes | `critical` or `warning` |

**Pass condition:** `COUNT(*) = COUNT(DISTINCT col1, col2, ...)`.

#### `row_count_delta`

Asserts that the current row count has not dropped by more than a defined percentage compared to the average of recent prior runs.

```yaml
- name: row_count_not_collapsed
  type: row_count_delta
  max_drop_pct: 20
  lookback_runs: 7
  severity: critical
```

| Field | Required | Description |
|-------|----------|-------------|
| `max_drop_pct` | Yes | Maximum acceptable percentage drop (0–100). A value of `20` means the row count may not drop more than 20% vs the lookback average. |
| `lookback_runs` | No | Number of prior runs to average. Defaults to 7. |
| `severity` | Yes | `critical` or `warning` |

**Pass condition:** `current_rows >= avg_prior_rows * (1 - max_drop_pct / 100)`. The rule is skipped (status `SKIPPED`) if fewer prior runs exist than `lookback_runs`.

#### `custom_sql`

Evaluates an arbitrary SQL assertion against the dataset. The SQL must be a `SELECT` that returns a single scalar value, which is compared against an `expected` value.

```yaml
- name: order_date_not_future
  type: custom_sql
  sql: "SELECT COUNT(*) FROM {table} WHERE order_date > current_date()"
  expected: 0
  severity: warning
```

| Field | Required | Description |
|-------|----------|-------------|
| `sql` | Yes | SQL query string. Use `{table}` as a placeholder for the dataset's fully qualified table name. Must return a single scalar. |
| `expected` | Yes | The expected scalar result for the assertion to pass. |
| `severity` | Yes | `critical` or `warning` |

**Pass condition:** query result equals `expected` (exact equality after type coercion to string).

### Full Example YAML

```yaml
version: "1"
dataset: silver/orders_cleaned
description: "Quality rules for orders silver layer"
owner: "data-engineering"
primary_key: [order_id]

rules:
  - name: order_id_not_null
    type: not_null
    columns: [order_id, customer_id, amount]
    severity: critical

  - name: amount_non_negative
    type: value_range
    column: amount
    min: 0
    severity: critical

  - name: status_accepted_values
    type: accepted_values
    column: status
    values: [open, closed, pending, cancelled, refunded]
    severity: critical

  - name: no_duplicate_orders
    type: unique_key
    columns: [order_id]
    severity: critical

  - name: row_count_not_collapsed
    type: row_count_delta
    max_drop_pct: 20
    lookback_runs: 7
    severity: critical

  - name: order_date_not_future
    type: custom_sql
    sql: "SELECT COUNT(*) FROM {table} WHERE order_date > current_date()"
    expected: 0
    severity: warning

anomaly_detection:
  enabled: true
  lookback_days: 30
  z_score_threshold: 3.0
```

### Severity Model

| Severity | On FAIL behavior | Written to results table | Alert fires |
|----------|------------------|--------------------------|-------------|
| `critical` | Airflow task fails immediately. All downstream tasks blocked. | Yes, status = `FAIL` | Yes |
| `warning` | Pipeline continues. Warning logged. | Yes, status = `WARN` | No (visible in portal) |

A run where all rules pass writes records with `status = PASS`. A rule that cannot be evaluated (e.g. `row_count_delta` with insufficient history) writes `status = SKIPPED`.

### Output: Rule Results Delta Table

**Path:** `_dq/rules/{safe_dataset_name}/results/`

**Schema:**

```
run_id          STRING       NOT NULL
pipeline_name   STRING
dataset_path    STRING       NOT NULL
run_timestamp   TIMESTAMP    NOT NULL
rule_name       STRING       NOT NULL
rule_type       STRING
severity        STRING       (critical / warning)
status          STRING       (PASS / FAIL / WARN / SKIPPED)
message         STRING       (human-readable description of result)
actual_value    STRING       (serialized actual metric value)
expected_value  STRING       (serialized expected/threshold value)
affected_rows   LONG         (rows violating the rule, where applicable)
```

---

## 5. Layer 3: Anomaly Detection

### Approach: Statistical Process Control

Layer 3 uses Statistical Process Control (SPC) to detect anomalies in pipeline metrics over time. After each run, the engine computes a Z-score for each tracked metric by comparing the current value to the rolling distribution of the same metric over the prior 30 days.

**Z-score formula:**

```
Z = (current_value - mean_30d) / stddev_30d
```

An anomaly is flagged when `|Z| > 3.0` (configurable via `z_score_threshold`). A Z-score of 3.0 corresponds to a value that falls outside 3 standard deviations from the 30-day mean — a statistically rare event that warrants investigation.

### Tracked Metrics

| Metric | What it detects |
|--------|-----------------|
| `rows_written` | Sudden data drops (upstream truncation, failed extraction) or explosions (fan-out bugs, duplicate ingestion) |
| `null_rate_{column}` | Per-column null rate anomalies — detects upstream data degradation, source field going blank, or a broken join introducing unexpected nulls |

### Why SPC Over ML

An ML-based approach (ARIMA, Prophet, isolation forest) introduces opacity: the model makes a decision but does not easily explain why. Engineers cannot reason about a model's threshold or audit its history without specialized knowledge.

SPC is transparent: every data point used in the decision is stored. The Z-score, the 30-day mean, and the 30-day standard deviation are written to the anomaly results Delta table alongside the `is_anomaly` flag. An engineer can open Trino, query the table, and understand exactly why a flag was raised. The algorithm is explainable in one sentence.

### Minimum History Requirement

The anomaly engine requires a minimum of **7 historical runs** before activating for a given dataset. If fewer than 7 prior runs exist in the auto-profiling metrics table, the engine writes no anomaly records for that run. This eliminates false positives during initial onboarding of a new dataset or after a schema migration resets history.

### Configuration

Anomaly detection is configured per-dataset in the YAML rules file:

```yaml
anomaly_detection:
  enabled: true          # set to false to disable for this dataset
  lookback_days: 30      # rolling window for mean/stddev calculation
  z_score_threshold: 3.0 # anomaly threshold; lower = more sensitive
```

The `lookback_days` and `z_score_threshold` values can also be set globally via environment variables (see [Section 11](#11-configuration-reference)). Dataset-level YAML values take precedence over global env vars.

### Output: Anomaly Results Delta Table

**Path:** `_dq/anomaly/{safe_dataset_name}/results/`

**Schema:**

```
run_id          STRING       NOT NULL
dataset_path    STRING       NOT NULL
run_timestamp   TIMESTAMP    NOT NULL
metric_name     STRING       (e.g. "rows_written", "null_rate_customer_id")
current_value   DOUBLE
mean_30d        DOUBLE
stddev_30d      DOUBLE
z_score         DOUBLE
is_anomaly      BOOLEAN
severity        STRING       (warning for all anomaly flags)
message         STRING
```

Every metric evaluated in a run produces one row, regardless of whether it is flagged as an anomaly. This means a clean run still populates the table with `is_anomaly = false` records, preserving the full Z-score history for trend analysis.

---

## 6. Storage Layout

### ADLS Path Convention

All DQ output tables are stored alongside their dataset in ADLS Gen2, under a `_dq/` prefix. The underscore prefix ensures DQ tables are not confused with the dataset itself and are excluded from standard `SHOW TABLES` output.

```
abfss://silver@forgeadlsdev.dfs.core.windows.net/
  orders_cleaned/                          ← actual dataset (Delta table)
  _dq/
    auto/
      silver_orders_cleaned/
        metrics/                           ← Layer 1: auto profiling (Delta)
    rules/
      silver_orders_cleaned/
        results/                           ← Layer 2: rule results (Delta)
    anomaly/
      silver_orders_cleaned/
        results/                           ← Layer 3: anomaly results (Delta)
```

### safe_dataset_name Convention

The `safe_dataset_name` is derived from the logical `dataset` field in the YAML (or passed to the `@track` decorator) by replacing all `/` characters with `_`.

| dataset value | safe_dataset_name |
|---------------|-------------------|
| `silver/orders_cleaned` | `silver_orders_cleaned` |
| `gold/analytics/kpi_daily` | `gold_analytics_kpi_daily` |
| `bronze/events_raw` | `bronze_events_raw` |

The `safe_dataset_name` is used as:
- The subfolder name under `_dq/auto/`, `_dq/rules/`, and `_dq/anomaly/`
- The Hive Metastore table name suffix under the `dq` database (see [Section 7](#7-querying-results))

### Hive Metastore Registration

All three `_dq/` Delta tables are registered in the Hive Metastore under the `dq` database using the pattern `{layer}__{safe_dataset_name}`. Registration happens automatically on first write.

| Layer | Hive table name (example) |
|-------|---------------------------|
| Auto profiling | `dq.auto__silver_orders_cleaned` |
| Rule results | `dq.rules__silver_orders_cleaned` |
| Anomaly results | `dq.anomaly__silver_orders_cleaned` |

### Permissions

| Identity | Role | Scope |
|----------|------|-------|
| `id-forge-compute-{env}` | Storage Blob Data Contributor | Writes all `_dq/` Delta tables (Spark job identity) |
| `id-forge-read-{env}` | Storage Blob Data Reader | Reads `_dq/` tables (Trino queries, portal DQ dashboard) |

---

## 7. Querying Results

All DQ Delta tables are registered in the Hive Metastore and queryable via Trino using the `dq` database. The following examples use `silver_orders_cleaned` as the target dataset.

### Pass Rate Trend (Last 30 Days)

```sql
SELECT
    DATE(run_timestamp)                                                        AS run_date,
    COUNT(*)                                                                   AS total_checks,
    SUM(CASE WHEN status = 'PASS' THEN 1 ELSE 0 END)                          AS passed,
    ROUND(
        100.0 * SUM(CASE WHEN status = 'PASS' THEN 1 ELSE 0 END) / COUNT(*),
        1
    )                                                                          AS pass_rate_pct
FROM dq.rules__silver_orders_cleaned
WHERE run_timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY 1
ORDER BY 1 DESC;
```

### Row Count Trend with Anomaly Flags

```sql
SELECT
    m.run_timestamp,
    m.rows_written,
    a.z_score,
    a.is_anomaly
FROM dq.auto__silver_orders_cleaned m
LEFT JOIN dq.anomaly__silver_orders_cleaned a
    ON  m.run_id       = a.run_id
    AND a.metric_name  = 'rows_written'
ORDER BY m.run_timestamp DESC
LIMIT 30;
```

### Anomaly History for a Dataset

```sql
SELECT
    run_timestamp,
    metric_name,
    current_value,
    mean_30d,
    stddev_30d,
    z_score,
    message
FROM dq.anomaly__silver_orders_cleaned
WHERE is_anomaly = true
ORDER BY run_timestamp DESC;
```

### Worst-Performing Datasets (Cross-Dataset Summary)

This query requires a view or a UNION across all `rules__*` tables. A convenient approach is to create a unified view in the Hive Metastore that unions all rule result tables with a `dataset_path` discriminator column. Once that view exists:

```sql
SELECT
    dataset_path,
    COUNT(*)                                                                   AS total_checks,
    SUM(CASE WHEN status IN ('FAIL', 'WARN') THEN 1 ELSE 0 END)               AS failures,
    ROUND(
        100.0 * SUM(CASE WHEN status IN ('FAIL', 'WARN') THEN 1 ELSE 0 END)
                / NULLIF(COUNT(*), 0),
        1
    )                                                                          AS failure_rate_pct
FROM dq.all_rule_results
WHERE run_timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY dataset_path
ORDER BY failure_rate_pct DESC
LIMIT 20;
```

### Per-Rule Failure Count (Last 90 Days)

```sql
SELECT
    rule_name,
    rule_type,
    severity,
    COUNT(*) FILTER (WHERE status IN ('FAIL', 'WARN'))   AS failure_count,
    COUNT(*)                                              AS total_evaluations,
    MAX(run_timestamp)                                    AS last_evaluated
FROM dq.rules__silver_orders_cleaned
WHERE run_timestamp >= NOW() - INTERVAL '90' DAY
GROUP BY rule_name, rule_type, severity
ORDER BY failure_count DESC;
```

---

## 8. Airflow Integration

### Two Integration Patterns

The `forge-dq` package provides two ways to integrate DQ into a pipeline:

| Pattern | When to use |
|---------|-------------|
| `@track` decorator | The Spark job is a Python function. DQ runs inline as part of the job, in the same Spark session, immediately after the DataFrame write. |
| `DQOperator` | DQ runs as a separate Airflow task, after an upstream write task has already completed. Useful when the write task is not a Python function (e.g. a `SparkKubernetesOperator` submitting a JAR). |

### The `@track` Decorator

The decorator wraps a function that returns a `DataFrame`. After the function executes and the DataFrame is written, the decorator automatically:

1. Computes Layer 1 profile metrics
2. Loads and evaluates Layer 2 rules (if `rules` path provided)
3. Runs Layer 3 anomaly detection
4. Writes all three result sets to Delta
5. Emits the OpenLineage DQ facet to Purview

```python
from forge_dq import track
from pyspark.sql import SparkSession, DataFrame

@track(
    dataset="silver/orders_cleaned",
    rules="orchestration/dq/rules/orders_cleaned.yaml"
)
def transform(spark: SparkSession) -> DataFrame:
    raw = spark.table("bronze.orders_raw")
    # ... transformation logic ...
    return cleaned_df
```

The decorator reads `FORGE_DQ_ENABLED` and `FORGE_DQ_FAIL_ON_CRITICAL` from the environment. If `FORGE_DQ_ENABLED=false`, the decorator is a no-op and the function behaves normally.

### The `DQOperator`

Use `DQOperator` as a standalone Airflow task that reads an already-written Delta table, runs all three DQ layers, and either passes or fails the task.

```python
from forge_dq.operators import DQOperator

check_orders_silver = DQOperator(
    task_id="dq_orders_silver",
    dataset="silver/orders_cleaned",
    rules_path="orchestration/dq/rules/orders_cleaned.yaml",
    run_id="{{ run_id }}",
    fail_on_critical=True,
)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | str | Airflow task ID |
| `dataset` | str | Logical dataset path (used to derive `safe_dataset_name`) |
| `rules_path` | str | Path to the YAML rules file, relative to the DAG repo root |
| `run_id` | str | Airflow run ID; supports Jinja templating |
| `fail_on_critical` | bool | If `True`, task fails on any critical rule failure. Defaults to `True`. |

### DAG Example: Bronze → Silver → Gold with DQ Gates

```python
from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.spark_kubernetes import (
    SparkKubernetesOperator,
)
from forge_dq.operators import DQOperator
from datetime import datetime, timedelta

default_args = {
    "owner": "data-engineering",
    "retries": 1,
    "retry_delay": timedelta(minutes=5),
}

with DAG(
    dag_id="orders_pipeline",
    default_args=default_args,
    schedule_interval="0 6 * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
) as dag:

    # --- Bronze ingestion ---
    ingest_bronze = SparkKubernetesOperator(
        task_id="ingest_orders_bronze",
        application_file="jobs/ingest_orders_bronze.yaml",
        namespace="spark-jobs",
    )

    # --- DQ gate: Bronze ---
    dq_bronze = DQOperator(
        task_id="dq_orders_bronze",
        dataset="bronze/orders_raw",
        rules_path="orchestration/dq/rules/orders_raw.yaml",
        run_id="{{ run_id }}",
        fail_on_critical=True,
    )

    # --- Silver transform ---
    transform_silver = SparkKubernetesOperator(
        task_id="transform_orders_silver",
        application_file="jobs/transform_orders_silver.yaml",
        namespace="spark-jobs",
    )

    # --- DQ gate: Silver ---
    dq_silver = DQOperator(
        task_id="dq_orders_silver",
        dataset="silver/orders_cleaned",
        rules_path="orchestration/dq/rules/orders_cleaned.yaml",
        run_id="{{ run_id }}",
        fail_on_critical=True,
    )

    # --- Gold aggregation ---
    aggregate_gold = SparkKubernetesOperator(
        task_id="aggregate_orders_gold",
        application_file="jobs/aggregate_orders_gold.yaml",
        namespace="spark-jobs",
    )

    # --- DQ gate: Gold ---
    dq_gold = DQOperator(
        task_id="dq_orders_gold",
        dataset="gold/analytics/orders_daily",
        rules_path="orchestration/dq/rules/orders_daily.yaml",
        run_id="{{ run_id }}",
        fail_on_critical=True,
    )

    (
        ingest_bronze
        >> dq_bronze
        >> transform_silver
        >> dq_silver
        >> aggregate_gold
        >> dq_gold
    )
```

**Failure propagation:** If `dq_silver` fails (a critical rule fails), `aggregate_gold` and `dq_gold` are blocked with status `upstream_failed`. The Gold layer is never written with bad Silver input.

---

## 9. OpenLineage Integration

### DQ Facet

On every run (decorator or `DQOperator`), after all three DQ layers complete, the `forge-dq` package emits an OpenLineage event to the Purview OpenLineage endpoint. The event attaches a custom `forge_dq` facet to the dataset output node that represents the written dataset.

**Example facet payload:**

```json
{
  "forge_dq": {
    "rows_written": 142350,
    "rules_total": 6,
    "rules_passed": 6,
    "rules_failed": 0,
    "rules_warned": 0,
    "critical_failures": [],
    "overall_status": "PASS"
  }
}
```

If a warning-severity rule fails, the facet reflects:

```json
{
  "forge_dq": {
    "rows_written": 142350,
    "rules_total": 6,
    "rules_passed": 5,
    "rules_failed": 0,
    "rules_warned": 1,
    "critical_failures": [],
    "overall_status": "WARN"
  }
}
```

If a critical-severity rule fails:

```json
{
  "forge_dq": {
    "rows_written": 142350,
    "rules_total": 6,
    "rules_passed": 4,
    "rules_failed": 1,
    "rules_warned": 0,
    "critical_failures": ["no_duplicate_orders"],
    "overall_status": "FAIL"
  }
}
```

### How It Appears in Purview

In the Microsoft Purview lineage graph, each dataset node that has been written by a `@track`-decorated function or a `DQOperator` task will show the `forge_dq` facet when selected. The facet is visible in the asset details panel under **Custom Properties → forge_dq**.

The `overall_status` field allows Purview users to see at a glance whether the last pipeline run for a given asset passed DQ. The `critical_failures` array identifies which rules failed by name, without requiring the viewer to open Trino or the DQ portal.

### Emission Behavior

The OpenLineage event is a fire-and-forget HTTP POST to the Purview endpoint. A failure to emit (e.g. network timeout, Purview API unavailability) does **not** cause the Airflow task to fail. The failure is logged at WARNING level and the pipeline continues. DQ results are always written to Delta regardless of lineage emission outcome.

---

## 10. Writing Custom Metrics

### Option 1: `custom_sql` Rule

The simplest way to add a custom metric is the `custom_sql` rule type. Any SQL expression that returns a single scalar value can be expressed as an assertion.

```yaml
- name: no_refunds_exceed_order_amount
  type: custom_sql
  sql: |
    SELECT COUNT(*)
    FROM {table}
    WHERE refund_amount > original_amount
  expected: 0
  severity: critical

- name: avg_order_amount_sanity
  type: custom_sql
  sql: "SELECT ROUND(AVG(amount), 2) FROM {table}"
  expected: 200.0          # adjust threshold per environment
  severity: warning
```

The `{table}` placeholder is replaced at runtime with the fully qualified Delta table name for the dataset. The query is executed via the Spark session's `spark.sql()` interface.

For the `avg_order_amount_sanity` example above, the expected value is an exact equality check. For threshold-based checks that do not reduce to an exact value, prefer `value_range` over `custom_sql`. Use `custom_sql` when the assertion logic cannot be expressed with the built-in rule types.

### Option 2: Direct `DQRunner` Usage with Custom Python Functions

For metrics that cannot be expressed in SQL — for example, statistical distribution tests, cross-dataset comparisons that require joining large DataFrames in Spark, or checks against external APIs — use `DQRunner` directly with a custom metric function.

```python
from forge_dq import DQRunner
from forge_dq.profiler import MetricResult
from pyspark.sql import DataFrame, SparkSession

def check_order_amount_distribution(df: DataFrame) -> MetricResult:
    """
    Custom metric: assert that P99 of order amount does not exceed $50,000.
    Returns a MetricResult that will be written to the auto-profiling table
    and evaluated against the provided threshold.
    """
    p99 = df.approxQuantile("amount", [0.99], 0.01)[0]
    return MetricResult(
        metric_name="p99_order_amount",
        value=p99,
        passed=p99 <= 50_000,
        message=f"P99 order amount is {p99:.2f}; threshold is 50000",
        severity="critical",
    )

def transform(spark: SparkSession) -> DataFrame:
    df = spark.table("bronze.orders_raw")
    # ... transformation logic ...
    return cleaned_df

runner = DQRunner(
    dataset="silver/orders_cleaned",
    rules_path="orchestration/dq/rules/orders_cleaned.yaml",
    run_id=run_id,
    spark=spark,
)
result_df = transform(spark)
runner.run(
    df=result_df,
    custom_metrics=[check_order_amount_distribution],
    fail_on_critical=True,
)
```

Custom metric functions:
- Receive the full `DataFrame` as their only argument
- Return a `MetricResult` (imported from `forge_dq.profiler`)
- Are executed after Layer 1 profiling completes
- Their results are written to the auto-profiling `column_profiles` JSON alongside the standard per-column metrics
- A `passed=False` result with `severity="critical"` causes the same failure behavior as a critical rule failure

---

## 11. Configuration Reference

### Environment Variables

All `forge-dq` configuration is resolved from environment variables. In Kubernetes deployments these are injected via Helm values into the Spark and Airflow pod specs.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FORGE_ENV` | Yes | — | Environment name (`dev`, `staging`, `prod`). Written into all DQ result records as `environment`. |
| `FORGE_ADLS_ACCOUNT` | Yes | — | ADLS Gen2 storage account name (e.g. `forgeadlsdev`). Used to construct `_dq/` output paths. |
| `FORGE_DQ_ENABLED` | No | `true` | Set to `false` to disable all DQ processing globally (the `@track` decorator and `DQOperator` become no-ops). Useful for local development. |
| `FORGE_DQ_FAIL_ON_CRITICAL` | No | `true` | Set to `false` to prevent critical rule failures from raising an exception. Results are still written. Useful for dry-run mode when onboarding a new dataset. |
| `FORGE_DQ_ANOMALY_LOOKBACK_DAYS` | No | `30` | Global default for anomaly detection lookback window. Overridden by per-dataset YAML value. |
| `FORGE_DQ_ANOMALY_Z_THRESHOLD` | No | `3.0` | Global default for anomaly Z-score threshold. Overridden by per-dataset YAML value. |
| `FORGE_DQ_ANOMALY_MIN_RUNS` | No | `7` | Minimum number of prior runs before anomaly detection activates for a dataset. |

### Helm Values (Spark)

```yaml
# infra/helm/compute/spark-operator/values-dev.yaml
sparkJobDefaults:
  env:
    - name: FORGE_ENV
      value: "dev"
    - name: FORGE_ADLS_ACCOUNT
      value: "forgeadlsdev"
    - name: FORGE_DQ_ENABLED
      value: "true"
    - name: FORGE_DQ_FAIL_ON_CRITICAL
      value: "true"
```

### Helm Values (Airflow)

```yaml
# infra/helm/orchestration/airflow/values-dev.yaml
env:
  - name: FORGE_ENV
    value: "dev"
  - name: FORGE_ADLS_ACCOUNT
    value: "forgeadlsdev"
  - name: FORGE_DQ_ENABLED
    value: "true"
  - name: FORGE_DQ_FAIL_ON_CRITICAL
    value: "true"
```

---

## 12. Adding DQ to a New Dataset

Follow this checklist when adding DQ coverage to a new or existing pipeline for the first time.

### Step 1: Identify the dataset

Determine the logical dataset path. This is the value you will pass to `dataset=` in the decorator or operator. Use the convention `{layer}/{dataset_name}`, for example `silver/orders_cleaned`.

Verify that the dataset is written as a Delta table in ADLS Gen2 and is registered in the Hive Metastore.

### Step 2: Create the YAML rules file

Create a new file at `orchestration/dq/rules/{dataset_name}.yaml`. Start with the minimum required structure:

```yaml
version: "1"
dataset: silver/orders_cleaned
description: "Quality rules for orders silver layer"
owner: "data-engineering"
primary_key: [order_id]

rules:
  - name: primary_key_not_null
    type: not_null
    columns: [order_id]
    severity: critical

  - name: row_count_not_collapsed
    type: row_count_delta
    max_drop_pct: 20
    lookback_runs: 7
    severity: critical

anomaly_detection:
  enabled: true
  lookback_days: 30
  z_score_threshold: 3.0
```

Add further rules incrementally after reviewing the Layer 1 auto-profiling output from the first few runs (see Step 5).

### Step 3: Add the `@track` decorator or `DQOperator`

**If the pipeline is a Python Spark job:**

```python
from forge_dq import track

@track(
    dataset="silver/orders_cleaned",
    rules="orchestration/dq/rules/orders_cleaned.yaml"
)
def transform(spark: SparkSession) -> DataFrame:
    # existing transformation logic — no changes required
    return result_df
```

**If the pipeline is a `SparkKubernetesOperator` task in an Airflow DAG:**

```python
from forge_dq.operators import DQOperator

dq_check = DQOperator(
    task_id="dq_orders_silver",
    dataset="silver/orders_cleaned",
    rules_path="orchestration/dq/rules/orders_cleaned.yaml",
    run_id="{{ run_id }}",
    fail_on_critical=True,
)

# Wire it into the DAG after the write task:
write_task >> dq_check >> next_task
```

### Step 4: Deploy to dev and run once with `FORGE_DQ_FAIL_ON_CRITICAL=false`

On the first deployment, set `FORGE_DQ_FAIL_ON_CRITICAL=false` (or pass `fail_on_critical=False` to `DQOperator`) to allow the pipeline to complete even if rules fail. This lets you observe the baseline DQ state of the dataset before making rules blocking.

After the first run completes, query the rule results table to see which rules passed and which failed:

```sql
SELECT rule_name, status, message, actual_value, expected_value
FROM dq.rules__silver_orders_cleaned
WHERE run_timestamp = (SELECT MAX(run_timestamp) FROM dq.rules__silver_orders_cleaned)
ORDER BY status DESC;
```

### Step 5: Review auto-profiling output and tune rules

Query the Layer 1 metrics to understand the dataset's actual distribution before finalizing thresholds:

```sql
SELECT
    run_timestamp,
    rows_written,
    column_profiles
FROM dq.auto__silver_orders_cleaned
ORDER BY run_timestamp DESC
LIMIT 10;
```

Use these baseline values to set realistic thresholds in the YAML. For `row_count_delta`, 3–5 initial runs are enough to set a representative baseline. For `value_range`, use the observed min/max with appropriate margins.

### Step 6: Re-enable critical failures and open a PR

Once all rules are passing in dev:

1. Set `FORGE_DQ_FAIL_ON_CRITICAL=true` (or remove the override — `true` is the default)
2. Open a pull request with the new YAML rules file
3. The PR description should explain the rationale for each rule and its threshold
4. Request review from a second data engineer before merging

### Step 7: Verify in staging before promoting to production

Run the pipeline in staging with DQ enabled and critical failures active. Confirm that all rules pass and that the anomaly detection engine has enough history (≥ 7 runs) before promoting to production.

### Quick Reference Checklist

```
[ ] Logical dataset path chosen (e.g. silver/orders_cleaned)
[ ] Delta table exists and is registered in Hive Metastore
[ ] orchestration/dq/rules/{dataset_name}.yaml created
[ ] YAML has at least: not_null on primary key, row_count_delta
[ ] @track decorator or DQOperator wired into the pipeline
[ ] First run executed with fail_on_critical=false
[ ] Auto-profiling output reviewed; rule thresholds tuned
[ ] All rules passing in dev
[ ] Pull request opened and reviewed
[ ] Pipeline run verified in staging with fail_on_critical=true
[ ] Promoted to production
```
