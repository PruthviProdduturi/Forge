# CLAUDE.md — Forge

## Who

Pruthvi Prodduturi — Engineering Lead & Platform Architect. Types fast with typos; parse intent, don't flag them. Prefers terse responses — no trailing summaries. No Co-Authored-By in commits.

## What is Forge

Forge is an **open-source core data engineering platform** built on Azure. It ingests, transforms, validates, and serves governed data through a medallion lakehouse (bronze → silver → gold → downstream consumers).

## Architecture

**Dual-cluster AKS design** — compute and orchestration are independent:

| Cluster | Components |
|---------|-----------|
| `forge-compute` | Spark Operator 2.5, Spark Connect 4.1.1, Trino 480, Hive Metastore 4.0 |
| `forge-orchestration` | Airflow 3.1.8, DQ Framework, Azure Monitor, Managed Grafana, Developer Portal |

**Lakehouse**: ADLS Gen2 with hierarchical namespace. Containers: `bronze`, `silver`, `gold`, `sandbox` (28-day TTL), `code` (jobs, DQ rules, checkpoints). All Delta Lake format.

**Auth**: AAD workload identity (OIDC) everywhere. No static secrets. Managed identities for all pods.

## Tech Stack

- **IaC**: Bicep only. Never suggest Terraform.
- **K8s**: Helm charts for all platform components
- **Compute**: Spark 4.1.1, Trino 480, Delta Lake 4.1
- **Orchestration**: Airflow 3.1.8, OpenLineage/Purview
- **Portal frontend**: Next.js 14 (App Router), TypeScript, React, CSS vars (`--forge-primary`, `--forge-light`)
- **Portal backend**: FastAPI (Python), AAD auth
- **SDK**: Python packages (`forge_sdk`, `forge_dq`) baked into Spark image. TypeScript CLI (`forge init`, `forge generate`)
- **VS Code extension**: Manifest editor with grey-region business logic lock

## Repo Layout

```
Forge/
├── infra/
│   ├── bicep/             # Azure resources (AKS, ADLS, KV, networking, Postgres, ACR)
│   ├── helm/              # Helm charts (compute/ + orchestration/)
│   ├── docker/            # Dockerfiles for all 7 images
│   └── scripts/           # forge-up.sh (8-phase deploy), sync-jobs.sh, portal-dev.sh
├── portal/
│   ├── frontend/          # Next.js app
│   └── backend/           # FastAPI API
├── orchestration/
│   ├── airflow/           # DAGs, operators, plugins
│   └── spark-jobs/        # Spark job Python files
├── sdk/
│   ├── python/            # forge_sdk + forge_dq + forge_catalog
│   ├── cli/               # TypeScript CLI for codegen from .forge.ts manifests
│   └── vscode-extension/
├── docs/                  # Architecture docs, impl guides, runbooks
├── STATUS.md              # Release tracking
├── ARCHITECTURE.md        # Platform architecture overview
└── README.md
```

## Portal Pages

`/` `/pipelines` `/datasets` `/datasources` `/lineage` `/dq` `/cost` `/observability` `/metadata` `/architecture` `/docs` `/about` `/status` `/settings`

## Deploy

```bash
# Full deploy (8 phases: infra → secrets → postgres → k8s-secrets → images → compute → orch → sync)
bash infra/scripts/forge-up.sh --env dev --git-pat <PAT>

# Bicep only
az deployment sub create --location <region> \
  --template-file infra/bicep/environments/dev/main.bicep \
  --parameters @infra/bicep/environments/dev/main.bicepparam \
  --name forge-dev
```

## Developer Workflow

Pipelines are defined in `.forge.ts` manifests → `forge generate` produces Spark job + Airflow DAG + DQ rules. `sync-jobs.sh` uploads to ADLS. DAG authors use `ForgeSparkOperator` and `ForgeDqGateOperator` — never write SparkApplication YAML directly.

## Preferences (for Claude)

- Keep responses short. No trailing summaries.
- Don't add docstrings/comments to code you didn't change.
- Parse typos by intent.
- Bicep for IaC, never Terraform.
- Check STATUS.md before suggesting next implementation steps.
