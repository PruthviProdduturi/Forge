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
async def trigger_dag(
    dag_id: str,
    conf: dict[str, Any] | None = None,
    logical_date: str | None = None,
) -> dict[str, Any]:
    """Trigger a DAG run, optionally for a specific logical_date (restate)."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        ts = logical_date or datetime.now(timezone.utc).isoformat()
        body: dict[str, Any] = {
            "dag_run_id": f"restate__{ts}" if logical_date else f"manual__{datetime.now(timezone.utc).isoformat()}",
            "logical_date": ts,
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


@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=4))
async def delete_dag_run(dag_id: str, run_id: str) -> None:
    """Hard-delete a specific DAG run and all its task instances."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.delete(f"/api/v2/dags/{dag_id}/dagRuns/{run_id}")
        if resp.status_code not in (200, 204, 404):
            resp.raise_for_status()


async def patch_task_instance_state(dag_id: str, run_id: str, task_id: str, new_state: str) -> None:
    """Set a specific task instance to a given state (e.g. 'success' to skip sensors)."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.patch(
            f"/api/v2/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}",
            json={"state": new_state},
        )
        # 404 = task not yet scheduled (too soon), ignore
        if resp.status_code not in (200, 404):
            resp.raise_for_status()


async def get_dag_runs_for_date(dag_id: str, logical_date: str) -> list[dict[str, Any]]:
    """Return all existing DAG runs for a specific logical_date (ISO string)."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        params = {"logical_date_gte": logical_date, "logical_date_lte": logical_date, "limit": 25}
        resp = await client.get(f"/api/v2/dags/{dag_id}/dagRuns", params=params)
        if resp.status_code == 200:
            return resp.json().get("dag_runs", [])
        return []


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
async def delete_dag(dag_id: str) -> None:
    """Delete a DAG from Airflow (dev only). Removes the DAG definition and all its runs."""
    token = await _get_jwt()
    async with _airflow_client(token) as client:
        resp = await client.delete(f"/api/v2/dags/{dag_id}")
        resp.raise_for_status()


def _parse_log_text(text: str) -> str:
    """Parse NDJSON, JSON {content:}, or plain-text log content into a readable string."""
    import json as _json

    text = text.strip()
    if not text:
        return "(no log output)"

    lines: list[str] = []
    first_line = text.splitlines()[0].strip()
    if first_line.startswith("{"):
        for raw_line in text.splitlines():
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                obj = _json.loads(raw_line)
                if "event" in obj:
                    ts = obj.get("timestamp", "")
                    level = obj.get("level", "").upper()
                    event = obj.get("event", "")
                    lines.append(f"[{ts}] {level} {event}" if ts else event)
                elif "content" in obj:
                    lines.append(obj["content"])
                else:
                    lines.append(raw_line)
            except _json.JSONDecodeError:
                lines.append(raw_line)
    else:
        lines = text.splitlines()

    return "\n".join(lines)


async def _read_log_from_adls(dag_id: str, run_id: str, task_id: str, attempt: int) -> str | None:
    """Fast path: read task logs directly from ADLS, bypassing Airflow's slow multi-source fetching.

    Airflow's WasbTaskHandler writes logs to:
      container=airflow-logs, blob=airflow-logs/dag_id={}/run_id={}/task_id={}/attempt={}.log
    Returns None if the blob doesn't exist yet (task still running) or on any error.
    """
    if not settings.adls_account:
        return None
    try:
        from azure.identity.aio import DefaultAzureCredential as _AsyncCred
        from azure.storage.blob.aio import BlobServiceClient

        blob_path = f"airflow-logs/dag_id={dag_id}/run_id={run_id}/task_id={task_id}/attempt={attempt}.log"
        account_url = f"https://{settings.adls_account}.blob.core.windows.net"
        async with _AsyncCred() as cred:
            async with BlobServiceClient(account_url, credential=cred) as client:
                blob_client = client.get_blob_client(container="airflow-logs", blob=blob_path)
                download = await blob_client.download_blob()
                raw = await download.readall()
                return _parse_log_text(raw.decode("utf-8", errors="replace"))
    except Exception as exc:
        log.debug("adls_log_read_miss", dag_id=dag_id, task_id=task_id, attempt=attempt, error=str(exc))
        return None


async def get_task_logs(dag_id: str, run_id: str, task_id: str, attempt: int = 1) -> str:
    """Fetch raw task logs for a specific task instance attempt.

    Fast path: reads directly from ADLS blob (milliseconds).
    Fallback: Airflow REST API (slow — tries ADLS then dead worker pod).
    """
    from urllib.parse import quote

    # Fast path — direct ADLS read (no Airflow involvement, no TCP timeouts)
    adls_text = await _read_log_from_adls(dag_id, run_id, task_id, attempt)
    if adls_text is not None:
        return adls_text

    # Fallback — Airflow REST API (task still running, logs not flushed to ADLS yet)
    # Short timeout: if Airflow is slow (dead worker pod fallback), fail fast.
    encoded_run_id = quote(run_id, safe="")
    try:
        token = await _get_jwt()
        async with httpx.AsyncClient(
            base_url=settings.airflow_url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=10.0,
        ) as client:
            resp = await client.get(
                f"/api/v2/dags/{dag_id}/dagRuns/{encoded_run_id}/taskInstances/{task_id}/logs/{attempt}",
                headers={"Accept": "application/x-ndjson"},
            )
            if resp.status_code in (404, 500):
                return "(Logs not available — task logs could not be retrieved.)"
            if not resp.is_success:
                return f"(Airflow returned HTTP {resp.status_code} — logs may not be available yet)"
            text = resp.text.strip()
        return _parse_log_text(text)
    except httpx.TimeoutException:
        return "(Logs not available — the task failed before writing logs. Check the Airflow UI or Spark operator logs for details.)"
    except Exception as exc:
        raise RuntimeError(f"Failed to fetch logs: {exc}") from exc


async def ping() -> bool:
    """Unauthenticated health check — no credentials needed."""
    try:
        async with httpx.AsyncClient(base_url=settings.airflow_url, timeout=5.0) as client:
            resp = await client.get("/api/v2/monitor/health")
            return resp.status_code < 500
    except Exception:
        return False
