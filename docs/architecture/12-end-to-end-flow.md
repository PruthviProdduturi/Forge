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
│  publishes → forge-sdk + forge-dq wheels to Azure Artifacts │
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
║  3. ADLS uploads (authenticated via workload identity):               ║
║  ├── code/spark/jobs/{name}.py       ← Spark job entry point         ║
║  └── code/dq/rules/{name}.yaml      ← DQ rules                       ║
║  NOTE: forge-sdk + forge-dq are baked into the Spark image.          ║
║        SDK changes → Spark image rebuild (forge-up.sh Phase 5).      ║
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
        │          resources, triggeredBy, endDate, params
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
        │  4. az storage blob upload:
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
   "jobs":"nyc_taxi_silver","dag_push":true}
```

---

## Phase 3 — Airflow Triggers the Job

```
Airflow Scheduler
        │
        │  DAG: nyc_taxi_silver  (schedule: "0 2 * * *")
        │
        │  ExternalTaskSensor: wait_for_nyc_taxi_bronze
        │  ├── external_dag_id: nyc_taxi_bronze
        │  ├── external_task_id: None  (waits for entire upstream DAG)
        │  ├── mode: reschedule       (frees task pod between checks)
        │  ├── poke_interval: 120s
        │  └── timeout: 8h
        │
        │  Sensor passes when nyc_taxi_bronze DAG run for same logical date
        │  reaches SUCCESS. Upstream DAG is unmodified — it does not know
        │  about consumers. New consumers add triggeredBy without touching
        │  the upstream.
        │
        │  1. Task pod created (KubernetesExecutor — ephemeral, 1 per task)
        │  2. CSI driver mounts Key Vault secrets
        │  3. OpenLineage emits START event
        │
        │  4. ForgeSparkOperator builds SparkApplication CRD internally
        │     and submits it to the compute cluster:
        ▼
SparkApplication CRD (compute cluster, namespace: spark-jobs)
        │
        │  mainApplicationFile:
        │    abfss://code@{storage}.dfs.core.windows.net/spark/jobs/nyc_taxi_silver.py
        │
        │  envFrom:
        │    forge-platform-config (ConfigMap)  ← FORGE_ENV, FORGE_STORAGE_ACCOUNT
        │    PARTITION_DATE: {{ ds }}
        │    PARTITION_HOUR: 0
        ▼
Spark Operator launches pods
        │
        │  Driver pod:
        │  ├── pulls nyc_taxi_silver.py from ADLS (mainApplicationFile)
        │  └── forge_sdk + forge_dq already installed in image (no ADLS download)
        │
        │  Executor pods (spot, auto-scaled):
        │  └── same image — forge_sdk + forge_dq available immediately
        ▼
nyc_taxi_silver.py runs
        │
        │  NycTaxiSilver().execute()
        │
        │  ┌─────────────────────────────────────────────────────┐
        │  │  setup()                                            │
        │  │  ├── _tracker_exists()  →  check ADLS tracker path  │
        │  │  └── If tracker found: raise SystemExit(0)          │
        │  │       ← idempotent skip on Airflow retry            │
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
        │  │       df.write.delta.saveAsTable(...)               │
        │  │       write tracker.json to ADLS                    │
        │  └─────────────────────────────────────────────────────┘
        │
        │  SparkApplication → COMPLETED
        │  ForgeSparkOperator task → SUCCESS
        ▼
ForgeDqGateOperator task
        │
        │  Submits forge_dq_gate.py as a SparkApplication
        │  RULES_PATH = abfss://code@{storage}/dq/rules/nyc_taxi_silver.yaml
        │
        │  forge_dq_gate.py:
        │  ├── downloads rules YAML from ADLS
        │  ├── filters to __date = "01_04_2026_00"  (silver/gold partition key)
        │  ├── runs DQRunner (profiling + rule checks + anomaly)
        │  ├── writes DQ results to Delta
        │  └── emits OpenLineage DQ facet
        │
        │  Critical failure → task FAILED → downstream tasks UPSTREAM_FAILED
        ▼
ADLS silver/nyc/taxi/trips/
        │
        │  Delta table partitioned by __date
        │  Tracker: silver/nyc/taxi/trips/_tracker/01_04_2026_00/tracker.json
        │           {"status": "success", "rows_written": 847291, ...}
        │
        │  OpenLineage COMPLETE event emitted
        │    input:  bronze/nyc/taxi   (schema + row count)
        │    output: silver/nyc_taxi_trips  (schema + row count + DQ facet)
        │
        │  nyc_taxi_gold DAG (if it exists) has its own ExternalTaskSensor
        │  pointing at nyc_taxi_silver — it wakes up when this DAG succeeds.
        │  The silver DAG does not know about or trigger gold.
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
| Storage account env var | `FORGE_STORAGE_ACCOUNT=forgeadls{alias}dev` | Set per-environment in CI |
| Spark Connect | Available (dev only) | Not deployed |
| sync-jobs.sh target | `FORGE_ENV=dev` | `FORGE_ENV=prod` |
| SDK distribution | forge-sdk + forge-dq baked into Spark image | Same — versioned wheels via Azure Artifacts |
| Airflow git-sync | Points to same repo, `src/airflow/dags/` | Points to pipelines repo, `src/airflow/dags/` |

---

## Observability During a Pipeline Run

```
Airflow task pod   → Azure Monitor (task_instance_state, dag_run_duration)
Spark Driver/Execs → Azure Monitor (executor count, task duration, GC time)
Trino coordinator  → Azure Monitor (active queries, query duration P95)
All pods           → Log Analytics (structured JSON with dag_id, run_id, task_id)
OpenLineage events → Portal lineage API (lineage graph, DQ facets)
DQ results         → Delta table silver/_platform/dq_results/ (append)
Trackers           → ADLS {layer}/_tracker/ (idempotency + downstream gating)

Grafana Platform Overview (live during a run):
  Pipeline Health:   ████████████████████ 100% (1 running, 0 failed)
  DQ Pass Rate 7d:   ████████████████████  99.8%
  Active Spark Jobs: ██░░░░░░░░░░░░░░░░░░  1
  Gold Freshness:    ████████████████████  PASS (all datasets within SLA)
  SDK version:       forge-sdk==1.0.0 forge-dq==1.0.0 (baked in Spark image)
```

---

## DAG Conventions

| Layer | Folder | Example DAG id |
|---|---|---|
| Bronze ingestion | `src/airflow/dags/ingestion/` | `nyc_taxi_bronze` |
| Silver transform | `src/airflow/dags/transformation/` | `nyc_taxi_silver` |
| Gold publish | `src/airflow/dags/transformation/` | `nyc_taxi_gold` |

DAG files are **fully managed** — never edit them directly. All DAG configuration (schedule, retries, endDate, triggeredBy) comes from the `.forge.ts` manifest. Re-run `forge generate` to update.
