from functools import lru_cache
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Platform
    forge_env: str = "dev"
    adls_account: str = "forgeadlsdev"
    azure_tenant_id: str = ""  # injected at runtime via env var or Key Vault
    azure_client_id: str = ""  # workload identity client ID, injected by K8s
    subscription_id: str = ""  # injected at runtime via env var or Key Vault
    resource_group: str = ""  # injected at runtime via env var or Key Vault
    owner_alias: str = ""  # e.g. prproddu
    key_vault_url: str = (
        ""  # e.g. https://kv-forge-dev.vault.azure.net/ — injected at deploy time
    )

    # Resource group names — used by cost and status endpoints.
    compute_rg: str = ""  # e.g. rg-forge-compute-prproddu-dev
    orch_rg: str = ""  # e.g. rg-forge-orchestration-prproddu-dev

    # AKS cluster names — used by status endpoint to query Azure Resource API.
    # Portal managed identity needs Reader on both clusters.
    compute_cluster_name: str = ""  # e.g. aks-forge-compute-prproddu-dev
    orch_cluster_name: str = ""  # e.g. aks-forge-orchestration-prproddu-dev

    # Airflow — password fetched from Key Vault at runtime via DefaultAzureCredential.
    # Set AIRFLOW_PASSWORD env var to override for local dev only.
    airflow_url: str = "http://airflow-api-server.airflow.svc.cluster.local:8080"
    airflow_username: str = "portal-api-svc"
    airflow_password: str = ""

    # Trino
    trino_host: str = "trino.trino.svc.cluster.local"
    trino_port: int = 8080
    trino_catalog: str = "lakehouse"
    trino_schema: str = "default"

    # Compute cluster public hostname — used for Spark Connect health check (port 15002).
    # Set to the external NGINX LB hostname (e.g. forge-compute-dseng-dev.northcentralus.cloudapp.azure.com).
    compute_host: str = ""

    # Spark Connect — HTTP REST endpoint for health checks
    spark_connect_url: str = "http://spark-connect.spark.svc.cluster.local:4040"

    # Postgres — portal database for user preferences.
    # pg_host: FQDN of the Azure PostgreSQL Flexible Server.
    # pg_user: name of the portal-api managed identity (the Postgres AAD user).
    # Both are injected at deploy time by forge-up.sh. When blank, theme.py falls
    # back to a local JSON file (local dev with no Postgres).
    pg_host: str = ""
    pg_user: str = ""

    # CORS — frontend origin. Override CORS_ORIGINS env var in production.
    cors_origins: list[str] = ["http://localhost:3001", "https://portal.forge.internal"]
    # In K8s the ingress serves both on the same origin, so CORS is not needed,
    # but we keep the list for local dev and future dedicated domain scenarios.

    @model_validator(mode="after")
    def _derive_rg_names(self) -> "Settings":
        """Auto-derive RG names from owner_alias + forge_env if not explicitly set."""
        if not self.compute_rg and self.owner_alias:
            self.compute_rg = f"rg-forge-compute-{self.owner_alias}-{self.forge_env}"
        if not self.orch_rg and self.owner_alias:
            self.orch_rg = f"rg-forge-orchestration-{self.owner_alias}-{self.forge_env}"
        return self

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
