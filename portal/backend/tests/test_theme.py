"""Tests for /api/v1/theme endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_get_theme(client) -> None:
    """GET /api/v1/theme should return a theme response."""
    with patch(
        "app.api.theme._pg_connect",
        new_callable=AsyncMock,
        return_value=None,
    ):
        resp = await client.get("/api/v1/theme")
    assert resp.status_code == 200
    body = resp.json()
    assert "primary_color" in body
