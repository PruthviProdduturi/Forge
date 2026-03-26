"""Tests for the /api/health endpoint."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_health_returns_200() -> None:
    """Health endpoint should return 200 even when services are down."""
    with (
        patch("app.api.health._check_airflow", new_callable=AsyncMock, return_value=False),
        patch("app.api.health._check_adls", new_callable=AsyncMock, return_value=False),
        patch("app.services.trino_client.ping", return_value=False),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/health")

    assert resp.status_code == 200
    body = resp.json()
    assert "status" in body
    assert "checks" in body
    assert "airflow" in body["checks"]
    assert "trino" in body["checks"]
    assert "adls" in body["checks"]


@pytest.mark.asyncio
async def test_health_ok_when_all_services_up() -> None:
    """Health endpoint should report ok when all services pass."""
    with (
        patch("app.api.health._check_airflow", new_callable=AsyncMock, return_value=True),
        patch("app.api.health._check_adls", new_callable=AsyncMock, return_value=True),
        patch("app.services.trino_client.ping", return_value=True),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/health")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["checks"]["airflow"] is True
    assert body["checks"]["trino"] is True
    assert body["checks"]["adls"] is True
