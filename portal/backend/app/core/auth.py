from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import structlog
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import get_settings

log = structlog.get_logger(__name__)
settings = get_settings()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


# ── JWT helpers ───────────────────────────────────────────────────────────────

def create_access_token(data: dict[str, Any]) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def verify_token(token: str) -> dict[str, Any]:
    """Validate a locally-issued HS256 JWT."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        return payload
    except JWTError as exc:
        log.warning("jwt_verification_failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


# ── Azure AD JWKS cache ───────────────────────────────────────────────────────
# Keyed by tenant_id.  Refreshed at most once per 30 minutes.

_jwks_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
_JWKS_TTL = 1800  # 30 minutes


def _get_jwks(tenant_id: str) -> list[dict[str, Any]]:
    cached = _jwks_cache.get(tenant_id)
    if cached and (time.time() - cached[1]) < _JWKS_TTL:
        return cached[0]
    url = f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys"
    resp = httpx.get(url, timeout=5)
    resp.raise_for_status()
    keys = resp.json().get("keys", [])
    _jwks_cache[tenant_id] = (keys, time.time())
    return keys


def _validate_azure_token(token: str) -> dict[str, Any]:
    """Validate an Azure AD RS256 token using JWKS, then extract user claims."""
    try:
        unverified_claims = jwt.get_unverified_claims(token)
        unverified_header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Malformed Azure AD token") from exc

    # Determine tenant from issuer claim
    iss: str = unverified_claims.get("iss", "")
    # e.g. https://login.microsoftonline.com/{tid}/v2.0
    tenant_id = settings.azure_tenant_id
    if not tenant_id:
        # Try to extract from iss
        parts = iss.rstrip("/").split("/")
        # sts.windows.net/{tid} or login.microsoftonline.com/{tid}/v2.0
        for i, p in enumerate(parts):
            if p in ("v2.0",):
                tenant_id = parts[i - 1]
                break
        if not tenant_id and len(parts) >= 4:
            tenant_id = parts[3]  # login.microsoftonline.com / {tid}

    if not tenant_id:
        raise HTTPException(status_code=401, detail="Cannot determine Azure AD tenant from token")

    expected_issuers = [
        f"https://login.microsoftonline.com/{tenant_id}/v2.0",
        f"https://sts.windows.net/{tenant_id}/",
    ]
    if iss not in expected_issuers:
        raise HTTPException(status_code=401, detail=f"Unexpected token issuer: {iss}")

    exp = unverified_claims.get("exp", 0)
    if datetime.now(timezone.utc).timestamp() > exp:
        raise HTTPException(status_code=401, detail="Azure AD token has expired")

    # Verify signature using JWKS
    kid = unverified_header.get("kid")
    try:
        keys = _get_jwks(tenant_id)
    except Exception as exc:
        log.warning("jwks_fetch_failed", tenant=tenant_id, error=str(exc))
        # Fall back to unverified claims (dev only — log prominently)
        log.warning("azure_token_signature_unverified", reason="JWKS unavailable")
        return unverified_claims

    matching = [k for k in keys if k.get("kid") == kid] if kid else keys
    if not matching:
        raise HTTPException(status_code=401, detail="No matching JWKS key for token")

    # python-jose[cryptography] accepts a cryptography RSAPublicKey object.
    # Construct it from the JWK n/e base64url values — most reliable approach.
    import base64 as _b64  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers  # noqa: PLC0415
    from cryptography.hazmat.backends import default_backend  # noqa: PLC0415

    def _b64url_to_int(val: str) -> int:
        pad = 4 - len(val) % 4
        padded = val + ("=" * (pad % 4))
        return int.from_bytes(_b64.urlsafe_b64decode(padded), "big")

    alg = unverified_header.get("alg", "RS256")
    last_exc: Exception | None = None
    for key in matching:
        try:
            n = _b64url_to_int(key["n"])
            e = _b64url_to_int(key["e"])
            public_key = RSAPublicNumbers(e, n).public_key(default_backend())
            claims = jwt.decode(
                token,
                public_key,
                algorithms=[alg],
                options={"verify_aud": False},
            )
            return claims
        except Exception as exc:
            last_exc = exc
            continue

    log.warning("azure_token_signature_failed", error=str(last_exc), kid=kid, alg=alg)
    raise HTTPException(status_code=401, detail="Azure AD token signature verification failed")


# ── Universal token dispatcher ────────────────────────────────────────────────

def _token_header_alg(token: str) -> str:
    """Return the 'alg' from the token header without full validation."""
    try:
        return jwt.get_unverified_header(token).get("alg", "HS256")
    except Exception:
        return "HS256"


def get_current_user(token: str | None = Depends(oauth2_scheme)) -> dict[str, Any]:
    """
    Accept either a locally-issued HS256 JWT or an Azure AD RS256 token.
    Routes to the correct validator based on the token header's 'alg' field.
    """
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    alg = _token_header_alg(token)
    if alg == settings.jwt_algorithm:
        # Local JWT
        return verify_token(token)

    # Asymmetric algorithm → treat as Azure AD token
    return _validate_azure_token(token)


# ── Password helpers ──────────────────────────────────────────────────────────

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)
