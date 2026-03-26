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

Setup:
    Port-forward the Spark Connect service::

        kubectl port-forward svc/spark-connect -n spark-connect 15002:15002

    Then set the endpoint env var::

        export FORGE_SPARK_CONNECT_ENDPOINT=sc://localhost:15002

    Or pass it explicitly::

        spark = forge_connect(endpoint="sc://localhost:15002")
"""
from __future__ import annotations

import logging
import os

from pyspark.sql import SparkSession

from forge_sdk.config.platform import PlatformConfig

logger = logging.getLogger(__name__)

_DEFAULT_ENDPOINT = "sc://localhost:15002"


def forge_connect(
    endpoint: str | None = None,
    app_name: str = "forge-interactive",
    config: PlatformConfig | None = None,
) -> SparkSession:
    """
    Connect to the Forge Spark Connect server for interactive development.

    The endpoint is resolved in this order:

    1. The ``endpoint`` argument (if provided)
    2. The ``FORGE_SPARK_CONNECT_ENDPOINT`` environment variable
    3. ``sc://localhost:15002`` (assumes ``kubectl port-forward`` is active)

    Args:
        endpoint: Spark Connect URI (``sc://host:port``).  When ``None`` the
                  value is taken from the environment variable or the default.
        app_name: Session name shown in the Spark UI.
        config:   :class:`~forge_sdk.config.platform.PlatformConfig`.
                  Defaults to :meth:`~forge_sdk.config.platform.PlatformConfig.from_env`.

    Returns:
        Remote :class:`~pyspark.sql.SparkSession` connected to the dev cluster.

    Raises:
        Exception: Propagates any Spark Connect connection errors so the
                   caller gets a clear error message if the server is unreachable.

    Example (VS Code notebook)::

        from forge_sdk.spark.connect import forge_connect
        from forge_sdk.storage.paths import silver

        spark = forge_connect()
        df = spark.read.format("delta").load(silver("crm/orders_cleaned"))
        df.show()
    """
    cfg = config or PlatformConfig.from_env()
    ep = endpoint or os.environ.get("FORGE_SPARK_CONNECT_ENDPOINT", _DEFAULT_ENDPOINT)

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
