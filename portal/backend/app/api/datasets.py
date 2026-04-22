"""Datasets API routes."""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services import trino_client

settings = get_settings()

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/datasets", tags=["datasets"])

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]

LAYER_COLORS = {
    "bronze": "#cd7f32",
    "silver": "#a8a9ad",
    "gold": "#d4af37",
}


def _build_dataset_entry(
    table_info: dict[str, Any],
    stats: dict[str, Any],
    dq_datasets: set[str],
) -> dict[str, Any]:
    name = table_info["name"]
    layer = table_info["layer"]
    return {
        "name": name,
        "layer": layer,
        "schema": table_info["schema"],
        "row_count": stats.get("row_count"),
        "last_updated": stats.get("last_updated"),
        "size_bytes": stats.get("size_bytes"),
        "has_dq": f"{layer}/{name}" in dq_datasets,
    }


async def _fetch_datasets(layer: str | None = None) -> list[dict[str, Any]]:
    try:
        tables = await asyncio.to_thread(trino_client.get_datasets, layer)
    except Exception as exc:
        log.error("datasets_list_failed", error=str(exc))
        raise HTTPException(status_code=502, detail="Could not query Trino") from exc

    # Get DQ-enabled dataset names
    dq_datasets: set[str] = set()
    try:
        dq_summaries = await asyncio.to_thread(trino_client.get_dq_summary)
        dq_datasets = {s["dataset"] for s in dq_summaries}
    except Exception:
        pass

    # Fetch stats for each table (in parallel, capped to avoid overwhelming Trino)
    sem = asyncio.Semaphore(5)

    async def fetch_one(t: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            try:
                stats = await asyncio.to_thread(
                    trino_client.get_table_stats,
                    t["catalog"],
                    t["schema"],
                    t["name"],
                )
            except Exception:
                stats = {"row_count": None, "last_updated": None, "size_bytes": None}
            return _build_dataset_entry(t, stats, dq_datasets)

    results = await asyncio.gather(*[fetch_one(t) for t in tables], return_exceptions=True)
    return [r for r in results if isinstance(r, dict)]


@router.get("")
async def list_datasets(current_user: CurrentUser) -> list[dict[str, Any]]:
    """List all datasets grouped by layer."""
    return await _fetch_datasets()


@router.get("/{layer}")
async def list_datasets_by_layer(
    layer: str, current_user: CurrentUser
) -> list[dict[str, Any]]:
    """Filter datasets by layer: bronze, silver, or gold."""
    valid_layers = {"bronze", "silver", "gold"}
    if layer not in valid_layers:
        raise HTTPException(status_code=400, detail=f"Layer must be one of: {valid_layers}")
    return await _fetch_datasets(layer)


@router.get("/{layer}/{name}/schema")
async def get_dataset_schema(
    layer: str, name: str, current_user: CurrentUser
) -> dict[str, Any]:
    """Return column schema + stats for a single dataset."""
    valid_layers = {"bronze", "silver", "gold"}
    if layer not in valid_layers:
        raise HTTPException(status_code=400, detail=f"Layer must be one of: {valid_layers}")

    columns, stats = await asyncio.gather(
        asyncio.to_thread(trino_client.get_table_schema, settings.trino_catalog, layer, name),
        asyncio.to_thread(trino_client.get_table_stats, settings.trino_catalog, layer, name),
        return_exceptions=True,
    )

    return {
        "columns": columns if isinstance(columns, list) else [],
        "stats": stats if isinstance(stats, dict) else {"row_count": None, "last_updated": None, "size_bytes": None},
    }
