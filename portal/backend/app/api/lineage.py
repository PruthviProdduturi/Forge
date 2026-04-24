"""Lineage API routes — derived from Airflow DAG source/output tags and Trino HMS."""
from __future__ import annotations

import asyncio
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, Query

from app.core.auth import get_current_user
from app.core.cache import cache
from app.services import airflow_client, trino_client

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/lineage", tags=["lineage"])

CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_lineage_graph() -> dict[str, dict[str, set[str]]]:
    """Build a lineage graph from Airflow DAG source/output tags.

    Returns a dict: normalized_name → {"upstream": set, "downstream": set}
    where normalized_name is the lowercase version of the tag value
    (e.g. "NycTaxiBronze" → "nyctaxibronze").

    DAGs emit two tag forms:
      source:NycTaxiBronze  — this DAG reads from NycTaxiBronze
      output:NycTaxiTrips   — this DAG writes to NycTaxiTrips
    """
    cache_key = "airflow:lineage_graph"
    hit, val = cache.get(cache_key)
    if hit:
        return val  # type: ignore[return-value]

    try:
        dags = await airflow_client.get_dags(limit=200, only_active=False)
    except Exception as exc:
        log.warning("lineage_airflow_failed", error=str(exc))
        return {}

    graph: dict[str, dict[str, set[str]]] = {}

    def _ensure(name: str) -> None:
        if name not in graph:
            graph[name] = {"upstream": set(), "downstream": set()}

    for dag in dags:
        tags = {t["name"] for t in dag.get("tags", [])}
        sources = {t[7:].lower() for t in tags if t.startswith("source:")}
        outputs = {t[7:].lower() for t in tags if t.startswith("output:")}

        for out in outputs:
            _ensure(out)
            graph[out]["upstream"].update(sources)

        for src in sources:
            _ensure(src)
            graph[src]["downstream"].update(outputs)

    cache.set(cache_key, graph, ttl=60)
    return graph


def _resolve_dataset(
    normalized: str,
    datasets_by_name: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Look up a normalized entity name in the HMS datasets map.

    Returns a lineage node dict — HMS table if found, external source otherwise.
    """
    ds = datasets_by_name.get(normalized)
    if ds:
        return {
            "guid": f"{ds['schema']}/{ds['name']}",
            "name": ds["name"],
            "type": f"{ds['layer'].capitalize()} Delta Table",
            "qualified_name": f"lakehouse.{ds['schema']}.{ds['name']}",
            "layer": ds["layer"],
        }
    # Unknown — external source or renamed table
    return {
        "guid": f"external:{normalized}",
        "name": normalized,
        "type": "External",
        "qualified_name": f"external:{normalized}",
        "layer": "external",
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/search")
async def search_lineage(
    current_user: CurrentUser,
    q: str = Query(..., min_length=1),
) -> list[dict[str, Any]]:
    """Search datasets in the Trino catalog."""
    try:
        all_datasets = await asyncio.to_thread(trino_client.get_datasets)
    except Exception as exc:
        log.error("lineage_search_failed", query=q, error=str(exc))
        return []

    q_lower = q.lower()
    results = [
        {
            "id": f"{d['schema']}/{d['name']}",
            "name": d["name"],
            "type": "Delta Table",
            "qualified_name": f"lakehouse.{d['schema']}.{d['name']}",
            "description": f"{d['layer'].capitalize()} layer — {d['schema']}.{d['name']}",
        }
        for d in all_datasets
        if q_lower in d["name"].lower() or q_lower in d["schema"].lower()
    ]
    return results[:20]


def _walk_direction(
    start: str,
    graph: dict[str, dict[str, set[str]]],
    direction: str,
    max_depth: int = 8,
) -> list[tuple[str, int]]:
    """BFS walk in one direction from *start*. Returns [(name, depth), ...]"""
    visited: set[str] = {start}
    result: list[tuple[str, int]] = []
    queue: list[tuple[str, int]] = [(start, 1)]
    while queue:
        current, depth = queue.pop(0)
        if depth > max_depth:
            continue
        for neighbor in graph.get(current, {}).get(direction, set()):
            if neighbor not in visited:
                visited.add(neighbor)
                result.append((neighbor, depth))
                queue.append((neighbor, depth + 1))
    return result


@router.get("/graph/{schema}/{table}")
async def get_lineage_graph(
    schema: str,
    table: str,
    current_user: CurrentUser,
) -> dict[str, Any]:
    """Return complete upstream + downstream lineage using Airflow DAG tags (multi-hop BFS)."""
    datasets_task = asyncio.create_task(asyncio.to_thread(trino_client.get_datasets))
    graph_task = asyncio.create_task(_get_lineage_graph())
    all_datasets, graph = await asyncio.gather(datasets_task, graph_task)

    datasets_by_name: dict[str, dict[str, Any]] = {
        d["name"].lower(): d for d in all_datasets
    }

    table_lower = table.lower()
    ds = datasets_by_name.get(table_lower)
    entity: dict[str, Any] = {
        "name": ds["name"] if ds else table,
        "type": f"{ds['layer'].capitalize()} Delta Table" if ds else "Delta Table",
        "qualified_name": f"lakehouse.{schema}.{table}",
        "layer": ds["layer"] if ds else schema,
    }

    # Walk full graph in both directions
    upstream_hops = _walk_direction(table_lower, graph, "upstream")
    downstream_hops = _walk_direction(table_lower, graph, "downstream")

    upstream = [
        {**_resolve_dataset(name, datasets_by_name), "depth": depth}
        for name, depth in upstream_hops
    ]
    downstream = [
        {**_resolve_dataset(name, datasets_by_name), "depth": depth}
        for name, depth in downstream_hops
    ]

    # Sort: upstream by ascending depth (closest first), then name
    upstream.sort(key=lambda x: (x["depth"], x["name"]))
    downstream.sort(key=lambda x: (x["depth"], x["name"]))

    log.info(
        "lineage_graph",
        table=f"{schema}.{table}",
        upstream=len(upstream),
        downstream=len(downstream),
    )
    return {"entity": entity, "upstream": upstream, "downstream": downstream}
