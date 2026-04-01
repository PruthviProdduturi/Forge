"""Lineage API routes backed by Microsoft Purview."""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import get_current_user
from app.services import purview_client

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/lineage", tags=["lineage"])

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


@router.get("/search")
async def search_lineage(
    current_user: CurrentUser,
    q: str = Query(..., min_length=1),
) -> list[dict[str, Any]]:
    """Search the Purview catalog."""
    try:
        results = await asyncio.to_thread(purview_client.search_entities, q)
        return results
    except Exception as exc:
        log.error("lineage_search_failed", query=q, error=str(exc))
        raise HTTPException(status_code=502, detail="Could not search Purview catalog") from exc


@router.get("/{qualified_name:path}")
async def get_lineage(
    qualified_name: str,
    current_user: CurrentUser,
    direction: str = Query("BOTH"),
    depth: int = Query(3, ge=1, le=10),
) -> dict[str, Any]:
    """Return lineage graph (upstream + downstream) for the given qualified name."""
    try:
        result = await asyncio.to_thread(
            purview_client.get_lineage, qualified_name, direction, depth
        )
        return result
    except Exception as exc:
        log.error("lineage_fetch_failed", qualified_name=qualified_name, error=str(exc))
        raise HTTPException(
            status_code=502,
            detail=f"Could not retrieve lineage for '{qualified_name}'",
        ) from exc
