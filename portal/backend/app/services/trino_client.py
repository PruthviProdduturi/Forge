"""Trino query client using the trino Python package."""
from __future__ import annotations

from typing import Any

import structlog
import trino

from app.core.cache import cache
from app.core.config import get_settings

log = structlog.get_logger(__name__)
settings = get_settings()

LAYER_SCHEMAS = {
    "bronze": "bronze",
    "silver": "silver",
    "gold": "gold",
}


def _get_connection() -> trino.dbapi.Connection:
    """Create a Trino connection.

    Port 443 → HTTPS ingress (e.g. external/dev-laptop access via Trino auth proxy).
    Any other port → HTTP internal cluster service (no auth required; trino package
    raises an error if auth is set on an http connection).
    """
    port = settings.trino_port
    http_scheme = "https" if port == 443 else "http"
    kwargs: dict[str, Any] = {
        "host": settings.trino_host,
        "port": port,
        "catalog": settings.trino_catalog,
        "schema": settings.trino_schema,
        "http_scheme": http_scheme,
        "user": "portal-api",  # Trino requires X-Trino-User even on HTTP (no proxy auth)
    }
    if http_scheme == "https":
        kwargs["auth"] = trino.auth.JWTAuthentication("")

    return trino.dbapi.connect(**kwargs)


def query(sql: str) -> list[dict[str, Any]]:
    """Execute SQL, return list of row dicts."""
    conn = _get_connection()
    try:
        cur = conn.cursor()
        cur.execute(sql)
        cols = [desc[0] for desc in cur.description] if cur.description else []
        rows = cur.fetchall()
        return [dict(zip(cols, row)) for row in rows]
    except Exception as exc:
        log.error("trino_query_failed", sql=sql[:200], error=str(exc))
        raise
    finally:
        conn.close()


def get_datasets(layer: str | None = None) -> list[dict[str, Any]]:
    """List tables in the relevant schema(s) of the lakehouse catalog."""
    cache_key = f"trino:datasets:{layer or 'all'}"
    hit, val = cache.get(cache_key)
    if hit:
        return val  # type: ignore[return-value]

    results: list[dict[str, Any]] = []
    schemas = [LAYER_SCHEMAS[layer]] if layer and layer in LAYER_SCHEMAS else list(LAYER_SCHEMAS.values())

    for schema in schemas:
        try:
            tables = query(f"SHOW TABLES FROM {settings.trino_catalog}.{schema}")

            # Filter out stale tables whose ADLS data is gone — a single batch query
            # against information_schema.columns is O(1) per schema and only returns
            # tables that actually have live column metadata.
            try:
                live_rows = query(
                    f"SELECT DISTINCT table_name "
                    f"FROM {settings.trino_catalog}.information_schema.columns "
                    f"WHERE table_schema = '{schema}'"
                )
                live_tables = {r.get("table_name") or r.get("TABLE_NAME") or "" for r in live_rows}
            except Exception as exc:
                log.warning("trino_live_tables_check_failed", schema=schema, error=str(exc))
                live_tables = None  # fall back to unfiltered list

            for t in tables:
                table_name = t.get("Table") or t.get("table") or ""
                if live_tables is not None and table_name not in live_tables:
                    log.debug("trino_stale_table_skipped", schema=schema, table=table_name)
                    continue
                results.append({
                    "name": table_name,
                    "layer": schema,
                    "schema": schema,
                    "catalog": settings.trino_catalog,
                })
        except Exception as exc:
            log.warning("trino_show_tables_failed", schema=schema, error=str(exc))

    cache.set(cache_key, results, ttl=60)
    return results


def get_table_stats(catalog: str, schema: str, table: str) -> dict[str, Any]:
    """Get basic stats for a table."""
    cache_key = f"trino:stats:{catalog}/{schema}/{table}"
    hit, val = cache.get(cache_key)
    if hit:
        return val  # type: ignore[return-value]

    fqn = f"{catalog}.{schema}.{table}"
    try:
        count_rows = query(f"SELECT COUNT(*) AS row_count FROM {fqn}")
        row_count = count_rows[0].get("row_count") if count_rows else None
    except Exception as exc:
        log.warning("trino_table_stats_failed", table=fqn, error=str(exc))
        row_count = None

    # Try to get last updated if the table has an updated_at or _updated_at column
    last_updated = None
    try:
        cols = query(
            f"SELECT column_name FROM information_schema.columns "
            f"WHERE table_catalog = '{catalog}' AND table_schema = '{schema}' "
            f"AND table_name = '{table}' "
            f"AND lower(column_name) IN ('updated_at', '_updated_at', 'modified_at', 'event_time')"
        )
        if cols:
            col_name = cols[0]["column_name"]
            ts_rows = query(f"SELECT MAX({col_name}) AS last_updated FROM {fqn}")
            if ts_rows:
                last_updated = ts_rows[0].get("last_updated")
                if last_updated is not None:
                    last_updated = str(last_updated)
    except Exception:
        pass

    result = {
        "row_count": row_count,
        "last_updated": last_updated,
        "size_bytes": None,  # Not directly available without Hive metastore DESCRIBE EXTENDED
    }
    cache.set(cache_key, result, ttl=120)
    return result


def get_table_schema(catalog: str, schema: str, table: str) -> list[dict[str, Any]]:
    """Return column names, types and ordinal positions for a table."""
    cache_key = f"trino:schema:{catalog}/{schema}/{table}"
    hit, val = cache.get(cache_key)
    if hit:
        return val  # type: ignore[return-value]

    try:
        rows = query(
            f"SELECT column_name, data_type, ordinal_position "
            f"FROM {catalog}.information_schema.columns "
            f"WHERE table_schema = '{schema}' AND table_name = '{table}' "
            f"ORDER BY ordinal_position"
        )
        result = [
            {"name": r["column_name"], "type": r["data_type"], "position": r["ordinal_position"]}
            for r in rows
        ]
        cache.set(cache_key, result, ttl=300)
        return result
    except Exception as exc:
        log.warning("trino_schema_failed", table=f"{catalog}.{schema}.{table}", error=str(exc))
        return []


