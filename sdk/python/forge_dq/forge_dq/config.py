"""
forge_dq.config — Configuration loaded from environment variables.

Set by Helm chart / Spark operator at pod creation time:
  FORGE_ENV                 dev | staging | prod
  FORGE_ADLS_ACCOUNT        Storage account name (e.g. forgeadlsdev)
  FORGE_DQ_ENABLED          true | false  (default: true)
  FORGE_DQ_FAIL_ON_CRITICAL true | false  (default: true)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool_env(var: str, default: bool) -> bool:
    """Parse a boolean environment variable."""
    val = os.environ.get(var, "").strip().lower()
    if val == "":
        return default
    return val in ("1", "true", "yes")


@dataclass(frozen=True)
class DQConfig:
    """Immutable configuration for the Forge DQ framework."""

    env: str = field(default_factory=lambda: os.environ.get("FORGE_ENV", "dev"))
    adls_account: str = field(
        default_factory=lambda: os.environ.get("FORGE_ADLS_ACCOUNT", "")
    )
    enabled: bool = field(
        default_factory=lambda: _bool_env("FORGE_DQ_ENABLED", True)
    )
    fail_on_critical: bool = field(
        default_factory=lambda: _bool_env("FORGE_DQ_FAIL_ON_CRITICAL", True)
    )

    def dq_base_path(self, container: str) -> str:
        """Return the ABFS base path for DQ output tables in the given container.

        Legacy fallback — used when the dataset ADLS path is unknown.
        Prefer :meth:`dq_path` for co-located output.

        Example:
            config.dq_base_path("silver")
            # → "abfss://silver@forgeadlsdev.dfs.core.windows.net/_dq"
        """
        return f"abfss://{container}@{self.adls_account}.dfs.core.windows.net/_dq"

    def dq_path(self, dataset_abfss_path: str, output_type: str) -> str:
        """Return the co-located DQ output path for a dataset.

        Stores DQ output alongside the data, next to ``_tracker/``.

        Example:
            config.dq_path(
                "abfss://bronze@forgeadlsdev.dfs.core.windows.net/Transport/.../NycTaxiBronze",
                "auto"
            )
            # → "abfss://bronze@.../Transport/.../NycTaxiBronze/_dq/auto"
        """
        return f"{dataset_abfss_path.rstrip('/')}/_dq/{output_type}"


# Module-level singleton — lazily initialised on first import.
# Jobs can override by constructing DQConfig(env=...) directly.
_default_config: DQConfig | None = None


def get_config() -> DQConfig:
    """Return the module-level default DQConfig instance."""
    global _default_config
    if _default_config is None:
        _default_config = DQConfig()
    return _default_config
