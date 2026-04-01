# Forge Developer Portal

Web UI for the Forge data platform. FastAPI backend + Next.js 15 frontend, deployed to the orchestration AKS cluster.

**Public URL:** `http://forge-portal-{alias}-{env}.{location}.cloudapp.azure.com`

## Architecture

```
Browser
  └── ingress-nginx (public LoadBalancer)
        ├── /        → portal-web  (Next.js,  port 3000)
        └── /api/*   → portal-api  (FastAPI,   port 8080)
```

`portal-api` talks to:

- **Airflow webserver** — in-cluster: `airflow-webserver.airflow.svc.cluster.local:8080`
- **Compute cluster** — Azure Management API (list `SparkApplication` CRDs)
- **Azure Key Vault** — runtime config: auth provider, AAD credentials

## Directory Layout

```
portal/
  backend/
    app/
      api/          FastAPI route handlers (auth.py, platform.py, status.py)
      core/         Config, auth providers, session management
      services/     Business logic called by route handlers
      main.py       FastAPI app entry point
    requirements.txt
  frontend/
    app/            Next.js App Router pages
    .dockerignore
```

Dockerfiles are in `infra/docker/portal-api/` and `infra/docker/portal-web/`.

## Key API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness probe |
| `GET` | `/api/status` | Cluster health (Spark, Trino, Airflow) |
| `GET` | `/api/pipelines` | List Airflow DAGs with last run status |
| `POST` | `/api/auth/login` | Login (local auth mode) |
| `POST` | `/api/auth/logout` | Logout |

## Auth Model

| Mode | How it works |
|---|---|
| `local` (default) | Username/password stored in-memory — dev only |
| `azure_ad` | Azure AD SSO via MSAL |

Switch modes via the portal Settings page or set the Key Vault secret `forge-portal-auth-provider` to `azure_ad`.

Authorization uses Azure RBAC app roles — no separate user database.

**Default credentials (local mode):** `admin` / `admin` — change in Settings after first login.

## Local Development

```bash
bash infra/scripts/portal-dev.sh           # frontend + backend
bash infra/scripts/portal-dev.sh api       # backend only  (FastAPI on :8080)
bash infra/scripts/portal-dev.sh portal    # frontend only (Next.js on :3001)
```

**Prerequisites:** Node.js 20+, Python 3.11+. Copy `portal/backend/.env.example` to `.env` before starting.

No AKS access required — the dev script stubs out cluster calls.

## Deployment

The portal is deployed as part of the full platform bring-up:

```bash
bash infra/scripts/forge-up.sh --env dev --alias <your-alias> ...
```

Portal is deployed as part of `forge-up.sh` phase [6/7]. To redeploy portal only:

```bash
bash infra/scripts/forge-up.sh --env dev --alias <your-alias> \
  --skip-infra --skip-sync
```

Helm chart: [`infra/helm/orchestration/portal/`](../infra/helm/orchestration/portal/).
