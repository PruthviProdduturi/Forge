"""Platform configuration API — Admin only.

Allows an Admin to read and update runtime platform settings (auth provider,
Azure AD client ID / tenant ID) without restarting the pod.  Changes are
written to ``platform_override.json`` next to the running process and take
effect immediately via the in-memory override dict.

In production, prefer env vars / Key Vault over this endpoint.  The file is
intentionally not persisted across pod restarts in production — it is a dev
convenience so you can flip the auth provider from the portal UI.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.core.config import get_settings

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/platform", tags=["platform"])

_OVERRIDE_FILE = Path(os.getenv("FORGE_OVERRIDE_FILE", "platform_override.json"))

# In-memory cache of overrides applied this session
_overrides: dict[str, Any] = {}

# Load any persisted overrides on import
if _OVERRIDE_FILE.exists():
    try:
        _overrides = json.loads(_OVERRIDE_FILE.read_text())
    except Exception:
        pass


def _is_admin(user: dict[str, Any]) -> bool:
    roles = user.get("roles", user.get("role", []))
    if isinstance(roles, str):
        roles = [roles]
    return any(r.lower() == "admin" for r in roles)


def _require_admin(current_user: Annotated[dict[str, Any], Depends(get_current_user)]) -> dict[str, Any]:
    if not _is_admin(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return current_user


class AuthConfigRequest(BaseModel):
    auth_provider: str          # "local" | "azure_ad"
    azure_client_id: str = ""
    azure_tenant_id: str = ""


class AuthConfigResponse(BaseModel):
    auth_provider: str
    azure_client_id: str
    azure_tenant_id: str
    aad_configured: bool        # True when client_id is non-empty


@router.get("/auth-config", response_model=AuthConfigResponse)
async def get_auth_config(
    _: Annotated[dict[str, Any], Depends(_require_admin)],
) -> AuthConfigResponse:
    """Return current auth configuration (Admin only)."""
    settings = get_settings()
    client_id = _overrides.get("azure_client_id", settings.azure_client_id) or ""
    tenant_id = _overrides.get("azure_tenant_id", settings.azure_tenant_id) or ""
    provider = _overrides.get("auth_provider", settings.auth_provider)
    return AuthConfigResponse(
        auth_provider=provider,
        azure_client_id=client_id,
        azure_tenant_id=tenant_id,
        aad_configured=bool(client_id),
    )


@router.post("/auth-config", response_model=AuthConfigResponse)
async def save_auth_config(
    body: AuthConfigRequest,
    _: Annotated[dict[str, Any], Depends(_require_admin)],
) -> AuthConfigResponse:
    """Save auth provider settings (Admin only).

    Writes to the in-memory override dict and persists to
    ``platform_override.json``.  The ``/api/auth/provider`` endpoint reads
    from this override so the frontend picks up the new provider on next load.
    """
    if body.auth_provider not in ("local", "azure_ad"):
        raise HTTPException(status_code=400, detail="auth_provider must be 'local' or 'azure_ad'")

    if body.auth_provider == "azure_ad" and not body.azure_client_id.strip():
        raise HTTPException(status_code=400, detail="azure_client_id is required when auth_provider is azure_ad")

    _overrides["auth_provider"] = body.auth_provider
    _overrides["azure_client_id"] = body.azure_client_id.strip()
    _overrides["azure_tenant_id"] = body.azure_tenant_id.strip() or "common"

    try:
        _OVERRIDE_FILE.write_text(json.dumps(_overrides, indent=2))
    except OSError as exc:
        log.warning("platform_override_write_failed", error=str(exc))

    log.info(
        "auth_config_updated",
        provider=body.auth_provider,
        client_id=body.azure_client_id[:8] + "…" if body.azure_client_id else "",
    )

    return AuthConfigResponse(
        auth_provider=_overrides["auth_provider"],
        azure_client_id=_overrides["azure_client_id"],
        azure_tenant_id=_overrides["azure_tenant_id"],
        aad_configured=bool(_overrides["azure_client_id"]),
    )
