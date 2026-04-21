"""Trino query client using the trino Python package."""
from __future__ import annotations

from typing import Any

import structlog
import trino

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
    results: list[dict[str, Any]] = []
    schemas = [LAYER_SCHEMAS[layer]] if layer and layer in LAYER_SCHEMAS else list(LAYER_SCHEMAS.values())

    for schema in schemas:
        try:
            tables = query(f"SHOW TABLES FROM {settings.trino_catalog}.{schema}")
            for t in tables:
                table_name = t.get("Table") or t.get("table") or ""
                results.append({
                    "name": table_name,
                    "layer": schema,
                    "schema": schema,
                    "catalog": settings.trino_catalog,
                })
        except Exception as exc:
            log.warning("trino_show_tables_failed", schema=schema, error=str(exc))

    return results


def get_table_stats(catalog: str, schema: str, table: str) -> dict[str, Any]:
    """Get basic stats for a table."""
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

    return {
        "row_count": row_count,
        "last_updated": last_updated,
        "size_bytes": None,  # Not directly available without Hive metastore DESCRIBE EXTENDED
    }


def get_dq_summary() -> list[dict[str, Any]]:
    """Query _dq Delta tables to aggregate pass rates by dataset."""
    results: list[dict[str, Any]] = []
    try:
        # DQ results are stored in lakehouse._dq schema
        tables = query(f"SHOW TABLES FROM {settings.trino_catalog}._dq")
        for t in tables:
            table_name = t.get("Table") or t.get("table") or ""
            if not table_name.endswith("_results"):
                continue
            dataset_name = table_name.replace("_results", "")
            try:
                rows = query(
                    f"SELECT "
                    f"  COUNT(*) AS total_runs, "
                    f"  SUM(CASE WHEN status = 'PASS' THEN 1 ELSE 0 END) AS passes, "
                    f"  SUM(CASE WHEN status = 'FAIL' AND severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical_failures, "
                    f"  SUM(CASE WHEN status = 'WARN' THEN 1 ELSE 0 END) AS warnings, "
                    f"  MAX(run_at) AS last_run_at, "
                    f"  MAX_BY(status, run_at) AS last_status "
                    f"FROM {settings.trino_catalog}._dq.{table_name}"
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
    except Exception as exc:
        log.error("trino_dq_summary_failed", error=str(exc))

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
