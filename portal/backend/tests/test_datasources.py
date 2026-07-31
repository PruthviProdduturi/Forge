"""Tests for /api/v1/datasources endpoints."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_list_datasources(client) -> None:
    """GET /api/v1/datasources should return a list."""
    with patch("app.api.datasources._pg_connect", new_callable=AsyncMock) as mock_pg:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)
        mock_pg.return_value = mock_conn

        resp = await client.get("/api/v1/datasources")

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
