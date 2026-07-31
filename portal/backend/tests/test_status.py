"""Tests for /api/status endpoints."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_platform_status(client) -> None:
    """GET /api/status should return cluster and workload status."""
    with (
        patch("app.api.status._k8s_orch_status", return_value={"components": []}),
        patch(
            "app.api.status._azure_compute_cluster_status",
            new_callable=AsyncMock,
            return_value={"status": "unknown"},
        ),
        patch(
            "app.api.status._compute_workload_probes",
            new_callable=AsyncMock,
            return_value=[],
        ),
    ):
        resp = await client.get("/api/status")
    assert resp.status_code == 200
