# Forge — Developer Portal Architecture

> **Version:** 1.1
> **Status:** Active development
> **Audience:** Platform engineers, data engineers, frontend/backend contributors

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io)

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Component Architecture](#2-component-architecture)
3. [Authentication Flow](#3-authentication-flow)
4. [API Design](#4-api-design)
5. [Health Checks](#5-health-checks)
6. [Cost Section](#6-cost-section)
7. [Platform Status](#7-platform-status)
8. [Caching Strategy](#8-caching-strategy)
9. [Deployment](#9-deployment)
10. [Architecture Diagram](#10-architecture-diagram)

---

## 1. Purpose and Scope

The Developer Portal is an **engineering observability tool** — not an analytics dashboard. Its job is to give data engineers and platform operators a single place to observe the operational state of the Forge platform: what is running, what failed, whether services are healthy, and what compute resources cost.

### What the Portal Is

- A real-time platform health dashboard showing the status of Airflow, Trino, Spark Connect, and ADLS
- A cost attribution view showing Azure spend across the compute and orchestration resource groups
- An administrative interface for managing auth provider configuration (local vs Azure AD)
- A cluster status view showing pod and node pool state across both AKS clusters

### What the Portal Is Not

The Developer Portal is **not** a business intelligence tool, a chart builder, a report scheduler, or an end-user data product. Analysts query data through Trino or the Gold layer directly. The portal is for the platform team and data engineers who build and operate the platform.

### Primary Users

| User | What They Use the Portal For |
|------|------------------------------|
| Data Engineer | Check platform health, view Airflow/Trino/Spark status, monitor cost |
| Platform Operator | Investigate service degradation, audit compute spend, manage auth configuration |
| On-Call Engineer | Quickly determine whether a component is healthy or unreachable across clusters |

---

## 2. Component Architecture

The portal consists of two independently deployed pods:

- **`portal-web`** — Next.js 14 frontend, App Router, all pages are `"use client"` components, custom `useAuth` hook for auth state management, MSAL browser for Azure AD OIDC
- **`portal-api`** — FastAPI backend, Python 3.11, structlog for structured logging, pydantic-settings for configuration

Both pods run on the **`workerpool`** node pool of the `forge-orchestration` AKS cluster in the `portal` namespace.

### Frontend: `portal-web` (Next.js 14)

The frontend uses Next.js 14 with the App Router. All pages are Client Components (`"use client"`). Data fetching uses plain `useEffect` + `fetch` — there is no React Query or global state library.

Key client-side components:

- **`useAuth` hook** — manages auth state, token refresh, MSAL integration, and auto-detects the active auth provider by calling `GET /api/auth/provider` on startup
- **`ForgeLoader`** — revolving crosshair SVG animation with a shimmer progress bar, used for all loading states throughout the portal
- **`ThemeModal`** — per-user theme picker; theme preferences are stored in PostgreSQL (the only use of the database)
- **`Layout`** — header navigation with environment badge dropdown; health-aware status section on the homepage

Route structure:

```
app/
├── page.tsx           ← /   Home dashboard (health overview, env info)
├── about/
│   └── page.tsx       ← /about   Platform about page
├── cost/
│   └── page.tsx       ← /cost   Cost attribution view
└── status/
    └── page.tsx       ← /status   Cluster and workload status
```

### Backend: `portal-api` (FastAPI)

The FastAPI backend is a thin aggregation layer. It does not own platform data — it queries upstream systems (Airflow, Azure Cost Management, AKS Management API, ADLS) and assembles responses for the frontend. Its core responsibilities are:

1. **Authentication** — validate Bearer tokens on every request; auto-detect local JWT (HS256) vs Azure AD JWT (RS256) from the token's `alg` header
2. **Authorization** — enforce role-based access; Admin role required for platform configuration endpoints
3. **Health aggregation** — probe Airflow, Trino, Spark Connect, and ADLS in parallel; return tri-state results
4. **Cost aggregation** — query Azure Cost Management for two resource groups in parallel; serve with in-memory stale-while-revalidate cache
5. **Platform configuration** — read and write auth provider settings to Azure Key Vault (or local file override in dev)
6. **Cluster status** — query in-cluster Kubernetes API for orchestration cluster pod state; query Azure Resource API for compute cluster AKS state

### Data Sources

| Data Source | Purpose | Protocol |
|-------------|---------|----------|
| Airflow REST API | Health probe (`GET /api/v1/health` with basic auth) | HTTP/JSON |
| Trino coordinator | Health probe (`GET /v1/info`, no SQL executed) | HTTP |
| ADLS Gen2 | Health probe (`GET https://{account}.dfs.core.windows.net/`) | HTTPS |
| Spark Connect | Health probe (HTTP GET to configured URL) | HTTP |
| Azure Cost Management API | RG-scoped spend for compute + orchestration RGs | Azure SDK |
| Azure Resource API (AKS) | Compute cluster provisioning state, node pools | Azure SDK |
| Kubernetes in-cluster API | Pod phase and readiness in orchestration namespaces | kubernetes-client |
| Azure Key Vault | Auth provider config (provider, client ID, tenant ID) | Azure SDK |
| PostgreSQL | Per-user theme preferences only | SQLAlchemy |

---

## 3. Authentication Flow

The portal supports two auth modes, auto-detected at runtime. The active mode is controlled by Key Vault secrets and can be changed without a pod restart.

### Identity Model

- **Dual-mode**: local (HS256 JWT issued by the backend) or Azure AD (MSAL browser OIDC, RS256 JWT)
- The frontend calls `GET /api/auth/provider` on startup to determine which mode is active
- The backend `get_current_user` dependency inspects the `alg` header of the Bearer token to auto-detect the mode: `HS256` → local verification, `RS256` → JWKS validation
- User roles come from Azure AD App Roles (Admin, Engineer, Viewer); no database is used for users

### Auth Configuration in Key Vault

Auth config is stored in three Key Vault secrets:

| Secret Name | Values |
|-------------|--------|
| `forge-portal-auth-provider` | `"local"` or `"azure_ad"` |
| `forge-portal-aad-client-id` | Azure AD App Registration Client ID |
| `forge-portal-aad-tenant-id` | Azure AD Tenant ID |

`GET /api/auth/provider` hot-reads these secrets on every call (no in-memory cache), so changing the provider via the Admin UI takes effect on the next browser load without a pod restart.

For local development when `KEY_VAULT_URL` is not set, the backend falls back to `.forge-dev-config.json` in the backend root, which persists config across restarts.

### Local Auth Mode

```
1. Frontend calls GET /api/auth/provider → { "provider": "local" }

2. Dev bypass: on startup, auto-login with admin/admin credentials
   OR: user submits login form → POST /api/auth/login

3. Backend verifies username/password against settings
   Returns HS256 JWT in LoginResponse

4. Frontend stores token in localStorage key: forge_local_token

5. Every API request: Authorization: Bearer <hs256-jwt>

6. Backend get_current_user sees alg=HS256 → verifies with shared secret
   Extracts sub, name, email, roles from claims
```

### Azure AD Auth Mode

```
1. Frontend calls GET /api/auth/provider
   → { "provider": "azure_ad", "azure_client_id": "...", "azure_tenant_id": "..." }

2. useAuth hook initialises MSAL browser PublicClientApplication
   with the returned client_id and tenant_id

3. MSAL performs OIDC authorization code flow with PKCE:
     redirect to: https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
     scopes: openid, profile, email
     MFA enforced at tenant level

4. MSAL receives ID token and access token
   Frontend sends the ID token (not access token) as Bearer

5. Backend get_current_user sees alg=RS256 → fetches JWKS:
     https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys
     (cached in-memory for 30 minutes)
   Validates signature, exp, nbf
   Extracts sub, name, email, roles (Azure AD App Roles) from claims

6. RBAC enforced per endpoint: Admin required for /api/platform/*
```

### Portal RBAC Roles

Roles are Azure AD App Roles registered on the portal application registration:

| Role | Portal Permissions |
|------|-------------------|
| `Admin` | All read + write; platform auth configuration management |
| `Engineer` | Standard read access to health, cost, status |
| `Viewer` | Read-only on all sections |

Unauthenticated requests return `401 Unauthorized`. Authenticated requests from users without the required role return `403 Forbidden`.

---

## 4. API Design

### Conventions

- All portal API routes are prefixed with `/api/` (no versioning prefix currently)
- All routes except `/api/health` and `/api/auth/provider` require a valid Bearer token
- Structured logging via structlog on every request (JSON in non-dev environments)
- OpenAPI schema auto-generated by FastAPI, available at `/docs` (Swagger UI) and `/redoc`

### Verified Endpoint Reference

#### Auth

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/api/auth/provider` | Returns active auth provider config (hot-read from Key Vault) | No |
| POST | `/api/auth/login` | Local login; returns HS256 JWT | No (local mode only) |
| GET | `/api/auth/me` | Returns current user claims (name, email, role) | Yes |

#### Health

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/api/health` | Tri-state health check for all platform services | No |

#### Platform (Admin Only)

| Method | Path | Description | Min Role |
|--------|------|-------------|----------|
| GET | `/api/platform/auth-config` | Read auth provider config from Key Vault | Admin |
| POST | `/api/platform/auth-config` | Write auth provider config to Key Vault | Admin |

#### Cost

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/api/cost/by-rg?days=N` | Cost for compute + orchestration RGs, parallel queries, 15-min cache | Yes |
| GET | `/api/cost/summary?days=N` | Subscription-level cost summary | Yes |

#### Status

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| GET | `/api/status` | AKS cluster state and workload probes | Yes |

### Error Response Format

All error responses use this envelope:

```json
{
  "detail": "Human-readable error message"
}
```

FastAPI's default error format is used. The `detail` field may be a string or a list of validation error objects for request validation failures.

---

## 5. Health Checks

`GET /api/health` checks four platform services in parallel and returns a tri-state result for each:

| Value | Meaning |
|-------|---------|
| `true` | Service is configured with a reachable host and responded healthy |
| `false` | Service is configured with a reachable host but did not respond |
| `null` | Service URL contains `.svc.cluster.local` — cluster-internal only, not checked from outside |

The `null` state is important for cross-cluster networking: Trino and Spark Connect run on the compute cluster and are not reachable via `.svc.cluster.local` DNS from the orchestration cluster. Their hosts must be set to internal LoadBalancer IPs for the health check to return `true` or `false` rather than `null`.

### Per-Service Probe Details

| Service | Probe Method |
|---------|-------------|
| Airflow | `GET /api/v1/health` with basic auth credentials from settings |
| Trino | `GET /v1/info` HTTP — no SQL query executed |
| Spark Connect | HTTP GET to the configured `SPARK_CONNECT_URL` |
| ADLS | `GET https://{ADLS_ACCOUNT}.dfs.core.windows.net/` |

### Example Response

```json
{
  "status": "degraded",
  "env": "dev",
  "auth_provider": "azure_ad",
  "platform": {
    "airflow_host": "airflow-webserver.airflow.svc.cluster.local",
    "trino_host": "10.1.4.20",
    "adls_account": "forgeadlsprproddudev",
    "purview_endpoint": "",
    "resource_group": "rg-forge-dev"
  },
  "checks": {
    "airflow": null,
    "trino": true,
    "spark_connect": null,
    "adls": true
  }
}
```

In this example, Airflow is on a `.svc.cluster.local` address (null — not checked), Trino has an internal LB IP (checked and healthy), Spark Connect is unconfigured (null), and ADLS is reachable.

---

## 6. Cost Section

The cost section shows Azure compute spend attributed to the two managed resource groups where node costs accumulate.

### Azure Cost Management API Integration

The backend uses the Azure SDK (`azure-mgmt-costmanagement`) scoped to resource group level:

```
/subscriptions/{sub}/resourceGroups/{rg}
```

Two resource groups are queried in parallel via `ThreadPoolExecutor`:

- **Compute RG**: `rg-mc-compute-{alias}-{env}` (AKS-managed RG for compute node pool VMs)
- **Orchestration RG**: `rg-mc-orch-{alias}-{env}` (AKS-managed RG for orchestration node pool VMs)

These are the AKS infrastructure resource groups (the `MC_` groups) where node VM costs actually appear, not the user-facing resource groups. The names are auto-derived from `OWNER_ALIAS` and `FORGE_ENV` if `COMPUTE_RG` and `ORCH_RG` environment variables are not explicitly set.

Authentication uses the `portal-api` workload identity (managed identity via Azure Workload Identity), which must have the `Cost Management Reader` role on both resource groups.

### Caching

Cost data is expensive to fetch and changes slowly. The backend uses in-memory stale-while-revalidate caching:

- **TTL**: 15 minutes
- **Stale-while-revalidate**: on cache expiry, the stale result is served immediately while a background thread fetches fresh data
- **429 handling**: if Azure Cost Management returns `429 Too Many Requests`, the backend serves the stale cached result without triggering a background refresh, avoiding a retry storm

### Environment Variables

| Variable | Description |
|----------|-------------|
| `COMPUTE_RG` | Override compute RG name (auto-derived if blank) |
| `ORCH_RG` | Override orchestration RG name (auto-derived if blank) |
| `SUBSCRIPTION_ID` | Azure subscription ID |
| `OWNER_ALIAS` | Used for RG name derivation (e.g. `prproddu`) |
| `FORGE_ENV` | Used for RG name derivation (e.g. `dev`) |

---

## 7. Platform Status

`GET /api/status` returns live state for both AKS clusters and key workloads. Three sources are queried in parallel:

### Orchestration Cluster (In-Cluster Kubernetes API)

The `portal-api` pod uses in-cluster config (`load_incluster_config()`) to list pods across the key orchestration namespaces: `airflow`, `portal`, `dq`, `monitoring`. For each pod it returns name, phase, and readiness.

The `portal-api` service account requires a ClusterRole granting `get`/`list`/`watch` on pods and deployments in these namespaces, bound via a ClusterRoleBinding.

### Compute Cluster (Azure Resource API)

The backend calls the Azure Container Service management API to get the compute AKS cluster provisioning state and the list of node pools with VM size, current count, and autoscaler bounds. This uses the portal workload identity, which needs `Reader` on the compute cluster resource or its resource group.

### Workload Probes

HTTP probes are fired at the Trino and Spark Connect internal LoadBalancer endpoints (configured via `TRINO_INTERNAL_URL` and `SPARK_CONNECT_INTERNAL_URL` env vars). These are the same cross-cluster reachability probes as in the health endpoint. If the env vars are not set, no probes are fired and the `workload_probes` array in the response is empty.

---

## 8. Caching Strategy

The portal uses in-memory caching only — there is no Redis dependency.

### Backend In-Memory Cache

| Endpoint | Cache Duration | Strategy |
|----------|---------------|----------|
| `GET /api/cost/by-rg` | 15 min TTL | Stale-while-revalidate; serves stale on 429 |
| `GET /api/cost/summary` | 15 min TTL | Stale-while-revalidate |
| `GET /api/auth/provider` | No cache | Hot-read from Key Vault on every request |
| `GET /api/health` | No cache | Live probes on every request |
| `GET /api/status` | No cache | Live queries on every request |

JWKS keys fetched from `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys` are cached in-memory for 30 minutes to avoid rate limiting the Microsoft identity endpoint.

### Frontend

The frontend uses plain `useEffect` + `fetch` for data fetching. Each page component manages its own loading and error state. There is no client-side cache layer — each page mount triggers fresh API calls.

---

## 9. Deployment

### Kubernetes Configuration

Both portal components run in the `portal` namespace on the `workerpool` node pool of the `forge-orchestration` cluster.

```
Namespace: portal

Deployment: portal-api
  replicas: 2
  node pool: workerpool (nodeSelector: agentpool=workerpool)
  pod:
    serviceAccountName: portal-api   (workload identity binding)
    containers:
      - name: portal-api
        port: 8080
        resources:
          requests: { cpu: "250m", memory: "256Mi" }
          limits:   { cpu: "500m", memory: "512Mi" }
        livenessProbe:
          httpGet: { path: /api/health, port: 8080 }
          initialDelaySeconds: 15, periodSeconds: 30
        readinessProbe:
          httpGet: { path: /api/health, port: 8080 }
          initialDelaySeconds: 10, periodSeconds: 10

Deployment: portal-web
  replicas: 2
  node pool: workerpool (nodeSelector: agentpool=workerpool)
  pod:
    containers:
      - name: portal-web
        port: 3001
        resources:
          requests: { cpu: "250m", memory: "256Mi" }
          limits:   { cpu: "500m", memory: "512Mi" }
        livenessProbe:
          httpGet: { path: /, port: 3001 }
          initialDelaySeconds: 20, periodSeconds: 30
        readinessProbe:
          httpGet: { path: /, port: 3001 }
          initialDelaySeconds: 15, periodSeconds: 10
```

### Services and Ingress

```
Service: portal-api  (ClusterIP, port 8080)
Service: portal-web  (ClusterIP, port 3001)

Ingress: NGINX ingress controller
  host: forge-portal-{alias}-{env}.{location}.cloudapp.azure.com
  rules:
    - path: /api/*  → portal-api:8080
    - path: /*      → portal-web:3001
```

The frontend uses relative `/api/*` paths — because both pods are served behind the same ingress hostname, no CORS configuration is needed for API calls.

### Environment Variables (portal-api)

| Variable | Description |
|----------|-------------|
| `FORGE_ENV` | Environment name (`dev`, `staging`, etc.) |
| `OWNER_ALIAS` | Deployer alias used for naming conventions |
| `ADLS_ACCOUNT` | Storage account name for ADLS health probe |
| `SUBSCRIPTION_ID` | Azure subscription ID |
| `RESOURCE_GROUP` | Primary Forge resource group (e.g. `rg-forge-dev`) |
| `AIRFLOW_URL` | Airflow webserver URL (internal cluster DNS for prod) |
| `TRINO_HOST` | Trino coordinator host (must be internal LB IP for cross-cluster) |
| `SPARK_CONNECT_URL` | Spark Connect URL (must be internal LB IP for cross-cluster) |
| `COMPUTE_RG` | Compute AKS managed RG (auto-derived if blank) |
| `ORCH_RG` | Orchestration AKS managed RG (auto-derived if blank) |
| `KEY_VAULT_URL` | Key Vault URL for auth config secrets |
| `AZURE_CLIENT_ID` | Managed identity client ID for workload identity |

### Deployment Scripts

The portal is deployed using one of two scripts depending on the operator's shell:

- **`infra/scripts/deploy-portal.sh`** — Bash (Linux / WSL / Cloud Shell)
- **`infra/scripts/deploy-portal.ps1`** — PowerShell (Windows)

Both scripts: install the NGINX ingress controller (if not present), build and push container images to ACR, and run `helm upgrade --install` for the `infra/helm/orchestration/portal` chart.

### Helm Chart

Chart location: `infra/helm/orchestration/portal/`

The chart creates:
- Two Deployments (`portal-api`, `portal-web`)
- Two ClusterIP Services
- One NGINX Ingress with the auto-generated DNS hostname
- RBAC resources for the `portal-api` service account

### Cross-Cluster Networking

The portal runs on the orchestration cluster; Trino and Spark Connect run on the compute cluster. Kubernetes `.svc.cluster.local` DNS does not resolve across cluster boundaries. To reach compute cluster workloads, the following must be set to internal LoadBalancer IPs rather than cluster-internal DNS names:

- `TRINO_HOST` — internal LB IP of Trino coordinator on compute cluster
- `SPARK_CONNECT_URL` — internal LB URL of Spark Connect on compute cluster

When these are set to `.svc.cluster.local` DNS names (the default for intra-cluster deployments), the health check returns `null` for those services rather than `true` or `false`.

---

## 10. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Engineer's Browser                                                         │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Next.js 14 App Router (all pages "use client")                       │  │
│  │                                                                       │  │
│  │  useAuth hook   │   ForgeLoader   │   ThemeModal   │   Layout         │  │
│  │                                                                       │  │
│  │  Home (health)  │  Cost  │  Status  │  About                         │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │  HTTPS
                                   ▼
                    ┌──────────────────────────┐
                    │  NGINX Ingress            │
                    │  forge-portal-{alias}-   │
                    │  {env}.{loc}.cloud...    │
                    └──────────┬───────────────┘
                               │
              ┌────────────────┴────────────────┐
              │  /api/*                         │  /*
              ▼                                 ▼
┌─────────────────────────┐        ┌──────────────────────────┐
│  portal-api (pod ×2)    │        │  portal-web (pod ×2)     │
│  FastAPI / Python 3.11  │◀──────▶│  Next.js 14              │
│  port 8080              │ REST   │  port 3001               │
│  structlog              │        │  useAuth + MSAL browser  │
│  pydantic-settings      │        │  useEffect + fetch       │
│  Workload Identity SA   │        │                          │
└────────────┬────────────┘        └──────────────────────────┘
             │
             │  (dual-mode auth detection)
             │  HS256 → local verify
             │  RS256 → JWKS validate
             ▼
┌────────────────────────────────────────────────────────────────┐
│  login.microsoftonline.com/{tenant}/discovery/v2.0/keys        │
│  JWKS endpoint — cached 30 min                                 │
└────────────────────────────────────────────────────────────────┘

             │
             ├─────────────────────────────────────────────────────────┐
             │                                                         │
             ▼                                                         ▼
┌────────────────────────┐                             ┌──────────────────────────┐
│  Azure Key Vault       │                             │  Azure Cost Management   │
│                        │                             │  API                     │
│  forge-portal-auth-    │                             │                          │
│  provider              │                             │  Compute RG + Orch RG    │
│  forge-portal-aad-     │                             │  queried in parallel     │
│  client-id             │                             │  15-min in-memory cache  │
│  forge-portal-aad-     │                             └──────────────────────────┘
│  tenant-id             │
└────────────────────────┘

             │
             ├─────────────────────────────────────────────────────────┐
             │                                                         │
             ▼                                                         ▼
┌────────────────────────┐                             ┌──────────────────────────┐
│  Orchestration Cluster │                             │  Compute Cluster         │
│  (in-cluster K8s API)  │                             │  (Azure Resource API)    │
│                        │                             │                          │
│  airflow namespace     │                             │  AKS cluster state       │
│  portal namespace      │                             │  Node pools              │
│  dq namespace          │                             │  VM sizes + counts       │
│  monitoring namespace  │                             └──────────────────────────┘
└────────────────────────┘


  Health probes (parallel, tri-state: true / false / null)
  ┌────────────────────────────────────────────────────────────────────────────┐
  │                                                                            │
  │  Airflow  GET /api/v1/health (basic auth)    ← .svc.cluster.local → null  │
  │  Trino    GET /v1/info (no SQL)              ← internal LB IP → true/false│
  │  Spark    GET {SPARK_CONNECT_URL}/            ← internal LB IP → true/false│
  │  ADLS     GET https://{account}.dfs.core...  ← public endpoint → true/false│
  │                                                                            │
  └────────────────────────────────────────────────────────────────────────────┘


  PostgreSQL (orchestration cluster)
  ┌────────────────────────────────────┐
  │  Per-user theme preferences only  │
  │  (no user accounts, no auth data) │
  └────────────────────────────────────┘
```
