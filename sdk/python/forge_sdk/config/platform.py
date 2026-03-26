"""
forge_sdk.config.platform — Platform configuration dataclass.

Reads configuration from environment variables with sensible defaults
for each Forge deployment environment (dev/prod).
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class PlatformConfig:
    """
    Immutable platform configuration for a Forge deployment.

    All values default to the dev environment when environment variables are
    absent, so local development works out-of-the-box without any extra setup.

    Environment variables:
        FORGE_ENV              — Target environment (dev | prod). Default: dev
        FORGE_ADLS_ACCOUNT     — ADLS Gen2 storage account name. Default: forgeadls{env}
        AZURE_TENANT_ID        — Azure AD tenant ID.
        FORGE_PURVIEW_ENDPOINT — Full URL of the Microsoft Purview account.
        FORGE_OL_NAMESPACE     — OpenLineage namespace used in Purview lineage.
    """

    env: str
    adls_account: str
    tenant_id: str
    purview_endpoint: str
    openlineage_namespace: str

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def from_env(cls) -> "PlatformConfig":
        """Build a PlatformConfig by reading environment variables."""
        env = os.environ.get("FORGE_ENV", "dev")
        return cls(
            env=env,
            adls_account=os.environ.get("FORGE_ADLS_ACCOUNT", f"forgeadls{env}"),
            tenant_id=os.environ.get(
                "AZURE_TENANT_ID", "72f988bf-86f1-41af-91ab-2d7cd011db47"
            ),
            purview_endpoint=os.environ.get(
                "FORGE_PURVIEW_ENDPOINT",
                f"https://purview-forge-{env}.purview.azure.com",
            ),
            openlineage_namespace=os.environ.get("FORGE_OL_NAMESPACE", f"forge-{env}"),
        )

    # ------------------------------------------------------------------
    # Path helper
    # ------------------------------------------------------------------

    def abfss(self, container: str, path: str = "") -> str:
        """
        Return a fully qualified ABFS URI for a path inside a container.

        Args:
            container: One of bronze | silver | gold | sandbox | checkpoints | code
            path:      Optional path within the container (leading slash stripped).

        Returns:
            ``abfss://<container>@<account>.dfs.core.windows.net[/<path>]``

        Example:
            >>> cfg = PlatformConfig.from_env()
            >>> cfg.abfss("silver", "crm/orders_cleaned")
            'abfss://silver@forgeadlsdev.dfs.core.windows.net/crm/orders_cleaned'
        """
        base = f"abfss://{container}@{self.adls_account}.dfs.core.windows.net"
        return f"{base}/{path.lstrip('/')}" if path else base
