# Forge SDK

Tools and libraries for building data pipelines on the Forge platform.

## Components

```
sdk/
  cli/              TypeScript CLI — generate Python jobs, DAGs, DQ rules from manifests
  python/           Python runtime libraries distributed to all Spark executors
    forge_sdk/      ForgeJob base class, ADLS helpers, partition utilities
    forge_dq/       Data quality rule engine (track() decorator)
  vscode-extension/ VS Code extension — manifest editing and code generation

orchestration/airflow/plugins/forge_airflow/
  operators.py      ForgeSparkOperator, ForgeDqGateOperator
```

## The generation flow

```
.forge.ts manifest
    ↓ forge generate
.py job + _dag.py + .yaml DQ rules
    ↓ sync-jobs.sh --job <name>
ADLS code/spark/jobs/{name}.py     ← Spark driver fetches this at runtime
ADLS code/dq/rules/{name}.yaml     ← ForgeDqGateOperator reads rules from here
dags/{name}_dag.py                 ← git-sync → Airflow (30 s)
```

The Forge SDK (`forge_sdk`, `forge_dq`, `forge_catalog`) is baked into the Spark image at build time. No `forge_lib.zip` distribution — SDK updates require an image rebuild and re-deploy.

## CLI (sdk/cli/)

```bash
forge init --name my_job --layer bronze                         # create manifest stub
forge generate --manifest-dir src/spark/jobs --dir .           # generate all files
forge generate --job my_job --check                            # CI gate: fail if stale
```

Install: `cd sdk/cli && npm install && npm run build && npm link`

Full CLI reference: `sdk/cli/README.md`

## End-to-end: create → generate → deploy → run

### 1. Create or edit the manifest

```bash
# Create a new manifest stub
forge init --name my_job --layer bronze

# Edit the manifest to configure source, partition, output, resources
code src/spark/jobs/my_job.forge.ts
```

### 2. Generate artefacts

```bash
# Generate Python job + Airflow DAG + DQ rules YAML
OWNER_ALIAS=DSEng forge generate --manifest src/spark/jobs/my_job.forge.ts --dir .

# Check what changed (CI gate — exits 1 if stale)
OWNER_ALIAS=DSEng forge generate --manifest src/spark/jobs/my_job.forge.ts --dir . --check
```

Generated files (committed to this repo, not auto-deployed):
- `jobs/my_job.py` — Spark driver (business logic preserved across regen)
- `dags/my_job_dag.py` — Airflow DAG (fully managed, do not edit)
- `dq/my_job.yaml` — DQ rules (written once, manually curated)

### 3. Deploy to Airflow + ADLS

```bash
# Upload Spark job + DQ rules to ADLS; let Airflow git-sync pick up the DAG
OWNER_ALIAS=DSEng bash infra/scripts/sync-jobs.sh --job my_job

# Preview without applying
OWNER_ALIAS=DSEng bash infra/scripts/sync-jobs.sh --job my_job --dry-run
```

Airflow git-sync polls ADLS every 30 s — the DAG appears in the UI within ~1 minute.
`--job` is mandatory — there is no bulk sync mode.

### 4. Trigger a run

Option A — Airflow UI:
1. Open Airflow → DAGs → `my_job`
2. Click ▶ **Trigger DAG** (top right)

Option B — Forge Portal:
1. Open the portal → **Pipelines**
2. Find `my_job`, click **Trigger**

Option C — CLI (one-off):
```bash
# Trigger via Airflow REST API (replace with your Airflow URL)
curl -X POST "http://<airflow-host>/api/v1/dags/my_job/dagRuns" \
  -H "Content-Type: application/json" \
  -d '{"conf": {}}'
```

### 5. Monitor

- **Portal → Pipelines** — live run state, task graph, logs per task
- **Airflow UI** → DAGs → `my_job` → Graph / Grid view
- Task logs: Portal → Pipelines → select run → click task node → Logs

## Manifest path schema

```typescript
source: {
  name: "TlcYellowTrip",
  version: 1,
  path: {
    container: "raw",       // ADLS container
    category: "Transport",
    entity: "Trip",
    audience: "Public",
    metricsCohort: "Rideshare",
    assetName: "NycTlc",
  },
  format: "parquet",
}
```

ADLS path formula:
`abfss://{container}@{storage}/{category}/{entity}/{audience}/{metricsCohort}/{assetName}/{version}/{name}`

## Python SDK (sdk/python/)

Baked into the Spark image at build time. SDK updates require an image rebuild.

- `ForgeJob`: base class handling Spark session, ADLS paths, partition stamping, idempotency guard, and tracker writes
- `forge_dq.track()`: DQ decorator — validates a DataFrame against a rules YAML before write

### SDK distribution

The SDK is baked into the Spark image at build time (installed from source in the Dockerfile).
When SDK code changes, rebuild and push the Spark image, then re-run `forge-up.sh --skip-infra`
to apply the new image. There is no `forge_lib.zip` — `spark.submit.pyFiles` is not used.

## forge_airflow plugin

**Location:** `orchestration/airflow/plugins/forge_airflow/operators.py`

The `forge_airflow` plugin provides the two Airflow operators that all generated DAGs import. It is not part of `sdk/python/` — it ships with the orchestration layer.

### ForgeSparkOperator

Submits a Spark job to the compute cluster. Builds the `SparkApplication` YAML internally at execute time — no YAML is authored in the DAG file. Platform config (`spark_image`, `storage_account`, `tenant_id`, `mi_client_id`) is read from Airflow Variables via `_require()` at parse time; a missing variable raises immediately.

### ForgeDqGateOperator

Submits the `forge_dq_gate` platform Spark job (`orchestration/spark-jobs/forge_dq_gate.py`). Passes `RULES_PATH=abfss://code@{storage}/dq/rules/{job}.yaml` as an environment variable. The gate job downloads the YAML from ADLS, applies partition-aware filtering (bronze: `__year/__month/__day`; silver/gold: `__date = DD_MM_YYYY_HH`), runs all three DQ layers, and fails on any critical rule violation.

### Deployment

| Environment | Mechanism |
|-------------|-----------|
| Dev | `forge-airflow-plugin` ConfigMap mounted at Python site-packages in the Airflow pod. No image rebuild needed for plugin updates. |
| Prod | Plugin files must be copied to `infra/docker/airflow/plugins/forge_airflow/` before the image build. SDK changes → image rebuild → `forge-up.sh --skip-infra`. |

---

## VS Code extension (sdk/vscode-extension/)

- Grey decorations on locked (generated) regions in `.py` files
- `Forge: Generate` command (Ctrl+Shift+P)
- Status bar shows the active manifest layer and job name

### Build and install the extension

```bash
cd sdk/vscode-extension
npm install
npm run build                    # compiles src/ → dist/extension.js
npm run package                  # vsce package → forge-sdk-<version>.vsix
```

Install the `.vsix` in VS Code: **Extensions → ⋯ → Install from VSIX…**

**Prerequisites:** Node.js 20+, `@vscode/vsce` (included as devDependency).
No `node_modules` are bundled — the extension uses only VS Code built-ins.
