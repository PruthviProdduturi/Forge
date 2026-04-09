"""
ForgeCatalog — discover tables, schemas, and datasets in the Forge lakehouse.

Connection resolution (same FORGE_COMPUTE_HOST pattern as forge_connect):

  Trino:
    1. trino_host / trino_port constructor args
    2. FORGE_TRINO_HOST / FORGE_TRINO_PORT env vars
    3. FORGE_COMPUTE_HOST:8080
    4. localhost:8080  (port-forward fallback)

  Portal API (optional — enriches results with DQ status and richer metadata):
    1. portal_url constructor arg
    2. FORGE_PORTAL_URL env var
    3. Omitted — Trino-only mode is fully functional without the portal

Usage::

    from forge_catalog import ForgeCatalog

    catalog = ForgeCatalog()
    tables  = catalog.tables("silver")        # list all silver tables
    cols    = catalog.schema("silver", "orders")
    hits    = catalog.search("order")         # search across all layers
    datasets = catalog.datasets()             # portal-enriched view
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import trino
import trino.dbapi

from forge_catalog.models import ColumnInfo, DatasetInfo, TableInfo

logger = logging.getLogger(__name__)

_LAYERS = ("bronze", "silver", "gold")
_TRINO_PORT = 8080


def _resolve_trino(host: str | None, port: int | None) -> tuple[str, int]:
    if host:
        return host, port or _TRINO_PORT
    if h := os.environ.get("FORGE_TRINO_HOST"):
        return h, int(os.environ.get("FORGE_TRINO_PORT", _TRINO_PORT))
    if h := os.environ.get("FORGE_COMPUTE_HOST"):
        return h, _TRINO_PORT
    return "localhost", _TRINO_PORT


def _resolve_portal(portal_url: str | None) -> str | None:
    return portal_url or os.environ.get("FORGE_PORTAL_URL")


class ForgeCatalog:
    """
    Browse and search data assets in the Forge lakehouse.

    All methods talk to Trino directly.  When ``portal_url`` is supplied (or
    ``FORGE_PORTAL_URL`` is set) the :meth:`datasets` method also fetches
    richer metadata from the Portal API — useful for notebooks that want DQ
    status, ownership, and lineage links alongside the raw Trino schema.

    Args:
        trino_host:  Hostname of the Trino coordinator.  Resolved from env if omitted.
        trino_port:  HTTP port (default 8080).
        portal_url:  Base URL of the Forge portal (e.g. https://forge-portal-dev.…).
        portal_token: Bearer token for portal API calls.  Resolved from
                      ``FORGE_PORTAL_TOKEN`` env var if omitted.
    """

    def __init__(
        self,
        trino_host: str | None = None,
        trino_port: int | None = None,
        portal_url: str | None = None,
        portal_token: str | None = None,
    ) -> None:
        self._trino_host, self._trino_port = _resolve_trino(trino_host, trino_port)
        self._portal_url = _resolve_portal(portal_url)
        self._portal_token = portal_token or os.environ.get("FORGE_PORTAL_TOKEN")
        logger.debug(
            "ForgeCatalog trino=%s:%s portal=%s",
            self._trino_host, self._trino_port, self._portal_url,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _conn(self) -> trino.dbapi.Connection:
        return trino.dbapi.connect(
            host=self._trino_host,
            port=self._trino_port,
            user="forge-catalog",
            http_scheme="http",
        )

    def _query(self, sql: str) -> list[dict]:
        conn = self._conn()
        try:
            cur = conn.cursor()
            cur.execute(sql)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
        finally:
            conn.close()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def layers(self) -> list[str]:
        """Return the available medallion layers that have tables."""
        existing = []
        for layer in _LAYERS:
            try:
                rows = self._query(f"SHOW TABLES FROM delta.{layer}")
                if rows:
                    existing.append(layer)
            except Exception:
                pass
        return existing

    def tables(self, layer: str | None = None) -> list[TableInfo]:
        """
        List tables in the lakehouse.

        Args:
            layer: One of ``bronze``, ``silver``, ``gold``.  When ``None``
                   all layers are returned.

        Returns:
            List of :class:`TableInfo`, sorted by layer then name.
        """
        layers = [layer] if layer else list(_LAYERS)
        results: list[TableInfo] = []
        for lyr in layers:
            try:
                rows = self._query(f"SHOW TABLES FROM delta.{lyr}")
                for row in rows:
                    name = row.get("Table") or row.get("table") or list(row.values())[0]
                    results.append(TableInfo(name=name, layer=lyr))
            except Exception as exc:
                logger.warning("Could not list tables for layer=%s: %s", lyr, exc)
        return sorted(results, key=lambda t: (t.layer, t.name))

    def schema(self, layer: str, table: str) -> list[ColumnInfo]:
        """
        Return the column schema for a table.

        Args:
            layer: Medallion layer (bronze / silver / gold).
            table: Table name.

        Returns:
            Ordered list of :class:`ColumnInfo`.
        """
        rows = self._query(f"DESCRIBE delta.{layer}.{table}")
        cols = []
        for row in rows:
            # Trino DESCRIBE returns: Column, Type, Extra, Comment
            name  = row.get("Column") or row.get("column") or list(row.values())[0]
            dtype = row.get("Type")   or row.get("type")   or list(row.values())[1]
            comment = row.get("Comment") or row.get("comment")
            cols.append(ColumnInfo(
                name=name,
                data_type=dtype,
                comment=comment or None,
            ))
        return cols

    def search(self, query: str, layer: str | None = None) -> list[TableInfo]:
        """
        Search for tables whose name contains ``query`` (case-insensitive).

        Args:
            query: Substring to match against table names.
            layer: Restrict search to one layer.

        Returns:
            Matching :class:`TableInfo` objects.
        """
        q = query.lower()
        return [t for t in self.tables(layer) if q in t.name.lower()]

    def datasets(self, layer: str | None = None) -> list[DatasetInfo]:
        """
        Return datasets enriched with metadata from the Portal API.

        Falls back to plain Trino-derived data if the portal is unreachable.

        Args:
            layer: Filter by medallion layer.
        """
        if self._portal_url:
            try:
                return self._datasets_from_portal(layer)
            except Exception as exc:
                logger.warning("Portal datasets fetch failed, falling back to Trino: %s", exc)
        return self._datasets_from_trino(layer)

    def _datasets_from_trino(self, layer: str | None) -> list[DatasetInfo]:
        return [
            DatasetInfo(name=t.name, layer=t.layer)
            for t in self.tables(layer)
        ]

    def _datasets_from_portal(self, layer: str | None) -> list[DatasetInfo]:
        import httpx  # noqa: PLC0415
        headers: dict[str, str] = {}
        if self._portal_token:
            headers["Authorization"] = f"Bearer {self._portal_token}"
        path = f"/api/datasets/{layer}" if layer else "/api/datasets"
        resp = httpx.get(
            f"{self._portal_url.rstrip('/')}{path}",
            headers=headers,
            timeout=15.0,
        )
        resp.raise_for_status()
        datasets = []
        for item in resp.json():
            raw_schema = item.get("schema") or []
            cols = [
                ColumnInfo(
                    name=c.get("name", ""),
                    data_type=c.get("type", ""),
                    comment=c.get("comment"),
                )
                for c in raw_schema
            ]
            datasets.append(DatasetInfo(
                name=item["name"],
                layer=item["layer"],
                schema=cols,
                row_count=item.get("row_count"),
                last_updated=item.get("last_updated"),
                size_bytes=item.get("size_bytes"),
                has_dq=item.get("has_dq", False),
            ))
        return datasets
