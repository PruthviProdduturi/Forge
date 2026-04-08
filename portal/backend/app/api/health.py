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
    import httpx
    url = settings.spark_connect_url
    if not url or (".svc.cluster.local" in url and not _running_in_cluster()):
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0, verify=False) as client:
            resp = await client.get(url)
            return resp.status_code < 500
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
        airflow=airflow_ok, trino=trino_ok, spark_connect=spark_ok, adls=adls_ok,
        status="ok" if all_ok else "degraded",
    )

    from urllib.parse import urlparse
    airflow_host = urlparse(settings.airflow_url).hostname or settings.airflow_url

    return {
        "status": "ok" if all_ok else "degraded",
        "env": settings.forge_env,
        "auth_provider": settings.auth_provider,
        "platform": {
            "airflow_host": airflow_host,
            "trino_host": settings.trino_host,
            "adls_account": settings.adls_account,
            "purview_endpoint": settings.purview_endpoint,
            "resource_group": settings.resource_group,
        },
        "checks": {
            "airflow": airflow_ok,
            "trino": trino_ok,
            "spark_connect": spark_ok,
            "adls": adls_ok,
        },
    }
