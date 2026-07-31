"""Tests for /api/platform endpoints."""

from __future__ import annotations

from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_get_auth_config(client) -> None:
    """GET /api/platform/auth-config should return auth configuration."""
    mock_config = {
        "auth_provider": "azure_ad",
        "azure_client_id": "",
        "azure_tenant_id": "common",
    }
    with patch("app.api.platform.get_auth_config_from_kv", return_value=mock_config):
        resp = await client.get("/api/platform/auth-config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["auth_provider"] == "azure_ad"
