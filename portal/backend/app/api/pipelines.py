"""Pipeline (Airflow DAG) API routes."""
from __future__ import annotations

import asyncio
import ssl
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services import airflow_client

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/pipelines", tags=["pipelines"])
settings = get_settings()

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


class TriggerRequest(BaseModel):
    conf: dict[str, Any] = {}
    force: bool = False  # if True, cancel active run for this slot first then retrigger


class RegisterRequest(BaseModel):
    dag_id: str
    owner_alias: str = ""


# ---------------------------------------------------------------------------
# Postgres helpers — pipeline_deployments table (same pattern as theme.py)
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
            host=settings.pg_host, port=5432, database="portal",
            user=settings.pg_user, password=token, ssl=ssl_ctx,
        )
        return conn
    except Exception as exc:
        log.warning("pg_connect_failed", error=str(exc))
        return None


async def _ensure_deployments_table(conn: Any) -> None:
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS pipeline_deployments (
            dag_id       TEXT PRIMARY KEY,
            owner_email  TEXT NOT NULL,
            owner_alias  TEXT NOT NULL DEFAULT '',
            deployed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)


def _summarise_dag(dag: dict[str, Any], runs: list[dict[str, Any]]) -> dict[str, Any]:
    last_run = runs[0] if runs else None
    last_run_state = None
    last_run_at = None
    if last_run:
        last_run_state = last_run.get("state")
        # Use logical_date as fallback so queued/running runs (no start_date yet) still show a date
        last_run_at = (
            last_run.get("start_date")
            or last_run.get("execution_date")
            or last_run.get("logical_date")
        )

    tags = [t.get("name", "") for t in dag.get("tags", [])]

    return {
        "dag_id": dag.get("dag_id", ""),
        "description": dag.get("description") or "",
        "is_active": not dag.get("is_paused", True),
        "is_paused": dag.get("is_paused", False),
        "last_run_state": last_run_state,
        "last_run_at": last_run_at,
        "last_run_id": last_run.get("dag_run_id") if last_run else None,
        "next_run_at": dag.get("next_dagrun"),
        "schedule": dag.get("schedule_interval") or dag.get("timetable_description"),
        "tags": tags,
    }


