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


async def _check_adls() -> bool:
    """Ping ADLS by checking if the storage account is reachable."""
    import httpx
    try:
        url = f"https://{settings.adls_account}.dfs.core.windows.net/"
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
            # 400 is fine — it means the endpoint is reachable but auth is needed
            return resp.status_code < 500
    except Exception:
        return False


@router.get("/health")
async def health_check() -> dict[str, Any]:
    """Check health of all platform services."""
    airflow_ok, trino_ok, adls_ok = await asyncio.gather(
        _check_airflow(),
        asyncio.to_thread(trino_client.ping),
        _check_adls(),
    )

    all_ok = airflow_ok and trino_ok and adls_ok
    log.info(
        "health_check",
        airflow=airflow_ok,
        trino=trino_ok,
        adls=adls_ok,
        status="ok" if all_ok else "degraded",
    )

    return {
        "status": "ok" if all_ok else "degraded",
        "env": settings.forge_env,
        "checks": {
            "airflow": airflow_ok,
            "trino": trino_ok,
            "adls": adls_ok,
        },
    }


async def _check_airflow() -> bool:
    return await airflow_client.ping()
