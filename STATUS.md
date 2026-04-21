# Forge Platform — Release Status

> Last updated: 2026-04-17
> Branch: `user/PrProddu/StarRocks`
> Environment: `dev` (prod deferred until dev is stable)
> Deploy command: `bash infra/scripts/forge-up.sh --env dev --git-pat <PAT> --skip-infra --skip-pg-grants`

---

## Summary

| Phase | Status | Blocker |
|-------|--------|---------|
| Phase 1 — Infrastructure (Bicep) | 🔄 In Progress | forge-up.sh not yet completed end-to-end |
| Phase 2 — Platform Services (Compute, Orchestration, Portal) | 🔄 In Progress | Depends on Phase 1 |
| Phase 3 — Validation & Testing | 🔄 In Progress | Depends on Phase 2 |
| Phase 4 — Production Readiness | 📋 Planning | After dev smoke test passes |

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ Done | Complete and verified |
| 🔄 In Progress | Active work, not yet verified end-to-end |
| 📋 Planning | Not started, scoped and understood |
| ❌ Blocked | Blocked by a dependency |

---

## Phase 1 — Infrastructure

### Bicep (Azure Resources)

| Item | Status | Notes |
|------|--------|-------|
| AKS clusters — compute + orchestration, VNet, NSGs, route tables | ✅ Done | Two clusters: `aks-forge-compute-prproddu-dev`, `aks-forge-orchestration-prproddu-dev` |
| ADLS Gen2 — 5 containers: bronze, silver, gold, sandbox, code | ✅ Done | Checkpoints under `code/checkpoints/<pipeline_id>/` — no separate container |
| PostgreSQL — AAD-only auth, password auth disabled | ✅ Done | Airflow MI + HMS MI + platform admin group registered as AAD admins via Bicep |
| Managed identities — Spark, Trino, HMS, Airflow, Portal | ✅ Done | Workload identity (OIDC) for all pods — no static secrets |
| RBAC role assignments — ADLS, ACR pull, Key Vault | ✅ Done | Spark/Trino/HMS: Storage Blob Data Contributor; Portal: Key Vault Secrets User |
| ACR — private, public pull disabled, private endpoint | ✅ Done | `forgeacr{alias}.azurecr.io` |
| Key Vault — private endpoint, RBAC access model | ✅ Done | `kv-forge-{alias}-dev` |
| Private DNS zones — postgres, blob, dfs, ACR, Key Vault | ✅ Done | Linked to VNet; corpnet reachable via ExpressRoute |
| **Deployed to Azure (dev)** | 🔄 In Progress | forge-up.sh [1/8] — run with `--skip-infra` if already provisioned |

### Docker Images

| Item | Status | Notes |
|------|--------|-------|
| Spark 4.1.1 Dockerfile — Delta 4.1.0, Iceberg 1.10.1, ADLS driver, OpenLineage | ✅ Done | Build context is repo root (COPY sdk/python requires it) |
| Trino 480 Dockerfile | ✅ Done | |
| Airflow 3.1.8 Dockerfile | ✅ Done | |
| Hive Metastore Dockerfile | ✅ Done | |
| Portal API (FastAPI) Dockerfile | ✅ Done | |
| Portal Web (Next.js) Dockerfile | ✅ Done | |
| forge-sdk + forge-dq — proper `pyproject.toml` packages, baked into Spark image | ✅ Done | `setuptools.build_meta` backend; no zip, no pyFiles, no ADLS at job startup |
| SDK prod path — Azure Artifacts publish script | ✅ Done | `sdk/python/publish.sh` ready; Dockerfile has inline comment for feed URL swap |
| **All images built and pushed to ACR** | 🔄 In Progress | forge-up.sh [5/8] — all 7 images consolidated in one phase; `--skip-build` to skip |

---

## Phase 2 — Platform Services

### Scripts

