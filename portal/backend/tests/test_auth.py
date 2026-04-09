"""Tests for /api/auth endpoints."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_provider_endpoint() -> None:
    """Provider endpoint should always return azure_ad."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/auth/provider")

    assert resp.status_code == 200
    body = resp.json()
    assert body["provider"] == "azure_ad"


@pytest.mark.asyncio
async def test_me_requires_auth() -> None:
    """/api/auth/me without token should return 401."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/auth/me")

    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_login_endpoint_removed() -> None:
    """/api/auth/login no longer exists — local auth is disabled."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin"},
        )

    assert resp.status_code == 404
