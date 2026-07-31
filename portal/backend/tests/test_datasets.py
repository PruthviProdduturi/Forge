"""Tests for /api/datasets endpoints."""
from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_list_datasets(client) -> None:
    """GET /api/datasets should return a list."""
    with patch("app.api.datasets._fetch_datasets", return_value=[]):
        resp = await client.get("/api/datasets")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_list_datasets_by_layer(client) -> None:
    """GET /api/datasets/{layer} should filter by layer."""
    with patch("app.api.datasets._fetch_datasets", return_value=[]):
        resp = await client.get("/api/datasets/bronze")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
