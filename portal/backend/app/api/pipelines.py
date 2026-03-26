"""Pipeline (Airflow DAG) API routes."""
from __future__ import annotations

from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.services import airflow_client

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/pipelines", tags=["pipelines"])

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


class TriggerRequest(BaseModel):
    conf: dict[str, Any] = {}


def _summarise_dag(dag: dict[str, Any], runs: list[dict[str, Any]]) -> dict[str, Any]:
    last_run = runs[0] if runs else None
    last_run_state = None
    last_run_at = None
    if last_run:
        last_run_state = last_run.get("state")
        last_run_at = last_run.get("execution_date") or last_run.get("start_date")

    tags = [t.get("name", "") for t in dag.get("tags", [])]

    return {
        "dag_id": dag.get("dag_id", ""),
        "description": dag.get("description") or "",
        "is_active": not dag.get("is_paused", True),
        "is_paused": dag.get("is_paused", False),
        "last_run_state": last_run_state,
        "last_run_at": last_run_at,
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


@router.get("/{dag_id}")
async def get_pipeline(dag_id: str, current_user: CurrentUser) -> dict[str, Any]:
    """Get a single DAG with recent runs."""
    try:
        dag = await airflow_client.get_dag(dag_id)
    except Exception as exc:
        log.error("get_pipeline_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not reach Airflow") from exc

    try:
        runs = await airflow_client.get_dag_runs(dag_id, limit=10)
    except Exception:
        runs = []

    summary = _summarise_dag(dag, runs)
    summary["recent_runs"] = runs
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

    try:
        result = await airflow_client.trigger_dag(dag_id, conf=body.conf)
        log.info("pipeline_triggered", dag_id=dag_id, user=current_user.get("sub"))
        return result
    except Exception as exc:
        log.error("trigger_pipeline_failed", dag_id=dag_id, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not trigger DAG in Airflow") from exc
