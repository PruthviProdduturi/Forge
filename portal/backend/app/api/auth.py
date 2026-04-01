"""Authentication API routes."""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.auth import create_access_token, get_current_user
from app.core.config import get_settings

log = structlog.get_logger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    expires_in: int


class ProviderResponse(BaseModel):
    provider: str
    azure_client_id: str | None
    azure_tenant_id: str | None


@router.get("/provider", response_model=ProviderResponse)
async def get_provider() -> ProviderResponse:
    """Return auth provider config for the frontend.

    Hot-reads from Key Vault on every call so the frontend picks up changes
    immediately without a pod restart.  Falls back to env vars / local
    overrides when KV is not configured (local dev).
    """
    from app.api.platform import get_auth_config_from_kv
    cfg = await asyncio.to_thread(get_auth_config_from_kv)
    provider  = cfg["auth_provider"]
    client_id = cfg["azure_client_id"] or None
    tenant_id = cfg["azure_tenant_id"] or None
    return ProviderResponse(
        provider=provider,
        azure_client_id=client_id,
        azure_tenant_id=tenant_id if provider == "azure_ad" else None,
    )


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest) -> LoginResponse:
    """Local username/password login. Returns a JWT."""
    if settings.auth_provider != "local":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Local login is disabled; use Azure AD",
        )

    if body.username != settings.local_admin_user or body.password != settings.local_admin_password:
        log.warning("login_failed", username=body.username)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    token_data: dict[str, Any] = {
        "sub": body.username,
        "name": "Forge Admin",
        "email": f"{body.username}@forge.local",
        "roles": ["Admin"],
    }
    token = create_access_token(token_data)
    log.info("login_success", username=body.username)

    return LoginResponse(
        token=token,
        expires_in=settings.jwt_expire_minutes * 60,
    )


@router.get("/me")
async def get_me(
    current_user: Annotated[dict[str, Any], Depends(get_current_user)],
) -> dict[str, Any]:
    """Return current user info from the JWT claims."""
    roles = current_user.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    role = "Viewer"
    for r in ["Admin", "Editor", "Analyst"]:
        if r.lower() in [x.lower() for x in roles]:
            role = r
            break

    return {
        "name": current_user.get("name", current_user.get("sub", "Unknown")),
        "email": current_user.get("email", ""),
        "role": role,
    }
