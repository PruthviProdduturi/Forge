"""Data Quality API routes."""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import get_current_user
from app.services import trino_client

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/dq", tags=["dq"])

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


@router.get("/summary")
async def get_dq_summary(current_user: CurrentUser) -> list[dict[str, Any]]:
    """Return DQ pass rate and critical failures per dataset."""
    try:
        results = await asyncio.to_thread(trino_client.get_dq_summary)
        return results
    except Exception as exc:
        log.error("dq_summary_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="Could not query DQ results from Trino") from exc


@router.get("/{safe_dataset_name}")
async def get_dq_dataset(
    safe_dataset_name: str, current_user: CurrentUser
) -> list[dict[str, Any]]:
    """Return recent rule results for a single dataset."""
    try:
        results = await asyncio.to_thread(trino_client.get_dq_dataset, safe_dataset_name)
        return results
    except Exception as exc:
        log.error("dq_dataset_failed", dataset=safe_dataset_name, error=str(exc))
        raise HTTPException(
            status_code=502,
            detail=f"Could not query DQ results for dataset '{safe_dataset_name}'",
        ) from exc
