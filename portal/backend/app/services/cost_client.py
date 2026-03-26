"""Azure Cost Management client."""
from __future__ import annotations

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


def _get_client() -> CostManagementClient:
    credential = DefaultAzureCredential()
    return CostManagementClient(credential)


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
            breakdown.append({
                "resource_type": row_dict.get("ResourceType", "Unknown"),
                "cost": round(cost, 2),
                "currency": row_dict.get("Currency", "USD"),
            })

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
            pipeline_costs.append({
                "pipeline": pipeline_tag,
                "cost": round(cost, 2),
                "currency": row_dict.get("Currency", "USD"),
            })

        pipeline_costs.sort(key=lambda x: x["cost"], reverse=True)
        return pipeline_costs
    except Exception as exc:
        log.error("cost_by_pipeline_failed", error=str(exc))
        raise
