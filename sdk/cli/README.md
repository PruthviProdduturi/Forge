# Forge CLI

Scaffold Spark jobs from a single TypeScript manifest. One file defines everything — schedule, DQ rules, resources, partition strategy. The CLI generates the Python job, Airflow DAG, and DQ YAML.

---

## How it works

```
src/spark/jobs/my_job.forge.ts      ← you write this (manifest)
src/spark/jobs/my_job.py            ← generated — only edit the BL block
src/airflow/dags/{layer}/my_job_dag.py  ← generated, fully managed
src/dq/rules/my_job.yaml            ← generated once, then yours to extend
```

On re-generation, the business logic block inside `.py` is **preserved**. Everything else is regenerated from the manifest.

The Spark job calls into `forge_sdk` and `forge_dq` at runtime. These are distributed to every executor automatically via `spark.submit.pyFiles: forge_lib.zip` — no image rebuild needed when the SDK changes.

---

## Install

```bash
cd sdk/cli
npm install
npm run build        # compiles to dist/
npm link             # makes `forge` available globally
```

Or run without installing:

```bash
npx tsx sdk/cli/src/index.ts <command>
```

---

## Commands

### `forge init` — create a new manifest

```bash
forge init --name nyc_taxi_bronze --layer bronze
# creates: examples/src/spark/jobs/nyc_taxi_bronze.forge.ts
```

Then open the generated `.forge.ts` and fill in the details.

---

### `forge generate` — generate job files from a manifest

```bash
# single job (--manifest-dir is where .forge.ts files live, --dir is the src root)
forge generate --job nyc_taxi_bronze --manifest-dir src/spark/jobs --dir .

# all manifests (processes every .forge.ts in manifest-dir)
forge generate --manifest-dir src/spark/jobs --dir .

# verbose output
forge generate --job nyc_taxi_bronze --manifest-dir src/spark/jobs --dir . --verbose
```

**What gets generated:**

| File | Location under `--dir` | Re-generated? |
|---|---|---|
| `{name}.py` | `src/spark/jobs/{name}.py` | Yes — business logic block preserved |
| `{name}_dag.py` | `src/airflow/dags/{ingestion\|transformation}/{name}_dag.py` | Yes — fully managed |
| `{name}.yaml` | `src/dq/rules/{name}.yaml` | No — written once, then yours |

---

### `forge generate --check` — CI gate

Fails with exit code 1 if the committed `.py` file is stale relative to the manifest. Use this as a PR validation step.

```bash
forge generate --check --job nyc_taxi_bronze
# exit 0 — up to date
# exit 1 — stale, run `forge generate --job nyc_taxi_bronze` to fix
```

**Azure DevOps pipeline step:**

```yaml
- script: npx tsx sdk/cli/src/index.ts generate --check --dir examples/src/spark/jobs
  displayName: Forge — check generated files are up to date
```

---

## The manifest

Every job is defined by a `.forge.ts` file:

```typescript
import { defineJob } from "@forge/cli/schema";

export default defineJob({
  name: "nyc_taxi_silver",            // snake_case, matches file name
  layer: "silver",                    // bronze | silver | gold
  description: "Clean NYC taxi trips",

  schedule: "0 0 1 * *",             // cron — omit if triggered by upstream
  triggeredBy: "nyc_taxi_bronze",    // upstream DAG id
  triggers: ["nyc_taxi_gold"],       // DAGs to trigger on success

  // ── Partition ──────────────────────────────────────────────────────────
  // Bronze  →  __year / __month / __day / __hour  (4 integer columns)
  // Silver/Gold  →  __date  string  "DD_MM_YYYY_HH"  e.g. "01_02_1991_00"
  //
  // column:  the date/timestamp column in your data
  // hasHour: true = extract hour from column; false = hour defaults to 0
  partition: {
    column: "pickup_datetime",
    hasHour: true,           // timestamp column — hour extracted
  },

  // ── Source ─────────────────────────────────────────────────────────────
  // Path formula: abfss://{container}@{storage}/{category}/{entity}/{audience}/{metricsCohort}/{assetName}/{version}/{name}
  // Lakehouse containers (bronze/silver/gold) → Delta format auto-detected
  // External containers → specify format explicitly
  source: {
    name: "NycTaxiBronze",
    version: 1,
    path: {
      container: "bronze",           // ADLS container
      category: "Transport",
      entity: "Trip",
      audience: "Internal",
      metricsCohort: "Rideshare",
      assetName: "NycTaxi",
    },
    filter: "__year = {_year} AND __month = {_month}",  // optional Delta filter
  },

  // ── Output ─────────────────────────────────────────────────────────────
  output: {
    name: "NycTaxiTrips",
    version: 1,
    path: {
      container: "silver",
      category: "Transport",
      entity: "Trip",
      audience: "Analytics",
      metricsCohort: "Rideshare",
      assetName: "NycTaxi",
    },
    mode: "overwrite",                // overwrite (default) | append
    // table: "lakehouse.silver.nyctaxi",  // HMS table name; derived from assetName if omitted
  },

  // ── DQ rules ───────────────────────────────────────────────────────────
  dq: {
    rules: "orchestration/dq/rules/nyc_taxi_silver.yaml",
    failFast: true,                   // fail job on critical violation
  },

  // ── Extra params (PARTITION_DATE + PARTITION_HOUR always auto-injected) ─
  params: {
    TAXI_TYPE: { type: "string", default: "yellow" },
  },

  // ── Resources ──────────────────────────────────────────────────────────
  resources: {
    driver:   { cores: 2, memory: "4g" },
    executor: { cores: 4, memory: "8g", instances: 3 },
  },

  tags: ["nyc-taxi", "monthly"],
});
```

