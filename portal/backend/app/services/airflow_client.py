"""Async Airflow REST API v1 client."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import get_settings

log = structlog.get_logger(__name__)
settings = get_settings()


def _airflow_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=settings.airflow_url,
        auth=(settings.airflow_username, settings.airflow_password),
        headers={"Content-Type": "application/json"},
        timeout=30.0,
    )


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_dags(limit: int = 100, only_active: bool = True) -> list[dict[str, Any]]:
    async with _airflow_client() as client:
        params: dict[str, Any] = {"limit": limit}
        if only_active:
            params["only_active"] = True
        resp = client.get("/api/v1/dags", params=params)
        resp = await resp
        resp.raise_for_status()
        data = resp.json()
        return data.get("dags", [])


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_dag(dag_id: str) -> dict[str, Any]:
    async with _airflow_client() as client:
        resp = await client.get(f"/api/v1/dags/{dag_id}")
        resp.raise_for_status()
        return resp.json()


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_dag_runs(dag_id: str, limit: int = 10) -> list[dict[str, Any]]:
    async with _airflow_client() as client:
        params = {"limit": limit, "order_by": "-execution_date"}
        resp = await client.get(f"/api/v1/dags/{dag_id}/dagRuns", params=params)
        resp.raise_for_status()
        data = resp.json()
        return data.get("dag_runs", [])


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_task_instances(dag_id: str, run_id: str) -> list[dict[str, Any]]:
    async with _airflow_client() as client:
        resp = await client.get(
            f"/api/v1/dags/{dag_id}/dagRuns/{run_id}/taskInstances"
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("task_instances", [])


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def trigger_dag(dag_id: str, conf: dict[str, Any] | None = None) -> dict[str, Any]:
    async with _airflow_client() as client:
        body: dict[str, Any] = {
            "dag_run_id": f"manual__{datetime.now(timezone.utc).isoformat()}",
            "conf": conf or {},
        }
        resp = await client.post(f"/api/v1/dags/{dag_id}/dagRuns", json=body)
        resp.raise_for_status()
        return resp.json()


async def get_dag_stats() -> dict[str, Any]:
    """Fetch all DAGs and aggregate run state counts."""
    try:
        dags = await get_dags(limit=100, only_active=False)
    except Exception as exc:
        log.error("airflow_dag_stats_failed", error=str(exc))
        raise

    total = len(dags)
    active = sum(1 for d in dags if not d.get("is_paused", True))
    paused = sum(1 for d in dags if d.get("is_paused", False))

    return {
        "total": total,
        "active": active,
        "paused": paused,
    }


async def ping() -> bool:
    """Return True if Airflow API is reachable."""
    try:
        async with _airflow_client() as client:
            resp = await client.get("/api/v1/health", timeout=5.0)
            return resp.status_code < 500
    except Exception:
        return False
