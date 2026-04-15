"""Data Sources registry endpoint.

GET    /api/v1/datasources           → list all registered sources
POST   /api/v1/datasources           → register a new source
PUT    /api/v1/datasources/{id}      → update a source
DELETE /api/v1/datasources/{id}      → delete a source

Storage: asyncpg → PostgreSQL `portal` DB, `data_sources` table.
Auth via AKS workload identity OIDC token (same as theme.py).

Source types:
  adls_gen2 — Azure Data Lake Storage Gen2
  adx       — Azure Data Explorer (Kusto)

Non-sensitive config is stored as JSONB.  If credentials are needed
(e.g. ADX client secret), the Key Vault secret *name* is stored in
`credential_kv_secret`; the secret value itself never enters Postgres.
"""
from __future__ import annotations

import asyncio
import ssl
import uuid
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.core.config import get_settings

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["datasources"])
settings = get_settings()

# ---------------------------------------------------------------------------
# Postgres helpers (same pattern as theme.py)
# ---------------------------------------------------------------------------

async def _pg_token() -> str:
    from azure.identity import WorkloadIdentityCredential  # type: ignore
    cred = WorkloadIdentityCredential()
    token_obj = await asyncio.to_thread(
        cred.get_token,
        "https://ossrdbms-aad.database.windows.net/.default",
    )
    return token_obj.token


async def _pg_connect():  # type: ignore[return]
    if not settings.pg_host or not settings.pg_user:
        return None
    try:
        import asyncpg  # type: ignore
        token = await _pg_token()
        ssl_ctx = ssl.create_default_context()
        conn = await asyncpg.connect(
            host=settings.pg_host,
            port=5432,
            database="portal",
            user=settings.pg_user,
            password=token,
            ssl=ssl_ctx,
        )
        return conn
    except Exception as exc:
        log.warning("ds_pg_connect_failed", error=str(exc))
        return None


