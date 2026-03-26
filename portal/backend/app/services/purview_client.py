"""Microsoft Purview lineage and catalog client."""
from __future__ import annotations

from typing import Any

import structlog
from azure.identity import DefaultAzureCredential
from azure.purview.catalog import PurviewCatalogClient

from app.core.config import get_settings

log = structlog.get_logger(__name__)
settings = get_settings()


def _get_client() -> PurviewCatalogClient:
    credential = DefaultAzureCredential()
    return PurviewCatalogClient(
        endpoint=settings.purview_endpoint,
        credential=credential,
    )


def get_lineage(
    qualified_name: str,
    direction: str = "BOTH",
    depth: int = 3,
) -> dict[str, Any]:
    """Get lineage graph for an entity by its qualified name."""
    try:
        client = _get_client()
        # First resolve the entity GUID from qualified name
        entity = get_entity(qualified_name)
        if not entity:
            return {"upstream": [], "downstream": [], "entity": None}

        guid = entity.get("guid", "")
        if not guid:
            return {"upstream": [], "downstream": [], "entity": entity}

        result = client.lineage.get_lineage_graph(
            guid=guid,
            direction=direction,
            depth=depth,
        )
        raw = dict(result)

        upstream: list[dict[str, Any]] = []
        downstream: list[dict[str, Any]] = []

        base_guid = raw.get("baseEntityGuid", guid)
        relations = raw.get("relations", [])
        entities_map: dict[str, Any] = {}
        for e in raw.get("guidEntityMap", {}).values():
            g = e.get("guid", "")
            entities_map[g] = e

        for rel in relations:
            from_g = rel.get("fromEntityId", "")
            to_g = rel.get("toEntityId", "")
            from_e = entities_map.get(from_g, {})
            to_e = entities_map.get(to_g, {})
            if to_g == base_guid:
                upstream.append({
                    "guid": from_g,
                    "name": from_e.get("attributes", {}).get("name", from_g),
                    "type": from_e.get("typeName", ""),
                    "qualified_name": from_e.get("attributes", {}).get("qualifiedName", ""),
                })
            elif from_g == base_guid:
                downstream.append({
                    "guid": to_g,
                    "name": to_e.get("attributes", {}).get("name", to_g),
                    "type": to_e.get("typeName", ""),
                    "qualified_name": to_e.get("attributes", {}).get("qualifiedName", ""),
                })

        return {
            "entity": entity,
            "upstream": upstream,
            "downstream": downstream,
        }
    except Exception as exc:
        log.error("purview_lineage_failed", qualified_name=qualified_name, error=str(exc))
        raise


def get_entity(qualified_name: str) -> dict[str, Any] | None:
    """Get entity metadata by qualified name."""
    try:
        client = _get_client()
        result = client.entity.get_by_unique_attributes(
            type_name="DataSet",
            attr_qualified_name=qualified_name,
        )
        raw = dict(result)
        entity = raw.get("entity", raw)
        return {
            "guid": entity.get("guid", ""),
            "type": entity.get("typeName", ""),
            "name": entity.get("attributes", {}).get("name", qualified_name),
            "qualified_name": qualified_name,
            "attributes": entity.get("attributes", {}),
        }
    except Exception as exc:
        log.warning("purview_entity_not_found", qualified_name=qualified_name, error=str(exc))
        return None


def search_entities(query_str: str, limit: int = 20) -> list[dict[str, Any]]:
    """Search the Purview catalog."""
    try:
        client = _get_client()
        body = {
            "keywords": query_str,
            "limit": limit,
            "offset": 0,
        }
        result = client.discovery.query(body=body)
        raw = dict(result)
        items = raw.get("value", [])
        return [
            {
                "id": item.get("id", ""),
                "name": item.get("name", ""),
                "type": item.get("entityType", ""),
                "qualified_name": item.get("qualifiedName", ""),
                "description": item.get("userDescription", ""),
                "classification": item.get("classification", []),
            }
            for item in items
        ]
    except Exception as exc:
        log.error("purview_search_failed", query=query_str, error=str(exc))
        raise
