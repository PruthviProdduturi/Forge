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

## Deploying a pipeline

Always deploy a single named job — bulk sync is not supported by design:

```bash
# Deploy (or redeploy) one pipeline
FORGE_ENV="dev" OWNER_ALIAS="DSEng" bash infra/scripts/sync-jobs.sh --job nyc_taxi_bronze

# Preview what would change without applying
FORGE_ENV="dev" OWNER_ALIAS="DSEng" bash infra/scripts/sync-jobs.sh --job nyc_taxi_bronze --dry-run
```

`sync-jobs.sh` regenerates the DAG + Spark job from the `.forge.ts` manifest, uploads
the `.py` to ADLS (`code/spark/jobs/`), uploads the DQ rules to ADLS (`code/dq/rules/`),
and the DAG file is picked up by Airflow git-sync within 30 seconds.
`--job` is mandatory — there is no full/bulk sync mode.

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
