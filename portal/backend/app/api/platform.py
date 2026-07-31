"""Platform configuration API — Admin only.

Reads and writes Azure AD auth configuration to Azure Key Vault:

  forge-portal-aad-client-id   → Azure AD App Registration Client ID
  forge-portal-aad-tenant-id   → Azure AD Tenant ID

The portal-api managed identity needs Key Vault Secrets Officer on the vault
(granted in identity.bicep / keyvault.bicep).  For local dev, falls back to
an in-memory dict when KV is not configured (KEY_VAULT_URL env var absent).
"""
from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.auth import get_current_user
from app.core.config import get_settings

log = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/platform", tags=["platform"])
settings = get_settings()

# ---------------------------------------------------------------------------
# Local dev fallback (no KV configured)
# ---------------------------------------------------------------------------
# Persisted to a JSON sidecar file so auth config survives backend restarts
# during local development.  In production this dict is never used — KV handles
# all reads and writes.
import json as _json  # noqa: E402
import pathlib as _pathlib  # noqa: E402

_LOCAL_OVERRIDES_FILE = _pathlib.Path(__file__).parent.parent.parent / ".forge-dev-config.json"

def _load_local_overrides() -> dict[str, str]:
    try:
        return _json.loads(_LOCAL_OVERRIDES_FILE.read_text()) if _LOCAL_OVERRIDES_FILE.exists() else {}
    except Exception:
        return {}

def _save_local_overrides(data: dict[str, str]) -> None:
    try:
        _LOCAL_OVERRIDES_FILE.write_text(_json.dumps(data, indent=2))
    except Exception:
        pass

_local_overrides: dict[str, str] = _load_local_overrides()

# ---------------------------------------------------------------------------
# Key Vault helpers
# ---------------------------------------------------------------------------

_KV_SECRET_PROVIDER  = "forge-portal-auth-provider"
_KV_SECRET_CLIENT_ID = "forge-portal-aad-client-id"
_KV_SECRET_TENANT_ID = "forge-portal-aad-tenant-id"


@lru_cache(maxsize=1)
def _kv_client():  # type: ignore[return]
    """Return an Azure SecretClient, or None when KV is not configured."""
    kv_url = settings.key_vault_url
    if not kv_url:
        return None
    try:
        from azure.identity import ManagedIdentityCredential  # type: ignore
        from azure.keyvault.secrets import SecretClient       # type: ignore
        credential = ManagedIdentityCredential(client_id=settings.azure_client_id or None)
        return SecretClient(vault_url=kv_url, credential=credential)
    except Exception as exc:
        log.warning("kv_client_init_failed", error=str(exc))
        return None


def _kv_get(name: str, default: str = "") -> str:
    client = _kv_client()
    if client is None:
        return _local_overrides.get(name, default)
    try:
        return client.get_secret(name).value or default
    except Exception:
        return _local_overrides.get(name, default)


def _kv_set(name: str, value: str) -> None:
    client = _kv_client()
    if client is None:
        _local_overrides[name] = value
        _save_local_overrides(_local_overrides)
        log.info("kv_local_override", secret=name)
        return
    try:
        client.set_secret(name, value)
        log.info("kv_secret_updated", secret=name)
    except Exception as exc:
        log.error("kv_set_failed", secret=name, error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to write secret {name!r} to Key Vault: {exc}",
        ) from exc


# ---------------------------------------------------------------------------
# Public helper — used by auth.py GET /api/auth/provider
# ---------------------------------------------------------------------------

def get_auth_config_from_kv() -> dict[str, str]:
    """Return current auth config. Hot-read from KV — no in-memory cache.

    Called on every GET /api/auth/provider so the frontend always gets
    the live value without a pod restart.  auth_provider is always azure_ad.
    """
    client_id = _kv_get(_KV_SECRET_CLIENT_ID, settings.azure_client_id or "")
    tenant_id = _kv_get(_KV_SECRET_TENANT_ID, settings.azure_tenant_id or "common")
    return {
        "auth_provider":  "azure_ad",
        "azure_client_id": client_id,
        "azure_tenant_id": tenant_id,
    }


# ---------------------------------------------------------------------------
# Auth guard
# ---------------------------------------------------------------------------

def _is_admin(user: dict[str, Any]) -> bool:
    roles = user.get("roles", user.get("role", []))
    if isinstance(roles, str):
        roles = [roles]
    return any(r.lower() == "admin" for r in roles)


def _require_admin(current_user: Annotated[dict[str, Any], Depends(get_current_user)]) -> dict[str, Any]:
    if not _is_admin(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return current_user


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class AuthConfigRequest(BaseModel):
    azure_client_id: str = ""
    azure_tenant_id: str = ""


class AuthConfigResponse(BaseModel):
    auth_provider: str          # always "azure_ad"
    azure_client_id: str
    azure_tenant_id: str
    aad_configured: bool        # True when client_id is non-empty
    kv_backed: bool             # True when Key Vault is configured


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/auth-config", response_model=AuthConfigResponse)
async def get_auth_config(
    _: Annotated[dict[str, Any], Depends(_require_admin)],
) -> AuthConfigResponse:
    cfg = get_auth_config_from_kv()
    return AuthConfigResponse(
        auth_provider=cfg["auth_provider"],
        azure_client_id=cfg["azure_client_id"],
        azure_tenant_id=cfg["azure_tenant_id"],
        aad_configured=bool(cfg["azure_client_id"]),
        kv_backed=bool(settings.key_vault_url),
    )


@router.post("/auth-config", response_model=AuthConfigResponse)
async def save_auth_config(
    body: AuthConfigRequest,
    _: Annotated[dict[str, Any], Depends(_require_admin)],
) -> AuthConfigResponse:
    """Write AAD client/tenant config to Key Vault (or local override in dev).

    After saving, GET /api/auth/provider immediately reflects the new config
    — no pod restart needed.
    """
    if not body.azure_client_id.strip():
        raise HTTPException(status_code=400, detail="azure_client_id is required")

    client_id = body.azure_client_id.strip()
    tenant_id = body.azure_tenant_id.strip() or "common"

    _kv_set(_KV_SECRET_CLIENT_ID, client_id)
    _kv_set(_KV_SECRET_TENANT_ID, tenant_id)

    log.info(
        "auth_config_saved",
        client_id=client_id[:8] + "…" if client_id else "",
        kv_backed=bool(settings.key_vault_url),
    )

    return AuthConfigResponse(
        auth_provider="azure_ad",
        azure_client_id=client_id,
        azure_tenant_id=tenant_id,
        aad_configured=bool(client_id),
        kv_backed=bool(settings.key_vault_url),
    )
