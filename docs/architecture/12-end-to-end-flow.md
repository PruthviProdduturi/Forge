# Forge — End-to-End Flow Architecture

> **Status:** Current
> **Purpose:** Complete walkthrough of how every component connects — from a developer writing a TypeScript manifest to data landing in the Gold layer and being queryable.

[![Apache Spark](https://img.shields.io/badge/Apache%20Spark-E25A1C?style=flat-square&logo=apachespark&logoColor=white)](https://spark.apache.org) [![Trino](https://img.shields.io/badge/Trino-DD00A1?style=flat-square&logo=trino&logoColor=white)](https://trino.io) [![Airflow](https://img.shields.io/badge/Airflow-017CEE?style=flat-square&logo=apacheairflow&logoColor=white)](https://airflow.apache.org) [![Delta Lake](https://img.shields.io/badge/Delta%20Lake-003366?style=flat-square&logo=delta&logoColor=white)](https://delta.io)

---

## Repository Layout

Forge uses a **two-repo model in production**. Everything in one repo during development — split at the point where the platform is stable.

```
┌─────────────────────────────────────────────────────────┐
│  Platform Repo  (platform team owns)                    │
│                                                         │
│  sdk/                                                   │
│  ├── python/                                            │
│  │   ├── forge_sdk/   ← ForgeJob, forge_session, paths  │
│  │   └── forge_dq/    ← DQ framework (@track, runner)   │
│  └── cli/             ← forge generate / forge init     │
│                                                         │
│  infra/                                                 │
│  ├── bicep/           ← AKS, ADLS, KV, ACR, networking  │
│  ├── helm/            ← Spark, Trino, Airflow charts     │
│  └── docker/          ← Spark, Trino, Airflow images     │
│                                                         │
│  publishes → forge_lib.zip to ADLS code/lib/ on release │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Pipelines Repo  (data engineers own)                   │
│                                                         │
│  src/                                                   │
│  ├── spark/jobs/      ← .forge.ts manifests + .py jobs  │
│  ├── airflow/dags/    ← generated DAG files             │
│  └── dq/rules/        ← DQ YAML rules (generated once)  │
│                                                         │
│  scripts/                                               │
│  └── sync-jobs.sh     ← scaffold → upload → git push    │
└─────────────────────────────────────────────────────────┘
```

> During development both repos are the same git repo. The `examples/` directory is the pipelines repo equivalent.

---

## System Map

```
╔═══════════════════════════════════════════════════════════════════════╗
║  DEVELOPER ENVIRONMENT                                                ║
║                                                                       ║
║  VS Code                                                              ║
║  ├── Forge Extension                                                  ║
║  │   ├── forge init   → creates .forge.ts manifest stub              ║
║  │   ├── forge gen    → re-scaffolds .py, preserves BL block         ║
║  │   └── Grey regions in .py → visual lock on non-editable zones     ║
║  │                                                                    ║
║  ├── .forge.ts manifest  ← data engineer writes this                 ║
║  │   (schedule, source, DQ rules, resources, partition)              ║
║  │                                                                    ║
║  └── .py job (BL block only)  ← data engineer writes this            ║
║      (everything else is regenerated automatically)                   ║
╚════════════════════╤══════════════════════════════════════════════════╝
                     │  commit + PR + merge
                     ▼
╔════════════════════════════════════════════════════════════════════════╗
║  SYNC PIPELINE  (sync-jobs.sh — runs on merge to main)                ║
║                                                                        ║
║  1. git diff since last deploy → changed .forge.ts files only         ║
║  2. forge generate → re-scaffold .py (preserve BL), DAG, DQ YAML     ║
║  3. Build forge_lib.zip from sdk/python/forge_sdk/ + forge_dq/        ║
║     (only when sdk/python/ changed)                                    ║
║                                                                        ║
║  ADLS uploads (authenticated via workload identity):                  ║
║  ├── code/spark/jobs/{name}.py       ← Spark job entry point         ║
║  ├── code/lib/forge_lib.zip          ← shared library (if changed)   ║
║  └── code/dq/rules/{name}.yaml      ← DQ rules                       ║
║                                                                        ║
║  Git push:                                                             ║
║  └── src/airflow/dags/{ingestion|transformation}/  ← Airflow picks   ║
║      up within 30 seconds via git-sync                                 ║
║                                                                        ║
║  Deployment state → ADLS state/:                                       ║
║  ├── last_deploy_{env}.json   ← commit SHA for next incremental run   ║
║  └── deployments_{env}.jsonl ← append-only history log               ║
╚════════════════════════════════════════════════════════════════════════╝
                     │
     ┌───────────────┴──────────────────┐
     │                                  │
     ▼                                  ▼
┌────────────────────┐      ┌───────────────────────────────────────┐
│  ADLS Gen2         │      │  ORCHESTRATION CLUSTER (AKS)          │
│                    │      │                                        │
│  code/             │      │  Airflow Scheduler (x2 HA)            │
│  ├── spark/jobs/   │      │  ├── git-sync → src/airflow/dags/     │
│  ├── lib/          │      │  ├── KubernetesExecutor                │
│  └── dq/rules/     │      │  └── Key Vault secrets backend        │
│                    │      │                                        │
│  bronze/           │      │  SparkKubernetesOperator submits CRD   │
│  silver/           │      │  → COMPUTE CLUSTER                    │
│  gold/             │      │                                        │
│  state/            │      └───────────────────────────────────────┘
└────────────────────┘
```

---

## Phase 1 — Developer Writes a Pipeline

```
Developer opens VS Code
        │
        │  forge init --name nyc_taxi_silver --layer silver
        │  → creates: src/spark/jobs/nyc_taxi_silver.forge.ts
        ▼
Edit nyc_taxi_silver.forge.ts
        │
        │  Define: schedule, source, partition column, DQ rules,
        │          resources, triggers, params
        │
        │  forge generate --job nyc_taxi_silver
        ▼
Generated output (src/):
        ├── spark/jobs/nyc_taxi_silver.py          ← scaffold with BL stub
        ├── airflow/dags/transformation/
        │   └── nyc_taxi_silver_dag.py             ← fully managed
        └── dq/rules/nyc_taxi_silver.yaml          ← written once, then yours

        │
        │  Developer edits ONLY the BL block in nyc_taxi_silver.py:
        │
        │  # ── FORGE:BUSINESS_LOGIC:START ──
        │  df = (
        │      raw
        │      .filter(F.col("pickup_datetime").isNotNull())
        │      .withColumn("trip_duration_min", ...)
        │      ...
        │  )
        │  # ── FORGE:BUSINESS_LOGIC:END ──
        │
        │  Everything else in .py is locked — regenerated on next
        │  forge generate without touching the BL block.
        ▼
git commit + PR → review → merge to main
```

---

## Phase 2 — sync-jobs.sh Deploys to Airflow + ADLS

```
sync-jobs.sh triggered (CI/CD on merge, or manual)
        │
        │  1. Download ADLS state/last_deploy_{env}.json
        │     → reads last deployed commit SHA
        │
        │  2. git diff <last_commit>...HEAD -- src/spark/jobs/*.forge.ts
        │     → finds only changed manifests (incremental by default)
        │
        │  For each changed manifest:
        │  3. forge generate --job {name}
        │     → regenerates .py (business logic preserved via BL sentinels)
        │     → regenerates DAG (fully managed)
        │     → skips DQ YAML if it already exists (yours to extend)
        │
        │  4. If sdk/python/ changed since last deploy:
        │     zip forge_sdk/ forge_dq/ → forge_lib.zip
        │     az storage blob upload → ADLS code/lib/forge_lib.zip
        │
        │  5. az storage blob upload:
        │     → ADLS code/spark/jobs/{name}.py
        │     → ADLS code/dq/rules/{name}.yaml
        │
        │  6. git add + commit + push DAG files
        │     → Airflow git-sync picks up within 30 seconds
        │
        │  7. Write state to ADLS:
        │     state/last_deploy_{env}.json   (updated commit SHA)
        │     state/deployments_{env}.jsonl  (deployment log line appended)
        ▼
ADLS state/deployments_dev.jsonl:
  {"deploy_id":"deploy-20260401T120000Z-d9f1100a","commit":"d9f1100a...","env":"dev",
   "jobs":"nyc_taxi_silver","lib_rebuilt":false,"dag_push":true}
```

---

## Phase 3 — Airflow Triggers the Job

```
Airflow Scheduler
        │
        │  DAG: nyc_taxi_silver
        │  Schedule: triggered by nyc_taxi_bronze (TriggerDagRunOperator)
        │
        │  1. Task pod created (KubernetesExecutor — ephemeral, 1 per task)
        │  2. CSI driver mounts Key Vault secrets
        │  3. OpenLineage emits START to Purview
        │
        │  4. SparkKubernetesOperator submits SparkApplication CRD:
        ▼
SparkApplication CRD (compute cluster, namespace: spark-jobs)
        │
        │  mainApplicationFile:
        │    abfss://code@{storage}.dfs.core.windows.net/spark/jobs/nyc_taxi_silver.py
        │
        │  sparkConf:
        │    spark.submit.pyFiles:
        │      abfss://code@{storage}.dfs.core.windows.net/lib/forge_lib.zip
        │
        │  envFrom:
        │    forge-platform-config (ConfigMap)  ← FORGE_ENV, FORGE_STORAGE_ACCOUNT
        │    PARTITION_DATE: {{ data_interval_start.strftime('%Y-%m-%d') }}
        ▼
Spark Operator launches pods
        │
        │  Driver pod:
        │  ├── pulls nyc_taxi_silver.py from ADLS (mainApplicationFile)
        │  └── pulls forge_lib.zip from ADLS (spark.submit.pyFiles)
        │
        │  Executor pods (spot, auto-scaled):
        │  └── forge_lib.zip distributed automatically by Spark
        │      → forge_sdk and forge_dq available on all executors
        ▼
nyc_taxi_silver.py runs
        │
        │  NycTaxiSilver().execute()
        │
        │  ┌─────────────────────────────────────────────────────┐
        │  │  setup()                                            │
        │  │  ├── _tracker_exists()  →  check ADLS tracker path  │
        │  │  ├── If tracker found and RESTATE=false:            │
        │  │  │     raise SystemExit(0)  ← idempotent skip       │
        │  │  └── If RESTATE=true: log + proceed                 │
        │  │                                                     │
        │  │  run()                                              │
        │  │  ├── SOURCE (locked):                               │
        │  │  │     raw = spark.read.delta(self.bronze(...))     │
        │  │  │                                                  │
        │  │  ├── BUSINESS LOGIC (editable):                     │
        │  │  │     df = raw.filter(...).withColumn(...)  ← yours│
        │  │  │                                                  │
        │  │  └── WRITE (locked):                               │
        │  │       row_count guard (skip if 0 rows)              │
        │  │       stamp __date = "01_04_2026_00"                │
        │  │       @track DQ gate (fail_fast if critical)        │
        │  │       df.write.delta.saveAsTable(...)               │
        │  │       write tracker.json to ADLS                    │
        │  └─────────────────────────────────────────────────────┘
        ▼
ADLS silver/nyc/taxi/trips/
        │
        │  Delta table partitioned by __date
        │  Tracker: silver/nyc/taxi/trips/_tracker/01_04_2026_00/tracker.json
        │           {"status": "success", "rows_written": 847291, ...}
        │
        │  OpenLineage COMPLETE → Purview
        │    input:  bronze/nyc/taxi   (schema + row count)
        │    output: silver/nyc_taxi_trips  (schema + row count + DQ facet)
        │
        │  SparkApplication → COMPLETED
        │  Airflow task → SUCCESS
        │  Triggers downstream: nyc_taxi_gold (TriggerDagRunOperator)
```

---

## Phase 4 — Data is Queryable

```
silver/nyc_taxi_trips is available to consumers:

  ┌────────────────────────────────────────────────────────────┐
  │  Trino SQL (portal query editor or direct client)          │
  │  SELECT taxi_type, COUNT(*) AS trips,                      │
  │         AVG(trip_duration_min) AS avg_duration             │
  │  FROM silver.nyc_taxi_trips                                │
  │  WHERE __date = '01_04_2026_00'                            │
  │  GROUP BY taxi_type                                        │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │  Spark Connect (data science, dev only)                    │
  │  spark = SparkSession.builder.remote("sc://10.4.0.10:15002")│
  │  df = spark.read.format("delta")                           │
  │       .load("abfss://silver@.../nyc/taxi/trips/")          │
  └────────────────────────────────────────────────────────────┘
```

---

## ADLS Storage Layout

```
ADLS Gen2  (single storage account per environment)
│
├── code/                   ← Spark job artefacts (deployed by sync-jobs.sh)
│   ├── spark/jobs/
│   │   ├── nyc_taxi_bronze.py
│   │   ├── nyc_taxi_silver.py
│   │   └── nyc_taxi_gold.py
│   ├── lib/
│   │   └── forge_lib.zip   ← forge_sdk + forge_dq shared library
│   └── dq/rules/
│       ├── nyc_taxi_silver.yaml
│       └── nyc_taxi_gold.yaml
│
├── state/                  ← Deployment tracking (written by sync-jobs.sh)
│   ├── last_deploy_dev.json
│   └── deployments_dev.jsonl
│
├── bronze/                 ← Raw data (Delta, immutable)
│   └── nyc/taxi/
│       └── __year=2026/__month=4/__day=1/__hour=0/
│           ├── part-0000.snappy.parquet
│           └── _tracker/2026/4/1/0/tracker.json
│
├── silver/                 ← Cleaned data (Delta, DQ-validated)
│   └── nyc/taxi/trips/
│       └── __date=01_04_2026_00/
│           ├── part-0000.snappy.parquet
│           └── _tracker/01_04_2026_00/tracker.json
│
└── gold/                   ← Business-ready (Delta, Z-ORDER optimised)
    └── nyc/taxi/trips/
        └── __date=01_04_2026_00/
```

> **No second ADLS needed.** The `code/` and `state/` containers live in the same ADLS account as the lakehouse. All access is via workload identity — no keys, no SAS tokens.

---

## What Changes Between Dev and Prod

| Concern | Dev | Prod |
|---|---|---|
| Repos | Single mono-repo (`examples/` = pipelines) | Two repos: platform + pipelines |
| ADLS | `forgeadls{alias}dev` | `forgeadls{alias}prod` |
| Storage account env var | `FORGE_STORAGE_ACCOUNT=forgeadlsprproddudev` | Set per-environment in CI |
| Spark Connect | Available (dev only) | Not deployed |
| sync-jobs.sh target | `FORGE_ENV=dev` | `FORGE_ENV=prod` |
| forge_lib.zip location | `code/lib/forge_lib.zip` in dev ADLS | `code/lib/forge_lib.zip` in prod ADLS |
| Airflow git-sync | Points to same repo, `src/airflow/dags/` | Points to pipelines repo, `src/airflow/dags/` |

---

## Observability During a Pipeline Run

```
Airflow task pod   → Azure Monitor (task_instance_state, dag_run_duration)
Spark Driver/Execs → Azure Monitor (executor count, task duration, GC time)
Trino coordinator  → Azure Monitor (active queries, query duration P95)
All pods           → Log Analytics (structured JSON with dag_id, run_id, task_id)
OpenLineage events → Microsoft Purview (lineage graph, DQ facets)
DQ results         → Delta table silver/_platform/dq_results/ (append)
Trackers           → ADLS {layer}/_tracker/ (idempotency + downstream gating)

Grafana Platform Overview (live during a run):
  Pipeline Health:   ████████████████████ 100% (1 running, 0 failed)
  DQ Pass Rate 7d:   ████████████████████  99.8%
  Active Spark Jobs: ██░░░░░░░░░░░░░░░░░░  1
  Gold Freshness:    ████████████████████  PASS (all datasets within SLA)
  forge_lib.zip:     v1.2.3 — deployed 2026-04-01 (last SDK release)
```

---

## DAG Conventions

| Layer | Folder | Example DAG id |
|---|---|---|
| Bronze ingestion | `src/airflow/dags/ingestion/` | `nyc_taxi_bronze` |
| Silver transform | `src/airflow/dags/transformation/` | `nyc_taxi_silver` |
| Gold publish | `src/airflow/dags/transformation/` | `nyc_taxi_gold` |

DAG files are **fully managed** — never edit them directly. All DAG configuration (schedule, retries, SLA, triggers) comes from the `.forge.ts` manifest. Re-run `forge generate` to update.