@router.get("")
async def list_pipelines(current_user: CurrentUser) -> list[dict[str, Any]]:
    """List all DAGs with their last run state."""
    try:
        dags = await airflow_client.get_dags(limit=100, only_active=False)
    except Exception as exc:
        log.error("list_pipelines_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc

    results: list[dict[str, Any]] = []
    for dag in dags:
        dag_id = dag.get("dag_id", "")
        try:
            runs = await airflow_client.get_dag_runs(dag_id, limit=1)
        except Exception:
            runs = []
        results.append(_summarise_dag(dag, runs))

    return results


@router.post("/register", status_code=200)
async def register_pipeline(body: RegisterRequest, current_user: CurrentUser) -> dict[str, str]:
    """Register (or re-register) a DAG deployment. Called by sync-jobs.sh via Bearer token."""
    email = current_user.get("email", "")
    alias = body.owner_alias or current_user.get("name", "")
    conn = await _pg_connect()
    if conn is not None:
        try:
            await _ensure_deployments_table(conn)
            await conn.execute("""
                INSERT INTO pipeline_deployments (dag_id, owner_email, owner_alias, deployed_at)
                VALUES ($1, $2, $3, now())
                ON CONFLICT (dag_id) DO UPDATE
                  SET owner_email = EXCLUDED.owner_email,
                      owner_alias = EXCLUDED.owner_alias,
                      deployed_at = now()
            """, body.dag_id, email, alias)
            log.info("pipeline_registered", dag_id=body.dag_id, owner=email)
        except Exception as exc:
            log.warning("pg_register_pipeline_failed", error=str(exc))
        finally:
            await conn.close()
    return {"dag_id": body.dag_id, "owner_email": email}


@router.get("/mine")
async def list_mine(current_user: CurrentUser) -> list[str]:
    """Return dag_ids owned by the current user."""
    email = current_user.get("email", "")
    conn = await _pg_connect()
    if conn is None:
        return []
    try:
        await _ensure_deployments_table(conn)
        rows = await conn.fetch(
            "SELECT dag_id FROM pipeline_deployments WHERE owner_email = $1", email
        )
        return [r["dag_id"] for r in rows]
    except Exception as exc:
        log.warning("pg_list_mine_failed", error=str(exc))
        return []
    finally:
        await conn.close()


@router.get("/mine/count")
async def count_mine(current_user: CurrentUser) -> dict[str, int]:
    """Return the number of DAGs owned by the current user. Used by sync-jobs.sh for DAG limit check."""
    email = current_user.get("email", "")
    conn = await _pg_connect()
    if conn is None:
        return {"count": 0}
    try:
        await _ensure_deployments_table(conn)
        row = await conn.fetchrow(
            "SELECT COUNT(*) as count FROM pipeline_deployments WHERE owner_email = $1", email
        )
        return {"count": int(row["count"])}
    except Exception as exc:
        log.warning("pg_count_mine_failed", error=str(exc))
        return {"count": 0}
    finally:
        await conn.close()


@router.get("/{dag_id}")
async def get_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """Get a single DAG with recent runs and ownership info."""
    try:
        dag = await airflow_client.get_dag(dag_id)
    except Exception as exc:
        log.error("get_pipeline_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc

    try:
        runs = await airflow_client.get_dag_runs(dag_id, limit=90)
    except Exception:
        runs = []

    summary = _summarise_dag(dag, runs)
    summary["recent_runs"] = runs
    summary["doc_md"] = dag.get("doc_md") or ""

    # Task structure for flow graph
    try:
        tasks_def = await airflow_client.get_dag_tasks(dag_id)
        summary["tasks_def"] = tasks_def
    except Exception:
        summary["tasks_def"] = []

    # Enrich with ownership info from Postgres
    conn = await _pg_connect()
    if conn is not None:
        try:
            await _ensure_deployments_table(conn)
            row = await conn.fetchrow(
                "SELECT owner_email, owner_alias, deployed_at FROM pipeline_deployments WHERE dag_id = $1",
                dag_id,
            )
            if row:
                summary["owner_email"] = row["owner_email"]
                summary["owner_alias"] = row["owner_alias"]
                summary["deployed_at"] = row["deployed_at"].isoformat() if row["deployed_at"] else None
        except Exception:
            pass
        finally:
            await conn.close()

    return summary


@router.get("/{dag_id}/runs")
async def get_pipeline_runs(dag_id: str, current_user: CurrentUser) -> list[dict[str, Any]]:
    """Get the last 20 runs for a DAG, including task counts."""
    try:
        runs = await airflow_client.get_dag_runs(dag_id, limit=20)
    except Exception as exc:
        log.error("get_pipeline_runs_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc

    enriched: list[dict[str, Any]] = []
    for run in runs:
        run_id = run.get("dag_run_id", "")
        try:
            tasks = await airflow_client.get_task_instances(dag_id, run_id)
        except Exception:
            tasks = []

        task_counts: dict[str, int] = {}
        for t in tasks:
            state = t.get("state") or "none"
            task_counts[state] = task_counts.get(state, 0) + 1

        run_copy = dict(run)
        run_copy["task_counts"] = task_counts
        run_copy["total_tasks"] = len(tasks)
        enriched.append(run_copy)

    return enriched


@router.get("/{dag_id}/runs/{run_id}/tasks")
async def get_run_tasks(dag_id: str, run_id: str, current_user: CurrentUser) -> list[dict[str, Any]]:
    """Get task instances for a specific DAG run."""
    try:
        return await airflow_client.get_task_instances(dag_id, run_id)
    except Exception as exc:
        log.error("get_run_tasks_failed", dag_id=dag_id, run_id=run_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc


@router.get("/{dag_id}/runs/{run_id}/tasks/{task_id}/logs")
async def get_task_logs(
    dag_id: str, run_id: str, task_id: str,
    current_user: CurrentUser,
    attempt: int = 1,
) -> dict[str, Any]:
    """Fetch Airflow task logs for a specific task instance attempt."""
    try:
        logs = await airflow_client.get_task_logs(dag_id, run_id, task_id, attempt)
        return {"logs": logs, "attempt": attempt}
    except Exception as exc:
        log.error("get_task_logs_failed", dag_id=dag_id, run_id=run_id, task_id=task_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not fetch task logs") from exc


@router.post("/{dag_id}/runs/{run_id}/cancel")
async def cancel_run(dag_id: str, run_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """Cancel a running or queued DAG run. Required before retriggering."""
    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    if not any(r.lower() in ("admin", "editor") for r in roles):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only Admin or Editor roles can cancel runs")
    try:
        result = await airflow_client.cancel_dag_run(dag_id, run_id)
        log.info("run_cancelled", dag_id=dag_id, run_id=run_id, user=current_user.get("sub"))
        return result
    except Exception as exc:
        log.error("cancel_run_failed", dag_id=dag_id, run_id=run_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not cancel DAG run") from exc


@router.post("/{dag_id}/pause")
async def pause_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """Pause a DAG."""
    try:
        return await airflow_client.set_dag_paused(dag_id, True)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Could not pause DAG") from exc


@router.post("/{dag_id}/unpause")
async def unpause_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """Unpause a DAG."""
    try:
        return await airflow_client.set_dag_paused(dag_id, False)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Could not unpause DAG") from exc


@router.delete("/{dag_id}")
async def delete_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, str]:
    """Delete a DAG from Airflow and deregister ownership. Dev environment only."""
    if settings.forge_env != "dev":
        raise HTTPException(status_code=403, detail="Pipeline deletion is only allowed in dev")

    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    if not any(r.lower() in ("admin", "editor") for r in roles):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only Admin or Editor roles can delete pipelines")

    try:
        await airflow_client.delete_dag(dag_id)
    except Exception as exc:
        log.error("delete_pipeline_airflow_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not delete DAG from Airflow") from exc

    conn = await _pg_connect()
    if conn is not None:
        try:
            await conn.execute("DELETE FROM pipeline_deployments WHERE dag_id = $1", dag_id)
        except Exception as exc:
            log.warning("pg_delete_pipeline_failed", dag_id=dag_id, error=str(exc))
        finally:
            await conn.close()

    log.info("pipeline_deleted", dag_id=dag_id, user=current_user.get("sub"))
    return {"dag_id": dag_id, "status": "deleted"}


@router.post("/{dag_id}/trigger")
async def trigger_pipeline(
    dag_id: str,
    body: TriggerRequest,
    current_user: CurrentUser,
) -> dict[str, Any]:
    """Trigger a DAG run. Requires Admin or Editor role."""
    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    roles_lower = [r.lower() for r in roles]
    if "admin" not in roles_lower and "editor" not in roles_lower:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Admin or Editor roles can trigger pipelines",
        )

    # Enforce one-run-per-slot rule:
    # If a run is active (running/queued) for the current slot, either block or cancel+retrigger.
    try:
        recent = await airflow_client.get_dag_runs(dag_id, limit=1)
        active = recent[0] if recent and recent[0].get("state") in ("running", "queued") else None
        if active:
            active_run_id = active.get("dag_run_id", "")
            if not body.force:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "message": "A run is already active for this slot. Use force=true to cancel it and retrigger.",
                        "active_run_id": active_run_id,
                        "active_state": active.get("state"),
                    },
                )
            # force=True — cancel active run first
            log.info("retrigger_cancel_active", dag_id=dag_id, run_id=active_run_id, user=current_user.get("sub"))
            try:
                await airflow_client.cancel_dag_run(dag_id, active_run_id)
            except Exception as exc:
                log.error("retrigger_cancel_failed", dag_id=dag_id, run_id=active_run_id, error=str(exc))
                raise HTTPException(status_code=502, detail="Could not cancel active run before retriggering") from exc
    except HTTPException:
        raise
    except Exception:
        pass  # if we can't check, allow the trigger through

    try:
        result = await airflow_client.trigger_dag(dag_id, conf=body.conf)
        log.info("pipeline_triggered", dag_id=dag_id, force=body.force, user=current_user.get("sub"))
        return result
    except Exception as exc:
        log.error("trigger_pipeline_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not trigger DAG in Airflow") from exc
