"""Tests for /api/dq endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_dq_summary(client) -> None:
    """GET /api/dq/summary should return pass rates."""
    with (
        patch("app.api.dq._pg_connect", new_callable=AsyncMock) as mock_pg,
        patch("app.api.dq.trino_client") as mock_trino,
    ):
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)
        mock_pg.return_value = mock_conn
        mock_trino.execute = AsyncMock(return_value=[])

        resp = await client.get("/api/dq/summary")

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
