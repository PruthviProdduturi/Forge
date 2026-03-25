# Forge — Data Quality Framework Architecture

> **Version:** 1.0
> **Status:** Production
> **Last updated:** 2026-03-24
> **Audience:** Platform engineers, data engineers

---

## Table of Contents

1. [Framework Philosophy](#1-framework-philosophy)
2. [Rule Taxonomy](#2-rule-taxonomy)
3. [YAML Ruleset Format](#3-yaml-ruleset-format)
4. [DQRunner Internals](#4-dqrunner-internals)
5. [Severity Model](#5-severity-model)
6. [Integration with Airflow](#6-integration-with-airflow)
7. [DQ Results Store](#7-dq-results-store)
8. [Reporters](#8-reporters)
9. [Longitudinal Tracking and Regression Detection](#9-longitudinal-tracking-and-regression-detection)
10. [DQ for Streaming](#10-dq-for-streaming)
11. [Architecture Diagram](#11-architecture-diagram)
12. [Adding a Custom Check Type](#12-adding-a-custom-check-type)

---

## 1. Framework Philosophy

### Code-Defined Rules, Not a GUI

Every DQ rule in Forge is defined in a YAML file that lives in the Git repository at `orchestration/dq/rules/`. There is no web interface for creating, editing, or approving rules. There is no database of rules separate from the codebase. A rule exists if and only if it is present in a committed YAML file.

This is a deliberate design choice with concrete consequences:

**Rules are reviewable.** A new DQ rule for the `orders` dataset is proposed as a pull request diff on `orchestration/dq/rules/orders.yaml`. The review process is the same as for code: a second engineer reviews the rule logic, threshold values, and severity before it reaches any environment. Mistakes are caught before they gate production pipelines or cause false alerts.

**Rules are versioned.** Git history shows exactly who added a rule, when, and why (via the commit message and PR description). If a threshold is changed from 1% to 5% null rate, the diff is visible, the change is attributed, and it can be reverted. No rule can be silently modified.

**Rules travel with the code.** When a pipeline is deployed to a new environment (dev → staging → prod), the DQ rules for that pipeline deploy with it — same file, same thresholds. There is no risk of a "loose" GUI-defined rule existing in production but not in dev. Environment-specific overrides are explicit (an `environments:` block in the YAML) and therefore visible in code review.

**Rules are testable.** The DQ SDK ships with a test harness that can run a ruleset against a synthetic DataFrame in a unit test, without Spark or Trino. Data engineers write unit tests for their DQ rules alongside their pipeline tests. A failing unit test blocks the CI pipeline.

### What the Framework Is Not

The DQ framework is not a data catalog. It does not manage schemas, owners, or descriptions — that is the metadata catalog's job. It does not replace data contracts or SLAs — it enforces preconditions on data that allow those contracts to be met. It is not a real-time anomaly detection system — it runs at pipeline boundaries on defined datasets, not continuously against all data.

---

## 2. Rule Taxonomy

Forge DQ rules are classified into four types. Each type targets a different dimension of data quality. The taxonomy is intentionally narrow — four types covers the vast majority of practical DQ requirements without introducing an unbounded check vocabulary.

### Schema Rules

**Definition:** Checks on the structure of the dataset — which columns exist, what their types are, and whether they permit null values.

**When to use:** Every dataset must have schema rules. Schema is the foundation: if the schema is wrong, content checks are meaningless. Schema rules run first. If any schema rule fails at CRITICAL severity, the remaining checks are skipped.

**What schema rules can check:**
- Column presence: required column exists in the DataFrame
- Column type: column is the expected Spark SQL type (e.g., `LongType`, `StringType`, `TimestampType`)
- Column nullability: column is non-nullable (no null values permitted) or nullable
- Column count: the DataFrame has at least N / exactly N columns (guard against schema collapse)

**Examples:**

| Rule | Check | Expected behavior |
|------|-------|-------------------|
| `order_id_present` | Column `order_id` exists | Fails if source dropped the column |
| `order_id_type` | Column `order_id` is `StringType` | Fails if upstream cast it to integer |
| `order_id_not_null` | Column `order_id` has zero nulls | Fails if primary key is nullable |
| `order_ts_type` | Column `order_ts` is `TimestampType` | Fails if shipped as string ISO-8601 |

Schema rules are cheap to run — they require only the DataFrame schema (no data scan) for type and presence checks, and a single `COUNT WHERE IS NULL` for nullability checks.

### Content Rules

**Definition:** Checks on the values within columns — distributions, ranges, formats, allowed values, and referential integrity.

**When to use:** After schema checks pass. Content rules validate business logic: not just "is this a string?" but "is this string a valid ISO country code?" or "is this amount positive?"

**What content rules can check:**
- **Null rate:** fraction of rows where a column is null, compared against a maximum threshold
- **Uniqueness:** fraction of rows that are distinct on one or more columns, compared against a minimum threshold
- **Value range:** minimum/maximum numeric value, or minimum/maximum date value
- **Allowed values:** column value is a member of a defined set (enum check)
- **Regex match:** column value matches a regular expression (format validation)
- **Referential integrity:** values in column A exist in column B of another dataset (foreign key check via Trino cross-table query)
- **Custom expression:** arbitrary SQL expression evaluated as a boolean — percent of rows where the expression is true must exceed a threshold

**Examples:**

| Rule | Check | Threshold |
|------|-------|-----------|
| `status_allowed_values` | `status IN ('open', 'closed', 'cancelled', 'pending')` | 100% of rows |
| `order_total_positive` | `order_total > 0` | 100% of rows |
| `customer_id_not_null` | null rate on `customer_id` | ≤ 0.001 (0.1%) |
| `order_id_unique` | uniqueness on `order_id` | ≥ 1.0 (100% distinct) |
| `country_code_format` | `country_code REGEXP '^[A-Z]{2}$'` | ≥ 0.999 (99.9% valid) |
| `customer_id_exists` | `customer_id IN (SELECT id FROM curated.customers)` | ≥ 0.999 |

Content checks that require scanning full column data are executed via Trino against the Delta table (avoiding loading the full dataset into the task pod's memory). For checks that can be expressed as aggregation SQL, Trino's distributed execution is significantly more efficient.

### Volume Rules

**Definition:** Checks on the size of the dataset — how many rows exist and how the count compares to expectations.

**When to use:** Volume checks catch silent data loss, extraction failures, and upstream truncations that content and schema checks cannot detect. A dataset that is structurally perfect but contains zero rows (or 90% fewer rows than yesterday) is a DQ failure.

**What volume rules can check:**
- **Absolute row count minimum:** the dataset must have at least N rows
- **Absolute row count maximum:** the dataset must have at most N rows (guard against accidental fan-out)
- **Row count delta:** the percentage change in row count compared to the most recent prior run must be within a range (e.g., -20% to +50%)
- **Partition completeness:** for a given date partition, all expected sub-partitions are present and non-empty
- **New rows minimum:** for an incremental load, at least N new rows must have been written (detects a silently failing ingestion that wrote zero rows)

**Examples:**

| Rule | Check | Threshold |
|------|-------|-----------|
| `min_row_count` | Row count ≥ N | 10,000 rows |
| `row_count_delta` | ABS((current - prior) / prior) ≤ threshold | ≤ 30% change |
| `new_rows_written` | Rows with `_ingestion_ts > last_watermark` ≥ N | ≥ 1 |
| `no_empty_partition` | Every date partition in last 7 days has > 0 rows | 100% partitions populated |

Volume checks use `COUNT(*)` SQL via Trino against the current Delta table and the DQ results store (for the prior-run row count comparison). They are inexpensive.

### Freshness Rules

**Definition:** Checks on how recently the data was updated — ensuring that the pipeline ran within its expected schedule and that the data reflects a recent state of the source system.

**When to use:** Freshness checks are the time-dimension complement to volume checks. A dataset can have the right number of rows but all be from last week. Freshness rules enforce that the latest data is actually recent.

**What freshness rules can check:**
- **Max partition age hours:** the most recently written partition must be no older than N hours
- **Max watermark lag hours:** `MAX(_updated_ts)` across all rows must be no older than N hours relative to the current wall clock
- **Pipeline run recency:** the DQ results store shows a successful run within the last N hours (meta-check: has the pipeline itself run recently?)
- **File modification time:** the most recently modified file in the Delta table path was written within N hours (for datasets where row timestamps are unreliable)

**Examples:**

| Rule | Check | Threshold |
|------|-------|-----------|
| `partition_freshness` | Max partition date ≥ today - 1 day | 1 day |
| `watermark_lag` | `MAX(_updated_ts) > NOW() - INTERVAL 2 HOURS` | 2 hours |
| `pipeline_recency` | Last successful DQ run for this dataset < 26 hours ago | 26 hours |

Freshness checks are critical for SLA-governed Gold layer datasets. The `max_partition_age_hours` check is the most common: it verifies that the `SHOW PARTITIONS` output for the Delta table includes a partition dated within the expected window.

---

## 3. YAML Ruleset Format

Each dataset has one YAML ruleset file. The file name matches the dataset's logical name. Rules are executed in the order they are listed, but within each type the DQRunner may parallelize.

### Complete Annotated Example

```yaml
# orchestration/dq/rules/orders.yaml
#
# DQ ruleset for the curated orders dataset.
# Owner: data-eng-commerce@company.com
# Dataset: silver/orders (abfss://silver@<account>.dfs.core.windows.net/orders/)
# Reviewed-by: PR #142 (2026-02-15)

# ---------------------------------------------------------------------------
# Ruleset-level metadata
# ---------------------------------------------------------------------------

ruleset_id: curated_orders                # Unique ID for this ruleset.
                                          # Used as the primary key in DQ results.

dataset:
  namespace: forge-prod                 # Marquez namespace. Injected into the DQ
                                          # facet sent to OpenLineage.
  name: curated.orders                    # Logical dataset name (Hive catalog form).
  path: "abfss://silver@${ADLS_ACCOUNT}.dfs.core.windows.net/orders/"
                                          # Actual Delta table path. ${ADLS_ACCOUNT}
                                          # is resolved from Airflow Variables at
                                          # runtime — never hardcoded.

execution:
  engine: trino                           # Default execution engine for this ruleset.
                                          # Options: trino | spark | python
                                          # Most content/volume/freshness checks use
                                          # trino (SQL aggregations). Schema checks
                                          # always use python (schema inspection).
                                          # Individual rules can override this.
  trino_catalog: lakehouse                # Trino catalog name (Delta connector).
  trino_schema: curated                   # Hive schema within the catalog.
  sample_fraction: 1.0                    # Fraction of rows to sample for content
                                          # checks. 1.0 = full scan. Use 0.1 for
                                          # very large tables where approximate
                                          # null rate is acceptable.

# ---------------------------------------------------------------------------
# Schema rules
# ---------------------------------------------------------------------------

rules:

  # --- Schema ---

  - id: schema_order_id_present
    type: schema
    check: column_present                 # Verifies the column exists in the schema.
    column: order_id
    severity: CRITICAL                    # Schema failures are always CRITICAL.
    description: "Primary key column must be present."

  - id: schema_order_id_type
    type: schema
    check: column_type
    column: order_id
    expected_type: StringType             # Spark SQL type name.
    severity: CRITICAL

  - id: schema_order_ts_type
    type: schema
    check: column_type
    column: order_ts
    expected_type: TimestampType
    severity: CRITICAL

  - id: schema_order_total_type
    type: schema
    check: column_type
    column: order_total_usd
    expected_type: DecimalType(18,2)      # Parameterized types use the full name.
    severity: CRITICAL

  - id: schema_status_present
    type: schema
    check: column_present
    column: status
    severity: CRITICAL

  - id: schema_customer_id_present
    type: schema
    check: column_present
    column: customer_id
    severity: CRITICAL

  - id: schema_metadata_columns_present
    type: schema
    check: columns_present                # Plural variant: checks a list of columns.
    columns:
      - _ingestion_ts
      - _source_system
      - _record_hash
    severity: CRITICAL
    description: "Platform metadata columns must always be present."

  # --- Content ---

  - id: content_order_id_not_null
    type: content
    check: null_rate                      # Fraction of rows where column IS NULL.
    column: order_id
    max_null_rate: 0.0                    # Threshold: zero nulls permitted.
    severity: CRITICAL
    description: "Primary key must never be null."

  - id: content_order_id_unique
    type: content
    check: uniqueness                     # Fraction of distinct values over total rows.
    column: order_id
    min_uniqueness: 1.0                   # 100% distinct required.
    severity: CRITICAL
    description: "Primary key must be unique."

  - id: content_customer_id_not_null
    type: content
    check: null_rate
    column: customer_id
    max_null_rate: 0.001                  # Up to 0.1% nulls acceptable (orphaned orders).
    severity: WARNING
    description: "Customer ID should rarely be null."

  - id: content_status_allowed_values
    type: content
    check: allowed_values                 # All values must be in the defined set.
    column: status
    values:
      - open
      - closed
      - cancelled
      - pending
      - refunded
    severity: CRITICAL
    description: "Status must be one of the defined lifecycle values."

  - id: content_order_total_positive
    type: content
    check: expression                     # Arbitrary SQL boolean expression.
    expression: "order_total_usd >= 0"    # Applied as: COUNT(*) WHERE NOT (expression)
    max_fail_rate: 0.0                    # Zero rows may violate the expression.
    severity: CRITICAL
    description: "Order totals must be non-negative."

  - id: content_country_code_format
    type: content
    check: regex
    column: country_code
    pattern: "^[A-Z]{2}$"               # ISO 3166-1 alpha-2.
    min_match_rate: 0.999                 # 99.9% of non-null values must match.
    severity: WARNING
    description: "Country code should be valid ISO-3166-1 alpha-2."

  - id: content_customer_id_referential_integrity
    type: content
    check: referential_integrity
    column: customer_id
    reference_dataset: "curated.customers"
    reference_column: customer_id
    min_match_rate: 0.999               # 99.9% of customer_ids must exist in customers table.
    severity: WARNING
    engine: trino                       # Override: this check requires cross-table SQL.
    description: "Customer IDs should exist in the customers master table."

  # --- Volume ---

  - id: volume_min_row_count
    type: volume
    check: row_count_min
    min_rows: 50000                       # Absolute minimum. Chosen from historical lows.
    severity: CRITICAL
    description: "Less than 50k orders would indicate a partial load."

  - id: volume_max_row_count
    type: volume
    check: row_count_max
    max_rows: 100000000                   # 100M rows. Guard against accidental fan-out.
    severity: WARNING
    description: "More than 100M rows would be suspicious — possible join explosion."

  - id: volume_row_count_delta
    type: volume
    check: row_count_delta               # Compares current run count to prior run count.
    max_decrease_pct: 20                 # Row count may not drop by more than 20%.
    max_increase_pct: 200                # Row count may not grow by more than 200%.
    severity: WARNING
    description: "Unusual row count delta vs previous run."

  - id: volume_new_rows_written
    type: volume
    check: new_rows_min                  # Rows where _ingestion_ts > last_watermark.
    min_new_rows: 1                      # At least one new row must have been written.
    severity: WARNING
    description: "An incremental run that writes zero new rows may indicate a broken ingestion."

  # --- Freshness ---

  - id: freshness_partition_age
    type: freshness
    check: max_partition_age_hours       # Age of the most recent Delta partition.
    max_age_hours: 26                    # Pipeline is daily; allow 2 hours of slack.
    severity: CRITICAL
    description: "Data must be no more than 26 hours old."

  - id: freshness_watermark_lag
    type: freshness
    check: watermark_lag_hours           # MAX(_ingestion_ts) vs NOW().
    watermark_column: _ingestion_ts
    max_lag_hours: 26
    severity: WARNING
    description: "Ingestion timestamp must be recent."

# ---------------------------------------------------------------------------
# Environment overrides
# ---------------------------------------------------------------------------

environments:
  dev:
    # In dev, use looser thresholds — dev data is a subset and may not meet
    # production volume requirements.
    rule_overrides:
      - id: volume_min_row_count
        min_rows: 100                    # Dev uses a small synthetic dataset.
      - id: volume_row_count_delta
        max_decrease_pct: 90             # Dev data is non-deterministic; skip delta check.
        max_increase_pct: 10000
      - id: freshness_partition_age
        max_age_hours: 168               # Dev pipelines run on-demand, not on schedule.
      - id: freshness_watermark_lag
        max_age_hours: 168

  staging:
    # Staging uses production-like data but may have some lag.
    rule_overrides:
      - id: freshness_partition_age
        max_age_hours: 48
```

### Required Fields per Rule

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique within the ruleset. Used as the primary key in DQ results. Snake case. |
| `type` | enum | Yes | `schema`, `content`, `volume`, or `freshness` |
| `check` | string | Yes | The specific check within the type. See check catalog below. |
| `severity` | enum | Yes | `CRITICAL`, `WARNING`, or `INFO` |
| `description` | string | No | Human-readable explanation. Surfaced in portal and alerts. |
| `engine` | enum | No | `trino`, `spark`, or `python`. Overrides ruleset-level `execution.engine`. |

---

## 4. DQRunner Internals

### Overview

`DQRunner` is the Python class in `forge.dq.sdk` that orchestrates the execution of a ruleset. It takes a `DQRuleset` (loaded from YAML), connects to the configured execution engines, runs all checks, aggregates results into a `DQRunReport`, and returns it to the caller.

`DQRunner` is designed to run inside an Airflow task pod — it is a library, not a service. It has no persistent process, no daemon, no port. It is instantiated, run, and garbage-collected within a single task execution.

### Loading a Ruleset

```python
from forge.dq.sdk import DQRunner, load_ruleset

ruleset = load_ruleset("orchestration/dq/rules/orders.yaml")
```

`load_ruleset()` performs the following steps:

1. Reads the YAML file from the path. The path is relative to the `FORGE_REPO_ROOT` environment variable, which is set to the git-sync volume mount path in the task pod.
2. Validates the YAML structure against the `DQRuleset` Pydantic model. Invalid rulesets (unknown check types, missing required fields, invalid threshold values) raise a `DQRulesetValidationError` at load time, not at execution time.
3. Resolves environment-specific overrides. The active environment is read from the `FORGE_ENV` environment variable (injected via Airflow's `airflow.cfg`). Override rules are merged on top of base rules, replacing any fields specified in the override.
4. Resolves `${VARIABLE}` placeholders in the ruleset (e.g., `${ADLS_ACCOUNT}`) by reading Airflow Variables via the Key Vault Secrets Backend.
5. Returns a `DQRuleset` object with all rules fully resolved and validated.

### Execution Engines

`DQRunner` supports three execution engines. The engine is selected per-rule (with a ruleset-level default).

**Trino engine**

Used for: content checks (null rate, uniqueness, allowed values, expression, referential integrity), volume checks (row count), freshness checks (watermark lag, partition age).

The Trino engine constructs SQL aggregate queries and issues them to the Trino coordinator via the `trino-python-client`. Each check becomes one or more SQL statements. Multiple checks of the same type against the same table are batched into a single SQL query to minimize round-trips:

```sql
-- Example: batched content checks for orders table
SELECT
  -- null_rate: order_id
  CAST(SUM(CASE WHEN order_id IS NULL THEN 1 ELSE 0 END) AS DOUBLE) / COUNT(*) AS order_id_null_rate,
  -- null_rate: customer_id
  CAST(SUM(CASE WHEN customer_id IS NULL THEN 1 ELSE 0 END) AS DOUBLE) / COUNT(*) AS customer_id_null_rate,
  -- uniqueness: order_id
  CAST(COUNT(DISTINCT order_id) AS DOUBLE) / NULLIF(COUNT(*), 0) AS order_id_uniqueness,
  -- expression: order_total_positive
  CAST(SUM(CASE WHEN NOT (order_total_usd >= 0) THEN 1 ELSE 0 END) AS DOUBLE) / COUNT(*) AS order_total_fail_rate,
  -- volume: row count
  COUNT(*) AS total_row_count
FROM lakehouse.curated.orders
```

Referential integrity checks use a separate query with a LEFT JOIN or NOT IN subquery. These are never batched with other checks because they reference a second table.

The Trino connection is obtained via `BaseHook.get_connection("trino_default")`, which reads from Key Vault.

**Spark engine**

Used for: checks that cannot be expressed in SQL (e.g., complex statistical checks), checks on DataFrames that have already been materialized in the calling Spark job and passed to DQRunner in-memory.

The Spark engine is only used when `DQRunner` is instantiated with a Spark `DataFrame` argument:

```python
runner = DQRunner(ruleset=ruleset, dataframe=df, spark=spark)
```

In this mode, checks run as Spark DataFrame operations (`.agg()`, `.filter()`, `.groupBy()`) against the in-memory DataFrame. This is the preferred mode when DQ runs inside a Spark job rather than a standalone Airflow task pod.

**Python engine**

Used for: schema checks (which operate on the DataFrame schema or the Delta table schema metadata — no data scan required), and freshness checks that read Delta table metadata (partition list) rather than querying data values.

The Python engine uses `delta-spark` or the Delta REST API to read table metadata without issuing SQL queries. For schema checks against a running Spark job, it inspects `df.schema` directly.

### Parallelism Model

Within a single `DQRunner.run()` call:

1. **Schema rules run first, sequentially.** If any CRITICAL schema rule fails, execution halts and the report is returned immediately. There is no point running content checks if the schema is wrong.
2. **Content, volume, and freshness rules run concurrently.** `DQRunner` uses a `ThreadPoolExecutor` with a configurable number of workers (default: 4) to issue Trino queries in parallel. This is safe because Trino queries are independent.
3. **Batching:** Before dispatching, `DQRunner` groups Trino-engine checks by table. Checks against the same table are combined into one batched SQL query (as shown above), then a single thread handles the batch.

The parallelism is thread-based (not process-based) because the bottleneck is network I/O (waiting for Trino query results), not CPU. Four concurrent Trino queries is the default; this can be tuned via the `FORGE_DQ_MAX_WORKERS` environment variable.

### Building the DQRunReport

After all checks complete, `DQRunner` assembles a `DQRunReport`:

```python
@dataclass
class DQRunReport:
    ruleset_id: str
    dataset_namespace: str
    dataset_name: str
    run_id: str                     # UUID generated at runner instantiation
    pipeline_run_id: str            # Airflow run_id, injected via AIRFLOW_RUN_ID env var
    run_ts: datetime                # Timestamp when runner.run() was called
    passed: bool                    # True iff zero CRITICAL failures
    rule_results: List[RuleResult]
    summary: DQRunSummary

@dataclass
class RuleResult:
    rule_id: str
    check_type: str                 # e.g. "null_rate", "row_count_min"
    rule_type: str                  # "schema" | "content" | "volume" | "freshness"
    passed: bool
    severity: str                   # "CRITICAL" | "WARNING" | "INFO"
    observed_value: Optional[float] # The measured value (null rate, row count, etc.)
    threshold: Optional[float]      # The configured threshold
    message: str                    # Human-readable result description
    duration_ms: int                # How long this rule took to execute

@dataclass
class DQRunSummary:
    total_rules: int
    passed_rules: int
    failed_rules: int
    critical_failures: int
    warning_failures: int
    info_failures: int
    total_duration_ms: int
```

`passed` is `True` if and only if `critical_failures == 0`. WARNING and INFO failures do not affect `passed`. This property drives the pipeline gate logic.

---

## 5. Severity Model

Three severity levels define how a rule failure affects pipeline execution, alerting, and reporting.

### CRITICAL

**Behavior:**

1. The `DQRunReport.passed` field is `False`.
2. The Airflow task that runs `DQRunner` raises an exception, causing the task to fail.
3. All downstream tasks in the DAG are marked `UPSTREAM_FAILED` and do not execute. Specifically: the serving publication task does not run. The Gold layer is not updated. The stale (but previously-validated) serving data remains in place.
4. `AlertReporter` fires the webhook immediately (before the Airflow task has even finished failing). The alert payload includes the rule IDs and observed values of all critical failures.
5. The DQ results row is written to the Delta table with `passed = FALSE` and the full `rule_results` array.
6. The `LineageReporter` emits a DQ facet to Marquez with `assertions` showing the critical failures.

**When to use CRITICAL:**

Use CRITICAL when a failure means the data cannot be trusted for any consumer purpose — the Gold layer should not be updated. Examples:
- Primary key is null or non-unique (structural corruption)
- Row count is below the absolute minimum (partial load)
- Required column is missing (schema regression)
- Latest data is more than N hours old (SLA-critical freshness)

### WARNING

**Behavior:**

1. The `DQRunReport.passed` field is `True` (WARNING failures do not affect it).
2. The Airflow task succeeds. Downstream tasks proceed normally — the Gold layer is updated.
3. `AlertReporter` fires the webhook with severity `WARNING`. The alert is informational: "pipeline continued but these rules failed."
4. The DQ results row is written with `passed = TRUE` (because no critical failures) but the `rule_results` array contains the failing WARNING rules with `passed = FALSE`.
5. `LineageReporter` includes the WARNING failures in the DQ facet.

**When to use WARNING:**

Use WARNING when a failure is notable and worth investigating but does not constitute a reason to block the pipeline. The data is usable but imperfect. Examples:
- Customer ID null rate exceeds 0.1% (unusual but tolerable)
- Row count delta exceeds 30% (could be organic growth; investigate)
- Country code format mismatch rate exceeds 0.1% (data entry noise)

### INFO

**Behavior:**

1. Does not affect `DQRunReport.passed`.
2. The Airflow task succeeds.
3. `AlertReporter` does NOT fire for INFO failures. They are silent outside of the DQ results store.
4. The DQ results row is written with the INFO failure in `rule_results`.

**When to use INFO:**

Use INFO for exploratory or diagnostic checks that you want to track over time but do not yet want to alert on. This is the appropriate starting severity when introducing a new check whose baseline behavior is not yet understood. Once the baseline is established, promote the check to WARNING or CRITICAL.

---

## 6. Integration with Airflow

### Position in the DAG

DQ runs as the third stage in the four-stage pipeline pattern, after the curated transform completes and before serving publication:

```
ingest_raw     →     transform_curated     →     validate_dq     →     publish_serving
(SparkApp)           (SparkApp)                  (@task)               (SparkApp / Trino)
```

The `validate_dq` task is a `@task`-decorated Python function that:
1. Instantiates `DQRunner` with the appropriate ruleset
2. Calls `runner.run()`
3. Passes the report to all configured reporters
4. Raises an exception if `report.has_critical_failures()` — causing the task to fail

### Task Failure Propagation

When `validate_dq` raises an exception:

- Airflow marks the `validate_dq` task instance as `FAILED`
- Airflow evaluates the downstream task (`publish_serving`) which has the default `trigger_rule="all_success"`. Because its upstream (`validate_dq`) is FAILED, `publish_serving` is set to `UPSTREAM_FAILED` and does not execute
- The DAG run ends in `FAILED` state
- `on_failure_callback` on the DAG fires, sending a separate "DAG failed" alert to the webhook (in addition to the DQ-specific alert from `AlertReporter`)

The previously-published serving data remains intact. Delta Lake's ACID properties ensure that no partial serving write has occurred — the serving table is exactly as it was after the last successful pipeline run.

### How to Override — Skipping DQ for a Manual Backfill

In some situations (backfilling historical data, running a one-time migration), an engineer may need to bypass DQ gating. This must be a deliberate, audited action.

The `validate_dq` task accepts a DAG run configuration parameter `skip_dq_gate`:

```python
@task(executor_config=RESOURCE_PROFILES["medium"])
def validate_dq(**context):
    conf = context["dag_run"].conf or {}
    if conf.get("skip_dq_gate", False):
        # Explicitly bypassing DQ. Log and write an INFO-level DQ report.
        logger.warning("DQ gate bypassed via dag_run.conf. Run ID: %s", context["run_id"])
        StoreReporter().report_bypass(context["run_id"], ruleset_id=RULESET_ID)
        return   # Task succeeds; serving publication proceeds
    ...
    # Normal DQ execution
```

Bypassing DQ:
- Requires the `Op` or `Admin` Airflow RBAC role to trigger a DAG run with custom config
- Is logged in the Airflow task log (visible in Azure Log Analytics and the Airflow UI)
- Writes a bypass record to the DQ results store (so the portal shows "DQ bypassed" rather than an unexplained gap)
- Is visible in the lineage graph (DQ facet marks the run as "bypassed")

Bypasses cannot be done via a code change — they require a deliberate runtime action by an authorized user.

### Retries

When `validate_dq` fails due to a CRITICAL DQ failure, Airflow will retry the task (default: 2 retries with 5-minute delay) before marking it permanently failed. This is intentional: transient issues (a Trino query timeout, a momentary ADLS read error) should not permanently fail the DQ task.

However, genuine DQ failures (actual bad data) will fail on every retry. After exhausting retries, the task is marked `FAILED` and the on-call alert fires. An engineer must investigate the data issue, either fix it and re-trigger the pipeline or explicitly bypass DQ for that run.

---

## 7. DQ Results Store

### Table Location

All DQ run reports are persisted as a Delta table at:

```
abfss://silver@<account>.dfs.core.windows.net/_platform/dq_results/
```

The `_platform/` prefix places this table outside the normal `domain/entity/` directory structure. It is a platform-managed table, not a domain dataset.

### Full Schema

```
dq_results Delta table
─────────────────────────────────────────────────────────────────────

Column                  Type                    Nullable  Notes
─────────────────────────────────────────────────────────────────────
ruleset_id              STRING                  NOT NULL  PK-like: unique ID of the
                                                          ruleset that produced this run.
                                                          e.g. "curated_orders"

dataset_namespace       STRING                  NOT NULL  Marquez namespace.
                                                          e.g. "forge-prod"

dataset_name            STRING                  NOT NULL  Logical dataset name.
                                                          e.g. "curated.orders"

run_id                  STRING                  NOT NULL  UUID. Unique per DQRunner
                                                          invocation.

pipeline_run_id         STRING                  NOT NULL  Airflow DAG run ID that
                                                          triggered this DQ run.
                                                          e.g. "scheduled__2026-03-24T00:00:00+00:00"

run_ts                  TIMESTAMP               NOT NULL  When runner.run() started (UTC).

run_date                DATE                    NOT NULL  Partition column. Derived from
                                                          run_ts. Used for partition pruning.

passed                  BOOLEAN                 NOT NULL  TRUE iff zero CRITICAL failures.

bypassed                BOOLEAN                 NOT NULL  TRUE if DQ gate was bypassed.

environment             STRING                  NOT NULL  e.g. "prod", "staging", "dev"

total_row_count         LONG                    NULLABLE  Row count of the dataset at
                                                          time of DQ run. Populated by
                                                          volume checks.

rule_results            ARRAY<STRUCT<            NOT NULL  One element per rule.
                          rule_id:      STRING,
                          check_type:   STRING,
                          rule_type:    STRING,
                          severity:     STRING,
                          passed:       BOOLEAN,
                          observed_value: DOUBLE,         Numeric observed value (null rate,
                          threshold:    DOUBLE,           row count, lag hours, etc.).
                          message:      STRING,           Human-readable result.
                          duration_ms:  LONG              Rule execution time.
                        >>

summary                 STRUCT<                 NOT NULL
                          total_rules:       INT,
                          passed_rules:      INT,
                          failed_rules:      INT,
                          critical_failures: INT,
                          warning_failures:  INT,
                          info_failures:     INT,
                          total_duration_ms: LONG
                        >

─────────────────────────────────────────────────────────────────────
Partitioned by: run_date
Z-ORDERED by:   dataset_name, run_ts  (for portal time-series queries)
```

### Query Examples for Portal Use Cases

**1. Latest DQ status for all datasets (portal home/DQ dashboard)**

```sql
WITH latest_run AS (
  SELECT
    dataset_name,
    MAX(run_ts) AS latest_run_ts
  FROM lakehouse.curated._platform_dq_results
  WHERE run_date >= CURRENT_DATE - INTERVAL '7' DAY
  GROUP BY dataset_name
)
SELECT
  r.dataset_name,
  r.run_ts,
  r.passed,
  r.bypassed,
  r.summary.critical_failures,
  r.summary.warning_failures,
  r.summary.total_rules,
  r.total_row_count
FROM lakehouse.curated._platform_dq_results r
JOIN latest_run lr
  ON r.dataset_name = lr.dataset_name
  AND r.run_ts = lr.latest_run_ts
ORDER BY r.dataset_name
```

**2. DQ pass rate trend over 30 days for a specific dataset (portal dataset detail)**

```sql
SELECT
  run_date,
  COUNT(*) AS total_runs,
  SUM(CASE WHEN passed THEN 1 ELSE 0 END) AS passed_runs,
  CAST(SUM(CASE WHEN passed THEN 1 ELSE 0 END) AS DOUBLE) / COUNT(*) AS pass_rate
FROM lakehouse.curated._platform_dq_results
WHERE
  dataset_name = 'curated.orders'
  AND run_date >= CURRENT_DATE - INTERVAL '30' DAY
GROUP BY run_date
ORDER BY run_date
```

**3. All critical rule failures in the last 24 hours (portal DQ alert drill-down)**

```sql
SELECT
  r.dataset_name,
  r.run_ts,
  r.pipeline_run_id,
  rr.rule_id,
  rr.check_type,
  rr.observed_value,
  rr.threshold,
  rr.message
FROM lakehouse.curated._platform_dq_results r
CROSS JOIN UNNEST(r.rule_results) AS t(rr)
WHERE
  r.run_ts >= NOW() - INTERVAL '24' HOUR
  AND rr.passed = FALSE
  AND rr.severity = 'CRITICAL'
ORDER BY r.run_ts DESC
```

**4. Row count history for a dataset (volume trend, anomaly detection)**

```sql
SELECT
  run_date,
  run_ts,
  total_row_count,
  LAG(total_row_count) OVER (PARTITION BY dataset_name ORDER BY run_ts) AS prior_row_count,
  CAST(total_row_count - LAG(total_row_count) OVER (PARTITION BY dataset_name ORDER BY run_ts) AS DOUBLE)
    / NULLIF(LAG(total_row_count) OVER (PARTITION BY dataset_name ORDER BY run_ts), 0) AS row_count_delta_pct
FROM lakehouse.curated._platform_dq_results
WHERE dataset_name = 'curated.orders'
ORDER BY run_ts
```

**5. Specific rule pass/fail history (track a single rule over time)**

```sql
SELECT
  r.run_date,
  r.run_ts,
  rr.rule_id,
  rr.passed,
  rr.observed_value,
  rr.threshold
FROM lakehouse.curated._platform_dq_results r
CROSS JOIN UNNEST(r.rule_results) AS t(rr)
WHERE
  r.dataset_name = 'curated.orders'
  AND rr.rule_id = 'content_order_id_not_null'
  AND r.run_date >= CURRENT_DATE - INTERVAL '90' DAY
ORDER BY r.run_ts
```

---

## 8. Reporters

After `DQRunner.run()` produces a `DQRunReport`, the caller passes it to one or more reporters. Each reporter handles one output channel. Reporters are independent — one reporter failing does not prevent others from executing.

In the standard `validate_dq` Airflow task, all three reporters are always used:

```python
from forge.dq.reporters import StoreReporter, AlertReporter, LineageReporter

for reporter in [StoreReporter(), AlertReporter(), LineageReporter()]:
    try:
        reporter.report(report)
    except Exception as e:
        logger.error("Reporter %s failed: %s", reporter.__class__.__name__, e)
        # Reporters are best-effort — their failure does not fail the DQ task.
        # A failed reporter is monitored via Azure Monitor metric counter: dq_reporter_errors_total.
```

### StoreReporter

**Responsibility:** Writes the `DQRunReport` as a row in the DQ results Delta table.

**Implementation:**

`StoreReporter` converts `DQRunReport` to a PySpark Row and appends it to the Delta table using `delta-spark`. The write uses `mode="append"` (never overwrite). The Delta table's schema is registered in the Hive Metastore on first write; subsequent writes validate schema compatibility.

The reporter runs in the Airflow task pod using the `id-forge-dq` workload identity, which has `Storage Blob Data Contributor` on the `curated` container scoped to the `_platform/dq_results/` path.

If the Delta table does not yet exist (first run in a new environment), `StoreReporter` creates it with the schema defined in `forge.dq.schema.DQ_RESULTS_SCHEMA`.

### AlertReporter

**Responsibility:** Posts a structured JSON payload to the configured webhook (Microsoft Teams or Slack) when rules fail at WARNING or CRITICAL severity.

**Alert conditions:**

| Condition | Alert sent? | Channel |
|-----------|------------|---------|
| One or more CRITICAL failures | Yes, immediately | `#data-platform-alerts` (Teams/Slack) |
| One or more WARNING failures | Yes | `#data-platform-warnings` |
| All rules passed | No | — |
| DQ gate bypassed | Yes (informational) | `#data-platform-alerts` |

**Alert payload (Teams Adaptive Card):**

```json
{
  "type": "AdaptiveCard",
  "body": [
    {
      "type": "TextBlock",
      "text": "DQ CRITICAL: curated.orders",
      "weight": "Bolder",
      "color": "Attention"
    },
    {
      "type": "FactSet",
      "facts": [
        { "title": "Run ID", "value": "a1b2c3d4-..." },
        { "title": "Pipeline Run", "value": "scheduled__2026-03-24T00:00:00+00:00" },
        { "title": "Failing rules", "value": "content_order_id_not_null, volume_min_row_count" },
        { "title": "Portal link", "value": "https://portal.forge.internal/dq/curated.orders/runs/a1b2c3d4-..." }
      ]
    }
  ]
}
```

The webhook URL is stored in Key Vault as `airflow-variables--dq-alert-webhook-url`. It is not hardcoded in the reporter or the ruleset.

### LineageReporter

**Responsibility:** Emits a DQ facet as part of an OpenLineage `COMPLETE` event to the Marquez API. This attaches the DQ run outcome to the dataset in the lineage graph, making it visible in the lineage explorer.

**DQ facet structure (OpenLineage `DataQualityAssertionsDatasetFacet`):**

```json
{
  "assertions": [
    {
      "assertion": "content_order_id_not_null",
      "passed": true,
      "column": "order_id"
    },
    {
      "assertion": "volume_min_row_count",
      "passed": false,
      "success": false
    }
  ]
}
```

This facet is attached to the output dataset event for the `validate_dq` job. In Marquez, the dataset node for `curated.orders` shows the DQ assertion results for the latest run and historical pass/fail trend.

The `LineageReporter` uses the `marquez_api` Airflow connection (stored in Key Vault) to reach the Marquez API at `http://marquez-api.lineage.svc:5000` inside the cluster.

---

## 9. Longitudinal Tracking and Regression Detection

### Pass Rate Trend

The DQ results store enables time-series analysis of data quality across all datasets. The Developer Portal's DQ dashboard displays the rolling 30-day pass rate per dataset, computed from the query in section 7.

A regression is defined as: the 7-day rolling pass rate for a dataset drops by more than 10 percentage points compared to the prior 7-day window.

### Azure Monitor Metrics

`DQRunner` exports counters and histograms via the `airflow_custom_metrics` statsd integration (scraped by the Azure Monitor Agent):

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `dq_runs_total` | Counter | `dataset`, `passed`, `environment` | Total DQ run completions |
| `dq_critical_failures_total` | Counter | `dataset`, `rule_id` | Total CRITICAL rule failures |
| `dq_warning_failures_total` | Counter | `dataset`, `rule_id` | Total WARNING rule failures |
| `dq_run_duration_ms` | Histogram | `dataset` | Total DQRunner.run() wall time |
| `dq_rule_duration_ms` | Histogram | `dataset`, `rule_id` | Per-rule execution time |
| `dq_reporter_errors_total` | Counter | `reporter` | Reporter invocation failures |

These metrics feed the Azure Managed Grafana "Platform Overview" dashboard's DQ pass rate panel and the Azure Monitor Alert rule:

```kql
// Azure Monitor Scheduled Query Alert: DQ pass rate drops below 95% over 1-hour window
InsightsMetrics
| where Name == "dq_runs_total"
| summarize
    passed = sumif(Val, Tags contains "passed=true"),
    total  = sum(Val)
  by bin(TimeGenerated, 1h)
| extend pass_rate = todouble(passed) / todouble(total)
| where pass_rate < 0.95
// Alert fires if any result row exists → severity 0 (Critical), action group: forge-platform-critical
```

### Detecting Regression in Specific Rules

To identify which rules have been trending toward failure over time:

```sql
-- Rules with increasing failure rates over last 14 days vs prior 14 days
WITH recent AS (
  SELECT
    rr.rule_id,
    AVG(CASE WHEN rr.passed THEN 0.0 ELSE 1.0 END) AS recent_fail_rate
  FROM lakehouse.curated._platform_dq_results r
  CROSS JOIN UNNEST(r.rule_results) AS t(rr)
  WHERE r.run_date >= CURRENT_DATE - INTERVAL '14' DAY
    AND r.dataset_name = 'curated.orders'
  GROUP BY rr.rule_id
),
prior AS (
  SELECT
    rr.rule_id,
    AVG(CASE WHEN rr.passed THEN 0.0 ELSE 1.0 END) AS prior_fail_rate
  FROM lakehouse.curated._platform_dq_results r
  CROSS JOIN UNNEST(r.rule_results) AS t(rr)
  WHERE r.run_date >= CURRENT_DATE - INTERVAL '28' DAY
    AND r.run_date < CURRENT_DATE - INTERVAL '14' DAY
    AND r.dataset_name = 'curated.orders'
  GROUP BY rr.rule_id
)
SELECT
  r.rule_id,
  p.prior_fail_rate,
  r.recent_fail_rate,
  r.recent_fail_rate - p.prior_fail_rate AS deterioration
FROM recent r
JOIN prior p ON r.rule_id = p.rule_id
WHERE r.recent_fail_rate > p.prior_fail_rate
ORDER BY deterioration DESC
```

This query surfaces rules whose failure rate has increased in the recent window compared to the prior window, indicating a potential data quality regression in the source system.

---

## 10. DQ for Streaming

### Context

Streaming pipelines in Forge use Spark Structured Streaming with micro-batch mode (30-second trigger interval) writing via MERGE to a curated Delta table. The consuming Airflow DAG (serving publication) runs on a faster schedule (every 5 minutes) rather than daily.

Running a full `DQRunner` execution against the entire streaming table every 5 minutes would be wasteful and would produce results that are difficult to interpret (is the failure from this micro-batch or an accumulated issue?). Streaming DQ uses an adapted approach.

### Adaptations for Streaming

**Freshness checks run on every micro-batch.** The streaming job itself checks freshness at the end of each micro-batch write: the event time of the latest committed record is compared against `NOW()`. If the lag exceeds the freshness threshold (e.g., 5 minutes), the streaming job emits a metric `spark_streaming_watermark_lag_seconds` which Azure Monitor Alerts monitors. This check is not done via `DQRunner` — it is embedded in the Spark streaming job's `foreachBatch` logic.

**Volume checks use sliding windows, not absolute counts.** For streaming, "volume" means "rows per unit time", not total rows. A streaming DQ volume rule specifies a minimum throughput:

```yaml
- id: volume_min_throughput
  type: volume
  check: rows_per_window               # Streaming-specific check type.
  window_minutes: 5                    # Look at the last 5 minutes of data.
  min_rows_in_window: 100              # At least 100 rows must have arrived.
  severity: WARNING
  description: "Order event stream must receive at least 100 events per 5 minutes."
```

This check reads `COUNT(*) WHERE event_time >= NOW() - INTERVAL 5 MINUTE` from the Delta table. It runs as a Trino query every 5 minutes from the serving publication DAG.

**Content checks run on a sample of recent rows.** Rather than scanning the full table, content checks for streaming datasets operate on a sliding window of recent rows (e.g., last 1 hour). This is configured via `sample_strategy: recent_window` in the ruleset:

```yaml
execution:
  sample_strategy: recent_window        # Options: full | fraction | recent_window
  recent_window_hours: 1                # Scan only rows where event_time >= NOW() - 1h
```

The Trino queries add a `WHERE event_time >= NOW() - INTERVAL 1 HOUR` predicate. This limits scan cost and focuses quality checks on the most recently arrived data.

**Schema checks are unchanged.** Schema is defined by the Delta table schema, which does not change between micro-batches. Schema checks run once per serving publication DAG run.

### Streaming DQ Thresholds vs Batch

| Check | Batch threshold | Streaming threshold | Rationale |
|-------|----------------|---------------------|-----------|
| Freshness | 26 hours | 5 minutes | Streaming SLA is fundamentally tighter |
| Min row count | 50,000 (full table) | 100 rows/5 min window | Streaming volume is rate, not absolute count |
| Partition age | 1 day | N/A (no partitions by date in streaming) | Replaced by watermark lag check |
| Null rate (customer_id) | 0.001 (full scan) | 0.001 (1-hour window) | Same threshold; different scan scope |
| Row count delta | 20% day-over-day | N/A | Not meaningful for streaming |

### DQ Results for Streaming

Streaming DQ results are written to the same `_platform/dq_results/` Delta table with `dataset_name = 'curated.orders_stream'` (a convention: append `_stream` to distinguish). The portal DQ dashboard treats streaming and batch datasets consistently — the pass rate trend and rule drill-down work identically for both.

---

## 11. Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║                       DQ Framework — Component Overview                          ║
╚══════════════════════════════════════════════════════════════════════════════════╝

Git Repository
orchestration/dq/rules/orders.yaml
orchestration/dq/rules/customers.yaml
orchestration/dq/rules/inventory.yaml
          │
          │  git-sync (60s cadence)
          ▼
Airflow Task Pod (validate_dq task)
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  load_ruleset("orchestration/dq/rules/orders.yaml")                         │
│    │                                                                         │
│    │  1. Parse YAML                                                          │
│    │  2. Validate against DQRuleset Pydantic model                          │
│    │  3. Apply environment overrides (FORGE_ENV=prod)                      │
│    │  4. Resolve ${ADLS_ACCOUNT} from Airflow Variables (Key Vault)         │
│    ▼                                                                         │
│  DQRuleset (validated, resolved)                                             │
│    │                                                                         │
│    ▼                                                                         │
│  DQRunner.run()                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  Phase 1: Schema checks (sequential, Python engine)                   │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  column_present, column_type, column_nullability                 │  │  │
│  │  │  → reads Delta table schema (no data scan)                      │  │  │
│  │  │  CRITICAL failure? → abort, return report                       │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  │  Phase 2: Content + Volume + Freshness (parallel, Trino engine)        │  │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────┐  │  │
│  │  │ Thread 1         │  │ Thread 2         │  │ Thread 3           │  │  │
│  │  │ Batched content  │  │ Volume checks    │  │ Freshness checks   │  │  │
│  │  │ SQL (null_rate,  │  │ (row_count,      │  │ (partition_age,    │  │  │
│  │  │  uniqueness,     │  │  delta,          │  │  watermark_lag)    │  │  │
│  │  │  expression)     │  │  new_rows)       │  │                    │  │  │
│  │  └───────┬──────────┘  └───────┬──────────┘  └──────────┬─────────┘  │  │
│  │          │                     │                          │            │  │
│  │          └─────────────────────┴──────────────────────────┘            │  │
│  │                                │                                        │  │
│  │                                ▼                                        │  │
│  │  Thread 4: Referential integrity checks (separate Trino cross-table     │  │
│  │            queries, run in parallel with Phase 2 threads)               │  │
│  │                                                                        │  │
│  │  Aggregate RuleResult list → DQRunReport                               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Reporters (sequential, each catches own exceptions)                        │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                                                                       │   │
│  │  StoreReporter                 AlertReporter          LineageReporter │   │
│  │  ┌──────────────────┐         ┌─────────────────┐   ┌─────────────┐  │   │
│  │  │ Writes DQRunReport│         │ Sends webhook   │   │ Emits DQ    │  │   │
│  │  │ to Delta table   │         │ to Teams/Slack  │   │ facet to    │  │   │
│  │  │ (append mode)    │         │ (CRITICAL +     │   │ Marquez API │  │   │
│  │  │                  │         │  WARNING only)  │   │             │  │   │
│  │  └────────┬─────────┘         └────────┬────────┘   └──────┬──────┘  │   │
│  │           │                            │                    │         │   │
│  └───────────┼────────────────────────────┼────────────────────┼─────────┘   │
│              │                            │                    │              │
│  if report.has_critical_failures():       │                    │              │
│      raise DQCriticalFailureError         │                    │              │
│         │                                │                    │              │
└─────────┼────────────────────────────────┼────────────────────┼──────────────┘
          │                                │                    │
          ▼                                ▼                    ▼
  Airflow task FAILED           Teams/Slack webhook       Marquez API
  downstream: UPSTREAM_FAILED   DQ alert message          DQ facet on
  AlertReporter already fired   (if CRITICAL/WARNING)     curated.orders
  serving not updated                                      dataset node


DATA STORES WRITTEN BY DQ FRAMEWORK
────────────────────────────────────

  abfss://silver@<account>.dfs.core.windows.net/_platform/dq_results/
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Delta table (append-only)                                          │
  │  Partitioned by run_date                                            │
  │  Z-ORDERED by dataset_name, run_ts                                  │
  │  One row per DQRunner.run() call                                    │
  │  Contains: run metadata + full rule_results array + summary         │
  └─────────────────────────────────────────────────────────────────────┘
          │
          │  queried by
          ├──► Developer Portal (DQ dashboard, dataset detail, trends)
          ├──► Azure Managed Grafana dashboard (via Azure Monitor / Trino data source)
          └──► dq_results_compact maintenance DAG (weekly OPTIMIZE + VACUUM)


EXECUTION ENGINE ROUTING
─────────────────────────

Rule type               Engine              How it executes
────────────────────────────────────────────────────────────────────
schema.column_present   Python              df.schema inspection (no I/O)
schema.column_type      Python              df.schema inspection (no I/O)
schema.column_nullability Python            Trino: COUNT WHERE IS NULL
content.*               Trino (default)     SQL aggregate query via trino-python-client
content.* (in Spark)    Spark               DataFrame .agg() on in-memory df
volume.row_count_*      Trino               COUNT(*) SQL
volume.row_count_delta  Trino + DQ store    COUNT(*) + prior run from _platform/dq_results/
freshness.partition_age Python              Delta SHOW PARTITIONS metadata
freshness.watermark_lag Trino               MAX(ts_column) SQL aggregate
referential_integrity   Trino               LEFT JOIN / NOT IN cross-table SQL
custom (extension)      Configurable        See section 12
```

---

## 12. Adding a Custom Check Type

### When to Use a Custom Check

The four built-in check types (schema, content, volume, freshness) cover the overwhelming majority of DQ requirements. A custom check type is appropriate when:

- The check logic cannot be expressed as a SQL aggregate or schema inspection
- The check requires calling an external API (e.g., validating a value against a reference service)
- The check involves a complex statistical computation (e.g., distribution drift detection)
- The check requires reading from two datasets simultaneously in a non-SQL way

Custom checks still follow the same YAML ruleset format, severity model, and reporter pipeline. The only difference is the implementation of the check logic.

### Extension Point

`DQRunner` discovers check implementations via a plugin registry. Each check type is a Python class that inherits from `BaseCheck` and is registered with the `@dq_check` decorator.

**Step 1: Implement the check class**

Create a new file in `orchestration/dq/sdk/checks/`:

```python
# orchestration/dq/sdk/checks/statistical_checks.py

from typing import Any, Dict
from forge.dq.sdk.base import BaseCheck, CheckResult, dq_check


@dq_check(check_type="distribution_drift")
class DistributionDriftCheck(BaseCheck):
    """
    Compares the distribution of a numeric column in the current run
    against the distribution from the most recent prior run using the
    Kolmogorov-Smirnov (KS) statistic.

    Fails if the KS statistic exceeds the configured threshold.

    Rule YAML:
        - id: order_total_drift
          type: content
          check: distribution_drift
          column: order_total_usd
          max_ks_statistic: 0.1
          severity: WARNING
    """

    def validate_params(self, rule: Dict[str, Any]) -> None:
        """Called at load_ruleset() time. Raise ValueError for invalid params."""
        if "column" not in rule:
            raise ValueError("distribution_drift requires 'column' parameter")
        if "max_ks_statistic" not in rule:
            raise ValueError("distribution_drift requires 'max_ks_statistic' parameter")
        if not 0.0 < rule["max_ks_statistic"] <= 1.0:
            raise ValueError("max_ks_statistic must be between 0 and 1")

    def execute(self, rule: Dict[str, Any], context: "DQRunContext") -> CheckResult:
        """
        Execute the check. context provides access to:
          context.trino_client  — authenticated Trino client
          context.spark         — SparkSession (if available)
          context.dq_store      — read access to _platform/dq_results/ Delta table
          context.dataset_path  — ADLS path of the current dataset
          context.run_ts        — timestamp of the current run
        """
        column = rule["column"]
        max_ks = rule["max_ks_statistic"]

        # Fetch current run's column percentiles via Trino
        current_percentiles = context.trino_client.query(f"""
            SELECT
              approx_percentile({column}, ARRAY[0.1, 0.2, 0.3, 0.4, 0.5,
                                                0.6, 0.7, 0.8, 0.9, 0.99])
            FROM {context.trino_table_ref}
            WHERE {column} IS NOT NULL
        """)

        # Fetch prior run's percentiles from DQ results store
        # (stored as a custom column when this check type ran previously)
        prior_percentiles = self._get_prior_percentiles(context, column)

        if prior_percentiles is None:
            # No prior run to compare against — pass with INFO message
            return CheckResult(
                passed=True,
                observed_value=None,
                threshold=max_ks,
                message=f"No prior run found for {column}; skipping drift check.",
            )

        # Compute KS statistic
        ks_stat = self._ks_statistic(current_percentiles, prior_percentiles)

        passed = ks_stat <= max_ks

        return CheckResult(
            passed=passed,
            observed_value=ks_stat,
            threshold=max_ks,
            message=(
                f"KS statistic for {column}: {ks_stat:.4f} "
                f"({'OK' if passed else 'EXCEEDS'} threshold {max_ks})"
            ),
        )

    def _ks_statistic(self, dist1, dist2) -> float:
        """Compute max absolute difference between two CDF arrays."""
        return max(abs(a - b) for a, b in zip(dist1, dist2))

    def _get_prior_percentiles(self, context, column):
        """Read prior run's percentile data from DQ results store."""
        # Custom checks can store structured data in the rule_results.observed_value
        # JSON field. This implementation reads the prior run's serialized percentiles.
        # Implementation detail omitted for brevity.
        ...
```

**Step 2: Register the check**

The `@dq_check(check_type="distribution_drift")` decorator registers the class in the global check registry at import time. For `DQRunner` to discover it, the module must be imported. Add the import to `orchestration/dq/sdk/checks/__init__.py`:

```python
# orchestration/dq/sdk/checks/__init__.py
from forge.dq.sdk.checks.schema_checks import *       # built-in
from forge.dq.sdk.checks.content_checks import *      # built-in
from forge.dq.sdk.checks.volume_checks import *       # built-in
from forge.dq.sdk.checks.freshness_checks import *    # built-in
from forge.dq.sdk.checks.statistical_checks import *  # custom extension
```

**Step 3: Write a unit test**

```python
# orchestration/dq/tests/test_distribution_drift.py

import pytest
from pyspark.sql import SparkSession
from forge.dq.sdk import DQRunner, DQRuleset
from forge.dq.sdk.checks.statistical_checks import DistributionDriftCheck

def test_distribution_drift_passes_when_ks_below_threshold(spark):
    ruleset = DQRuleset.from_dict({
        "ruleset_id": "test_drift",
        "dataset": {"namespace": "test", "name": "test.orders"},
        "rules": [{
            "id": "order_total_drift",
            "type": "content",
            "check": "distribution_drift",
            "column": "order_total_usd",
            "max_ks_statistic": 0.1,
            "severity": "WARNING",
        }]
    })

    # Create a DataFrame with a known distribution
    df = spark.createDataFrame([
        (float(i),) for i in range(1000)
    ], ["order_total_usd"])

    # First run: no prior run — should pass with INFO message
    runner = DQRunner(ruleset=ruleset, dataframe=df, spark=spark)
    report = runner.run()
    assert report.passed
    assert report.rule_results[0].message.startswith("No prior run found")

def test_distribution_drift_fails_when_ks_exceeds_threshold(spark):
    # Test with dramatically different distributions
    ...
```

**Step 4: Use in a YAML ruleset**

```yaml
rules:
  - id: order_total_drift
    type: content
    check: distribution_drift           # Matches the @dq_check(check_type=...) decorator value
    column: order_total_usd
    max_ks_statistic: 0.1
    severity: WARNING
    description: "Alert if order total distribution drifts significantly vs yesterday."
    engine: python                      # Custom checks use the Python engine (not Trino)
```

### What BaseCheck Provides

| Attribute / Method | Type | Description |
|-------------------|------|-------------|
| `validate_params(rule)` | Method | Override to validate rule-specific parameters at load time. Called by load_ruleset(). |
| `execute(rule, context)` | Method | Override to implement the check. Must return a `CheckResult`. |
| `context.trino_client` | `TrinoClient` | Authenticated Trino client for SQL queries |
| `context.spark` | `SparkSession` | Available when runner is in Spark mode |
| `context.dq_store` | `DQResultsReader` | Read access to `_platform/dq_results/` for historical comparisons |
| `context.dataset_path` | `str` | ADLS path of the dataset being checked |
| `context.trino_table_ref` | `str` | Fully qualified Trino table reference (e.g., `lakehouse.curated.orders`) |
| `context.run_ts` | `datetime` | UTC timestamp of the current run |
| `context.environment` | `str` | Active environment (`prod`, `staging`, `dev`) |

Custom checks are subject to the same severity model, reporter pipeline, and longitudinal tracking as built-in checks. There is no special handling for custom check types — they produce `RuleResult` objects and `CheckResult` returns just like any other check, and they appear in the DQ results store and portal alongside built-in checks.
