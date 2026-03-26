"""Tests for /api/auth endpoints."""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.auth import verify_token
from app.main import app


@pytest.mark.asyncio
async def test_local_login_returns_jwt() -> None:
    """Valid credentials should return a JWT token."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "forge-dev-admin"},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert "token" in body
    assert "expires_in" in body
    assert isinstance(body["token"], str)
    assert len(body["token"]) > 10

    # Token should be a valid JWT
    payload = verify_token(body["token"])
    assert payload["sub"] == "admin"
    assert "Admin" in payload.get("roles", [])


@pytest.mark.asyncio
async def test_invalid_credentials_return_401() -> None:
    """Wrong password should return 401."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "wrong-password"},
        )

    assert resp.status_code == 401
    body = resp.json()
    assert "detail" in body


@pytest.mark.asyncio
async def test_wrong_username_returns_401() -> None:
    """Unknown username should return 401."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/auth/login",
            json={"username": "hacker", "password": "forge-dev-admin"},
        )

    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_provider_endpoint() -> None:
    """Provider endpoint should return the auth configuration."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/auth/provider")

    assert resp.status_code == 200
    body = resp.json()
    assert "provider" in body
    assert body["provider"] in ("local", "azure_ad")


@pytest.mark.asyncio
async def test_me_requires_auth() -> None:
    """/api/auth/me without token should return 401."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/auth/me")

    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_me_with_valid_token() -> None:
    """/api/auth/me with a valid token returns user info."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # Login first
        login_resp = await client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "forge-dev-admin"},
        )
        token = login_resp.json()["token"]

        # Call /me
        me_resp = await client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert me_resp.status_code == 200
    body = me_resp.json()
    assert "name" in body
    assert "email" in body
    assert "role" in body
    assert body["role"] == "Admin"
