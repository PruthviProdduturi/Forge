from __future__ import annotations

import os
from typing import Any

import structlog
from fastapi import HTTPException, Request, status

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Local dev fallback
# Set FORGE_DEV_USER_EMAIL (and optionally FORGE_DEV_USER_NAME / FORGE_DEV_USER_ROLE)
# when running portal-api locally without the auth proxy.
# Never set these in production — the proxy headers take precedence.
# ---------------------------------------------------------------------------
_DEV_EMAIL = os.environ.get("FORGE_DEV_USER_EMAIL", "")
_DEV_NAME = os.environ.get("FORGE_DEV_USER_NAME", "Dev User")
_DEV_ROLE = os.environ.get("FORGE_DEV_USER_ROLE", "Admin")


def get_current_user(request: Request) -> dict[str, Any]:
    """Extract the authenticated user from proxy-injected headers.

    In production the portal-auth-proxy validates the Azure AD session and
    injects X-User-Email, X-User-Name, X-User-Role, and X-User-Roles headers
    before forwarding requests here. These headers are trusted.

    Locally (no proxy): set FORGE_DEV_USER_EMAIL to bypass auth entirely.
    """
    email = request.headers.get("X-User-Email", "")

    # Local dev fallback — proxy not running
    if not email and _DEV_EMAIL:
        log.debug("dev_auth_fallback", user=_DEV_EMAIL)
        return {
            "email": _DEV_EMAIL,
            "name": _DEV_NAME,
            "role": _DEV_ROLE,
            "roles": [_DEV_ROLE],
        }

    if not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    return {
        "email": email,
        "name": request.headers.get("X-User-Name", email.split("@")[0]),
        "role": request.headers.get("X-User-Role", "Viewer"),
        "roles": request.headers.get("X-User-Roles", "").split(","),
    }
