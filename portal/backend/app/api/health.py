"""Health check endpoint."""

from __future__ import annotations

import asyncio
from typing import Any

import structlog
from fastapi import APIRouter

from app.core.config import get_settings
from app.services import airflow_client, trino_client

log = structlog.get_logger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api", tags=["health"])


def _running_in_cluster() -> bool:
    """True when this process is running inside a Kubernetes pod."""
    import os

    return os.path.exists("/var/run/secrets/kubernetes.io/serviceaccount/token")


async def _check_airflow() -> bool | None:
    """None = cluster-internal URL but running outside cluster."""
    if ".svc.cluster.local" in settings.airflow_url and not _running_in_cluster():
        return None
    return await airflow_client.ping()


async def _check_trino() -> bool | None:
    if ".svc.cluster.local" in settings.trino_host and not _running_in_cluster():
        return None
    return await asyncio.to_thread(trino_client.ping)


async def _check_spark_connect() -> bool | None:
    """TCP reachability check for Spark Connect gRPC port (15002).

    Spark Connect is gRPC-only — no HTTP endpoint to probe. We do a TCP
    socket connect to the public compute cluster host on port 15002.
    Returns None when no host is configured so the UI shows '—' rather
    than 'Unreachable'.
    """
    import asyncio

    # Use the explicit compute_host (public NGINX LB hostname) for Spark Connect.
    # trino_host may be the internal LB IP (different port, unreachable for 15002).
    host = settings.compute_host or settings.trino_host
    if not host or ".svc.cluster.local" in host:
        return None
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, 15002), timeout=5.0
        )
        writer.close()
        await writer.wait_closed()
        return True
    except Exception:
        return False


async def _check_adls() -> bool | None:
    import httpx

    if not settings.adls_account:
        return None
    try:
        url = f"https://{settings.adls_account}.dfs.core.windows.net/"
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
            return resp.status_code < 500
    except Exception:
        return False


@router.get("/spark/stats")
async def spark_stats() -> dict[str, Any]:
    """Return current Spark job activity from Airflow.

    Counts only the most recent run per DAG so metrics reflect current
    state (not historical totals). running + queued = actively in-flight jobs.
    """
    try:
        dags = await airflow_client.get_dags(limit=200, only_active=False)
    except Exception:
        return {"running": 0, "queued": 0, "recent_success": 0, "recent_failed": 0}

    running = queued = recent_success = recent_failed = 0
    for dag in dags[:30]:  # cap to avoid too many parallel Airflow calls
        dag_id = dag.get("dag_id", "")
        try:
            runs = await airflow_client.get_dag_runs(dag_id, limit=1)
        except Exception:
            continue
        if not runs:
            continue
        state = runs[0].get("state", "")
        if state == "running":
            running += 1
        elif state == "queued":
            queued += 1
        elif state == "success":
            recent_success += 1
        elif state == "failed":
            recent_failed += 1

    return {
        "running": running,
        "queued": queued,
        "recent_success": recent_success,
        "recent_failed": recent_failed,
    }


@router.get("/health")
async def health_check() -> dict[str, Any]:
    """Check health of all platform services.

    Each check is one of:
      true  — reachable and healthy
      false — configured with a real host but unreachable
      null  — using a cluster-internal DNS name; only resolvable from inside a pod
    """
    airflow_ok, trino_ok, adls_ok, spark_ok = await asyncio.gather(
        _check_airflow(),
        _check_trino(),
        _check_adls(),
        _check_spark_connect(),
    )

    # Only non-null checks count toward overall status
    configured = [v for v in [airflow_ok, trino_ok, adls_ok] if v is not None]
    all_ok = all(configured) if configured else True

    log.info(
        "health_check",
        airflow=airflow_ok,
        trino=trino_ok,
        spark_connect=spark_ok,
        adls=adls_ok,
        status="ok" if all_ok else "degraded",
    )

    from urllib.parse import urlparse

    airflow_host = urlparse(settings.airflow_url).hostname or settings.airflow_url

    return {
        "status": "ok" if all_ok else "degraded",
        "env": settings.forge_env,
        "auth_provider": "azure_ad",
        "platform": {
            "airflow_host": airflow_host,
            "trino_host": settings.trino_host,
            "compute_host": settings.compute_host,
            "adls_account": settings.adls_account,
            "resource_group": settings.resource_group,
            "subscription_id": settings.subscription_id,
        },
        "checks": {
            "airflow": airflow_ok,
            "trino": trino_ok,
            "spark_connect": spark_ok,
            "adls": adls_ok,
        },
    }
