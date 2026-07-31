# CLAUDE.md — Forge

## Who

Pruthvi Prodduturi — Engineering Lead & Platform Architect. Types fast with typos; parse intent, don't flag them. Prefers terse responses — no trailing summaries, no over-explaining. Make changes and confirm in one line. Strong product instincts; iterates visually in browser.

## What is Forge

Forge is the **core data engineering platform** — an internal Azure-based system that ingests, transforms, validates, and serves governed data through a medallion lakehouse (bronze → silver → gold → downstream consumers).

Previously called "Stratum" (rebranded 2026-03-24 due to Hitachi Vantara conflict). Always use "Forge" branding.

## Architecture

**Dual-cluster AKS design** — compute and orchestration are independent:

| Cluster | Components |
|---------|-----------|
| `forge-compute` | Spark Operator 2.5, Spark Connect 4.1.1, Trino 480, Hive Metastore 4.0 |
| `forge-orchestration` | Airflow 3.1.8, DQ Framework, Azure Monitor, Managed Grafana, Developer Portal |

**Lakehouse**: ADLS Gen2 with hierarchical namespace. Containers: `bronze`, `silver`, `gold`, `sandbox` (28-day TTL), `code` (jobs, DQ rules, checkpoints). All Delta Lake format.

**Auth**: AAD workload identity (OIDC) everywhere. No static secrets. Managed identities for all pods.

## Tech Stack

- **IaC**: Bicep only. Terraform was removed. Never suggest Terraform.
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
│   ├── bicep/          # Azure resources (AKS, ADLS, KV, networking, Postgres, ACR)
│   │   ├── modules/    # Reusable Bicep modules
│   │   └── environments/  # dev/ and prod/ parameter files
│   ├── helm/           # Helm charts (compute/ + orchestration/)
│   ├── docker/         # Dockerfiles for all 7 images
│   └── scripts/        # forge-up.sh (8-phase deploy), sync-jobs.sh, portal-dev.sh
├── portal/
│   ├── frontend/       # Next.js app — all pages scaffolded
│   └── backend/        # FastAPI — auth, pipelines, datasets, dq, lineage, cost, status
├── orchestration/
│   ├── airflow/        # DAGs, operators, plugins
│   └── spark-jobs/     # Spark job Python files
├── sdk/
│   ├── python/         # forge_sdk + forge_dq + forge_catalog packages
│   ├── cli/            # TypeScript CLI for codegen from .forge.ts manifests
│   └── vscode-extension/
├── docs/               # 15 architecture docs, 6 impl guides, runbooks
├── STATUS.md           # Single source of truth for release tracking
├── ARCHITECTURE.md     # Platform architecture overview
└── README.md           # Project overview with quick start
```

## Portal Pages

`/` (home), `/pipelines`, `/datasets`, `/datasources`, `/lineage`, `/dq`, `/cost`, `/observability`, `/metadata`, `/architecture`, `/docs`, `/about`, `/status`, `/settings`

## Deploy

```bash
# Full deploy (8 phases: infra → secrets → postgres → k8s-secrets → images → compute → orch → sync)
bash infra/scripts/forge-up.sh --env dev --git-pat <PAT>

# Skip already-done phases
bash infra/scripts/forge-up.sh --env dev --git-pat <PAT> --skip-infra --skip-pg-grants

# Bicep only
az deployment sub create --location northcentralus \
  --template-file infra/bicep/environments/dev/main.bicep \
  --parameters @infra/bicep/environments/dev/main.bicepparam \
  --name forge-dev
```

**Dev portal URL**: `http://forge-portal-prproddu-dev.northcentralus.cloudapp.azure.com`

## Known Issues

- `az postgres flexible-server execute` hangs against private endpoint → use `--skip-pg-grants`, run grants from inside cluster pod
- S360 IP tagging: add `FirstPartyUsage=/NonProd` tag immediately post-deploy, don't modify after
- SDK uses `setuptools.build_meta` backend (not `legacy`)

## Developer Workflow

Pipelines are defined in `.forge.ts` manifests → `forge generate` produces Spark job + Airflow DAG + DQ rules. `sync-jobs.sh` uploads to ADLS. DAG authors use `ForgeSparkOperator` and `ForgeDqGateOperator` — never write SparkApplication YAML directly.

## Sibling Projects (same machine, D:\Repos\PruthviProdduturi\)

| Repo | What |
|------|------|
| **LoomX** | Self-hosted analytics platform (Superset competitor). Next.js 15 + FastAPI. Fabric SQL, Azure AD auth. Monorepo (pnpm + Turborepo). |
| **ARVANA** | Multi-model consensus stock prediction platform. Python 3.12 + Next.js 15. Real-time quant, macro-gated trades. |
| **KentPokemonStore** | .NET Pokemon store app (older project). |
| **PruthviProdduturi** | GitHub profile README. |
| **PruthviProdduturi.github.io** | Personal site / resume hosting. |
| **arvana-pages** | GitHub Pages for ARVANA landing page. |
| **claude-memory** | Cross-machine Claude Code memory sync repo. |
| **dotfiles** | Windows dev box setup — bootstrap.ps1, git config, shell profile, Claude memory sync. |
| **interview-prep** | Staff/Principal interview prep (Google, Meta, Snowflake). Started 2026-07-08. |

## Preferences (for Claude)

- Keep responses short. No trailing summaries.
- Don't add docstrings/comments to code you didn't change.
- Parse typos by intent — don't ask for clarification on obvious meaning.
- Bicep for IaC, never Terraform.
- Check STATUS.md before suggesting next implementation steps.
