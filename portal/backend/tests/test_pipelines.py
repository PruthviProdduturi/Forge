"""Tests for /api/pipelines endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_list_pipelines(client) -> None:
    """GET /api/pipelines should return a list."""
    with (
        patch(
            "app.services.airflow_client.get_dags",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "app.api.pipelines._pg_connect",
            new_callable=AsyncMock,
            return_value=None,
        ),
    ):
        resp = await client.get("/api/pipelines")

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_get_pipeline_runs(client) -> None:
    """GET /api/pipelines/{dag_id}/runs should return a list."""
    with patch(
        "app.services.airflow_client.get_dag_runs",
        new_callable=AsyncMock,
        return_value=[],
    ):
        resp = await client.get("/api/pipelines/test_dag/runs")

    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