def get_dq_summary() -> list[dict[str, Any]]:
    """Query _dq Delta tables to aggregate pass rates by dataset.

    DQ rule results are stored one-row-per-rule in ``_dq.{layer}_{slug}_rules``
    tables (registered by DeltaWriter._register_hms with output_type="rules").
    We group by run_id first to get per-run stats, then aggregate across runs.
    """
    cache_key = "trino:dq_summary"
    hit, val = cache.get(cache_key)
    if hit:
        return val  # type: ignore[return-value]

    results: list[dict[str, Any]] = []
    try:
        # DQ rule result tables are named {safe_dataset}_rules
        # _safe_dataset_name("bronze/nyctaxibronze") → "bronze_nyctaxibronze"
        tables = query(f"SHOW TABLES FROM {settings.trino_catalog}._dq")
        table_names = [t.get("Table") or t.get("table") or "" for t in tables]

        rules_datasets: set[str] = set()

        for table_name in table_names:
            if not table_name.endswith("_rules"):
                continue
            safe_name = table_name[:-6]  # strip "_rules"
            # Reverse _safe_dataset_name: first "_" separates layer from slug
            dataset_name = safe_name.replace("_", "/", 1)
            rules_datasets.add(dataset_name)
            try:
                rows = query(
                    f"WITH runs AS ("
                    f"  SELECT run_id, MAX(run_timestamp) AS last_ts,"
                    f"    MAX(CASE WHEN status = 'FAIL' AND upper(severity) = 'CRITICAL' THEN 1 ELSE 0 END) AS crit,"
                    f"    MAX(CASE WHEN status = 'WARN' THEN 1 ELSE 0 END) AS warn"
                    f"  FROM {settings.trino_catalog}._dq.{table_name}"
                    f"  GROUP BY run_id"
                    f")"
                    f"SELECT"
                    f"  COUNT(*) AS total_runs,"
                    f"  SUM(CASE WHEN crit = 0 AND warn = 0 THEN 1 ELSE 0 END) AS passes,"
                    f"  SUM(crit) AS critical_failures,"
                    f"  SUM(warn) AS warnings,"
                    f"  MAX(last_ts) AS last_run_at,"
                    f"  MAX_BY(CASE WHEN crit > 0 THEN 'FAIL' WHEN warn > 0 THEN 'WARN' ELSE 'PASS' END, last_ts) AS last_status"
                    f" FROM runs"
                )
                if rows:
                    r = rows[0]
                    total = r.get("total_runs") or 0
                    passes = r.get("passes") or 0
                    results.append({
                        "dataset": dataset_name,
                        "total_runs": total,
                        "pass_rate": round(passes / total, 4) if total > 0 else 0.0,
                        "last_run_at": str(r.get("last_run_at") or ""),
                        "critical_failures": r.get("critical_failures") or 0,
                        "warnings": r.get("warnings") or 0,
                        "last_status": r.get("last_status") or "PASS",
                    })
            except Exception as exc:
                log.warning("trino_dq_table_failed", table=table_name, error=str(exc))

        # Fallback: datasets with _auto profiling but no _rules yet show as "Monitored"
        for table_name in table_names:
            if not table_name.endswith("_auto"):
                continue
            safe_name = table_name[:-5]  # strip "_auto"
            dataset_name = safe_name.replace("_", "/", 1)
            if dataset_name in rules_datasets:
                continue  # already covered by _rules entry
            try:
                rows = query(
                    f"SELECT COUNT(*) AS runs, MAX(run_timestamp) AS last_ts"
                    f" FROM {settings.trino_catalog}._dq.{table_name}"
                )
                if rows:
                    r = rows[0]
                    results.append({
                        "dataset": dataset_name,
                        "total_runs": r.get("runs") or 0,
                        "pass_rate": None,
                        "last_run_at": str(r.get("last_ts") or ""),
                        "critical_failures": 0,
                        "warnings": 0,
                        "last_status": "MONITORED",
                    })
            except Exception as exc:
                log.warning("trino_dq_auto_fallback_failed", table=table_name, error=str(exc))

    except Exception as exc:
        log.error("trino_dq_summary_failed", error=str(exc))

    cache.set(cache_key, results, ttl=60)
    return results


def get_dq_dataset(safe_name: str, limit: int = 50) -> list[dict[str, Any]]:
    """Recent rule results for one dataset."""
    table = f"{safe_name}_results"
    try:
        return query(
            f"SELECT * FROM {settings.trino_catalog}._dq.{table} "
            f"ORDER BY run_at DESC LIMIT {limit}"
        )
    except Exception as exc:
        log.error("trino_dq_dataset_failed", dataset=safe_name, error=str(exc))
        return []


def ping() -> bool:
    """Return True if Trino endpoint is reachable (no query executed).

    Uses https when port is 443 (HTTPS ingress) regardless of env.
    Accepts any HTTP response including 302/401 — those mean the ingress/proxy
    is up even if the request is unauthenticated.
    """
    import httpx
    try:
        port = settings.trino_port
        scheme = "https" if port == 443 else "http"
        url = f"{scheme}://{settings.trino_host}:{port}/v1/info"
        resp = httpx.get(url, timeout=5, verify=False, follow_redirects=False)
        return resp.status_code < 500
    except Exception:
        return False
