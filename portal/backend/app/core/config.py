from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Platform
    forge_env: str = "dev"
    adls_account: str = "forgeadlsdev"
    azure_tenant_id: str = "72f988bf-86f1-41af-91ab-2d7cd011db47"
    azure_client_id: str = ""  # workload identity client ID, injected by K8s
    subscription_id: str = "eaa4a83d-8511-497c-b0bc-40aa5f0deae1"
    resource_group: str = "rg-forge-platform-prproddu-dev"

    # Auth
    auth_provider: str = "local"  # "local" | "azure_ad"
    local_admin_user: str = "admin"
    local_admin_password: str = "forge-dev-admin"  # override in prod via KV
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
