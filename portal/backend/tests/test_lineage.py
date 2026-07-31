"""Tests for /api/lineage endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_lineage_search(client) -> None:
    """GET /api/lineage/search should return matching datasets."""
    with patch(
        "app.api.lineage._get_lineage_graph",
        new_callable=AsyncMock,
        return_value={"upstream": {}, "downstream": {}},
    ):
        resp = await client.get("/api/lineage/search", params={"q": "test"})
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_lineage_graph(client) -> None:
    """GET /api/lineage/graph/{schema}/{table} should return graph structure."""
    with patch(
        "app.api.lineage._get_lineage_graph",
        new_callable=AsyncMock,
        return_value={"upstream": {}, "downstream": {}},
    ):
        resp = await client.get("/api/lineage/graph/bronze/my_table")
    assert resp.status_code == 200
    body = resp.json()
    assert "nodes" in body
    assert "edges" in body
