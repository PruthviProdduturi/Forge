"""Authentication API routes."""

from __future__ import annotations

import asyncio
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.core.auth import get_current_user

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class ProviderResponse(BaseModel):
    provider: str
    azure_client_id: str | None
    azure_tenant_id: str | None


@router.get("/provider", response_model=ProviderResponse)
async def get_provider() -> ProviderResponse:
    """Return auth provider config — kept for backwards compatibility."""
    from app.api.platform import get_auth_config_from_kv

    cfg = await asyncio.to_thread(get_auth_config_from_kv)
    return ProviderResponse(
        provider="azure_ad",
        azure_client_id=cfg["azure_client_id"] or None,
        azure_tenant_id=cfg["azure_tenant_id"] or None,
    )


@router.get("/me")
async def get_me(
    request: Request,
    current_user: Annotated[dict[str, Any], Depends(get_current_user)],
) -> dict[str, Any]:
    """Return current user info from proxy-injected headers."""
    return {
        "name": current_user["name"],
        "email": current_user["email"],
        "role": current_user["role"],
    }
