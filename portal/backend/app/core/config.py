from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Platform
    forge_env: str = "dev"
    adls_account: str = "forgeadlsdev"
    azure_tenant_id: str = ""  # injected at runtime via env var or Key Vault
    azure_client_id: str = ""  # workload identity client ID, injected by K8s
    subscription_id: str = ""  # injected at runtime via env var or Key Vault
    resource_group: str = ""   # injected at runtime via env var or Key Vault

    # Auth
    auth_provider: str = "local"  # "local" | "azure_ad"
    local_admin_user: str = "admin"
    local_admin_password: str = "forge-dev-admin"  # dev default; override in prod via KV secret LOCAL_ADMIN_PASSWORD
    jwt_secret: str = "forge-dev-secret-change-in-prod"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 480

    # Airflow
    airflow_url: str = "http://airflow-webserver.airflow.svc.cluster.local:8080"
    airflow_username: str = "admin"
    airflow_password: str = "admin"

    # Trino
    trino_host: str = "trino.trino.svc.cluster.local"
    trino_port: int = 8080
    trino_catalog: str = "lakehouse"
    trino_schema: str = "default"

    # Purview
    purview_endpoint: str = "https://purview-forge-dev.purview.azure.com"

    # CORS — frontend origin
    cors_origins: list[str] = ["http://localhost:3001", "https://portal.forge.internal"]

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
