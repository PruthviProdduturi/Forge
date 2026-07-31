"""Azure Cost Management client."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog
from azure.identity import DefaultAzureCredential
from azure.mgmt.costmanagement import CostManagementClient
from azure.mgmt.costmanagement.models import (
    QueryDefinition,
    QueryTimePeriod,
    QueryDataset,
    QueryAggregation,
    QueryGrouping,
)

from app.core.config import get_settings

log = structlog.get_logger(__name__)
settings = get_settings()

SCOPE = f"/subscriptions/{settings.subscription_id}"

# Cache: key → (result, fetched_at)
# Stale-while-revalidate: serve stale data immediately while refreshing in background.
_cache: dict[str, tuple[Any, float]] = {}
_CACHE_TTL = 900  # 15 min fresh window
_CACHE_STALE_TTL = 3600  # 1 hr — serve stale rather than hammer the API


def _cached(key: str, fn: Any, *args: Any) -> Any:
    entry = _cache.get(key)
    age = (time.monotonic() - entry[1]) if entry else float("inf")

    if entry and age < _CACHE_TTL:
        log.debug("cost_cache_hit", key=key)
        return entry[0]

    if entry and age < _CACHE_STALE_TTL:
        # Serve stale immediately; refresh in background
        log.info("cost_cache_stale_serve", key=key, age_s=int(age))
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(_refresh_cache, key, fn, args)
        return entry[0]

    # No usable cache — fetch synchronously
    return _refresh_cache(key, fn, args)


def _refresh_cache(key: str, fn: Any, args: tuple[Any, ...]) -> Any:
    try:
        result = fn(*args)
        _cache[key] = (result, time.monotonic())
        return result
    except Exception as exc:
        # On 429 or other error, keep serving stale if we have it
        entry = _cache.get(key)
        if entry:
            log.warning("cost_fetch_failed_serving_stale", key=key, error=str(exc))
            return entry[0]
        raise


def _get_client() -> CostManagementClient:
    credential = DefaultAzureCredential()
    return CostManagementClient(credential)


def _query_rg_cost(rg_name: str, days: int) -> dict[str, Any]:
    """Query Azure Cost Management for a single resource group."""
    sub = settings.subscription_id
    if not sub or not rg_name:
        raise ValueError("subscription_id and rg_name are required")

    scope = f"/subscriptions/{sub}/resourceGroups/{rg_name}"
    client = _get_client()
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days)

    query_def = QueryDefinition(
        type="ActualCost",
        timeframe="Custom",
        time_period=QueryTimePeriod(from_property=start_date, to=end_date),
        dataset=QueryDataset(
            granularity="None",
            aggregation={"totalCost": QueryAggregation(name="Cost", function="Sum")},
            grouping=[QueryGrouping(type="Dimension", name="ResourceType")],
        ),
    )

    result = client.query.usage(scope=scope, parameters=query_def)
    rows = result.rows or []
    columns = [c.name for c in (result.columns or [])]

    breakdown: list[dict[str, Any]] = []
    total_cost = 0.0
    currency = "USD"
    for row in rows:
        rd = dict(zip(columns, row))
        cost = float(rd.get("Cost", 0))
        total_cost += cost
        currency = rd.get("Currency", "USD")
        breakdown.append(
            {
                "resource_type": rd.get("ResourceType", "Unknown"),
                "cost": round(cost, 2),
            }
        )

    breakdown.sort(key=lambda x: x["cost"], reverse=True)
    return {
        "rg": rg_name,
        "total_cost": round(total_cost, 2),
        "currency": currency,
        "period_days": days,
        "breakdown": breakdown[:8],
    }


def get_by_rg(days: int = 30) -> list[dict[str, Any]]:
    """Return cost for the compute and orchestration RGs."""
    results = []

    if not settings.subscription_id:
        return [
            {
                "key": key,
                "display_name": display_name,
                "rg": "",
                "total_cost": None,
                "currency": "USD",
                "period_days": days,
                "breakdown": [],
                "error": "SUBSCRIPTION_ID not configured",
            }
            for key, _, display_name in [
                ("compute", settings.compute_rg, "Compute"),
                ("orchestration", settings.orch_rg, "Orchestration"),
            ]
        ]

    rgs = [
        ("compute", settings.compute_rg, "Compute"),
        ("orchestration", settings.orch_rg, "Orchestration"),
    ]

    def _fetch(key: str, rg_name: str, display_name: str) -> dict[str, Any]:
        if not rg_name:
            return {
                "key": key,
                "display_name": display_name,
                "rg": "",
                "total_cost": None,
                "currency": "USD",
                "period_days": days,
                "breakdown": [],
                "error": "RG name not configured",
            }
        cache_key = f"rg:{rg_name}:{days}"
        try:
            data = _cached(cache_key, _query_rg_cost, rg_name, days)
            return {**data, "key": key, "display_name": display_name}
        except Exception as exc:
            log.warning("rg_cost_failed", rg=rg_name, error=str(exc))
            return {
                "key": key,
                "display_name": display_name,
                "rg": rg_name,
                "total_cost": None,
                "currency": "USD",
                "period_days": days,
                "breakdown": [],
                "error": str(exc),
            }

    # Query both RGs in parallel
    order = {item[0]: i for i, item in enumerate(rgs)}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(_fetch, key, rg, name): key for key, rg, name in rgs}
        for future in as_completed(futures):
            results.append(future.result())

    results.sort(key=lambda r: order[r["key"]])
    return results


def get_summary(days: int = 30) -> dict[str, Any]:
    """Total spend last N days, grouped by resource type."""
    try:
        client = _get_client()
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)

        query_def = QueryDefinition(
            type="ActualCost",
            timeframe="Custom",
            time_period=QueryTimePeriod(
                from_property=start_date,
                to=end_date,
            ),
            dataset=QueryDataset(
                granularity="None",
                aggregation={
                    "totalCost": QueryAggregation(name="Cost", function="Sum"),
                },
                grouping=[
                    QueryGrouping(type="Dimension", name="ResourceType"),
                ],
            ),
        )

        result = client.query.usage(scope=SCOPE, parameters=query_def)
        rows = result.rows or []
        columns = [c.name for c in (result.columns or [])]

        # Build per-resource breakdown
        breakdown: list[dict[str, Any]] = []
        total_cost = 0.0
        for row in rows:
            row_dict = dict(zip(columns, row))
            cost = float(row_dict.get("Cost", 0))
            total_cost += cost
            breakdown.append(
                {
                    "resource_type": row_dict.get("ResourceType", "Unknown"),
                    "cost": round(cost, 2),
                    "currency": row_dict.get("Currency", "USD"),
                }
            )

        # Sort by cost descending, top 5
        breakdown.sort(key=lambda x: x["cost"], reverse=True)
        top5 = breakdown[:5]

        return {
            "total_cost": round(total_cost, 2),
            "currency": top5[0]["currency"] if top5 else "USD",
            "period_days": days,
            "top_resource_types": top5,
        }
    except Exception as exc:
        log.error("cost_summary_failed", error=str(exc))
        raise


def get_by_pipeline(days: int = 30) -> list[dict[str, Any]]:
    """Cost grouped by the 'pipeline' tag."""
    try:
        client = _get_client()
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)

        query_def = QueryDefinition(
            type="ActualCost",
            timeframe="Custom",
            time_period=QueryTimePeriod(
                from_property=start_date,
                to=end_date,
            ),
            dataset=QueryDataset(
                granularity="None",
                aggregation={
                    "totalCost": QueryAggregation(name="Cost", function="Sum"),
                },
                grouping=[
                    QueryGrouping(type="TagKey", name="pipeline"),
                ],
            ),
        )

        result = client.query.usage(scope=SCOPE, parameters=query_def)
        rows = result.rows or []
        columns = [c.name for c in (result.columns or [])]

        pipeline_costs: list[dict[str, Any]] = []
        for row in rows:
            row_dict = dict(zip(columns, row))
            cost = float(row_dict.get("Cost", 0))
            pipeline_tag = row_dict.get("pipeline", "untagged") or "untagged"
            pipeline_costs.append(
                {
                    "pipeline": pipeline_tag,
                    "cost": round(cost, 2),
                    "currency": row_dict.get("Currency", "USD"),
                }
            )

        pipeline_costs.sort(key=lambda x: x["cost"], reverse=True)
        return pipeline_costs
    except Exception as exc:
        log.error("cost_by_pipeline_failed", error=str(exc))
        raise
