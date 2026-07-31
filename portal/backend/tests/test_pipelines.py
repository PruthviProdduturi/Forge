"""Tests for /api/pipelines endpoints."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_list_pipelines(client) -> None:
    """GET /api/pipelines should return a list."""
    with (
        patch("app.api.pipelines.airflow_client") as mock_af,
        patch("app.api.pipelines._pg_connect", new_callable=AsyncMock) as mock_pg,
    ):
        mock_af.get = AsyncMock(return_value=MagicMock(status_code=200, json=lambda: {"dags": []}))
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)
        mock_pg.return_value = mock_conn

        resp = await client.get("/api/pipelines")

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_get_pipeline_runs(client) -> None:
    """GET /api/pipelines/{dag_id}/runs should return a list."""
    with patch("app.api.pipelines.airflow_client") as mock_af:
        mock_af.get = AsyncMock(
            return_value=MagicMock(status_code=200, json=lambda: {"dag_runs": []})
        )
        resp = await client.get("/api/pipelines/test_dag/runs")

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
