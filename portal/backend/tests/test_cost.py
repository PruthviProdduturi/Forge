"""Tests for /api/cost endpoints."""

from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_cost_summary(client) -> None:
    """GET /api/cost/summary should return spend data."""
    with patch("app.api.cost.cost_client") as mock_cc:
        mock_cc.get_summary.return_value = {
            "total": 0.0,
            "currency": "USD",
            "period": "last_30_days",
        }
        resp = await client.get("/api/cost/summary")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_cost_by_rg(client) -> None:
    """GET /api/cost/by-rg should return list."""
    with patch("app.api.cost.cost_client") as mock_cc:
        mock_cc.get_by_resource_group.return_value = []
        resp = await client.get("/api/cost/by-rg")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
