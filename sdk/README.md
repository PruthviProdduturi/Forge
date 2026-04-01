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
```

## The generation flow

```
.forge.ts manifest
    ↓ forge generate
.py job + _dag.py + .yaml DQ rules
    ↓ sync-jobs.sh
ADLS code/spark/jobs/*.py          ← Spark driver fetches this
ADLS code/lib/forge_lib.zip        ← Spark distributes to all executors
orchestration/airflow/dags/        ← git-sync → Airflow
```

## CLI (sdk/cli/)

```bash
forge init --name my_job --layer bronze                         # create manifest stub
forge generate --manifest-dir src/spark/jobs --dir .           # generate all files
forge generate --job my_job --check                            # CI gate: fail if stale
```

Install: `cd sdk/cli && npm install && npm run build && npm link`

Full CLI reference: `sdk/cli/README.md`

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

Distributed to executors via `forge_lib.zip` — no image rebuild when the SDK changes.

- `ForgeJob`: base class handling Spark session, ADLS paths, partition stamping, idempotency guard, and tracker writes
- `forge_dq.track()`: DQ decorator — validates a DataFrame against a rules YAML before write

### forge_lib.zip distribution

Built by `sync-jobs.sh` whenever `sdk/python/` changes, then uploaded to
`abfss://code@{storage}/lib/forge_lib.zip`. Every SparkApplication references it via
`spark.submit.pyFiles`.

## VS Code extension (sdk/vscode-extension/)

- Grey decorations on locked (generated) regions in `.py` files
- `Forge: Generate` command (Ctrl+Shift+P)
- Status bar shows the active manifest layer and job name
