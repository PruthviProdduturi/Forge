# Runbook: DQ Failure — Pipeline Blocked

> **Severity:** P2 (pipeline halted at DQ gate) / P3 (DQ warnings only)
> **Audience:** On-call platform engineer, data engineer who owns the pipeline

---

## Overview

When a DQ rule marked `severity: critical` fails and `failFast: true` is set in the manifest, the Spark job exits with a non-zero code and writes **no data**. The Airflow task is marked `FAILED`. No partial data is written to the Delta table.

DQ warnings do not stop the pipeline — only critical failures do.

---

## Quick Diagnosis

### 1. Find the failure in Airflow

```bash
# Get the failed task logs
kubectl exec -n airflow --context forge-orch-dev \
  deployment/airflow-scheduler \
  -- airflow tasks logs <dag_id> <task_id> <run_id>
```

Or navigate to: `https://forge-portal-prproddu-dev.westcentralus.cloudapp.azure.com/pipelines`

Look for the DQ failure summary in the Spark driver logs:

```
DQRunner: 3 rules evaluated, 1 critical failure
  [FAILED CRITICAL] schema_order_id_not_null: 142 null values found (threshold: 0)
DQRunner: failFast=True — raising DQCriticalFailure
```

### 2. Query the DQ results Delta table

The DQ results are persisted in ADLS even on failure (the DQ report is written before the `failFast` exception):

```sql
-- Trino query: last 10 DQ runs for a specific job
SELECT
  job_name,
  run_id,
  rule_name,
  severity,
  status,
  observed_value,
  threshold,
  run_ts
FROM lakehouse.dq.results
WHERE job_name = 'nyc_taxi_silver'
  AND run_ts > now() - INTERVAL '7' DAY
ORDER BY run_ts DESC
LIMIT 50;
```

### 3. Inspect the failing rule

```bash
# Find the ruleset file
cat orchestration/dq/rules/nyc_taxi_silver.yaml
```

---

## Remediation Paths

### Path A: Data issue (upstream source has bad data)

The source data genuinely has quality problems (nulls, duplicates, out-of-range values).

**Steps:**
1. Identify which upstream pipeline produced the bad data.
2. Fix the upstream source or re-run the upstream pipeline to produce clean data.
3. Once upstream data is clean, re-trigger the failed DAG task:

```bash
kubectl exec -n airflow --context forge-orch-dev \
  deployment/airflow-scheduler \
  -- airflow tasks clear <dag_id> --task-id <task_id> --yes --start-date <YYYY-MM-DD>
```

4. Airflow will re-run the task. If data is now clean, it passes and continues.

---

### Path B: Rule threshold is too strict

The data is acceptable but the rule threshold is miscalibrated (e.g., a `null_rate` threshold of `0.001` but legitimate nulls exist at `0.002`).

**Steps:**
1. Open the ruleset YAML: `orchestration/dq/rules/<job_name>.yaml`
2. Adjust the threshold:

```yaml
# Before
- name: content_customer_id_null_rate
  type: null_rate
  column: customer_id
  threshold: 0.001        # too strict
  severity: critical

# After
- name: content_customer_id_null_rate
  type: null_rate
  column: customer_id
  threshold: 0.01         # allows up to 1% nulls
  severity: critical
```

3. Commit, push, and wait for git-sync.
4. Re-trigger the task (see Path A step 3).

> **Note:** Threshold changes to critical rules require a comment explaining the business justification. Add it as a YAML comment above the rule.

---

### Path C: New column added to source breaks schema rule

A schema rule checks for required columns, but the source schema changed (column renamed, removed, or type changed).

```yaml
# Example: schema rule that checks a column exists and has the right type
- name: schema_order_id_string
  type: column_type
  column: order_id
  expected_type: string
  severity: critical
```

**Steps:**
1. Verify whether the schema change is intentional (check with the source team).
2. If intentional: update the ruleset to match the new schema, update the Spark job's transformation logic if column handling changed, then re-trigger.
3. If accidental: escalate to the source team to revert.

---

### Path D: Temporarily bypass DQ for an emergency load (last resort)

Use only when a business-critical partition must be loaded and the DQ issue cannot be resolved quickly. Requires explicit approval from the data product owner.

1. In the manifest `.forge.ts`, temporarily set:

```typescript
dq: {
  rules: "orchestration/dq/rules/nyc_taxi_silver.yaml",
  failFast: false,   // WARNING: temporarily disabled
},
```

2. Regenerate: `forge generate --job nyc_taxi_silver`
3. Commit with a message explaining the bypass and the ticket tracking the fix.
4. Re-trigger the pipeline.
5. Create a follow-up ticket to re-enable `failFast: true` and fix the root cause before the next scheduled run.

> Do not leave `failFast: false` across more than one scheduled run. DQ exists to protect downstream consumers.

---

## Checking DQ History in the Portal

Navigate to: **Datasets → [dataset name] → DQ tab**

The DQ tab shows:
- Rule pass/fail trend over the last 30 days per rule
- The observed value vs threshold for each run
- A download link for the full DQ report JSON

---

## Related Architecture

- [DQ Architecture](../architecture/09-data-quality.md) — DQ rule schema, how results are stored, failFast semantics
- [Restatement Runbook](../guides/developer-experience.md#11-restatement--backfill) — How to re-run a partition after fixing a DQ issue
