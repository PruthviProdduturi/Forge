"""Airflow REST API v2 client (Airflow 3.x).

Auth flow (Airflow 3 REST API v2):
  1. POST /auth/token with username/password → Airflow JWT (expires ~24h)
  2. Use JWT as Bearer token for all /api/v2/* calls.

Service account: portal-api-svc (Viewer role), created by forge-up.sh phase 7.4.1.
Password: stored in Key Vault as airflow-portal-api-password. Fetched at first
use via DefaultAzureCredential (workload identity → KV Secrets User role).
AIRFLOW_PASSWORD env var overrides KV lookup for local dev only.
The JWT is cached in-process and refreshed 1h before expiry.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

import httpx
import structlog
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import get_settings

log = structlog.get_logger(__name__)
settings = get_settings()

# ---------------------------------------------------------------------------
# JWT token cache (in-process, per pod)
# ---------------------------------------------------------------------------
_jwt: str = ""
_jwt_expiry: float = 0.0
_airflow_password: str = ""  # resolved once from env var or KV


def _resolve_airflow_password() -> str:
    """Return the portal-api-svc password.

    Priority:
      1. AIRFLOW_PASSWORD env var (local dev override)
      2. Key Vault secret airflow-portal-api-password (via workload identity)
    """
    global _airflow_password
    if _airflow_password:
        return _airflow_password
    if settings.airflow_password:
        _airflow_password = settings.airflow_password
        return _airflow_password
    if not settings.key_vault_url:
        raise RuntimeError(
            "Neither AIRFLOW_PASSWORD env var nor KEY_VAULT_URL is configured"
        )
    log.info("airflow_password_kv_fetch", kv=settings.key_vault_url)
    credential = DefaultAzureCredential()
    kv_client = SecretClient(vault_url=settings.key_vault_url, credential=credential)
    secret = kv_client.get_secret("airflow-portal-api-password")
    _airflow_password = secret.value or ""
    if not _airflow_password:
        raise RuntimeError("KV secret airflow-portal-api-password is empty")
    return _airflow_password


async def _get_jwt() -> str:
    """Return a valid Airflow JWT, refreshing if expired or absent."""
    global _jwt, _jwt_expiry
    if _jwt and time.time() < _jwt_expiry:
        return _jwt
    password = _resolve_airflow_password()
    async with httpx.AsyncClient(base_url=settings.airflow_url, timeout=10.0) as client:
        resp = await client.post(
            "/auth/token",
            json={"username": settings.airflow_username, "password": password},
        )
        resp.raise_for_status()
        _jwt = resp.json()["access_token"]
        _jwt_expiry = time.time() + 82800  # 23h (tokens valid 24h, refresh 1h early)
    return _jwt


def _airflow_client(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=settings.airflow_url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30.0,
    )


# ---------------------------------------------------------------------------
# API methods
# ---------------------------------------------------------------------------

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_dags(limit: int = 100, only_active: bool = True) -> list[dict[str, Any]]:
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        params: dict[str, Any] = {"limit": limit}
        if only_active:
            params["paused"] = False
        resp = await client.get("/api/v2/dags", params=params)
        resp.raise_for_status()
        return resp.json().get("dags", [])


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_dag(dag_id: str) -> dict[str, Any]:
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.get(f"/api/v2/dags/{dag_id}")
        resp.raise_for_status()
        return resp.json()


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_dag_runs(dag_id: str, limit: int = 10) -> list[dict[str, Any]]:
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        params = {"limit": limit, "order_by": "-start_date"}
        resp = await client.get(f"/api/v2/dags/{dag_id}/dagRuns", params=params)
        resp.raise_for_status()
        return resp.json().get("dag_runs", [])


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_dag_tasks(dag_id: str) -> list[dict[str, Any]]:
    """Return the task list for a DAG (structure — not instances)."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.get(f"/api/v2/dags/{dag_id}/tasks")
        resp.raise_for_status()
        return resp.json().get("tasks", [])


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def get_task_instances(dag_id: str, run_id: str) -> list[dict[str, Any]]:
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.get(
            f"/api/v2/dags/{dag_id}/dagRuns/{run_id}/taskInstances"
        )
        resp.raise_for_status()
        return resp.json().get("task_instances", [])


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def trigger_dag(dag_id: str, conf: dict[str, Any] | None = None) -> dict[str, Any]:
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        now = datetime.now(timezone.utc)
        body: dict[str, Any] = {
            "dag_run_id": f"manual__{now.isoformat()}",
            "logical_date": now.isoformat(),
            "conf": conf or {},
        }
        resp = await client.post(f"/api/v2/dags/{dag_id}/dagRuns", json=body)
        resp.raise_for_status()
        return resp.json()


async def get_dag_stats() -> dict[str, Any]:
    """Aggregate DAG counts (total / active / paused)."""
    try:
        dags = await get_dags(limit=100, only_active=False)
    except Exception as exc:
        log.error("airflow_dag_stats_failed", error=str(exc))
        raise
    total = len(dags)
    active = sum(1 for d in dags if not d.get("is_paused", True))
    paused = sum(1 for d in dags if d.get("is_paused", False))
    return {"total": total, "active": active, "paused": paused}


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def cancel_dag_run(dag_id: str, run_id: str) -> dict[str, Any]:
    """Cancel (mark as failed) a running or queued DAG run."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.patch(
            f"/api/v2/dags/{dag_id}/dagRuns/{run_id}",
            json={"state": "failed"},
        )
        resp.raise_for_status()
        return resp.json()


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def set_dag_paused(dag_id: str, is_paused: bool) -> dict[str, Any]:
    """Pause or unpause a DAG."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.patch(f"/api/v2/dags/{dag_id}", json={"is_paused": is_paused})
        resp.raise_for_status()
        return resp.json()


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def delete_dag(dag_id: str) -> None:
    """Delete a DAG from Airflow (dev only). Removes the DAG definition and all its runs."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.delete(f"/api/v2/dags/{dag_id}")
        resp.raise_for_status()


@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=4))
async def get_task_logs(dag_id: str, run_id: str, task_id: str, attempt: int = 1) -> str:
    """Fetch raw task logs for a specific task instance attempt.

    Airflow 3.x log API returns application/x-ndjson (newline-delimited JSON).
    Each line is {"event": "...", "timestamp": "...", "level": "..."}.
    We extract the event fields and join them into a plain-text log string.
    """
    import json as _json

    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.get(
            f"/api/v2/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}/logs/{attempt}",
            headers={"Accept": "application/x-ndjson"},
        )
        resp.raise_for_status()

    lines: list[str] = []
    for raw_line in resp.text.splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            obj = _json.loads(raw_line)
            ts = obj.get("timestamp", "")
            level = obj.get("level", "").upper()
            event = obj.get("event", raw_line)
            lines.append(f"[{ts}] {level} {event}" if ts else event)
        except _json.JSONDecodeError:
            lines.append(raw_line)
    return "\n".join(lines)


async def ping() -> bool:
    """Unauthenticated health check — no credentials needed."""
    try:
        async with httpx.AsyncClient(base_url=settings.airflow_url, timeout=5.0) as client:
            resp = await client.get("/api/v2/monitor/health")
            return resp.status_code < 500
    except Exception:
        return False
