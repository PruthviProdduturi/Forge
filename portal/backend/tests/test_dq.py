"""Tests for /api/dq endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_dq_summary(client) -> None:
    """GET /api/dq/summary should return pass rates."""
    with patch(
        "app.api.dq._pg_connect",
        new_callable=AsyncMock,
        return_value=None,
    ):
        resp = await client.get("/api/dq/summary")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
