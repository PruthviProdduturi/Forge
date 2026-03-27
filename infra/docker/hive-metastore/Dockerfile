# =============================================================================
# Forge — Hive Metastore 3.1.3 Image
# Base: apache/hive:3.1.3 (official Docker Hub image — HMS pre-installed)
#
# Added on top:
#   - PostgreSQL JDBC 42.7.1 (replaces Derby for production metadata backend)
#   - azure-identity-extensions 1.1.5 (AAD token auth for PostgreSQL JDBC)
#
# AAD auth: HMS authenticates against Azure Database for PostgreSQL using its
# managed identity via the azure-identity-extensions JDBC plugin.
# No password is stored anywhere — token exchange at connection time.
#
# Build (from repo root):
#   az acr build \
#     --registry forgeacr{alias} \
#     --image hive-metastore:3.1.3 \
#     --file infra/docker/hive-metastore/Dockerfile \
#     .
# =============================================================================

FROM apache/hive:3.1.3

ARG POSTGRES_JDBC_VERSION=42.7.1
ARG AZURE_IDENTITY_EXTENSIONS_VERSION=1.1.5

USER root

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Add PostgreSQL JDBC driver
RUN curl -fsSL \
    "https://jdbc.postgresql.org/download/postgresql-${POSTGRES_JDBC_VERSION}.jar" \
    -o /opt/hive/lib/postgresql-${POSTGRES_JDBC_VERSION}.jar

# Add Azure Identity Extensions — enables AAD token auth for PostgreSQL JDBC
RUN curl -fsSL \
    "https://repo1.maven.org/maven2/com/azure/azure-identity-extensions/${AZURE_IDENTITY_EXTENSIONS_VERSION}/azure-identity-extensions-${AZURE_IDENTITY_EXTENSIONS_VERSION}.jar" \
    -o /opt/hive/lib/azure-identity-extensions-${AZURE_IDENTITY_EXTENSIONS_VERSION}.jar

USER hive

EXPOSE 9083