---

## Partition scheme

### Bronze — 4 integer columns

Every bronze table has `__year`, `__month`, `__day`, `__hour`:

```python
__year  = 1991          # int
__month = 2             # int
__day   = 1             # int
__hour  = 0             # int — 0 when hasHour: false
```

- Airflow always passes `PARTITION_DATE` (yyyy-MM-dd) and `PARTITION_HOUR` (default 0)
- `__hour` is either extracted from the data column (`hasHour: true`) or `PARTITION_HOUR` literal
- Idempotent replaceWhere: `__year = 1991 AND __month = 2 AND __day = 1 AND __hour = 0`

### Silver / Gold — 1 string column

Every silver/gold table has a single `__date` column:

```
01_02_1991_00    →  DD_MM_YYYY_HH
```

- Format is always `DD_MM_YYYY_HH` — hour always present, `00` when not applicable
- Consistent format across all tables regardless of source granularity
- Trino filter: `WHERE __date = '01_02_1991_00'`
- Idempotent replaceWhere: `__date = '01_02_1991_00'`

---

## Tracker files

Every generated job writes a `tracker.json` to ADLS after a successful write. This is the source of truth for pipeline run history — not logs, not Airflow metadata.

**Bronze** — path per partition:
```
abfss://bronze@{storage}.dfs.core.windows.net/{table}/_tracker/{year}/{month}/{day}/{hour}/tracker.json
```

**Silver/Gold** — path per `__date` key:
```
abfss://silver@{storage}.dfs.core.windows.net/{table}/_tracker/01_02_1991_00/tracker.json
```

**Content:**
```json
{
  "version": "v1",
  "job": "NycTaxiSilver",
  "table": "lakehouse.silver.nyc_taxi_trips",
  "partition": { "date": "01_02_1991_00" },
  "status": "success",
  "rows_written": 847291,
  "completed_at": "1991-02-01T03:12:45+00:00",
  "forge_env": "dev"
}
```

The job also guards against empty partitions — if `df.count() == 0` after the business logic block, the write and tracker are skipped and the job exits cleanly (no failure, no empty Delta partition).

---

## The generated Python

```python
# GENERATED BY FORGE CLI — DO NOT EDIT OUTSIDE THE MARKED BLOCK
# Source: nyc_taxi_silver.forge.ts  |  Layer: silver
# Regenerate: forge generate --job nyc_taxi_silver

# ... locked: imports, params, class definition, source read ...

        # ╔══════════════════════════════════════════╗
        # ║  EDIT THIS BLOCK — business logic only   ║
        # ╚══════════════════════════════════════════╝
        # ── FORGE:BUSINESS_LOGIC:START ──
        df = raw  # TODO: transform raw → df
        # ── FORGE:BUSINESS_LOGIC:END ──
        # ════════════════════════════════════════════

# ... locked: __date/__year stamping, write, saveAsTable ...
```

**Rules:**
- Only edit between `FORGE:BUSINESS_LOGIC:START` and `FORGE:BUSINESS_LOGIC:END`
- Re-running `forge generate` will regenerate everything else and keep your logic
- The VS Code extension decorates locked regions with a grey background

---

## VS Code extension

The extension is in `sdk/vscode-extension/`. It provides:

- **Grey decorations** on locked regions in generated `.py` files
- **Status bar**: `Forge: silver — nyc_taxi_silver` when a `.forge.ts` is open
- **Commands** (Ctrl+Shift+P):
  - `Forge: Generate` — runs `forge generate` for the active manifest
  - `Forge: Check` — runs `forge generate --check` (useful before committing)
  - `Forge: Init` — creates a new manifest stub

To install locally: `cd sdk/vscode-extension && npm install && npm run build`, then install the `.vsix` from VS Code.
