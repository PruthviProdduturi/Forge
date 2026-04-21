"""
forge_sdk.spark.session — SparkSession factory for the Forge platform.

:func:`forge_session` creates a :class:`~pyspark.sql.SparkSession` pre-wired
for:

* **ADLS Gen2** access via Azure Workload Identity (ABFS OAuth2)
* **Delta Lake** as the default table format and catalog
* **OpenLineage → Microsoft Purview** automatic lineage capture

In a production Spark Operator job the SparkSession is already created by the
operator before ``main()`` is called — :func:`forge_session` will simply
return the existing active session via ``getOrCreate()``.

Use this factory explicitly for:

* Local unit tests (``local[*]`` master)
* Spark Connect interactive sessions (prefer :func:`~forge_sdk.spark.connect.forge_connect`)
* Any context where you need to control ``app_name`` or pass ``extra_conf``
"""
from __future__ import annotations

import logging

from pyspark.sql import SparkSession

from forge_sdk.config.platform import PlatformConfig

logger = logging.getLogger(__name__)


def forge_session(
    app_name: str,
    config: PlatformConfig | None = None,
    extra_conf: dict[str, str] | None = None,
) -> SparkSession:
    """
    Create (or retrieve) a :class:`~pyspark.sql.SparkSession` pre-configured
    for the Forge platform.

    Configuration applied:

    * Delta Lake extensions and catalog
    * ADLS Gen2 OAuth2 via Workload Identity (OIDC token provider)
    * OpenLineage listener posting to Microsoft Purview via ``azure_identity``
      transport (no static tokens)

    Args:
        app_name:   SparkApplication name.  Appears in the Spark UI, Purview
                    lineage, and cluster logs.
        config:     :class:`~forge_sdk.config.platform.PlatformConfig`.
                    Defaults to :meth:`~forge_sdk.config.platform.PlatformConfig.from_env`.
        extra_conf: Additional Spark configuration key-value pairs merged on
                    top of the platform defaults.  Use to pass job-specific
                    settings without subclassing.

    Returns:
        A configured :class:`~pyspark.sql.SparkSession`.

    Example::

        from forge_sdk import forge_session, silver

        spark = forge_session("crm-orders-silver")
        df = spark.read.format("delta").load(silver("crm/orders_cleaned"))
        df.show()
    """
    cfg = config or PlatformConfig.from_env()

    logger.debug(
        "Building SparkSession app_name=%s env=%s adls=%s",
        app_name,
        cfg.env,
        cfg.adls_account,
    )

    builder = (
        SparkSession.builder.appName(app_name)
        .enableHiveSupport()
        # ------------------------------------------------------------------
        # Delta Lake
        # ------------------------------------------------------------------
        .config(
            "spark.sql.extensions",
            "io.delta.sql.DeltaSparkSessionExtension",
        )
        .config(
            "spark.sql.catalog.spark_catalog",
            "org.apache.spark.sql.delta.catalog.DeltaCatalog",
        )
        # ------------------------------------------------------------------
        # ADLS Gen2 — Azure Workload Identity (OIDC)
        # ------------------------------------------------------------------
        .config(
            f"fs.azure.account.auth.type.{cfg.adls_account}.dfs.core.windows.net",
            "OAuth",
        )
        .config(
            f"fs.azure.account.oauth.provider.type.{cfg.adls_account}.dfs.core.windows.net",
            "org.apache.hadoop.fs.azurebfs.oauth2.WorkloadIdentityTokenProvider",
        )
        .config("fs.azure.account.oauth2.msi.tenant", cfg.tenant_id)
        # ------------------------------------------------------------------
        # OpenLineage → Microsoft Purview
        # ------------------------------------------------------------------
        .config(
            "spark.extraListeners",
            "io.openlineage.spark.agent.OpenLineageSparkListener",
        )
        .config("spark.openlineage.transport.type", "http")
        .config(
            "spark.openlineage.transport.url",
            (
                f"{cfg.purview_endpoint}/dataMap/openlineage"
                f"/namespaces/{cfg.openlineage_namespace}/events"
            ),
        )
        .config("spark.openlineage.transport.auth.type", "azure_identity")
        .config("spark.openlineage.namespace", cfg.openlineage_namespace)
        .config("spark.openlineage.appName", app_name)
    )

    if extra_conf:
        for key, value in extra_conf.items():
            builder = builder.config(key, value)

    session = builder.getOrCreate()
    logger.info(
        "SparkSession ready app_name=%s spark_version=%s",
        app_name,
        session.version,
    )
    return session
