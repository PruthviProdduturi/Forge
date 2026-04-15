# Forge Developer Portal

Web UI for the Forge data platform. FastAPI backend + Next.js 15 frontend, deployed to the orchestration AKS cluster.

**Public URL:** `https://forge-portal-{env}.{location}.cloudapp.azure.com`

## Architecture

```
Browser
  └── ingress-nginx (public LoadBalancer)
        ├── /        → portal-web  (Next.js 15, port 3000)
        └── /api/*   → portal-api  (FastAPI,    port 8080)
```

`portal-api` talks to:

- **Airflow webserver** — in-cluster: `airflow-webserver.airflow.svc.cluster.local:8080`
- **Microsoft Purview** — lineage graph via Purview Atlas REST API
- **ADLS Gen2** — dataset discovery via HNS directory listing
- **Azure Cost Management** — resource-group cost aggregation
- **Azure Key Vault** — runtime config: auth credentials, API keys
- **PostgreSQL** — per-user theme preferences only (`user_preferences` table)

## Directory Layout

```
portal/
  backend/
    app/
      api/          FastAPI route handlers
                      auth.py, health.py, platform.py, status.py
                      pipelines.py, datasets.py, datasources.py
                      dq.py, lineage.py, cost.py, theme.py
      core/         Config (pydantic-settings), auth (JWT validation)
      services/     Business logic called by route handlers
      main.py       FastAPI app entry point
    requirements.txt
  frontend/
    app/            Next.js App Router pages
      page.tsx              /           Home dashboard
      about/page.tsx        /about      Platform overview
      pipelines/page.tsx    /pipelines  Airflow DAG monitor
      datasets/page.tsx     /datasets   ADLS dataset browser
      datasources/page.tsx  /datasources  Data source registry
      lineage/page.tsx      /lineage    Microsoft Purview lineage explorer
      dq/page.tsx           /dq         Data quality rule monitor
      cost/page.tsx         /cost       Azure cost attribution
      observability/page.tsx /observability  Grafana / Azure Monitor links
      status/page.tsx       /status     AKS cluster health
      settings/page.tsx     /settings   User preferences
      docs/                 /docs       Embedded platform docs
    components/     Shared UI: Layout, ThemeModal, PageLayout, ForgeLoader
    contexts/       ThemeContext (per-user accent colour)
    auth/           useAuth hook (MSAL loginPopup)
    .dockerignore
```

Dockerfiles are in `infra/docker/portal-api/` and `infra/docker/portal-web/`.

## Key API Endpoints

### Auth

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness probe (no auth) |
| `GET` | `/api/auth/provider` | Active auth provider config |
| `GET` | `/api/auth/me` | Current user claims (name, email, role) |

### Data

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pipelines` | List Airflow DAGs with last-run status |
| `GET` | `/api/pipelines/{dag_id}` | Single DAG detail |
| `GET` | `/api/pipelines/{dag_id}/runs` | Run history |
| `POST` | `/api/pipelines/{dag_id}/trigger` | Trigger a DAG run |
| `GET` | `/api/datasets` | All datasets across bronze/silver/gold |
| `GET` | `/api/datasets/{layer}` | Datasets filtered by layer |
| `GET` | `/api/dq/summary` | DQ summary across all datasets |
| `GET` | `/api/dq/{dataset_name}` | DQ rules + results for a dataset |
| `GET` | `/api/lineage/search?q=` | Search Purview entities |
| `GET` | `/api/lineage/{qualified_name}` | Lineage graph for an entity |
| `GET` | `/api/v1/datasources` | List registered data sources |
| `POST` | `/api/v1/datasources` | Register a new data source |
| `PUT` | `/api/v1/datasources/{id}` | Update a data source |
| `DELETE` | `/api/v1/datasources/{id}` | Remove a data source |
| `POST` | `/api/v1/datasources/test` | Test a data source connection |

### Platform

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cost/summary?days=N` | Subscription-level cost summary |
| `GET` | `/api/cost/by-rg?days=N` | Cost by resource group |
| `GET` | `/api/cost/by-pipeline` | Per-pipeline cost breakdown |
| `GET` | `/api/status` | AKS cluster state and workload probes |
| `GET` | `/api/v1/theme` | Current user's theme preference |
| `PUT` | `/api/v1/theme` | Save theme preference |
| `GET` | `/api/platform/auth-config` | Read auth config (Admin only) |
| `POST` | `/api/platform/auth-config` | Write auth config (Admin only) |

## Auth Model

The portal uses **Azure AD SSO via MSAL** (`loginPopup`). There is no local username/password mode in production.

| Item | Detail |
|---|---|
| Flow | MSAL `loginPopup` → AAD → session in `sessionStorage` |
| User ID | AAD `oid` claim (used as Postgres `user_preferences.user_id`) |
| Authorization | Azure AD App Roles — no separate user/role tables |
| Redirect URI type | SPA (not Web) in the AAD app registration |

## Local Development

```bash
bash infra/scripts/portal-dev.sh           # frontend + backend
bash infra/scripts/portal-dev.sh api       # backend only  (FastAPI on :8080)
bash infra/scripts/portal-dev.sh portal    # frontend only (Next.js on :3001)
```

**Prerequisites:** Node.js 20+, Python 3.11+. Copy `portal/backend/.env.example` to `.env` before starting.

When `PG_HOST` is not set, the theme API falls back to a local JSON file instead of Postgres.

## Deployment

```bash
bash infra/scripts/forge-up.sh --env dev --alias <your-alias> ...
```

Portal is deployed in phase 7 of `forge-up.sh`. To redeploy portal images only:

```bash
bash infra/scripts/forge-up.sh --env dev --alias <your-alias> \
  --skip-infra --skip-imports --skip-sync
```

Helm chart: [`infra/helm/orchestration/portal/`](../infra/helm/orchestration/portal/).
