"""
forge_sdk.spark.connect — Spark Connect factory for interactive development.

:func:`forge_connect` returns a remote :class:`~pyspark.sql.SparkSession`
connected to the Forge Spark Connect server running on the dev cluster.

Intended use-cases:

* VS Code / Jupyter notebooks during active development
* Ad-hoc data exploration without a full Spark Operator submission
* Integration tests that run against a live dev cluster

For production batch jobs submitted via Spark Operator, use
:func:`~forge_sdk.spark.session.forge_session` or rely on the session
created by the operator.

Setup (recommended — set once in your shell profile or VS Code env)::

    export FORGE_COMPUTE_HOST=forge-compute-prproddudev.westcentralus.cloudapp.azure.com

Then in your notebook::

    from forge_sdk import forge_connect
    spark = forge_connect()   # connects to sc://<FORGE_COMPUTE_HOST>:15002

Endpoint resolution order:

1. ``endpoint`` argument (explicit override)
2. ``FORGE_SPARK_CONNECT_ENDPOINT`` env var (full URI, e.g. ``sc://host:15002``)
3. ``FORGE_COMPUTE_HOST`` env var → ``sc://<host>:15002``
4. ``sc://localhost:15002`` (port-forward fallback)

Trino connection (DBeaver / VS Code SQL extension)::

    Host:  $FORGE_COMPUTE_HOST   Port: 8080   Catalog: lakehouse
    Auth:  OAuth2 (opens browser on first connection)
"""
from __future__ import annotations

import logging
import os

from pyspark.sql import SparkSession

from forge_sdk.config.platform import PlatformConfig

logger = logging.getLogger(__name__)

_DEFAULT_ENDPOINT = "sc://localhost:15002"
_SPARK_CONNECT_PORT = 15002


def _resolve_endpoint(endpoint: str | None) -> str:
    """Resolve the Spark Connect endpoint from args / env vars / defaults."""
    if endpoint:
        return endpoint
    if ep := os.environ.get("FORGE_SPARK_CONNECT_ENDPOINT"):
        return ep
    if host := os.environ.get("FORGE_COMPUTE_HOST"):
        return f"sc://{host}:{_SPARK_CONNECT_PORT}"
    return _DEFAULT_ENDPOINT


def forge_connect(
    endpoint: str | None = None,
    app_name: str = "forge-interactive",
    config: PlatformConfig | None = None,
) -> SparkSession:
    """
    Connect to the Forge Spark Connect server for interactive development.

    Args:
        endpoint: Spark Connect URI (``sc://host:port``).  When ``None`` the
                  value is resolved from env vars (see module docstring).
        app_name: Session name shown in the Spark UI.
        config:   :class:`~forge_sdk.config.platform.PlatformConfig`.
                  Defaults to :meth:`~forge_sdk.config.platform.PlatformConfig.from_env`.

    Returns:
        Remote :class:`~pyspark.sql.SparkSession` connected to the Forge cluster.

    Raises:
        Exception: Propagates any Spark Connect connection errors so the
                   caller gets a clear error message if the server is unreachable.

    Example (VS Code notebook)::

        import os
        os.environ["FORGE_COMPUTE_HOST"] = "forge-compute-prproddudev.westcentralus.cloudapp.azure.com"

        from forge_sdk import forge_connect, silver
        spark = forge_connect()
        spark.read.format("delta").load(silver("crm/orders_cleaned")).show()
    """
    cfg = config or PlatformConfig.from_env()
    ep = _resolve_endpoint(endpoint)

    logger.info(
        "Connecting via Spark Connect endpoint=%s app_name=%s env=%s",
        ep,
        app_name,
        cfg.env,
    )

    session = (
        SparkSession.builder
        .remote(ep)
        .appName(app_name)
        .getOrCreate()
    )

    logger.info("Spark Connect session established app_name=%s", app_name)
    return session
