# =============================================================================
# Forge — Hive Metastore 3.1.3 Image
# Base: eclipse-temurin:17-jre-jammy (consistent with Spark image)
#
# Included:
#   - Apache Hive Standalone Metastore 3.1.3
#   - PostgreSQL JDBC 42.7.1 (metadata backend)
#   - azure-identity-extensions 1.1.5 (AAD token auth for PostgreSQL JDBC)
#   - Non-root hive user (UID 1000)
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

FROM eclipse-temurin:17-jre-jammy

ARG HMS_VERSION=3.1.3
ARG POSTGRES_JDBC_VERSION=42.7.1
ARG AZURE_IDENTITY_EXTENSIONS_VERSION=1.1.5

ENV HIVE_HOME=/opt/hive
ENV PATH="${HIVE_HOME}/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
      wget \
      procps \
    && rm -rf /var/lib/apt/lists/*

# Download Hive Standalone Metastore
RUN wget -q \
    "https://archive.apache.org/dist/hive/hive-standalone-metastore-${HMS_VERSION}/hive-standalone-metastore-${HMS_VERSION}-bin.tar.gz" \
    -O /tmp/hive-metastore.tar.gz \
  && tar -xzf /tmp/hive-metastore.tar.gz -C /opt \
  && mv /opt/apache-hive-metastore-${HMS_VERSION}-bin ${HIVE_HOME} \
  && rm /tmp/hive-metastore.tar.gz

# Replace bundled Guava with a version compatible with Hadoop 3.x
RUN rm -f ${HIVE_HOME}/lib/guava-*.jar \
  && wget -q \
      "https://repo1.maven.org/maven2/com/google/guava/guava/27.0-jre/guava-27.0-jre.jar" \
      -O ${HIVE_HOME}/lib/guava-27.0-jre.jar

# PostgreSQL JDBC driver
RUN wget -q \
    "https://jdbc.postgresql.org/download/postgresql-${POSTGRES_JDBC_VERSION}.jar" \
    -O ${HIVE_HOME}/lib/postgresql-${POSTGRES_JDBC_VERSION}.jar

# Azure Identity Extensions — enables AAD token auth for PostgreSQL JDBC
# The JDBC plugin exchanges the workload identity token for a PostgreSQL access token.
RUN wget -q \
    "https://repo1.maven.org/maven2/com/azure/azure-identity-extensions/${AZURE_IDENTITY_EXTENSIONS_VERSION}/azure-identity-extensions-${AZURE_IDENTITY_EXTENSIONS_VERSION}.jar" \
    -O ${HIVE_HOME}/lib/azure-identity-extensions-${AZURE_IDENTITY_EXTENSIONS_VERSION}.jar

# Non-root user
RUN groupadd -r hive --gid=1000 \
  && useradd -r -g hive --uid=1000 --home-dir=${HIVE_HOME} hive \
  && chown -R hive:hive ${HIVE_HOME}

USER hive
WORKDIR ${HIVE_HOME}

EXPOSE 9083

ENTRYPOINT ["/opt/hive/bin/hive", "--service", "metastore"]
