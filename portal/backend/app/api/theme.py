"""Per-user theme preference endpoint.

GET  /api/v1/theme            → { primary_color: str }
PUT  /api/v1/theme  { primary_color } → { primary_color: str }

Storage strategy:
  - In-cluster (pg_host set): asyncpg → PostgreSQL `portal` DB, `user_preferences` table.
    Auth via AKS workload identity OIDC token exchange (no password in config).
  - Local dev (pg_host blank): JSON sidecar file on disk — same pattern as platform.py.

Auth on the endpoints is optional.  When a valid Bearer token is present the
preference is keyed by the AAD object-id (oid) claim.  Without a token a
single global fallback key is used.
"""
from __future__ import annotations

import asyncio
import json as _json
import pathlib as _pathlib
import ssl
from typing import Any

import structlog
from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.core.config import get_settings

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["theme"])
settings = get_settings()

_DEFAULT_COLOR = "#1e3a5f"

# ---------------------------------------------------------------------------
# Local dev fallback (no Postgres configured)
# ---------------------------------------------------------------------------
_LOCAL_FILE = _pathlib.Path(__file__).parent.parent.parent / ".forge-theme-prefs.json"


def _local_load() -> dict[str, str]:
    try:
        return _json.loads(_LOCAL_FILE.read_text()) if _LOCAL_FILE.exists() else {}
    except Exception:
        return {}


def _local_save(data: dict[str, str]) -> None:
    try:
        _LOCAL_FILE.write_text(_json.dumps(data, indent=2))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Postgres helpers
# ---------------------------------------------------------------------------

async def _pg_token() -> str:
    """Fetch an AAD access token for Postgres using AKS workload identity."""
    from azure.identity import WorkloadIdentityCredential  # type: ignore
    cred = WorkloadIdentityCredential()
    token_obj = await asyncio.to_thread(
        cred.get_token,
        "https://ossrdbms-aad.database.windows.net/.default",
    )
    return token_obj.token


async def _pg_connect():  # type: ignore[return]
    """Return an asyncpg connection, or None if Postgres is not configured."""
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
        log.warning("pg_connect_failed", error=str(exc))
        return None


async def _ensure_table(conn: Any) -> None:
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id    TEXT PRIMARY KEY,
            theme_color TEXT NOT NULL,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)


# ---------------------------------------------------------------------------
# User key
# ---------------------------------------------------------------------------

def _user_key(request: Request) -> str:
    """Return the user email from proxy-injected header, else '_global'."""
    return request.headers.get("X-User-Email", "_global") or "_global"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ThemeResponse(BaseModel):
    primary_color: str


class ThemeRequest(BaseModel):
    primary_color: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/theme", response_model=ThemeResponse)
async def get_theme(request: Request) -> ThemeResponse:
    key = _user_key(request)
    conn = await _pg_connect()
    if conn is not None:
        try:
            await _ensure_table(conn)
            row = await conn.fetchrow(
                "SELECT theme_color FROM user_preferences WHERE user_id = $1", key
            )
            color = row["theme_color"] if row else _DEFAULT_COLOR
        except Exception as exc:
            log.warning("pg_get_theme_failed", error=str(exc))
            color = _DEFAULT_COLOR
        finally:
            await conn.close()
    else:
        color = _local_load().get(key, _DEFAULT_COLOR)
    return ThemeResponse(primary_color=color)


@router.put("/theme", response_model=ThemeResponse)
async def put_theme(request: Request, body: ThemeRequest) -> ThemeResponse:
    color = body.primary_color.strip() or _DEFAULT_COLOR
    key = _user_key(request)
    conn = await _pg_connect()
    if conn is not None:
        try:
            await _ensure_table(conn)
            await conn.execute("""
                INSERT INTO user_preferences (user_id, theme_color, updated_at)
                VALUES ($1, $2, now())
                ON CONFLICT (user_id) DO UPDATE
                  SET theme_color = EXCLUDED.theme_color,
                      updated_at  = now()
            """, key, color)
            log.info("theme_saved_pg", key=key, color=color)
        except Exception as exc:
            log.warning("pg_put_theme_failed", error=str(exc))
        finally:
            await conn.close()
    else:
        data = _local_load()
        data[key] = color
        _local_save(data)
        log.info("theme_saved_local", key=key, color=color)
    return ThemeResponse(primary_color=color)