async def _ensure_table(conn: Any) -> None:
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS data_sources (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name                TEXT UNIQUE NOT NULL,
            display_name        TEXT NOT NULL,
            description         TEXT NOT NULL DEFAULT '',
            source_type         TEXT NOT NULL,
            config              JSONB NOT NULL DEFAULT '{}',
            auth_type           TEXT NOT NULL DEFAULT 'managed_identity',
            credential_kv_secret TEXT,
            created_by          TEXT NOT NULL DEFAULT '',
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class DataSourceBase(BaseModel):
    name: str = Field(..., pattern=r'^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$',
                      description="Slug used in pipeline params (lowercase, hyphens only)")
    display_name: str
    description: str = ""
    source_type: str = Field(..., pattern=r'^(adls_gen2|adx)$')
    config: dict = Field(default_factory=dict)
    auth_type: str = "managed_identity"
    credential_kv_secret: str | None = None


class DataSourceCreate(DataSourceBase):
    pass


class DataSourceUpdate(BaseModel):
    display_name: str | None = None
    description: str | None = None
    config: dict | None = None
    auth_type: str | None = None
    credential_kv_secret: str | None = None


class DataSourceResponse(DataSourceBase):
    id: str
    created_by: str
    created_at: str
    updated_at: str


def _row_to_response(row: Any) -> DataSourceResponse:
    import json
    cfg = row["config"]
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    return DataSourceResponse(
        id=str(row["id"]),
        name=row["name"],
        display_name=row["display_name"],
        description=row["description"] or "",
        source_type=row["source_type"],
        config=cfg if cfg else {},
        auth_type=row["auth_type"],
        credential_kv_secret=row["credential_kv_secret"],
        created_by=row["created_by"] or "",
        created_at=row["created_at"].isoformat() if row["created_at"] else "",
        updated_at=row["updated_at"].isoformat() if row["updated_at"] else "",
    )


def _user(request: Request) -> str:
    return request.headers.get("X-User-Email", "unknown") or "unknown"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/datasources", response_model=list[DataSourceResponse])
async def list_datasources() -> list[DataSourceResponse]:
    conn = await _pg_connect()
    if conn is None:
        return []
    try:
        await _ensure_table(conn)
        rows = await conn.fetch(
            "SELECT * FROM data_sources ORDER BY display_name ASC"
        )
        return [_row_to_response(r) for r in rows]
    except Exception as exc:
        log.warning("ds_list_failed", error=str(exc))
        return []
    finally:
        await conn.close()


@router.post("/datasources", response_model=DataSourceResponse, status_code=201)
async def create_datasource(request: Request, body: DataSourceCreate) -> DataSourceResponse:
    import json
    conn = await _pg_connect()
    if conn is None:
        raise HTTPException(status_code=503, detail="Database not available")
    try:
        await _ensure_table(conn)
        row = await conn.fetchrow("""
            INSERT INTO data_sources
                (name, display_name, description, source_type, config,
                 auth_type, credential_kv_secret, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        """,
            body.name,
            body.display_name,
            body.description,
            body.source_type,
            json.dumps(body.config),
            body.auth_type,
            body.credential_kv_secret,
            _user(request),
        )
        log.info("ds_created", name=body.name, by=_user(request))
        return _row_to_response(row)
    except Exception as exc:
        err = str(exc)
        if "unique" in err.lower() or "duplicate" in err.lower():
            raise HTTPException(status_code=409, detail=f"A data source named '{body.name}' already exists")
        log.warning("ds_create_failed", error=err)
        raise HTTPException(status_code=500, detail="Failed to create data source")
    finally:
        await conn.close()


@router.put("/datasources/{source_id}", response_model=DataSourceResponse)
async def update_datasource(source_id: str, body: DataSourceUpdate) -> DataSourceResponse:
    import json
    # Validate UUID
    try:
        uuid.UUID(source_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid source ID")

    conn = await _pg_connect()
    if conn is None:
        raise HTTPException(status_code=503, detail="Database not available")
    try:
        await _ensure_table(conn)
        current = await conn.fetchrow("SELECT * FROM data_sources WHERE id = $1", uuid.UUID(source_id))
        if not current:
            raise HTTPException(status_code=404, detail="Data source not found")

        new_display = body.display_name if body.display_name is not None else current["display_name"]
        new_desc = body.description if body.description is not None else current["description"]
        new_config = json.dumps(body.config) if body.config is not None else json.dumps(current["config"] or {})
        new_auth = body.auth_type if body.auth_type is not None else current["auth_type"]
        new_kv = body.credential_kv_secret if body.credential_kv_secret is not None else current["credential_kv_secret"]

        row = await conn.fetchrow("""
            UPDATE data_sources
               SET display_name = $1, description = $2, config = $3,
                   auth_type = $4, credential_kv_secret = $5, updated_at = now()
             WHERE id = $6
            RETURNING *
        """, new_display, new_desc, new_config, new_auth, new_kv, uuid.UUID(source_id))

        log.info("ds_updated", id=source_id)
        return _row_to_response(row)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("ds_update_failed", error=str(exc))
        raise HTTPException(status_code=500, detail="Failed to update data source")
    finally:
        await conn.close()


@router.delete("/datasources/{source_id}")
async def delete_datasource(source_id: str) -> Response:
    try:
        uuid.UUID(source_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid source ID")

    conn = await _pg_connect()
    if conn is None:
        raise HTTPException(status_code=503, detail="Database not available")
    try:
        await _ensure_table(conn)
        result = await conn.execute(
            "DELETE FROM data_sources WHERE id = $1", uuid.UUID(source_id)
        )
        if result == "DELETE 0":
            raise HTTPException(status_code=404, detail="Data source not found")
        log.info("ds_deleted", id=source_id)
        return Response(status_code=204)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("ds_delete_failed", error=str(exc))
        raise HTTPException(status_code=500, detail="Failed to delete data source")
    finally:
        await conn.close()
