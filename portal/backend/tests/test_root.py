"""Tests for root endpoint."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_root_endpoint(client) -> None:
    """GET / should return API info."""
    resp = await client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["message"] == "Forge Developer Portal API"
    assert "version" in body
