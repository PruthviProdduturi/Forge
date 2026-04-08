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
    resource_group: str = ""   # injected at runtime via env var or Key Vault
    owner_alias: str = ""      # e.g. prproddu
    key_vault_url: str = ""    # e.g. https://kv-forge-dev.vault.azure.net/ — injected at deploy time

    # Resource group names — used by cost and status endpoints.
    compute_rg: str = ""   # e.g. rg-forge-compute-prproddu-dev
    orch_rg: str = ""      # e.g. rg-forge-orchestration-prproddu-dev

    # AKS cluster names — used by status endpoint to query Azure Resource API.
    # Portal managed identity needs Reader on both clusters.
    compute_cluster_name: str = ""   # e.g. aks-forge-compute-prproddu-dev
    orch_cluster_name: str = ""      # e.g. aks-forge-orchestration-prproddu-dev

    # Auth
    auth_provider: str = "azure_ad"  # "local" | "azure_ad"
    local_admin_user: str = "admin"
    local_admin_password: str = "admin"  # dev default; override via LOCAL_ADMIN_PASSWORD env var or KV secret in prod
    jwt_secret: str = "forge-dev-secret-change-in-prod"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 480

    # Airflow
    airflow_url: str = "http://airflow-api-server.airflow.svc.cluster.local:8080"
    airflow_username: str = "admin"
    airflow_password: str = "admin"

    # Trino
    trino_host: str = "trino.trino.svc.cluster.local"
    trino_port: int = 8080
    trino_catalog: str = "lakehouse"
    trino_schema: str = "default"

    # Spark Connect — HTTP REST endpoint for health checks
    spark_connect_url: str = "http://spark-connect.spark.svc.cluster.local:4040"

    # Purview
    purview_endpoint: str = "https://purview-forge-dev.purview.azure.com"

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

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