| Item | Status | Notes |
|------|--------|-------|
| forge-up.sh — 8-phase single-command deploy | ✅ Done | Phases: infra → secrets → postgres → k8s secrets → images → compute → orch → sync |
| forge-up.sh — single config file (`dev.parameters.json`) | ✅ Done | `forge` section for runtime config; `parameters` section for Bicep ARM |
| forge-up.sh — AAD-only Postgres, no passwords | ✅ Done | Phase [3/8] uses engineer's AAD session; `--skip-pg-grants` to bypass if private endpoint hangs |
| forge-up.sh — Key Vault seeding (client ID, tenant ID from config) | ✅ Done | `forge.clientId` + `parameters.tenantId` read from params file |
| forge-up.sh — `--skip-pg-grants` flag | ✅ Done | Postgres grants done from inside cluster pod when private endpoint not reachable from laptop |
| sync-jobs.sh — DAG/job/DQ sync, incremental by git diff | ✅ Done | No forge_lib.zip — SDK is in image; syncs `.py` jobs + DQ YAML + DAGs only |
| portal-dev.sh — local portal dev without AKS | ✅ Done | Runs Next.js + FastAPI locally |
| **forge-up.sh end-to-end successful run** | 🔄 In Progress | Working through phases; currently at image build phase |

### Helm Charts

| Item | Status | Notes |
|------|--------|-------|
| Spark Operator (kubeflow/spark-operator) | ✅ Done | Manages SparkApplication CRDs in `spark-jobs` namespace |
| Spark Connect | ✅ Done | Interactive Spark from laptop via `forge_connect()`; dev-only |
| Hive Metastore | ✅ Done | PostgreSQL backend (AAD auth); Delta table registry for Trino |
| Trino 480 | ✅ Done | Delta connector via HMS; queries silver/gold Delta tables |
| Trino Auth Proxy | ✅ Done | IMDS managed identity → MSAL federated credential; S360-compliant, no client secrets |
| Airflow — git-sync + AAD token workload identity Postgres connection | ✅ Done | Init container fetches IMDS token; no password in connection string |
| Portal chart — FastAPI + Next.js, ingress, managed identity | ✅ Done | |
| ingress-nginx — public IP, DNS label, HTTP (dev) | ✅ Done | `http://forge-portal-{alias}-dev.northcentralus.cloudapp.azure.com` |
| **Charts deployed to clusters** | 🔄 In Progress | forge-up.sh [6/8] compute + [7/8] orchestration |

### SDK & CLI

| Item | Status | Notes |
|------|--------|-------|
| forge CLI (TypeScript) — DataPath schema, `forge generate`, `forge init` | ✅ Done | Scaffolds `.py` job + DAG + DQ YAML from `.forge.ts` manifest |
| Python SDK — `forge_sdk` (session, paths, ForgeJob, PlatformConfig) | ✅ Done | Package: `sdk/python/forge_sdk/` with `pyproject.toml` |
| Python SDK — `forge_dq` (`@track`, DQRunner, rules, anomaly, lineage) | ✅ Done | Package: `sdk/python/forge_dq/` with `pyproject.toml`; Airflow as optional dep |
| VS Code extension — forge manifest editor, grey-region BL lock | ✅ Done | |
| SDK distribution to Spark executors | ✅ Done | Baked into Spark image via `pip install`; no zip, no ADLS dependency at runtime |

### Compute

| Item | Status | Notes |
|------|--------|-------|
| Spark Connect deployed and reachable from laptop | 🔄 In Progress | Requires cluster up + kubeconfig + port-forward |
| Trino queryable — SELECT from silver / gold Delta tables | 🔄 In Progress | Requires HMS connected + Delta tables registered |
| Hive Metastore connected to PostgreSQL and Delta tables | 🔄 In Progress | Requires Postgres grants (Phase 3) and ADLS access |

### Orchestration

| Item | Status | Notes |
|------|--------|-------|
| Example DAGs — nyc_taxi bronze→silver→gold chain, forge_demo chain | ✅ Done | In `examples/src/airflow/dags/` |
| Airflow deployed + git-sync pulling DAGs from repo | 🔄 In Progress | git-sync polls every 30s; requires PAT (`--git-pat`) |
| DAG run end-to-end successfully | 🔄 In Progress | Blocked on Airflow deploy + Postgres grants |

### Portal

| Item | Status | Notes |
|------|--------|-------|
| FastAPI backend — platform status, auth, proxy endpoints | ✅ Done | |
| Next.js frontend — platform overview, component health, about page | ✅ Done | |
| Portal deployed and accessible via public URL | 🔄 In Progress | URL: `http://forge-portal-prproddu-dev.northcentralus.cloudapp.azure.com` |
| AAD SSO — currently local auth mode | 🔄 In Progress | Client ID + tenant ID now seeded to Key Vault; SSO config pending |

