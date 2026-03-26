> **Forge Platform** · Data Restatement & Backfill Architecture

[![Airflow](https://img.shields.io/badge/Airflow-3.1-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org) [![Delta Lake](https://img.shields.io/badge/Delta_Lake-4.0-003366?style=flat-square)](https://delta.io) [![ADLS Gen2](https://img.shields.io/badge/ADLS-Gen2-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/storage/data-lake-storage)

---

## 1. Overview

Every pipeline in Forge is **idempotent by design**. Running a pipeline twice for the same partition produces the same result — no duplicates, no partial writes. The mechanism that makes this possible is the **partition tracker**: a small metadata file written to ADLS Gen2 alongside the output data after every successful pipeline run.

Restatement is the controlled process of invalidating trackers for a date range and re-running the affected pipelines. It is the standard mechanism for:

- **Backfilling** new pipelines over historical data
- **Correcting** upstream source data that was delivered with errors
- **Re-applying** a logic change (e.g. a bug fix in the transformation) to historical partitions
- **Recovering** from a partial write failure that left data in an inconsistent state

### Restatement Mode vs New Version

Two modes exist. Choose based on whether the correction changes the semantic contract of the dataset:

| Mode | When | Mechanism |
|------|------|-----------|
| **Same-version restatement** | Bug fix, corrected source data — schema and semantics unchanged | Delete trackers → trigger Airflow backfill → overwrite partitions in-place. Delta Lake time travel preserves prior state for the configured log retention window. |
| **New version** | Schema change, semantic change, grain change, or any correction where existing consumers must explicitly migrate | Publish `vN+1` alongside `vN`. Old version continues serving during the 90–180 day deprecation window. Coordinate consumer migrations before retiring `vN`. |

Corrections to historical data must **not** silently overwrite a prior version when the correction changes the contract. In that case a new version is required. See [Storage Architecture — Versioning](./storage-architecture.md#3-data-asset-versioning) for the full versioning rules.

Restatement is a first-class operation in Forge. It is triggered from the **Developer Portal**, tracked in the **Restatement Registry**, and fully observable in **Azure Monitor / Grafana**.

---

## 2. The Partition Tracker

### 2.1 What Is a Tracker

A tracker is a JSON file written to the output partition path after the pipeline task completes successfully. Its presence is the authoritative signal that a partition has been processed. Its absence means the partition needs (re-)processing.

```
silver/
  sales/
    orders/
      v1/
        delta/
          year=2024/month=01/day=01/hour=00/   ← data
            part-0000.parquet
        _tracker/
          year=2024/month=01/day=01/hour=00/
            _SUCCESS.json                          ← tracker for this partition
        _dq/
          year=2024/month=01/day=01/hour=00/
            dq_result_abc123_20240101060000.json    ← DQ results
```

### 2.2 Tracker Schema

The canonical tracker file schema — all fields, types, and descriptions — is defined in [Storage Architecture §5.3](storage-architecture.md#53-tracker-file-schema).

The `restatement_id` field is the key field for this document: it is `null` on normal writes and set to the UUID of the originating restatement request when the partition was produced by a restatement run. This is how the Restatement Registry identifies which partitions have been corrected and whether a restatement is still in progress.

### 2.3 Tracker Location Convention

Trackers are co-located with data, always at the root of the partition directory:

| Layer | Path pattern |
|-------|-------------|
| Silver | `silver/<domain>/<entity>/v<N>/_tracker/year=YYYY/month=MM/day=DD/hour=HH/_SUCCESS.json` |
| Gold (analytics) | `gold/analytics/<domain>/<asset>/v<N>/_tracker/year=YYYY/month=MM/day=DD/hour=HH/_SUCCESS.json` |
| Gold (data product) | `gold/data_products/<product>/v<N>/_tracker/year=YYYY/month=MM/day=DD/hour=HH/_SUCCESS.json` |

Bronze does **not** use trackers. Bronze is append-only raw data — reprocessing bronze means re-ingesting from source, which is a source system concern, not a Forge concern.

**No manual writes.** Data must never be written directly to ADLS (via Storage Explorer, `az storage`, or raw SDK calls) outside of a pipeline. Manual writes bypass the tracker, lineage, and DQ — the platform cannot account for them. All data writes go through a Forge pipeline.

### 2.4 How Pipelines Use Trackers

At the start of each Airflow task that writes a partition, the pipeline checks for the tracker:

```python
from forge.sdk.tracker import TrackerClient

tracker = TrackerClient()

@task
def transform_silver(execution_date: str, **context):
    partition = f"year={execution_date[:4]}/month={execution_date[5:7]}/day={execution_date[8:10]}/hour=00"
    dataset   = "sales.orders_v1"

    # Check tracker — skip if already processed
    if tracker.exists(layer="silver", dataset=dataset, asset_version="v1", partition=partition):
        log.info("Tracker found — partition already processed, skipping.")
        return  # idempotent exit

    # --- do the work ---
    df = spark.read.format("delta").load(f"abfss://bronze@{ACCOUNT}.dfs.core.windows.net/sales/orders/v1/year={partition[:4]}/month={partition[5:7]}/day={partition[8:10]}/hour=00/")
    df_silver = apply_transformations(df)
    df_silver.write.mode("overwrite").parquet(
        f"abfss://silver@{ACCOUNT}.dfs.core.windows.net/sales/orders/{partition}/"
    )

    # Write tracker only after successful write
    tracker.write(
        layer="silver",
        dataset=dataset,
        asset_version="v1",
        partition=partition,
        row_count=df_silver.count(),
        output_size_bytes=get_partition_size(partition),
        schema_version="v1",
    )
```

**Key rule:** The tracker is written **last**, after the data write completes. If the task fails mid-write, no tracker is written. The next run will overwrite the partial data and write a clean tracker.

---

## 3. Restatement Flow

### 3.1 End-to-End Sequence

```
Developer Portal                  Portal API              Restatement Registry       Airflow
      │                               │                          │                      │
      │  1. Select dataset +          │                          │                      │
      │     date range + reason       │                          │                      │
      ├──────────────────────────────►│                          │                      │
      │                               │  2. Validate (RBAC,      │                      │
      │                               │     no active conflict)  │                      │
      │                               │                          │                      │
      │                               │  3. Create restatement   │                      │
      │                               │     record (PENDING)     │                      │
      │                               ├─────────────────────────►│                      │
      │                               │                          │                      │
      │                               │  4. Delete trackers for  │                      │
      │                               │     affected partitions  │                      │
      │                               │     (ADLS Gen2)          │                      │
      │                               │                          │                      │
      │                               │  5. Trigger Airflow      │                      │
      │                               │     DAG backfill via     │                      │
      │                               │     REST API             │                      │
      │                               ├──────────────────────────────────────────────► │
      │                               │                          │                      │
      │                               │  6. Update record        │                      │
      │                               │     (IN_PROGRESS +       │                      │
      │                               │     dag_run_id)          │                      │
      │                               ├─────────────────────────►│                      │
      │                               │                          │                      │
      │  7. Stream progress           │◄─ Airflow webhook / poll │◄─────────────────── │
      │◄──────────────────────────────┤                          │                      │
      │                               │                          │                      │
      │  8. Show completion +         │  9. Update record        │                      │
      │     impact summary            │     (COMPLETED)          │                      │
      │◄──────────────────────────────├─────────────────────────►│                      │
```

### 3.2 Step-by-Step Detail

#### Step 1 — Portal: Build the Restatement Request

The user selects:
- **Dataset** (or pipeline) to restate
- **Start date / End date** (inclusive, partition granularity)
- **Cascade depth**: Silver only, Silver + Gold, or Full (all layers)
- **Reason** (free text, required — stored in registry for audit)

The portal displays a preview before confirmation:

```
┌─────────────────────────────────────────────────────────────┐
│  Restate: sales.orders                                      │
│                                                             │
│  Date range:   2024-01-01 → 2024-01-07  (7 partitions)      │
│  Layers:       Silver, Gold                                 │
│  Trackers:     14 will be deleted                           │
│  Downstream:   sales.order_lines, finance.revenue_daily     │
│                (not included — cascade not selected)        │
│                                                             │
│  Reason:  Source system redelivered corrected January data  │
│                                                             │
│  ⚠  This will overwrite 7 Silver + 7 Gold partitions.       │
│     Existing data will be replaced via Delta overwrite.     │
│                                                             │
│  [ Cancel ]                        [ Confirm Restatement ]  │
└─────────────────────────────────────────────────────────────┘
```

#### Step 2 — API: Validation

Before proceeding, the Portal API validates:

| Check | Action if fails |
|-------|----------------|
| User has `restatement.write` RBAC permission on the dataset | 403 Forbidden |
| No other restatement is IN_PROGRESS for an overlapping partition range of the same dataset | 409 Conflict — show active restatement link |
| Requested date range does not exceed 90 days | 400 Bad Request — requires platform team approval for larger ranges |
| All specified layers exist for the dataset | 400 Bad Request |

#### Step 3 — API: Create Restatement Record

A record is written to the Restatement Registry before any destructive action. This ensures every restatement is auditable even if it fails before completing.

```json
{
  "restatement_id":      "rst-7f3a9c2b-...",
  "dataset_id":          "sales.orders",
  "pipeline_id":         "ingest_sales_orders",
  "triggered_by":        "prproddu@contoso.com",
  "triggered_at":        "2024-01-15T09:12:00Z",
  "date_range_start":    "2024-01-01",
  "date_range_end":      "2024-01-07",
  "layers":              ["silver", "gold"],
  "reason":              "Source system redelivered corrected January data",
  "status":              "PENDING",
  "trackers_to_delete":  14,
  "partitions_affected": 14,
  "dag_run_id":          null,
  "completed_at":        null,
  "rows_before":         338051,
  "rows_after":          null,
  "error_message":       null
}
```

#### Step 4 — API: Delete Trackers

The Portal API deletes `_SUCCESS.json` tracker files from all affected partition paths in ADLS Gen2.

```python
# Portal API — restatement service
for partition in affected_partitions:
    tracker_path = f"abfss://{layer}@{account}.dfs.core.windows.net/{dataset_path}/v1/_tracker/{partition}/_SUCCESS.json"
    adls_client.delete_file(tracker_path)
    log.info(f"Deleted tracker: {tracker_path}")
```

This is the point of no return: once trackers are deleted, Airflow will reprocess those partitions on next run.

#### Step 5 — API: Trigger Airflow Backfill

The Portal API calls the Airflow 3.x REST API to create backfill DAG runs:

```http
POST /api/v1/dags/{dag_id}/dagRuns
{
  "dag_run_id": "restatement__rst-7f3a9c2b__2024-01-01",
  "logical_date": "2024-01-01T00:00:00Z",
  "conf": {
    "restatement_id": "rst-7f3a9c2b-...",
    "restatement_mode": true,
    "force_layer": "silver"
  }
}
```

One DAG run is created per partition per layer. For a 7-day Silver+Gold restatement on a dataset with two layers: 14 DAG runs are created.

The `restatement_id` is passed in `dag_run conf` so the pipeline can stamp it in the new tracker file.

#### Step 6 — Airflow: Process Partitions

Airflow processes each backfill run normally. Because the trackers were deleted in Step 4, each task finds no tracker and processes the full partition. After writing data it writes a new tracker with `restatement_id` set.

For Gold layers that depend on Silver, the Gold DAG run is queued to start only after the Silver run for the same partition completes (Airflow sensor or explicit dependency).

#### Step 7 — Portal: Progress Streaming

The portal polls the Airflow REST API and the Restatement Registry to stream progress to the user:

```
┌──────────────────────────────────────────────────────────────┐
│  Restatement in progress — sales.orders                      │
│  rst-7f3a9c2b  ·  Triggered by prproddu  ·  09:12 UTC       │ 
│                                                              │
│  Progress:  9 / 14 partitions complete                       │
│  ████████████████░░░░░░░░  64%                               │
│                                                              │
│  Silver   ██████████  7/7  ✓ complete                       │ 
│  Gold     ████░░░░░░  2/7  ⟳ running                        │ 
│                                                              │
│  ETA: ~4 min  ·  Elapsed: 8 min                             │ 
│                                                              │
│  [ View Airflow Runs ↗ ]           [ Cancel Restatement ]   │ 
└──────────────────────────────────────────────────────────────┘
```

#### Step 8 — Registry: Mark Complete

Once all DAG runs succeed, the Portal API updates the restatement record:

```json
{
  "status":       "COMPLETED",
  "completed_at": "2024-01-15T09:24:37Z",
  "rows_before":  338051,
  "rows_after":   341204,
  "dag_run_ids":  ["restatement__rst-7f3a9c2b__2024-01-01", "..."]
}
```

The row delta (`+3153`) is shown in the completion summary, giving the user confirmation that the corrected source data was reflected.

---

## 4. Restatement Registry

The Restatement Registry is a Delta Lake table in the gold layer:

```
gold/_platform/restatement_registry/
  _SUCCESS.json   ← the registry table itself has a tracker
  *.parquet
```

This makes it queryable via Trino and Spark, and visible in the portal's audit views.

### 4.1 Schema

```sql
CREATE TABLE gold._platform.restatement_registry (
  restatement_id      STRING NOT NULL,    -- UUID: rst-{uuid4}
  dataset_id          STRING NOT NULL,    -- e.g. sales.orders
  pipeline_id         STRING NOT NULL,    -- Airflow DAG ID
  triggered_by        STRING NOT NULL,    -- UPN of the user
  triggered_at        TIMESTAMP NOT NULL,
  date_range_start    DATE NOT NULL,
  date_range_end      DATE NOT NULL,
  layers              ARRAY<STRING>,      -- ['silver', 'gold']
  reason              STRING NOT NULL,    -- required free text
  status              STRING NOT NULL,    -- PENDING | IN_PROGRESS | COMPLETED | FAILED | CANCELLED
  trackers_deleted    INT,
  partitions_affected INT,
  dag_run_ids         ARRAY<STRING>,
  rows_before         LONG,
  rows_after          LONG,
  completed_at        TIMESTAMP,
  error_message       STRING
)
USING DELTA
PARTITIONED BY (date_trunc('month', triggered_at));
```

### 4.2 Querying Restatement History

```sql
-- All restatements for a dataset in the last 90 days
SELECT
  restatement_id,
  triggered_by,
  triggered_at,
  date_range_start,
  date_range_end,
  layers,
  reason,
  status,
  rows_after - rows_before AS row_delta
FROM gold._platform.restatement_registry
WHERE dataset_id = 'sales.orders'
  AND triggered_at >= current_date - INTERVAL 90 DAYS
ORDER BY triggered_at DESC;
```

---

## 5. Cascade Restatement

When a Bronze or Silver dataset is restated, its downstream derived datasets should also be restated — otherwise the gold layer will contain data derived from the old (incorrect) silver, while silver now has the corrected values.

### 5.1 Lineage-Driven Cascade

The portal uses the **Purview lineage graph** to determine downstream impact. When the user selects cascade, the portal queries Purview for all datasets downstream of the target:

```
ingest_sales_orders  →  silver/sales/orders
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
          gold/sales/orders_daily   gold/sales/orders_monthly
                                        │
                    ▼
          gold/finance/revenue_daily
```

The cascade UI shows the user exactly which datasets will be restated and in what order.

### 5.2 Cascade Execution Order

Cascade restatements execute in topological order (parents before children). The Portal API builds the execution graph and gates each child DAG run on its parent completing successfully.

```
Phase 1: silver/sales/orders         (direct target)
Phase 2: gold/sales/orders_daily     (depends on phase 1)
Phase 3: gold/sales/orders_monthly   (depends on phase 1)
         gold/finance/revenue_daily  (depends on phase 2)
```

### 5.3 Selective Cascade

Users can select cascade depth:

| Option | Description |
|--------|-------------|
| **This layer only** | Restate only the selected dataset. Downstream datasets retain stale-but-consistent data. |
| **Immediate children** | Restate the target + one level of downstream datasets. |
| **Full cascade** | Restate the target and all downstream datasets recursively. Use for major source corrections. |

---

## 6. Safety Guards

### 6.1 Concurrency Lock

Only one active restatement is permitted per dataset per time at a time. If a second restatement is requested while one is IN_PROGRESS, the portal returns:

```
409 Conflict
A restatement (rst-7f3a9c2b) is already in progress for sales.orders
covering 2024-01-01 → 2024-01-07. Wait for it to complete or cancel it first.
```

### 6.2 Partition Range Limit

Restatements are capped at **90 partitions (days)** per request via the portal. This prevents accidental full-history rewrites. For larger ranges, the platform team runs a manual `forge restate --force` CLI command with explicit sign-off.

### 6.3 DQ Re-validation

After every restatement partition completes, the DQ framework **automatically re-runs** the ruleset for that partition. If DQ fails on restated data:
- The restatement status for that partition is marked `DQ_FAILED`
- An alert fires to the dataset owner
- The partition remains without a tracker (will be retried on next run)

### 6.4 Partial Failure Handling

If a restatement fails mid-way (e.g. 4 of 7 partitions succeed before a Spark error):

- Completed partitions have new trackers — they are in a good state
- Failed partitions have no trackers — they will be re-attempted on next regular Airflow run
- The restatement record is set to `PARTIALLY_FAILED` with details
- An alert fires to the dataset owner
- The user can re-trigger restatement for the remaining date range

### 6.5 Cancellation

An IN_PROGRESS restatement can be cancelled from the portal:

1. Portal API calls Airflow REST API to cancel all queued/running DAG runs
2. Already-deleted trackers are **not** restored (the data written so far is valid)
3. Remaining partitions have no trackers → will be reprocessed on next regular run
4. Restatement record is set to `CANCELLED`

---

## 7. Tracker SDK

The `forge-sdk` provides a `TrackerClient` that all pipelines use. It handles path construction, ADLS authentication via workload identity, and atomic writes.

### 7.1 Core API

```python
from forge.sdk.tracker import TrackerClient

tracker = TrackerClient()   # picks up workload identity and storage account from env

# Check if a partition has been processed
exists: bool = tracker.exists(
    layer="silver",
    dataset="sales.orders_v1",
    asset_version="v1",
    partition="year=2024/month=01/day=01/hour=00",
)

# Write a tracker after successful data write
tracker.write(
    layer="silver",
    dataset="sales.orders_v1",
    asset_version="v1",
    partition="year=2024/month=01/day=01/hour=00",
    row_count=48293,
    output_size_bytes=12483920,
    schema_version="v1",
    restatement_id=context.get("params", {}).get("restatement_id"),
)

# Delete a tracker (used by restatement service — not called from pipelines)
tracker.delete(
    layer="silver",
    dataset="sales.orders_v1",
    asset_version="v1",
    partition="year=2024/month=01/day=01/hour=00",
)

# List all partitions without a tracker (used for backfill detection)
missing: list[str] = tracker.list_missing(
    layer="silver",
    dataset="sales.orders_v1",
    asset_version="v1",
    start_date="2024-01-01",
    end_date="2024-01-31",
)
```

### 7.2 Airflow Operator Integration

For convenience, the `ForgeSparkOperator` and `ForgeTransformOperator` in the SDK handle tracker checking and writing automatically when `use_tracker=True` (the default):

```python
from forge.sdk.operators import ForgeTransformOperator

transform_silver = ForgeTransformOperator(
    task_id="transform_silver",
    dataset="sales.orders",
    layer="silver",
    transform_fn="jobs.sales.orders.transform_silver",
    use_tracker=True,        # default — skip if tracker present, write on success
    schema_version="v3",
)
```

---

## 8. Portal: Restatement UI

### 8.1 Trigger Entry Points

Restatement can be triggered from three places in the portal:

1. **Dataset page** → "Restate" button (top-right) — for data-centric restatements
2. **Pipeline page** → "Backfill / Restate" → date picker — for pipeline-centric restatements
3. **Lineage graph** → right-click any dataset node → "Restate this dataset"

### 8.2 Restatement History

Every dataset page has a **Restatements** tab showing:

| Column | Description |
|--------|-------------|
| ID | `rst-{short-id}` — links to full detail |
| Triggered by | User UPN |
| Date | When triggered |
| Range | e.g. `2024-01-01 → 2024-01-07` |
| Layers | Silver, Gold |
| Reason | Summary of the text |
| Status | `COMPLETED` / `IN_PROGRESS` / `FAILED` |
| Row delta | `+3,153` or `-12` |

### 8.3 Active Restatement Banner

When a restatement is IN_PROGRESS for a dataset, a banner is shown on the dataset page and in any lineage view referencing that dataset:

```
⟳  Restatement in progress (rst-7f3a9c2b) · 9/14 partitions · ~4 min remaining
   Triggered by prproddu · Reason: Source system redelivered corrected January data
   [ View Progress ]
```

Downstream consumers querying the dataset during restatement via Trino will read the most recent committed version (Delta Lake snapshot isolation). They are not blocked.

### 8.4 RBAC

| Role | Capability |
|------|-----------|
| `viewer` | View restatement history only |
| `contributor` | Trigger restatements on owned datasets (max 30-day range) |
| `owner` | Trigger restatements on any dataset (max 90-day range) |
| `platform-admin` | Force restatements beyond 90 days via CLI |

---

## 9. Observability

### 9.1 Metrics

The following metrics are emitted to Azure Monitor:

| Metric | Type | Labels |
|--------|------|--------|
| `forge.restatement.started` | Counter | `dataset`, `triggered_by`, `layer` |
| `forge.restatement.completed` | Counter | `dataset`, `status` (`completed`/`failed`) |
| `forge.restatement.duration_seconds` | Histogram | `dataset`, `layer` |
| `forge.restatement.partitions_affected` | Gauge | `dataset` |
| `forge.tracker.missing` | Counter | `dataset`, `layer` — increments each time a pipeline finds a missing tracker (normal + restatement) |

### 9.2 Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| Restatement stuck | IN_PROGRESS for > 4 hours | P2 |
| Restatement DQ failed | Any partition DQ_FAILED after restatement | P2 |
| Unexpected tracker missing | `forge.tracker.missing` spikes outside of known restatement windows | P3 |

### 9.3 Lineage

Every restatement run emits OpenLineage events stamped with `restatement_id`. This means the Purview lineage graph shows:

- **Normal runs** — steady-state lineage
- **Restatement runs** — visually distinct (tagged `restatement`) overlaid on the same dataset nodes

Lineage consumers (audit tools, downstream teams) can distinguish restated data from organic pipeline output by querying for `restatement_id IS NOT NULL` in the tracker.

---

## 10. Architecture Diagram

```
┌───────────────── Developer Portal ──────────────────────────┐
│                                                             │
│  Dataset Page   Pipeline Page   Lineage Graph               │
│       │               │               │                     │
│       └───────────────┴───────────────┘                     │
│                       │                                     │
│              [Restate Button / Form]                        │
│                       │                                     │
│              Portal API (/api/restatements)                 │
│                       │                                     │
│          ┌────────────┼────────────────────┐                │
│          ▼            ▼                    ▼                │
│   Validate RBAC  Restatement Registry  Airflow REST API     │
│                  (Delta Lake table)    (trigger backfill)   │
└──────────────────────────────────────────────────────────--┘
                         │
           ┌─────────────┴─────────────┐
           ▼                           ▼
   ADLS Gen2                      Airflow DAG Runs
   Delete tracker _SUCCESS.json   (per partition per layer)
   files for affected                     │
   partitions                             ▼
                               Spark writes Delta partition
                               + TrackerClient.write()
                               + DQ re-validation
                               + OpenLineage event (restatement tagged)
```
