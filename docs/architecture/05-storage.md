> **Forge Platform** · ADLS Gen2 Storage Architecture

[![ADLS Gen2](https://img.shields.io/badge/ADLS-Gen2-0078D4?style=flat-square&logo=microsoftazure&logoColor=white)](https://azure.microsoft.com/en-us/products/storage/data-lake-storage) [![Delta Lake](https://img.shields.io/badge/Delta_Lake-4.0-003366?style=flat-square)](https://delta.io) [![Medallion](https://img.shields.io/badge/Architecture-Medallion-6C3483?style=flat-square)]()

---

## 1. Overview

The Forge lakehouse is organized into four ADLS Gen2 containers aligned to the **Medallion architecture**: Bronze (raw intake), Silver (standardized/validated), Gold (aggregated/curated business-ready), and Sandbox (non-production experimentation). Every layer has its own governance rules, retention policy, and folder conventions.

All production data assets — Bronze, Silver, and Gold — are written as **Delta Lake** tables. All production datasets carry an explicit **version identifier** (`v1`, `v2`, …) in the storage path and asset name.

```
adls account: forgeadls<alias><env>.dfs.core.windows.net
│
├── bronze/       ← raw intake, immutable, append-only, Delta
├── silver/       ← standardized, validated, schema-enforced, Delta
├── gold/
│   ├── analytics/      ← aggregated metrics, KPIs, curated datasets
│   └── data_products/  ← packaged domain data products for broad reuse
└── sandbox/      ← non-production, auto-purge 28 days, no lineage
```

---

## 2. Layer Definitions

### 2.1 Bronze — Raw Intake Zone

**Purpose:** Preserve original source-delivered data for audit, lineage, and reprocessing. The Bronze layer is the platform's immutable record of what was received and when.

| Property | Value |
|----------|-------|
| Format | **Delta Lake** (all sources onboarded to Delta at ingestion) |
| Mutability | **Append-only.** Data is never modified or overwritten. |
| Transformations | None. Raw semantics are preserved. |
| Retention | **2 years.** Compliance exceptions must be documented in the data catalog. |
| Access | Ingestion pipelines and platform/engineering teams only. |

**Folder structure:**

```
bronze/<source-system>/<entity>/v<N>/year=YYYY/month=MM/day=DD/hour=HH/
```

Example:
```
bronze/erp-finance/invoices/v1/year=2026/month=03/day=09/hour=10/
  part-0000.parquet   (Delta format)
  _tracker/year=2026/month=03/day=09/hour=10/
    _SUCCESS.json
  _dq/year=2026/month=03/day=09/hour=10/
    dq_result_abc123_20260309100000.json
```

**Versioning in Bronze:** If the upstream source publishes an explicit schema version, mirror it. If not, assign an internal ingestion-contract version starting at `v1`, incremented only when the upstream schema or contract changes in a breaking way.

**Ingestion metadata** (required per run): ingest timestamp, source checksum, source file size, row count.

---

### 2.2 Silver — Standardized Zone

**Purpose:** Validate, clean, standardize, and enrich raw data. Silver is the conformed, schema-enforced view of each entity — the foundation for all analytics and product teams.

| Property | Value |
|----------|-------|
| Format | **Delta Lake** (required) |
| Schema enforcement | Enabled. Schema drift causes pipeline failure, not silent acceptance. |
| Quality gates | Hard gates for contract-breaking issues (null PK, duplicate key, type violation). |
| PII | Masking or tokenization applied where required. |
| Retention | **2 years.** Compliance exceptions must be documented. |
| Access | Platform engineering and domain data engineers. Analytics teams read from Gold. |

**Folder structure:**

```
silver/<domain>/<entity>/v<N>/delta/year=YYYY/month=MM/day=DD/hour=HH/
```

Example:
```
silver/sales/orders/v1/delta/year=2026/month=03/day=09/hour=00/
  part-0000.parquet
  _tracker/year=2026/month=03/day=09/hour=00/
    _SUCCESS.json
  _dq/year=2026/month=03/day=09/hour=00/
    dq_result_def456_20260309061500.json
```

**Governance rules:**
- All datasets must have a documented owner (domain + primary contact).
- Versioning is required for all Silver datasets (see Section 3).
- No raw or semi-processed data allowed. Unvalidated data belongs in Bronze.

---

### 2.3 Gold — Aggregated / Curated Zone

**Purpose:** Publish business-ready datasets, metrics, and KPIs for analytics, ML, reporting, and downstream applications. Gold has two sub-paths with different ownership models:

| Sub-path | Purpose | Owner |
|----------|---------|-------|
| `gold/analytics/` | Aggregated metrics, KPIs, curated views for domain analytics | Domain team |
| `gold/data_products/` | Packaged data products for broad cross-domain reuse | Domain team + platform review |

| Property | Value |
|----------|-------|
| Format | **Delta Lake** (required) |
| Quality | Business-rule validation applied. Hard or soft gates depending on criticality. |
| Schema stability | Stable contracts. Breaking changes require a new version and change-control approval. |
| PII | Masking or tokenization applied where required. |
| Retention | **2 years.** Compliance exceptions must be documented. |
| Access | Broad — analytics platforms, ML, Trino, downstream applications. |

**Folder structures:**

Analytics assets:
```
gold/analytics/<domain>/<asset>/v<N>/delta/year=YYYY/month=MM/day=DD/hour=HH/
```

Data products:
```
gold/data_products/<product_name>/v<N>/delta/year=YYYY/month=MM/day=DD/hour=HH/
```

Examples:
```
gold/analytics/supply_chain/inventory_positions/v1/delta/year=2026/month=03/day=09/hour=10/
gold/data_products/compete_insights/v2/delta/year=2026/month=03/day=09/hour=00/
```

**Governance rules:**
- All datasets must have documented owners.
- Versioning is required.
- Breaking updates require change-control approval and must be released via a new version.

---

### 2.4 Sandbox — Non-Production Workspace

**Purpose:** Isolated workspace for experimentation, ad-hoc analysis, and temporary data exploration. Completely isolated from production data flows.

| Property | Value |
|----------|-------|
| Format | Any |
| Versioning | Not required |
| Lineage | Not tracked |
| Backup | None |
| Retention | **28 days — auto-purge via ADLS lifecycle policy. No exceptions** without platform governance approval. |
| Access | Per-user or per-team scope. |

**Folder structure:**

```
sandbox/<user-or-team>/<project-or-experiment>/YYYYMMDD/
```

Example:
```
sandbox/{alias}/supplier-invoice-exploration/20260309/
sandbox/team-ml/churn-model-features/20260301/
```

**Rules:**
- No sensitive or unmasked PII allowed.
- No production pipelines read from Sandbox.
- Data written to Sandbox never promotes to Bronze/Silver/Gold. A proper pipeline must be created for that.
- Users are responsible for cleanup. After 28 days, lifecycle policy auto-deletes regardless.

---

## 3. Data Asset Versioning

Every production data asset (table, dataset, data product) must be published with an explicit version identifier. This applies to all Bronze, Silver, and Gold assets. Sandbox is excluded.

### 3.1 Version Format

Version token: simple monotonic integer string — `v1`, `v2`, `v3` (no gaps, no semver).

| Where | Convention |
|-------|-----------|
| Storage path | `/<asset>/v<N>/delta/...` |
| Asset name | `<asset_name>_v<N>` (e.g. `sales_orders_v1`) |
| Data catalog | Version field on the asset registration |
| Lineage | Asset name includes version (visible in the portal lineage graph) |

### 3.2 When to Create a New Version

A **new version is required** when a change is breaking for existing consumers:

| Change | Breaking? | Action |
|--------|-----------|--------|
| Column rename or drop | Yes | New version (v+1) |
| Data type change | Yes | New version (v+1) |
| Semantic change to an existing field | Yes | New version (v+1) |
| Key or grain change | Yes | New version (v+1) |
| Partitioning change that affects downstream reads | Yes | New version (v+1) |
| Adding a nullable column | No | Same version |
| Adding a new partition | No | Same version |
| Performance-only optimization (OPTIMIZE, VACUUM) | No | Same version |
| Bug fix that corrects values within the existing contract | No | Same version (restatement) |

### 3.3 Compatibility, Deprecation, and Support Window

- **Default version:** The latest version (`vN`) is the default for all new consumers.
- **Support window:** Prior versions remain available for **90–180 days** after the new version is published. The exact window is defined per asset in the data contract.
- **Deprecation:** Once a version is deprecated, mark it in the data catalog, stop accepting new dependents, and communicate via change-control. After the support window, the version may be retired per retention policy.
- **No silent breaking changes:** Breaking updates must only be released via a new version. Consumers must be notified through change-control before the old version is retired.

### 3.4 Versioning and Restatement

Two restatement modes exist:

| Mode | When to use | How |
|------|-------------|-----|
| **Same-version restatement** | Bug fix or source data correction that stays within the existing schema/contract | Delete trackers for affected partitions and re-run. Delta Lake time travel preserves prior state for the configured log retention window. |
| **New-version restatement** | Semantic change, schema change, or any correction where the existing consumers must explicitly migrate | Publish a new version (`vN+1`) alongside the old. Old version continues serving during the deprecation window. Coordinate with consumers before retiring `vN`. |

Corrections to historical data must **not** silently overwrite a prior version when the correction represents a semantic change. Either publish a new version or a clearly labelled correction layer, with domain governance approval.

See [Restatement Architecture](./13-restatement.md) for the full operational flow.

---

## 4. Partitioning Standard

All production datasets in Bronze, Silver, and Gold must be partitioned by **year, month, day, and hour only**, using Hive-style folder names. Any deviation requires a documented exception and governance approval.

### 4.1 Standard Keys, Format, and Timezone

| Rule | Value |
|------|-------|
| Allowed partition keys | `year`, `month`, `day`, `hour` only |
| Required ordering | `year → month → day → hour` |
| Format | Numeric, zero-padded: `year=YYYY/month=MM/day=DD/hour=HH` |
| Timezone | **UTC** (default). If a different timezone is used, it must be documented in the data contract. |

### 4.2 What to Partition On

| Layer | Partition time column |
|-------|----------------------|
| Bronze | **Source event time** (the time the record logically occurred). Ingestion metadata (ingest timestamp, checksum) is captured but does not drive the partition layout. |
| Silver | The dataset's **primary time column** (event time or snapshot time). |
| Gold | The dataset's **primary time column** or the snapshot date of the aggregation. |

**Fallback:** If source event time is missing or unreliable, use ingestion time. This must be flagged as an exception in the data contract with rationale.

### 4.3 Rules and Examples

**Do:**
- Keep partition granularity consistent across related assets to simplify joins.
- Use compaction (Delta `OPTIMIZE`) to avoid small-file explosion.
- Drop the `hour` partition if the source delivers daily (not hourly) data — but document this as an exception.

**Don't:**
- Partition by high-cardinality attributes (`userId`, `tenantId`, `region`, `sku`, etc.). These explode partition counts and degrade performance.
- Use string-formatted dates (`date=2026-03-09`) — use separate `year/month/day` keys.
- Change the partition scheme of an existing asset without creating a new version.

**Example (correct):**
```
gold/analytics/supply_chain/inventory_positions/v1/delta/year=2026/month=03/day=09/hour=10/
```

**Example (incorrect — do not do this):**
```
gold/analytics/supply_chain/inventory_positions/date=2026-03-09/    ← wrong: string date, no version
gold/analytics/supply_chain/inventory_positions/region=EMEA/        ← wrong: high-cardinality key
```

### 4.4 Exceptions

Any deviation (dropping `hour`, non-UTC timezone, non-standard key) must be:
1. Documented in the data contract with the query pattern that motivates the deviation.
2. Approved by the platform governance team before the dataset is published.

---

## 5. Run Tracker Files

Every pipeline run must emit a **run tracker file** after successfully writing data and DQ results. The tracker is the authoritative signal that a partition was processed successfully.

### 5.1 Semantics

- **Written last:** The tracker is created only after both the data write and the DQ results file are complete.
- **Success signal:** Presence of the tracker means the partition is done.
- **Idempotency gate:** If the tracker exists, the pipeline skips that partition. An explicit tracker deletion (restatement reset) is required to trigger reprocessing.
- **Validation order:** Downstream consumers must check for the tracker first. Only if the tracker exists should they evaluate the DQ results.

### 5.2 Tracker Path and Filename

```
/<layer>/<domain-or-source>/<entity>/v<N>/_tracker/year=YYYY/month=MM/day=DD/hour=HH/_SUCCESS.json
```

| Layer | Example |
|-------|---------|
| Bronze | `bronze/erp-finance/invoices/v1/_tracker/year=2026/month=03/day=09/hour=10/_SUCCESS.json` |
| Silver | `silver/sales/orders/v1/_tracker/year=2026/month=03/day=09/hour=00/_SUCCESS.json` |
| Gold | `gold/analytics/sales/orders_daily/v1/_tracker/year=2026/month=03/day=09/hour=00/_SUCCESS.json` |

### 5.3 Tracker File Schema

```json
{
  "tracker_version": "1",
  "pipeline_id":      "ingest_sales_orders",
  "dag_run_id":       "scheduled__2026-03-09T00:00:00+00:00",
  "airflow_task_id":  "transform_silver",
  "layer":            "silver",
  "dataset":          "sales.orders_v1",
  "asset_version":    "v1",
  "partition":        "year=2026/month=03/day=09/hour=00",
  "completed_at":     "2026-03-09T06:23:11Z",
  "duration_seconds": 142,
  "row_count":        48293,
  "output_size_bytes":12483920,
  "schema_version":   "v1",
  "spark_app_id":     "spark-abc123def",
  "restatement_id":   null
}
```

### 5.4 Re-run / Reset

To reprocess a partition:
1. Delete the tracker file for the partition (`_tracker/year=.../month=.../day=.../hour=.../_SUCCESS.json`).
2. Optionally delete or archive the DQ results file.
3. The next pipeline run finds no tracker and reprocesses the full partition.
4. The pipeline writes: (a) data, (b) DQ results, (c) tracker — in that order.

Never delete only the data without also deleting the tracker. Mismatched state (data present, tracker absent or vice versa) causes undefined behavior.

---

## 6. DQ Results Files

Every pipeline run that writes a partition must also emit a DQ results file alongside the data. This file captures the quality metrics for that run and is used by the DQ framework to evaluate thresholds and fire alerts.

### 6.1 Results Path

```
/<layer>/<domain-or-source>/<entity>/v<N>/_dq/year=YYYY/month=MM/day=DD/hour=HH/
  dq_result_<run_id>_<YYYYMMDDHHmmss>.json
```

| Layer | Example |
|-------|---------|
| Bronze | `bronze/erp-finance/invoices/v1/_dq/year=2026/month=03/day=09/hour=10/dq_result_abc123_20260309101500.json` |
| Silver | `silver/sales/orders/v1/_dq/year=2026/month=03/day=09/hour=00/dq_result_def456_20260309061500.json` |

### 6.2 Required Metrics (Minimum Standard)

Every DQ results file must include:

| Metric | Description |
|--------|-------------|
| `volume.row_count` | Total records written |
| `volume.key_dimension_counts` | Counts by key dimensions (domain-defined) |
| `freshness.max_event_time` | Latest event time in the partition |
| `freshness.min_event_time` | Earliest event time in the partition |
| `freshness.lag_minutes` | Lag vs expected schedule |
| `schema.version_used` | Schema version applied |
| `schema.drift_detected` | Boolean — unexpected adds/drops/type changes |
| `nullability.<col>` | Null count and null % for each critical column (contract-defined) |
| `uniqueness.duplicate_count` | Duplicate count for primary/natural keys |
| `validity.pass_count` | Records passing all business validations |
| `validity.fail_count` | Records failing at least one validation |
| `pipeline.start_time` | Pipeline task start timestamp |
| `pipeline.end_time` | Pipeline task end timestamp |
| `pipeline.duration_seconds` | Task duration |
| `pipeline.status` | `SUCCESS` / `FAILED` |
| `pipeline.retry_count` | Number of retries before this run |

### 6.3 Quality Gates

| Layer | Hard gate (fail run) | Soft gate (alert only) |
|-------|---------------------|----------------------|
| Silver | Null primary key, duplicate key, type violation, schema drift | Volume outside expected range, freshness lag > threshold |
| Gold | Duplicate key, schema drift | Volume outside range, business rule violation count > threshold |
| Bronze | Schema drift detection only (alert) | N/A — Bronze receives whatever the source delivers |

---

## 7. Data Contract

Every production dataset must have a registered data contract. The contract is the single source of truth for schema, ownership, quality expectations, and SLAs.

### 7.1 Required Fields

| Field | Description |
|-------|-------------|
| `dataset_id` | Unique identifier: `<layer>.<domain>.<asset>_v<N>` |
| `owner` | Domain name and primary contact (name + email) |
| `version` | `vN`, publish date, and change log (what changed and why) |
| `schema` | Column definitions: name, type, nullable, PK/FK, description |
| `grain` | The row-level uniqueness key and time granularity |
| `partition_key` | Time column used for partitioning and its timezone |
| `quality_gates` | Required DQ checks and thresholds (maps to `_dq/` metrics) |
| `retention_sla` | Data retention period and support window for older versions |
| `refresh_cadence` | Expected schedule (e.g. `@daily`, `@hourly`) |
| `sensitivity` | Data classification (public / internal / confidential / restricted) and any masking/tokenization rules |
| `dependencies` | Upstream datasets this asset reads from (lineage anchors) |
| `consumers` | Known downstream consumers (for deprecation notifications) |

Data contracts are stored in `orchestration/contracts/<layer>/<domain>/<asset>_v<N>.yaml` and registered in the Developer Portal at publish time.

---

## 8. Full Path Reference

```
adls account root
├── bronze/
│   └── <source-system>/
│       └── <entity>/
│           └── v<N>/
│               ├── year=YYYY/month=MM/day=DD/hour=HH/   ← data (Delta)
│               ├── _tracker/
│               │   └── year=YYYY/month=MM/day=DD/hour=HH/
│               │       └── _SUCCESS.json
│               └── _dq/
│                   └── year=YYYY/month=MM/day=DD/hour=HH/
│                       └── dq_result_<id>_<ts>.json
│
├── silver/
│   └── <domain>/
│       └── <entity>/
│           └── v<N>/
│               ├── delta/
│               │   └── year=YYYY/month=MM/day=DD/hour=HH/
│               ├── _tracker/
│               │   └── year=YYYY/month=MM/day=DD/hour=HH/
│               │       └── _SUCCESS.json
│               └── _dq/
│                   └── year=YYYY/month=MM/day=DD/hour=HH/
│                       └── dq_result_<id>_<ts>.json
│
├── gold/
│   ├── analytics/
│   │   └── <domain>/
│   │       └── <asset>/
│   │           └── v<N>/
│   │               ├── delta/
│   │               │   └── year=YYYY/month=MM/day=DD/hour=HH/
│   │               ├── _tracker/...
│   │               └── _dq/...
│   └── data_products/
│       └── <product_name>/
│           └── v<N>/
│               ├── delta/...
│               ├── _tracker/...
│               └── _dq/...
│
├── sandbox/
│   └── <user-or-team>/
│       └── <project>/
│           └── YYYYMMDD/
│               └── (any format, auto-purge 28 days)
│
└── _platform/                 ← platform metadata (not domain data)
    └── restatement_registry/
    └── dq_aggregate/
```