---

## Phase 3 — Validation & Testing

| Item | Status | Notes |
|------|--------|-------|
| Smoke test — NYC TLC ingest → bronze → silver → gold → Trino COUNT(*) | 🔄 In Progress | `--run-test` flag in forge-up.sh; requires all services up |
| Real dataset pipeline running on schedule via Airflow | 🔄 In Progress | After smoke test passes |
| Spark Connect usable from laptop (PySpark notebook → cluster) | 🔄 In Progress | Dev-only feature |
| Portal health checks all green | 🔄 In Progress | Blocked on portal deploy |
| Postgres grants verified (Airflow can connect) | 🔄 In Progress | `--skip-pg-grants` used; manual grant from cluster pod pending |

---

## Phase 4 — Production Readiness

| Item | Status | Notes |
|------|--------|-------|
| Prod Bicep parameters file (`prod.parameters.json`) | 📋 Planning | Mirror of `dev.parameters.json`; different alias, LRS→ZRS storage, larger node counts |
| Prod environment deployed | 📋 Planning | After dev smoke test passes |
| CI/CD pipeline — Azure DevOps | 📋 Planning | forge-up.sh phases as pipeline stages; PAT stored in pipeline secrets |
| Platform repo — extracted from DSEngCoreInfra | 📋 Planning | `git filter-repo --subdirectory-filter Forge` to preserve history |
| Pipelines repo — dedicated data engineer workspace | 📋 Planning | Airflow git-sync points directly here in prod (no copy step) |
| forge-sdk + forge-dq published to Azure Artifacts (PyPI feed) | 📋 Planning | `sdk/python/publish.sh` ready; Dockerfile needs feed URL + version pin |
| S360 IP tagging — AKS-managed static IPs | ✅ Done | Adding `FirstPartyUsage=/NonProd` works on first-time tag (no existing tags). Restriction only blocks modifying already-tagged IPs. Tag immediately post-deploy. |

---

## Documentation

| Item | Status | Notes |
|------|--------|-------|
| Architecture docs (15 documents) | ✅ Done | Codegen redesign: ForgeSparkOperator, ForgeDqGateOperator, ExternalTaskSensor, forge generate, endDate, triggeredBy, partition conventions, idempotency tracker, ADLS layout |
| Implementation guides (6 documents) | ✅ Done | sync-jobs.sh `--job` flag mandatory, forge_lib.zip removed throughout |
| Operational runbooks — Airflow down, DQ failure, ADLS connectivity, post-deploy | ✅ Done | DQ failure runbook updated for ForgeDqGateOperator architecture |
| Sub-READMEs — infra, portal, orchestration, sdk | ✅ Done | sdk/README.md: forge_lib.zip removed, SDK baked into image; sdk/cli/README.md: triggers field removed, SDK distribution corrected |
| Developer experience guide — DAG authoring sections rewritten | ✅ Done | ForgeSparkOperator, ForgeDqGateOperator, ExternalTaskSensor patterns; forge generate workflow |
| Prod sizing — orchestration cluster for 150+ jobs | ✅ Done | `docs/architecture/07-orchestration.md` §17; `prod.parameters.json` updated |
| STATUS.md — this file | ✅ Done | Single source of truth for release tracking |

---

## Known Issues & Decisions

| Issue | Resolution |
|-------|-----------|
| `az postgres flexible-server execute` hangs against private endpoint | Use `--skip-pg-grants`; run grants manually from inside cluster pod after deploy |
| S360 IP tagging on AKS-managed static IPs | Resolved — adding tag works on IPs with no existing tags; restriction only blocks re-tagging. Tag once post-deploy, don't modify after. |
| forge-sdk `setuptools.backends.legacy` build error | Fixed — correct backend is `setuptools.build_meta` |
| forge_lib.zip — not production-grade | Removed — SDK baked into Spark image as proper pip packages |
| Postgres schema grants for Airflow MI | Pending — `--skip-pg-grants` used; run from cluster pod once up |
