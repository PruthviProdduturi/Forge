"""Tests for /api/v1/theme endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_get_theme(client) -> None:
    """GET /api/v1/theme should return a theme response."""
    with (
        patch(
            "app.api.theme._pg_connect",
            new_callable=AsyncMock,
            side_effect=Exception("no db"),
        ),
        patch("app.api.theme._local_load", return_value={}),
    ):
        resp = await client.get("/api/v1/theme")
    assert resp.status_code == 200
