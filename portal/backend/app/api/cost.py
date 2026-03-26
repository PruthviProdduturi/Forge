"""Cost API routes."""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import get_current_user
from app.services import cost_client

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/cost", tags=["cost"])

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


@router.get("/summary")
async def get_cost_summary(
    days: int = Query(30, ge=1, le=365),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Return total spend and top resource types for the last N days."""
    try:
        return await asyncio.to_thread(cost_client.get_summary, days)
    except Exception as exc:
        log.error("cost_summary_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="Could not retrieve cost data from Azure") from exc


@router.get("/by-pipeline")
async def get_cost_by_pipeline(
    days: int = Query(30, ge=1, le=365),
    current_user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Return spend per pipeline tag for the last N days."""
    try:
        return await asyncio.to_thread(cost_client.get_by_pipeline, days)
    except Exception as exc:
        log.error("cost_by_pipeline_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="Could not retrieve pipeline cost data") from exc
