# Forge — Developer Portal Architecture

> **Version:** 1.0
> **Status:** Production
> **Audience:** Platform engineers, data engineers, frontend/backend contributors

[![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=flat-square&logo=kubernetes&logoColor=white)](https://kubernetes.io)

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Component Architecture](#2-component-architecture)
3. [Authentication Flow](#3-authentication-flow)
4. [API Design](#4-api-design)
5. [Pipelines Section](#5-pipelines-section)
6. [Datasets Section](#6-datasets-section)
7. [Lineage Section](#7-lineage-section)
8. [Data Quality Section](#8-data-quality-section)
9. [Cost Section](#9-cost-section)
10. [Metadata Section](#10-metadata-section)
11. [Caching Strategy](#11-caching-strategy)
12. [Deployment](#12-deployment)
13. [Architecture Diagram](#13-architecture-diagram)

---

## 1. Purpose and Scope

The Developer Portal is an **engineering observability tool** — not an analytics dashboard. Its job is to give data engineers and platform operators a single place to observe the operational state of the Forge platform: what is running, what failed, where data came from, whether it is healthy, and what it cost.

### What the Portal Is

- A real-time view of pipeline execution state (Airflow DAG runs, task statuses, logs)
- A catalog of all datasets in the lakehouse (schema, partitions, freshness, DQ status)
- A lineage explorer for tracing data provenance from source to serving
- A DQ dashboard for monitoring rule pass rates and investigating failures
- A cost attribution tool for tracking compute spend by pipeline
- A metadata hub for tagging, ownership, and SLA definitions

### What the Portal Is Not

The Developer Portal is **not** a business intelligence tool, a chart builder, a report scheduler, or an end-user data product. Analysts query data through Trino or the Gold layer directly. The portal is for the platform team and data engineers who build and operate the pipelines that produce that data.

This distinction shapes every design decision: the portal shows raw run history, not trend summaries for executives; it shows task-level logs, not aggregated job health KPIs; it shows partition counts and Delta log state, not business metrics.

### Primary Users

| User | What They Use the Portal For |
|------|------------------------------|
| Data Engineer | Check pipeline run status, read task logs, preview dataset schema, inspect DQ failures, view lineage graph of their pipeline |
| Platform Operator | Monitor overall platform health, investigate SLA misses, audit DQ results, track cost anomalies |
| On-Call Engineer | Find the failed task, read its logs, determine if DQ blocked downstream, trigger a manual re-run |

---

## 2. Component Architecture

The portal consists of two independently deployed pods:

- **`portal-web`** — Next.js 14 frontend, App Router, server-side rendered pages with client-side data fetching via React Query
- **`portal-api`** — FastAPI backend, Python 3.11, aggregates data from Airflow, Purview Data Map API, Trino (DQ store), Azure Cost Management, and ADLS catalog

Both pods run on the `platform` node pool of the `forge-orchestration` AKS cluster.

### Frontend: `portal-web` (Next.js 14)

The frontend uses Next.js 14 with the App Router (not Pages Router). This means:

- Each page directory under `src/app/` is a route segment
- Server Components are used for the initial page shell and static metadata
- Client Components (marked with `"use client"`) handle interactive elements: the lineage graph, live log streaming, real-time status polling
- NextAuth.js handles Azure AD OIDC sign-in and manages the browser session + JWT token lifecycle

Route structure:

```
src/app/
├── (auth)/
│   └── login/            ← NextAuth sign-in page
├── (portal)/
│   ├── layout.tsx         ← portal shell: sidebar, nav, auth guard
│   ├── page.tsx           ← /   Home dashboard
│   ├── pipelines/
│   │   ├── page.tsx       ← /pipelines   DAG list
│   │   └── [dag_id]/
│   │       ├── page.tsx   ← /pipelines/:dag_id   DAG detail
│   │       └── runs/
│   │           └── [run_id]/
│   │               └── page.tsx  ← /pipelines/:dag_id/runs/:run_id
│   ├── datasets/
│   │   ├── page.tsx       ← /datasets   catalog
│   │   └── [namespace]/
│   │       └── [name]/
│   │           └── page.tsx  ← /datasets/:namespace/:name
│   ├── lineage/
│   │   └── page.tsx       ← /lineage   lineage explorer
│   ├── dq/
│   │   ├── page.tsx       ← /dq   DQ summary dashboard
│   │   └── [namespace]/
│   │       └── [name]/
│   │           └── page.tsx  ← /dq/:namespace/:name   dataset DQ detail
│   ├── cost/
│   │   └── page.tsx       ← /cost   cost attribution
│   └── metadata/
│       └── page.tsx       ← /metadata   search + tagging
```

State management is entirely local to each route (no Redux, no Zustand global store). React Query manages server state: caching, stale detection, background refresh, and pagination. This keeps the client bundle small and the data always consistent with the backend.

### Backend: `portal-api` (FastAPI)

The FastAPI backend is a thin aggregation layer. It does not own any data — it queries upstream data sources and assembles responses for the frontend. Its responsibilities are:

1. **Authentication** — validate Azure AD Bearer tokens on every request, extract user identity and role
2. **Data aggregation** — call Airflow REST API, Purview Data Map API, Trino (DQ Delta table), Azure Cost Management API, and ADLS catalog table; assemble unified responses
3. **Authorization** — enforce RBAC (Admin, Editor, Reader) per endpoint
4. **Pagination and filtering** — apply cursor-based or offset pagination before returning collections
5. **Error normalization** — translate upstream errors (Airflow 5xx, Purview API timeout) into structured portal error responses

The backend is stateless. All data lives in upstream systems. The only state the backend holds is a Redis cache entry (when Redis is enabled) and in-memory Python LRU caches for cheap, rarely-changing data (e.g., DAG list).

### Data Sources the Backend Integrates With

| Data Source | Purpose | Protocol |
|-------------|---------|----------|
| Airflow REST API | DAG list, DAG run history, task instance state, task log streaming, manual trigger | HTTP/JSON (Airflow 3.x stable API) |
| Purview Data Map API | Lineage graph, dataset list, job list, dataset versions, run facets | HTTPS/JSON (Azure Purview Data Map REST API) |
| Trino (DQ Delta table) | DQ run results, pass rate calculations, failing rule details, trend queries | JDBC via `trino-python-client` |
| Azure Cost Management API | Cost by resource, cost by tag, anomaly detection | Azure SDK (`azure-mgmt-costmanagement`) |
| ADLS catalog Delta table | Dataset discovery, schema, partition list, row count, freshness | Delta reader via `deltalake` Python library (direct ADLS read) |

The backend does **not** call PostgreSQL directly (Airflow's). All access goes through REST APIs. The only direct storage access is the ADLS catalog table and the DQ results table (via Trino).

---

## 3. Authentication Flow

Every request to the portal — browser page load or API call — is authenticated against Azure AD. There are no anonymous routes, no API keys, and no local user accounts.

### Identity Model

- **Azure AD** is the identity provider
- **NextAuth.js** manages the browser session (OIDC authorization code flow)
- **FastAPI** validates the Bearer token JWT on every API request using the Azure AD JWKS endpoint
- **RBAC** is enforced by FastAPI after token validation, using Azure AD group membership claims in the token

### Full Authentication Flow

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                    │
│  1. USER VISITS PORTAL                                                             │
│                                                                                    │
│     Browser ──HTTPS──▶ Application Gateway ──▶ portal-web (Next.js)                │
│                                                                                    │
│     Next.js App Router checks session cookie (NextAuth session):                   │
│       • If session valid → serve page, hydrate React Query                         │
│       • If no session → redirect to /api/auth/signin                               │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  no session
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                    │
│  2. AZURE AD OIDC — AUTHORIZATION CODE FLOW                                        │
│                                                                                    │
│     portal-web                                                                     │
│       │                                                                            │
│       │  NextAuth: redirect to Azure AD /authorize                                 │
│       ▼                                                                            │
│     login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize                       │
│       │  scopes: openid, profile, email, offline_access,                           │
│       │          api://<portal-app-id>/portal.read                                 │
│       │                                                                            │
│       │  User authenticates (MFA enforced at tenant level)                         │
│       │                                                                            │
│       │  Azure AD returns authorization code to redirect_uri                       │
│       ▼                                                                            │
│     portal-web /api/auth/callback/azure-ad                                         │
│       │                                                                            │
│       │  NextAuth exchanges code for tokens:                                       │
│       │    • id_token (JWT — user identity, name, email, group claims)             │
│       │    • access_token (JWT — audience: portal-api, roles, groups)              │
│       │    • refresh_token (for session renewal)                                   │
│       │                                                                            │
│       │  NextAuth stores:                                                          │
│       │    • Server-side session (encrypted cookie, HttpOnly, Secure, SameSite)    │
│       │    • access_token in server-side session (not in browser localStorage)     │
│       │                                                                            │
└────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  session established
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                    │
│  3. FRONTEND → BACKEND API CALL                                                    │
│                                                                                    │
│     React Query (client component) calls /api/v1/pipelines                         │
│       │                                                                            │
│       │  Next.js route handler (server-side proxy):                                │
│       │    • Reads access_token from server-side session                           │
│       │    • Attaches: Authorization: Bearer <access_token>                        │
│       │    • Forwards request to portal-api (internal cluster DNS)                 │
│       ▼                                                                            │
│     portal-api (FastAPI, internal service)                                         │
│       │                                                                            │
│       │  FastAPI HTTPBearer dependency on every route:                             │
│       │    1. Extract Bearer token from Authorization header                       │
│       │    2. Fetch Azure AD JWKS from:                                            │
│       │       https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys       │
│       │       (cached in-memory, refreshed every 12h)                              │
│       │    3. Validate JWT:                                                        │
│       │       • Signature valid (RS256, JWKS key)                                  │
│       │       • aud == "api://<portal-app-id>"                                     │
│       │       • iss == "https://login.microsoftonline.com/<tenant>/v2.0"           │
│       │       • exp > now()                                                        │
│       │       • nbf <= now()                                                       │
│       │    4. Extract claims:                                                      │
│       │       • sub (user object ID)                                               │
│       │       • name, email                                                        │
│       │       • groups (Azure AD group OIDs)                                       │
│       │       • roles (app roles assigned in Azure AD)                             │
│       │                                                                            │
│       │  FastAPI RBAC dependency (per-route):                                      │
│       │    • Map groups/roles → portal role (Admin, Editor, Reader)                │
│       │    • Reject 403 if role insufficient for endpoint                          │
│       │                                                                            │
│       │  Business logic + upstream API calls                                       │
│       │                                                                            │
│       │  Return structured JSON response                                           │
│       ▼                                                                            │
│     React Query receives response, caches with stale-while-revalidate              │
│     React renders updated UI                                                       │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  access_token approaching expiry
                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                    │
│  4. TOKEN REFRESH                                                                  │
│                                                                                    │
│     NextAuth detects access_token expiry (< 5 min remaining)                       │
│       │                                                                            │
│       │  Uses refresh_token to call Azure AD /token endpoint                       │
│       │  Receives new access_token + refresh_token                                 │
│       │  Updates server-side session silently                                      │
│       │  Next API call uses new access_token automatically                         │
│       │                                                                            │
│       │  If refresh_token expired (session > 24h idle):                            │
│       │    → User redirected to Azure AD re-authentication                         │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Portal RBAC Roles

Roles are assigned via Azure AD app roles registered on the portal application registration:

| Role | Azure AD Group | Portal Permissions |
|------|---------------|-------------------|
| `portal.admin` | `grp-forge-platform-admin` | All read + write operations; trigger runs; manage tags, owners, SLAs |
| `portal.editor` | `grp-forge-data-engineer` | All read; trigger runs; manage own pipeline tags/owners |
| `portal.reader` | `grp-forge-analyst` | Read-only on all sections; no trigger, no write |

Unauthenticated requests to portal-api return `401 Unauthorized`. Authenticated requests where the user lacks the required role return `403 Forbidden`. Both responses use the standard portal error format (see API Design section).

---

## 4. API Design

### Conventions

The portal API is a RESTful JSON API. All design follows these rules:

- **Versioned prefix**: all routes are under `/api/v1/`. Breaking changes increment the version (`/api/v2/`).
- **Authenticated**: every route requires a valid Bearer token. No unauthenticated endpoints.
- **Consistent error format**: all errors return the same JSON envelope.
- **Pagination**: collections use cursor-based pagination (large result sets) or offset pagination (small, fixed-size sets). The response always includes `total`, `page`, and `next_cursor` or `next_page`.
- **HTTP semantics**: GET for reads, POST for actions (trigger run, create tag), PATCH for updates (ownership, SLA), DELETE for removals.

### OpenAPI Documentation

FastAPI generates OpenAPI 3.1 schema automatically from Python type annotations. Documentation is served at:

- `/docs` — Swagger UI (interactive, requires Bearer token via the Authorize button)
- `/redoc` — ReDoc (read-only, cleaner formatting)
- `/openapi.json` — raw schema

### Error Response Format

All error responses use this envelope:

```json
{
  "error": {
    "code": "DAG_NOT_FOUND",
    "message": "DAG 'ingest_sales_orders' not found in Airflow.",
    "detail": "Airflow returned 404 for GET /api/v1/dags/ingest_sales_orders",
    "request_id": "3f7a91bc-12d4-4e5a-b881-000c29a4f821",
    "timestamp": "2026-03-24T14:32:10.441Z"
  }
}
```

`code` is a machine-readable string (snake_case, uppercase). `message` is human-readable. `detail` gives the technical root cause for debugging. `request_id` correlates to the structured access log in Log Analytics.

### Pagination Format

```json
{
  "data": [...],
  "pagination": {
    "total": 847,
    "page": 1,
    "page_size": 50,
    "next_cursor": "eyJydW5faWQiOiAiMjAyNi0wMy0yM1QxMjowMDowMCJ9"
  }
}
```

Cursor is a base64-encoded JSON object containing the sort key of the last item returned. Callers pass `?cursor=<value>` to get the next page.

### Endpoint Reference

#### Pipelines

| Method | Path | Description | Min Role |
|--------|------|-------------|----------|
| GET | `/api/v1/pipelines` | List all DAGs with summary state | Reader |
| GET | `/api/v1/pipelines/{dag_id}` | DAG detail: schedule, owner, recent runs | Reader |
| GET | `/api/v1/pipelines/{dag_id}/runs` | DAG run history (paginated) | Reader |
| GET | `/api/v1/pipelines/{dag_id}/runs/{run_id}` | Run detail: task instances, state, duration | Reader |
| GET | `/api/v1/pipelines/{dag_id}/runs/{run_id}/tasks/{task_id}/logs` | Stream task log (SSE) | Reader |
| POST | `/api/v1/pipelines/{dag_id}/trigger` | Trigger a manual DAG run | Editor |
| PATCH | `/api/v1/pipelines/{dag_id}/metadata` | Update owner, tags, SLA definition | Editor |

#### Datasets

| Method | Path | Description | Min Role |
|--------|------|-------------|----------|
| GET | `/api/v1/datasets` | List datasets from catalog (all zones) | Reader |
| GET | `/api/v1/datasets/{namespace}/{name}` | Dataset detail: schema, freshness, DQ status | Reader |
| GET | `/api/v1/datasets/{namespace}/{name}/schema` | Schema with column types and nullability | Reader |
| GET | `/api/v1/datasets/{namespace}/{name}/partitions` | Partition list from Delta log | Reader |
| GET | `/api/v1/datasets/{namespace}/{name}/preview` | Row preview (Trino query, max 100 rows) | Reader |
| GET | `/api/v1/datasets/{namespace}/{name}/versions` | Delta table version history | Reader |
| PATCH | `/api/v1/datasets/{namespace}/{name}/metadata` | Update owner, tags, description | Editor |

#### Lineage

| Method | Path | Description | Min Role |
|--------|------|-------------|----------|
| GET | `/api/v1/lineage/datasets/{namespace}/{name}` | Lineage graph for a dataset | Reader |
| GET | `/api/v1/lineage/jobs/{namespace}/{name}` | Lineage graph for a job | Reader |
| GET | `/api/v1/lineage/impact/{namespace}/{name}` | Downstream impact list for a dataset | Reader |

#### Data Quality

| Method | Path | Description | Min Role |
|--------|------|-------------|----------|
| GET | `/api/v1/dq/summary` | Platform-wide DQ pass rate | Reader |
| GET | `/api/v1/dq/datasets` | DQ status per dataset (pass rate, last run) | Reader |
| GET | `/api/v1/dq/datasets/{namespace}/{name}` | DQ history for a dataset | Reader |
| GET | `/api/v1/dq/datasets/{namespace}/{name}/runs/{run_id}` | Full DQ run report: all rules, results | Reader |

#### Cost

| Method | Path | Description | Min Role |
|--------|------|-------------|----------|
| GET | `/api/v1/cost/summary` | Total platform cost: current month, prior month | Reader |
| GET | `/api/v1/cost/pipelines` | Cost attributed per pipeline (tag-based) | Reader |
| GET | `/api/v1/cost/pipelines/{dag_id}` | Pipeline cost detail: compute, trend | Reader |
| GET | `/api/v1/cost/anomalies` | Detected cost anomalies | Reader |

#### Metadata

| Method | Path | Description | Min Role |
|--------|------|-------------|----------|
| GET | `/api/v1/metadata/search` | Full-text search across datasets and jobs | Reader |
| GET | `/api/v1/metadata/tags` | List all tags in use | Reader |
| POST | `/api/v1/metadata/tags` | Create a new tag | Editor |
| GET | `/api/v1/metadata/owners` | List all dataset and pipeline owners | Reader |

#### System

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/health` | Pod liveness check | None |
| GET | `/ready` | Pod readiness check | None |
| GET | `/metrics` | Prometheus-format metrics (scraped by Azure Monitor Agent) | Internal only |

---

## 5. Pipelines Section

The pipelines section gives engineers a real-time view of every Airflow DAG managed by the platform.

### Data Source: Airflow REST API

All pipeline data originates from the Airflow 3.x stable REST API. The portal backend authenticates to Airflow using a service account JWT (stored in Key Vault, loaded via CSI driver). The Airflow REST API base URL is an internal cluster service (`http://airflow-webserver.airflow.svc.cluster.local:8080`).

No direct PostgreSQL access is made to the Airflow metadata database. The REST API is the only interface.

### DAG List

The DAG list page fetches `/api/v1/pipelines`, which calls Airflow's `GET /api/v1/dags` with pagination parameters. The backend enriches each DAG with:

- Latest DAG run state and timestamp (from `GET /api/v1/dags/{dag_id}/dagRuns?limit=1&order_by=-start_date`)
- Latest DQ result for any datasets this DAG outputs (joined from DQ results store by matching the DAG ID in the `pipeline_run_id` column)
- Owner and tag metadata from the portal's own metadata store (ADLS catalog Delta table)

Response is a list of DAG summaries, sorted by last run descending by default. Supports query parameters:
- `?status=failed` — filter by last run state
- `?owner=jane.smith` — filter by owner
- `?tag=sales` — filter by tag
- `?search=orders` — filter DAG IDs by substring

### DAG Run History

Run history is fetched via `GET /api/v1/dags/{dag_id}/dagRuns` with cursor-based pagination. Each run includes:

- `run_id` (Airflow run ID string, e.g. `scheduled__2026-03-24T00:00:00+00:00`)
- `state`: `success`, `failed`, `running`, `queued`
- `start_date`, `end_date`, `duration`
- `run_type`: `scheduled`, `manual`, `backfill`
- `conf` (dict of trigger configuration, if manually triggered)

The portal renders this as a run history chart (bar chart, one bar per run, coloured by state) and a sortable table with filtering.

### Task Instance State

For a given run, the portal fetches `GET /api/v1/dags/{dag_id}/dagRuns/{run_id}/taskInstances`. This returns the state of every task in the DAG for that run:

- Task ID, operator type
- State: `success`, `failed`, `running`, `upstream_failed`, `skipped`, `deferred`
- Start time, end time, duration
- Try number (retry count)

The frontend renders this as a task grid — a visual representation of the DAG's task topology, coloured by state. The task topology (dependency edges) is fetched once from `GET /api/v1/dags/{dag_id}/tasks` and cached client-side.

### Task Log Streaming

Task logs are streamed from Airflow via Server-Sent Events (SSE). The flow:

```
Browser
  │  opens EventSource to Next.js /api/stream/task-log
  ▼
Next.js API Route (server-side)
  │  authenticates user via session
  │  opens HTTP streaming request to portal-api
  ▼
portal-api /api/v1/pipelines/{dag_id}/runs/{run_id}/tasks/{task_id}/logs
  │  calls Airflow GET /api/v1/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}/logs/{try_number}
  │  streams Airflow log response chunks
  │  emits SSE events (data: <log_line>\n\n)
  ▼
Browser receives SSE events, appends to log viewer component
```

Airflow returns task logs as a plain text stream for the active log backend (in production: ADLS-backed remote log store via Airflow's ADLS log handler). For completed tasks, the full log is fetched in one request. For running tasks, the portal polls Airflow every 3 seconds (controlled by React Query `refetchInterval`) and appends new lines, simulating streaming without a persistent SSE connection.

### Manual Run Trigger

`POST /api/v1/pipelines/{dag_id}/trigger` calls Airflow's `POST /api/v1/dags/{dag_id}/dagRuns` with:

```json
{
  "run_id": "manual__portal__<user_sub>__<timestamp>",
  "conf": { "triggered_by": "portal", "user": "<email>" },
  "note": "Triggered via Developer Portal by <name>"
}
```

Requires the `portal.editor` role. The response includes the new `run_id`, which the frontend uses to navigate directly to the run detail page and begin polling for task state.

---

## 6. Datasets Section

The datasets section is the lakehouse catalog — a searchable, browseable list of all datasets across all three zones (raw, curated, serving), with schema, partition, DQ, and lineage context.

### Dataset Discovery

Datasets are discovered from two complementary sources that are merged by the backend:

**Source 1: Purview Asset Registry**

Microsoft Purview maintains a registry of every dataset (asset) that has appeared as an input or output in any OpenLineage event. This is the authoritative list of what the platform knows about. The backend queries:

```
GET /api/v1/namespaces            → list all namespaces
GET /api/v1/namespaces/{ns}/datasets   → list datasets in namespace
```

Namespaces in Purview correspond to ADLS containers: `raw`, `curated`, `serving`. Dataset names follow the path convention: `{domain}/{entity}`.

Each Purview dataset asset record includes:
- Name, namespace
- Last modified timestamp (from most recent run that touched it)
- Schema (from the schema facet of the most recent run)
- Current version ID

**Source 2: ADLS Catalog Delta Table**

The platform maintains a catalog Delta table at:

```
abfss://silver@<account>.dfs.core.windows.net/_platform/catalog/
```

This table is written by the serving publish DAG at the end of each successful pipeline run. It contains columns not carried by Purview:

```
catalog/
  namespace         STRING    (raw, curated, serving)
  dataset_name      STRING    (domain/entity)
  zone              STRING
  delta_path        STRING    (full abfss path)
  row_count         BIGINT    (from DQ results or DESCRIBE DETAIL)
  partition_columns ARRAY<STRING>
  last_partition    STRING    (latest partition value)
  last_refreshed_ts TIMESTAMP
  owner             STRING
  tags              ARRAY<STRING>
  description       STRING
  sla_freshness_hours  INT    (SLA in hours, NULL if not defined)
```

The backend reads this table using the `deltalake` Python library (`DeltaTable.forPath(...)`) directly from ADLS via the portal's workload identity. This is a lightweight metadata read, not a full table scan.

**Merging the Two Sources**

The backend performs an in-memory merge: the Purview asset list provides lineage-context and schema; the catalog table provides row counts, partition info, owner, tags, and SLA. The merge key is `(namespace, dataset_name)`. Datasets in Purview but not in the catalog table are shown with a "catalog pending" badge (they have been seen in lineage but the serving publish has not yet run). Datasets in the catalog table but not in Purview have no lineage context (typically tables created manually or imported without OpenLineage instrumentation).

### Schema Rendering

Dataset schema is fetched from the Purview asset's most recent schema facet:

```json
{
  "fields": [
    { "name": "order_id",       "type": "STRING",        "description": "Business order identifier" },
    { "name": "customer_id",    "type": "STRING",        "description": null },
    { "name": "order_total",    "type": "DECIMAL(18,2)", "description": "Total order value in USD" },
    { "name": "order_ts",       "type": "TIMESTAMP",     "description": "Order placement timestamp" },
    { "name": "status",         "type": "STRING",        "description": "open | fulfilled | cancelled" }
  ]
}
```

The frontend renders this as a sortable table with column name, type, description, and a "non-nullable" indicator. If column-level lineage is available for this dataset (from the Purview Data Map column-level lineage API), each column shows a "lineage" icon that opens the lineage graph filtered to that column.

### Partition List from Delta Log

Partition information is read directly from the Delta table transaction log. The backend uses `DeltaTable.forPath(path).files()` which reads the `_delta_log/` directory in ADLS and returns the list of active files with their partition values. From this, the backend derives:

- Partition columns and their values
- Number of files per partition
- Latest partition value
- Total size (sum of file sizes in bytes)

This is a metadata-only operation — no data files are read. For large Delta tables with thousands of partitions, the backend returns only the most recent N=200 partitions, sorted descending by partition value.

### Row Count from DQ Results Store

Row count is sourced from the most recent DQ run report for the dataset, where the volume check rule stores `observed_value` = row count. The backend queries Trino:

```sql
SELECT
  observed_value AS row_count,
  run_ts
FROM dq_results
WHERE
  dataset_namespace = :namespace
  AND dataset_name   = :name
  AND rule_results[check_type = 'VOLUME']
ORDER BY run_ts DESC
LIMIT 1
```

If no DQ runs exist for the dataset (rare for production datasets, common for Bronze layer datasets), the row count falls back to `DESCRIBE DETAIL` run via Trino against the Delta table:

```sql
SELECT num_rows FROM delta."{path}"."$properties"
```

---

## 7. Lineage Section

The lineage section is an interactive graph explorer for tracing data provenance and understanding downstream impact.

### Fetching the Lineage Graph from Purview

The lineage graph is fetched from the Purview Data Map API. Purview models lineage as a directed graph of asset nodes and process nodes, connected by edges representing input/output relationships.

For a given dataset, the backend calls:

```
GET /api/v1/lineage?nodeId=dataset:{namespace}:{name}&depth=3
```

`depth=3` means: expand three hops in both directions (upstream and downstream). This is configurable per request via a query parameter (`?depth=N`, capped at 5 to prevent excessively large graphs).

The Purview response is a graph with:
- `nodes`: array of dataset and job nodes, each with `id`, `type`, `data` (name, namespace, schema facet, DQ facet)
- `edges`: array of directed edges `{origin, destination}` representing input/output relationships

The portal backend normalises this into a format suitable for ReactFlow:

```json
{
  "nodes": [
    {
      "id": "dataset:raw:sales/orders",
      "type": "dataset",
      "zone": "raw",
      "name": "sales/orders",
      "namespace": "raw",
      "schema": { "fields": [...] },
      "dq_status": "passed",
      "freshness_ok": true
    },
    {
      "id": "job:airflow:transform_curated_orders",
      "type": "job",
      "name": "transform_curated_orders",
      "namespace": "airflow",
      "last_run": { "state": "success", "end_at": "2026-03-24T06:12:44Z" }
    }
  ],
  "edges": [
    { "source": "dataset:raw:sales/orders", "target": "job:airflow:transform_curated_orders" },
    { "source": "job:airflow:transform_curated_orders", "target": "dataset:curated:sales/orders" }
  ]
}
```

### Graph Rendering with ReactFlow (XYFlow)

The lineage graph is rendered client-side using ReactFlow (the `@xyflow/react` package). ReactFlow provides:

- Automatic layout (using the `dagre` algorithm for hierarchical left-to-right layout)
- Pan and zoom on the canvas
- Click-to-select nodes with a detail panel
- Custom node types (dataset nodes styled differently from job nodes, zones colour-coded)

Custom node types:

```
DatasetNode:
  ┌──────────────────────────┐
  │ [zone badge] raw         │
  │ sales/orders             │
  │ ● DQ: passed             │
  │ ● 2.1M rows              │
  └──────────────────────────┘

JobNode:
  ┌──────────────────────────┐
  │ ⚙ transform_curated_...  │
  │ Airflow · DAG            │
  │ Last run: ✓ 2h ago       │
  └──────────────────────────┘
```

Nodes are coloured by zone: raw = grey, curated = blue, serving = green. Failed/errored nodes are highlighted in red. The graph auto-fits to the viewport on first render.

### Upstream and Downstream Navigation

The initial graph load uses `depth=3`. When a user clicks on a node, the detail panel appears on the right with:

- For dataset nodes: schema, DQ status, freshness, owner, link to dataset detail page, link to DQ detail
- For job nodes: last run state, link to pipeline run page, execution duration

If the user wants to navigate further upstream or downstream than the loaded depth, they click **"Expand upstream"** or **"Expand downstream"** on any node. This triggers a new API call to `/api/v1/lineage/datasets/{namespace}/{name}?depth=5` from that node's perspective, and the result is merged into the existing graph (ReactFlow nodes are additive — already-visible nodes are deduplicated by ID).

### Column-Level Lineage Toggle

When the user activates the **"Column level"** toggle in the graph toolbar, the frontend calls:

```
GET /api/v1/lineage/datasets/{namespace}/{name}?level=column
```

The backend calls the Purview Data Map column lineage endpoint:

```
GET https://purview-forge-{env}.purview.azure.com/dataMap/api/atlas/v2/lineage/{assetGuid}?direction=BOTH&depth=3
```

Purview returns column-level edges derived from the OpenLineage `columnLineage` facet emitted by the Spark OpenLineage plugin (which instruments the Spark logical plan) and from the `sqlLineage` facet emitted by the Trino OpenLineage plugin (which parses the SQL AST).

In column-level view, the ReactFlow graph expands each dataset node to show its individual columns, and edges connect specific columns across datasets:

```
raw:orders.subtotal ──▶ [transform job] ──▶ curated:orders.order_subtotal_usd
raw:orders.tax      ──▶ [transform job] ──▶ curated:orders.order_total_usd
                                              (derived: subtotal + tax)
```

The column-level view can be filtered to a specific column using the search box in the lineage toolbar, which highlights the transitive lineage chain for just that column.

### Impact Analysis Computation

Impact analysis answers: "if this column or dataset changes, what downstream datasets and consumers are affected?"

The backend computes this by traversing the lineage graph downstream from the selected node:

```
GET /api/v1/lineage/impact/{namespace}/{name}

Algorithm:
  1. Call Purview Data Map GET /atlas/v2/lineage/<assetGuid>?direction=BOTH&depth=10 (deep)
  2. Filter to only downstream edges (source is the target dataset or any of its descendants)
  3. Collect all downstream dataset nodes
  4. For each downstream dataset: look up its DQ status, freshness, owner, zone
  5. Return sorted list: Gold layer datasets first (highest consumer impact), then curated
```

The impact analysis response is rendered as a flat list of affected datasets, each showing:
- Dataset name and zone
- Owner (who to notify)
- Number of dependent jobs between the changed dataset and this one (depth)
- Whether the affected dataset has an active SLA

This is used by data engineers before making schema changes: paste in the column or dataset name, see every downstream dataset and their owners, then notify the right people before deploying the change.

---

## 8. Data Quality Section

The DQ section provides a full view of data quality health across the platform.

### Reading DQ Results from the Delta Table via Trino

All DQ data is stored in the DQ results Delta table:

```
abfss://silver@<account>.dfs.core.windows.net/_platform/dq_results/
```

The portal backend queries this table using Trino via `trino-python-client`. The connection is made to the Trino coordinator internal service (`http://trino-coordinator.trino.svc.cluster.local:8080`) using the portal's service account credentials. The Trino catalog `lakehouse` exposes the `_platform` schema with the `dq_results` table registered via the Delta Lake connector.

The DQ results table schema:

```
dataset_namespace   STRING
dataset_name        STRING
run_id              STRING          UUID of this DQ run
pipeline_run_id     STRING          Airflow run ID that triggered this
run_ts              TIMESTAMP       when the DQ run executed
passed              BOOLEAN         true = all CRITICAL rules passed
rule_results        ARRAY<STRUCT<
  rule_id             STRING,
  check_type          STRING,       (SCHEMA|CONTENT|VOLUME|FRESHNESS)
  severity            STRING,       (CRITICAL|WARNING|INFO)
  passed              BOOLEAN,
  observed_value      DOUBLE,
  threshold           DOUBLE,
  message             STRING
>>
summary             STRUCT<
  total               INT,
  passed              INT,
  failed              INT,
  critical_failures   INT,
  warning_failures    INT
>
```

### Pass Rate Calculation

The platform-wide DQ pass rate is the percentage of DQ runs in the last N days where `passed = true`. The portal backend runs this query:

```sql
SELECT
  COUNT(*)                                         AS total_runs,
  SUM(CASE WHEN passed THEN 1 ELSE 0 END)          AS passed_runs,
  CAST(SUM(CASE WHEN passed THEN 1 ELSE 0 END) AS DOUBLE)
    / COUNT(*)                                     AS pass_rate
FROM lakehouse._platform.dq_results
WHERE run_ts >= NOW() - INTERVAL '7' DAY
```

This result is cached in Redis for 5 minutes (or in-memory LRU for 2 minutes if Redis is not available). The DQ summary API response includes the current pass rate, the 7-day trend (pass rate per day), and a count of CRITICAL failures.

### Trend Queries

The DQ trend chart shows pass rate per day over the last 30 days. The backend runs:

```sql
SELECT
  CAST(run_ts AS DATE)                                     AS run_date,
  dataset_namespace,
  dataset_name,
  COUNT(*)                                                 AS runs,
  SUM(CASE WHEN passed THEN 1 ELSE 0 END)                 AS passed,
  CAST(SUM(CASE WHEN passed THEN 1 ELSE 0 END) AS DOUBLE)
    / COUNT(*)                                             AS pass_rate
FROM lakehouse._platform.dq_results
WHERE run_ts >= NOW() - INTERVAL '30' DAY
GROUP BY 1, 2, 3
ORDER BY 1 DESC
```

This query result is cached for 15 minutes — it is expensive (full scan of 30 days of DQ data) but changes slowly.

### Failing Rules Detail

When an engineer clicks into a specific DQ run that failed, the portal fetches the full rule results array. The detail view shows:

- Each rule by `rule_id` and `check_type`
- Whether it passed or failed, with severity badge (CRITICAL in red, WARNING in amber)
- The observed value vs threshold (e.g., "null rate: 4.2% (threshold: 1.0%)")
- The rule message string from the YAML ruleset definition

Failing CRITICAL rules are shown first, sorted by severity. This gives the engineer the exact information needed to investigate: which column is failing, what the actual value is, and what the expected threshold is. A "View in Dataset" button links to the dataset detail page. A "View Lineage" button links to the lineage graph for the dataset where the failure occurred.

---

## 9. Cost Section

The cost section attributes Azure compute spend to individual pipelines, making it possible to identify which DAGs are the most expensive and detect unexpected spend spikes.

### Azure Cost Management API Integration

The portal backend uses the Azure SDK (`azure-mgmt-costmanagement`) to query the Azure Cost Management API. Authentication uses the portal's workload identity (`id-forge-read-{env}`), which has the `Cost Management Reader` role scoped to the Forge resource group.

The primary API used is `CostManagementClient.query.usage()` with a date range and grouping. The backend queries at both the resource group level (overall platform cost) and filtered by resource tag (pipeline-level attribution).

### Tag-Based Pipeline Cost Allocation

Forge uses Azure resource tags to attribute compute costs to specific pipelines. When Airflow submits a `SparkApplication` CRD, it injects a label:

```yaml
metadata:
  labels:
    forge.io/pipeline: "ingest_sales_orders"
    forge.io/dag_id:   "ingest_sales_orders"
    forge.io/env:      "prod"
```

The Spark Operator propagates these labels to the driver and executor pods. Azure Monitor collects pod-level resource usage and maps it to AKS node cost via the `Microsoft.ContainerService/managedClusters` resource.

For cost attribution, the backend queries the Azure Cost Management API grouping by the `forge-pipeline` tag value:

```python
query_definition = QueryDefinition(
    type=ExportType.ACTUAL_COST,
    timeframe=TimeframeType.CUSTOM,
    time_period=QueryTimePeriod(
        from_property=start_date,
        to=end_date,
    ),
    dataset=QueryDataset(
        granularity=GranularityType.DAILY,
        aggregation={
            "totalCost": QueryAggregation(name="Cost", function=FunctionType.SUM)
        },
        grouping=[
            QueryGrouping(type=QueryColumnType.TAG, name="forge-pipeline")
        ]
    )
)
```

This returns daily cost broken down by pipeline tag. Pipelines that ran on shared node pools have their cost apportioned pro-rata based on CPU/memory reservation time relative to total node cost for that day. This is an approximation — not a perfect attribution — which is clearly stated in the portal UI.

### Anomaly Detection

Cost anomalies are detected by comparing each pipeline's daily cost against its rolling 14-day average. The backend computes this entirely in Python from the Cost Management API results:

```python
# For each pipeline, for each day:
z_score = (today_cost - rolling_mean) / rolling_std

# Anomaly threshold: z_score > 2.0 (cost > 2 standard deviations above mean)
```

Pipelines with `z_score > 2.0` are flagged as anomalies. The anomaly list is returned by `/api/v1/cost/anomalies` and displayed as a warning panel on the cost dashboard. Common causes: a long-running Spark job due to data skew, a runaway retry loop, or a pipeline accidentally triggered multiple times.

---

## 10. Metadata Section

### Search

Full-text search queries across datasets and jobs simultaneously. The backend queries two sources in parallel and merges results:

1. **Purview asset search** — Purview Data Map search API (`POST /dataMap/api/search/query` with keyword filter)
2. **Catalog table search** — Trino query against the catalog table:

```sql
SELECT namespace, dataset_name, description, owner, tags
FROM lakehouse._platform.catalog
WHERE
  LOWER(dataset_name) LIKE LOWER('%' || :q || '%')
  OR LOWER(description) LIKE LOWER('%' || :q || '%')
  OR ARRAY_JOIN(tags, ',') LIKE LOWER('%' || :q || '%')
LIMIT 50
```

Results are ranked by relevance: exact name match first, then name substring match, then description match, then tag match. Duplicate results (same dataset appearing in both Purview and catalog) are deduplicated by `(namespace, dataset_name)`.

### Tag Management

Tags are free-form string labels attached to datasets and pipelines. They are stored in the catalog Delta table and pipeline metadata store (also in ADLS). Tags are:

- Lowercase, hyphen-separated (`sales-domain`, `pii-data`, `sla-critical`)
- Applied via the portal (`PATCH /api/v1/datasets/{ns}/{name}/metadata`) or via the `forge-cli` (`forge dataset tag`)
- Searchable (included in full-text search index)
- Used for filtering the datasets list and pipelines list

### Ownership

Every dataset and pipeline has an `owner` field — an email address or Azure AD group alias. Ownership is:

- Required for all Gold layer datasets (enforced by the serving publish DAG, which fails if no owner is set in the catalog)
- Set via the portal or CLI
- Displayed prominently on dataset and pipeline detail pages
- Used by the impact analysis feature to identify who to contact

### SLA Definitions

SLA definitions for dataset freshness are stored in the catalog table (`sla_freshness_hours` column). The SLA is defined as: the maximum allowed age of the latest partition, in hours. For example, `sla_freshness_hours = 2` means the dataset must have data no older than 2 hours.

SLAs are set via the portal (`PATCH /api/v1/datasets/{ns}/{name}/metadata`) or via the DAG configuration. The serving publish DAG checks the SLA at publish time and fails if it is breached. The portal's dataset detail page shows:

- SLA definition (hours)
- Current freshness (age of latest partition)
- SLA status: OK / BREACHED
- SLA history: the last 30 days, colour-coded by status

---

## 11. Caching Strategy

The portal uses a two-tier caching strategy: client-side via React Query, and server-side via Redis (optional).

### Client-Side: React Query (Stale-While-Revalidate)

React Query is the primary data-fetching layer in the Next.js frontend. Every API call is managed by React Query with configured `staleTime` and `gcTime` values:

| Data Type | staleTime | gcTime | refetchInterval |
|-----------|-----------|--------|-----------------|
| DAG list | 30s | 5 min | 30s (auto-refresh) |
| DAG run history | 10s | 5 min | 10s if run is active |
| Task instance state | 5s | 2 min | 5s if run is active |
| Dataset catalog | 5 min | 30 min | None (manual) |
| Dataset schema | 10 min | 1 hour | None |
| Lineage graph | 2 min | 15 min | None |
| DQ summary | 1 min | 10 min | 1 min (auto-refresh) |
| DQ run history | 5 min | 30 min | None |
| Cost summary | 15 min | 1 hour | None |

The `staleTime` is the period during which cached data is served without a background refetch. After `staleTime` elapses, React Query serves the cached data immediately (stale-while-revalidate) while fetching fresh data in the background. This ensures the UI is always responsive even on a slow network, while staying close to real-time for pipeline state.

For active DAG runs (state = `running`), React Query uses `refetchInterval` to poll the backend every 5–10 seconds, updating the task grid in real time.

### Server-Side: Redis (Optional)

For expensive backend queries that are cheap to cache, the portal-api supports an optional Redis cache. Redis is not required for portal operation — the portal falls back to in-memory LRU caching if Redis is not configured.

When Redis is enabled (configured via `REDIS_URL` environment variable), the following queries are cached in Redis:

| Query | Cache Key | TTL |
|-------|-----------|-----|
| DQ pass rate (platform-wide) | `dq:summary:passrate` | 5 min |
| DQ trend (30 days) | `dq:trend:30d` | 15 min |
| Cost summary (current month) | `cost:summary:month` | 30 min |
| Cost by pipeline (7 days) | `cost:pipelines:7d` | 30 min |
| Lineage graph (dataset, depth=3) | `lineage:{ns}:{name}:d3` | 2 min |

Cache invalidation is TTL-based only — there is no event-driven cache invalidation. The TTL values are chosen to match the expected update frequency of each data type. DQ results update at pipeline frequency (typically hourly or daily); cost data updates daily from Azure Cost Management.

When Redis is not available (connection refused, timeout), the backend logs a warning and proceeds without caching — queries hit the upstream APIs directly. Redis failure does not degrade portal availability.

---

## 12. Deployment

### Kubernetes Pods

Both portal components run on the `platform` node pool of the `forge-orchestration` cluster:

```
Namespace: portal

Deployment: portal-web
  replicas: 2
  pod:
    containers:
      - name: portal-web
        image: forgeacr-prod.azurecr.io/portal-web:<git-sha>
        ports: [3000]
        resources:
          requests: { cpu: "250m", memory: "512Mi" }
          limits:   { cpu: "1",    memory: "1Gi" }
        livenessProbe:
          httpGet: { path: /api/health, port: 3000 }
          initialDelaySeconds: 15, periodSeconds: 10
        readinessProbe:
          httpGet: { path: /api/ready, port: 3000 }
          initialDelaySeconds: 5, periodSeconds: 5
        env:
          - NEXTAUTH_URL (from Key Vault via CSI)
          - NEXTAUTH_SECRET (from Key Vault via CSI)
          - AZURE_AD_CLIENT_ID (from Key Vault via CSI)
          - AZURE_AD_CLIENT_SECRET (from Key Vault via CSI)
          - PORTAL_API_URL: http://portal-api.portal.svc.cluster.local:8000

Deployment: portal-api
  replicas: 2
  pod:
    containers:
      - name: portal-api
        image: forgeacr-prod.azurecr.io/portal-api:<git-sha>
        ports: [8000]
        resources:
          requests: { cpu: "500m", memory: "512Mi" }
          limits:   { cpu: "2",    memory: "2Gi" }
        livenessProbe:
          httpGet: { path: /health, port: 8000 }
          initialDelaySeconds: 10, periodSeconds: 10
        readinessProbe:
          httpGet: { path: /ready, port: 8000 }
          initialDelaySeconds: 5, periodSeconds: 5
        env:
          - AIRFLOW_BASE_URL: http://airflow-webserver.airflow.svc.cluster.local:8080
          - PURVIEW_ACCOUNT: purview-forge-{env}
          - PURVIEW_ENDPOINT: https://purview-forge-{env}.purview.azure.com
          - TRINO_HOST: trino-coordinator.trino.svc.cluster.local
          - AZURE_AD_TENANT_ID (from Key Vault via CSI)
          - AZURE_SUBSCRIPTION_ID (from Key Vault via CSI)
          - ADLS_ACCOUNT_NAME (from Key Vault via CSI)
          - REDIS_URL (optional, from Key Vault via CSI)
```

### Services and Ingress

```
Service: portal-web (ClusterIP, port 3000)
Service: portal-api (ClusterIP, port 8000)

Ingress: portal-ingress
  annotations:
    kubernetes.io/ingress.class: azure/application-gateway
    appgw.ingress.kubernetes.io/ssl-redirect: "true"
  rules:
    - host: portal.forge.internal
      paths:
        - path: /api/v1/*   → portal-api:8000
        - path: /*          → portal-web:3000
```

The portal is exposed via Azure Application Gateway (WAF v2) at `https://portal.forge.internal`. The Application Gateway terminates TLS (certificate from Azure Key Vault). Traffic from the Application Gateway to the portal pods is HTTP on the private VNet.

### Rolling Update Strategy

Both deployments use Kubernetes rolling update strategy:

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1         # one extra pod during update
    maxUnavailable: 0   # never take a pod offline before replacement is ready
```

This ensures zero downtime during deployments. With 2 replicas and `maxUnavailable: 0`, the update sequence is:

1. Spin up 1 new pod (total: 3 pods — 2 old + 1 new)
2. Wait for new pod readiness probe to pass
3. Terminate 1 old pod (total: 2 pods — 1 old + 1 new)
4. Spin up 1 new pod (total: 3 pods — 1 old + 2 new)
5. Wait for readiness
6. Terminate last old pod (total: 2 new pods)

### Image Tagging and CD Pipeline

Portal images are tagged with the Git commit SHA (`portal-web:a3f91bc`). The ADO release pipeline deploys the Helm chart on every merge to `main`:

```yaml
# infra/pipelines/release-portal.yml (excerpt)
- stage: Deploy
  jobs:
    - deployment: HelmUpgrade
      environment: forge-orchestration-dev
      steps:
        - task: HelmDeploy@0
          inputs:
            command: upgrade
            chartPath: infra/helm/orchestration/portal
            releaseName: portal
            namespace: portal
            valueFile: infra/helm/orchestration/portal/values-$(environment).yaml
```

To deploy a new portal version: update the image tag in the Helm values file and merge to `main`. The ADO pipeline triggers automatically and runs `helm upgrade`. No manual `kubectl apply` is run in production.

---

## 13. Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                              Corporate Network / VPN                               │
│                                                                                    │
│   ┌─────────────────────────────────────────────────────────────────────────────┐  │
│   │  Engineer's Browser                                                         │  │
│   │                                                                             │  │
│   │  ┌──────────────────────────────────────────────────────────────────────┐   │  │
│   │  │  Next.js 14 App (React, React Query, ReactFlow, NextAuth.js)         │   │  │
│   │  │                                                                      │   │  │
│   │  │  Pipelines  │  Datasets  │  Lineage  │  DQ  │  Cost  │  Metadata    │   │  │ 
│   │  └──────────────────────────────────────────────────────────────────────┘   │  │
│   └──────────────────────────────────────┬──────────────────────────────────────┘  │
│                                          │  HTTPS                                  │
└──────────────────────────────────────────┼────────────────────────────────────────┘
                                           │
                               ┌───────────▼────────────┐
                               │  Azure Application      │
                               │  Gateway (WAF v2)        │
                               │  TLS termination         │
                               │  portal.forge.internal │
                               └───────────┬────────────┘
                                           │  HTTP (private VNet)
                         ┌─────────────────┴─────────────────┐
                         │                                   │
                         ▼                                   ▼
             ┌───────────────────────┐           ┌──────────────────────┐
             │  portal-web (pod ×2)  │           │  portal-api (pod ×2) │
             │  Next.js 14           │           │  FastAPI Python 3.11 │
             │  App Router           │  ◀──────  │                      │
             │  NextAuth.js (OIDC)   │  REST/JSON│  JWT validation      │
             │  React Query          │           │  RBAC enforcement    │
             │  ReactFlow (lineage)  │           │  Data aggregation    │
             └───────────────────────┘           └──────────┬───────────┘
                         │                                  │ 
                         │  /api/auth/*                     │ 
                         ▼                                  │
             ┌───────────────────────┐                      │
             │  login.microsoft..    │                      │
             │  Azure AD OIDC        │                      │
             │  Token issuance       │                      │
             └───────────────────────┘                      │
                                                            │
                    ┌───────────────────────────────────────┤
                    │                                       │
          ┌─────────▼───────────┐              ┌───────────▼──────────┐
          │  Airflow REST API   │              │  Purview Data Map    │
          │  airflow-webserver  │              │  API                 │
          │  .airflow.svc       │              │  .lineage.svc        │
          │                     │              │                      │
          │  DAG list           │              │  Lineage graph       │
          │  Run history        │              │  Dataset versions    │
          │  Task state         │              │  Job list            │
          │  Task logs          │              │  Column lineage      │
          │  Manual trigger     │              └──────────────────────┘
          └─────────────────────┘
                                               ┌──────────────────────┐
                    ┌──────────────────────────▶  Trino Coordinator   │
                    │                          │  .trino.svc          │
                    │                          │                      │
                    │                          │  DQ results queries  │
                    │                          │  Dataset preview     │
                    │                          │  Row count fallback  │
                    │                          └──────────┬───────────┘
                    │                                     │            
                    │              ┌──────────────────────▼───────────┐
                    │              │  ADLS Gen2 (via Trino Delta conn) │
                    │              │  silver/_platform/dq_results/   │ 
                    │              │  silver/_platform/catalog/      │ 
                    │              └──────────────────────────────────┘
                    │
          ┌─────────▼───────────┐
          │  Azure Cost Mgmt    │
          │  API (azure-mgmt-   │
          │  costmanagement)    │
          │                     │
          │  Spend by resource  │
          │  Spend by tag       │
          │  Anomaly detection  │
          └─────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  Optional Redis Cache (portal namespace)                        │
  │  TTL-based caching for DQ trends, cost summaries, lineage       │
  │  Falls back to in-memory LRU if Redis unavailable               │
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │  ADLS Gen2 (direct read — portal workload identity)             │
  │  silver/_platform/catalog/   ← dataset catalog Delta table     │ 
  │  DeltaTable.forPath() — metadata only, no data file reads       │
  └─────────────────────────────────────────────────────────────────┘
```
