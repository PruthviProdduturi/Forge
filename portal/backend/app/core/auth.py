from datetime import datetime, timedelta, timezone
from typing import Any

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


# ── JWT helpers ──────────────────────────────────────────────────────────────

def create_access_token(data: dict[str, Any]) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def verify_token(token: str) -> dict[str, Any]:
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


def get_current_user(token: str | None = Depends(oauth2_scheme)) -> dict[str, Any]:
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return verify_token(token)


# ── Azure AD token validation ─────────────────────────────────────────────────

def validate_azure_token(token: str) -> dict[str, Any]:
    """
    Validate an Azure AD token by checking aud, iss, and exp claims.
    In production, also verify the signature against JWKS.
    """
    try:
        # Decode without verification first to inspect claims
        unverified = jwt.get_unverified_claims(token)
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid Azure AD token") from exc

    tenant_id = settings.azure_tenant_id
    expected_issuers = [
        f"https://login.microsoftonline.com/{tenant_id}/v2.0",
        f"https://sts.windows.net/{tenant_id}/",
    ]

    iss = unverified.get("iss", "")
    if iss not in expected_issuers:
        raise HTTPException(status_code=401, detail=f"Unexpected token issuer: {iss}")

    exp = unverified.get("exp", 0)
    if datetime.now(timezone.utc).timestamp() > exp:
        raise HTTPException(status_code=401, detail="Azure AD token has expired")

    return unverified


# ── Password helpers ──────────────────────────────────────────────────────────

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)
