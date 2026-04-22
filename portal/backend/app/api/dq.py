"""Data Quality API routes."""
from __future__ import annotations

import asyncio
import ssl
from datetime import datetime, timezone
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.core.config import get_settings

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/dq", tags=["dq"])

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]
settings = get_settings()

# ---------------------------------------------------------------------------
# Postgres helpers (same pattern as theme.py / pipelines.py)
# ---------------------------------------------------------------------------

async def _pg_token() -> str:
    from azure.identity import WorkloadIdentityCredential  # type: ignore
    cred = WorkloadIdentityCredential()
    token_obj = await asyncio.to_thread(
        cred.get_token, "https://ossrdbms-aad.database.windows.net/.default"
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
        log.warning("dq_pg_connect_failed", error=str(exc))
        return None


async def _ensure_table(conn: Any) -> None:
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS dq_results (
            id              SERIAL PRIMARY KEY,
            dataset         TEXT NOT NULL,
            pipeline_name   TEXT NOT NULL DEFAULT '',
            run_id          TEXT NOT NULL,
            overall_status  TEXT NOT NULL,
            total_rules     INT  NOT NULL DEFAULT 0,
            passes          INT  NOT NULL DEFAULT 0,
            critical_failures TEXT NOT NULL DEFAULT '',
            warnings        INT  NOT NULL DEFAULT 0,
            run_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    # Index for fast per-dataset lookups
    await conn.execute("""
        CREATE INDEX IF NOT EXISTS dq_results_dataset_idx ON dq_results (dataset, run_at DESC)
    """)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class DQIngestRequest(BaseModel):
    dataset: str
    pipeline_name: str = ""
    run_id: str
    overall_status: str  # PASS | FAIL | WARN
    total_rules: int = 0
    passes: int = 0
    critical_failures: list[str] = []
    warnings: int = 0
    run_at: str = ""  # ISO timestamp; defaults to now() if blank


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/summary")
async def get_dq_summary(current_user: CurrentUser) -> list[dict[str, Any]]:
    """Return DQ pass rate and critical failures per dataset (from Postgres)."""
    conn = await _pg_connect()
    if conn is None:
        return []
    try:
        await _ensure_table(conn)
        rows = await conn.fetch("""
            SELECT
                dataset,
                COUNT(*)                                                     AS total_runs,
                SUM(CASE WHEN overall_status = 'PASS' THEN 1 ELSE 0 END)    AS passes,
                SUM(CASE WHEN critical_failures <> '' THEN 1 ELSE 0 END)     AS critical_failures,
                SUM(warnings)                                                AS warnings,
                MAX(run_at)                                                  AS last_run_at,
                (ARRAY_AGG(overall_status ORDER BY run_at DESC))[1]          AS last_status
            FROM dq_results
            GROUP BY dataset
            ORDER BY dataset
        """)
        results = []
        for r in rows:
            total = r["total_runs"] or 0
            passes = r["passes"] or 0
            last_run_at = r["last_run_at"]
            results.append({
                "dataset": r["dataset"],
                "total_runs": total,
                "pass_rate": round(passes / total, 4) if total > 0 else 0.0,
                "last_run_at": last_run_at.isoformat() if last_run_at else "",
                "critical_failures": r["critical_failures"] or 0,
                "warnings": r["warnings"] or 0,
                "last_status": r["last_status"] or "PASS",
            })
        return results
    except Exception as exc:
        log.error("dq_summary_failed", error=str(exc))
        return []
    finally:
        await conn.close()


@router.get("/{safe_dataset_name}")
async def get_dq_dataset(
    safe_dataset_name: str, current_user: CurrentUser
) -> list[dict[str, Any]]:
    """Return recent rule results for a single dataset (from Postgres)."""
    conn = await _pg_connect()
    if conn is None:
        return []
    try:
        await _ensure_table(conn)
        rows = await conn.fetch("""
            SELECT run_id, overall_status, total_rules, passes, critical_failures, warnings, run_at
            FROM dq_results
            WHERE dataset = $1
            ORDER BY run_at DESC
            LIMIT 50
        """, safe_dataset_name)
        return [dict(r) for r in rows]
    except Exception as exc:
        log.error("dq_dataset_failed", dataset=safe_dataset_name, error=str(exc))
        return []
    finally:
        await conn.close()


@router.post("/ingest")
async def ingest_dq_result(body: DQIngestRequest) -> dict[str, str]:
    """Ingest a DQ run summary from Spark/Airflow (no user auth — internal service call).

    The Spark DQ runner (forge_dq) calls this endpoint after each DQ run via
    the FORGE_PORTAL_API_URL environment variable. Results are stored in Postgres
    and surfaced on the DQ portal page.
    """
    conn = await _pg_connect()
    if conn is None:
        log.warning("dq_ingest_no_pg", dataset=body.dataset)
        return {"status": "skipped", "reason": "postgres not configured"}
    try:
        await _ensure_table(conn)
        run_at = body.run_at or datetime.now(timezone.utc).isoformat()
        critical_str = ",".join(body.critical_failures)
        await conn.execute("""
            INSERT INTO dq_results (dataset, pipeline_name, run_id, overall_status, total_rules, passes, critical_failures, warnings, run_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
        """, body.dataset, body.pipeline_name, body.run_id, body.overall_status,
            body.total_rules, body.passes, critical_str, body.warnings, run_at)
        log.info("dq_ingest_ok", dataset=body.dataset, status=body.overall_status)
        return {"status": "ok"}
    except Exception as exc:
        log.error("dq_ingest_failed", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await conn.close()
