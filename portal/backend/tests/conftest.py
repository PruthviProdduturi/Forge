"""Shared test fixtures for Forge portal backend."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

_AUTH_HEADERS = {
    "X-User-Email": "test@forge.dev",
    "X-User-Name": "Test User",
    "X-User-Role": "Admin",
    "X-User-Roles": "Admin",
}


@pytest.fixture
async def client():
    """Async HTTP client with auth headers for testing FastAPI endpoints."""
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers=_AUTH_HEADERS,
    ) as c:
        yield c
