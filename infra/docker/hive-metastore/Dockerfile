# =============================================================================
# Forge — Hive Metastore 4.0.0 Image
# Base: apache/hive:4.0.0 (official Docker Hub image — HMS pre-installed)
#
# Upgraded from 3.1.3 (Hadoop 3.1.0) → 4.0.0 (Hadoop 3.3.6) to resolve
# all S360 findings in the prior image:
#   - jackson-databind 2.9.x/2.10.x → 2.15.x (20+ CVEs)
#   - jetty-server 9.3.x → 9.4.51+ (6+ CVEs)
#   - netty 4.0/4.1 early → 4.1.94+ (multiple CVEs)
#   - Hadoop 3.1.0 privilege escalation (GHSA-rmpj-7c96-mrg8, GHSA-f8vc-wfc8-hxqh)
#   - commons-compress 1.4.1/1.19 → 1.21+ (3 CVEs)
#   - commons-beanutils 1.9.3, guava 11.0.2, snakeyaml 1.16, and others
#
# Added on top of base:
#   - PostgreSQL JDBC 42.7.1 (replaces Derby for production metadata backend)
#   - azure-identity-extensions 1.1.5 + transitive deps via Maven
#     HTTP transport: azure-core-http-okhttp (NOT netty — Hadoop's Netty JARs
#     conflict with reactor-netty causing HttpClientConfig to fail to initialize)
#
# AAD auth: HMS authenticates against Azure Database for PostgreSQL using its
# managed identity via the azure-identity-extensions JDBC plugin.
# No password is stored anywhere — token exchange at connection time.
#
# Schema migration: the initContainer runs schematool -upgradeSchema to
# migrate an existing 3.1.0 metastore schema to 4.0.0 automatically.
#
# Build (from repo root):
#   az acr build \
#     --registry forgeacr{alias} \
#     --image hive-metastore:4.0.0 \
#     --file infra/docker/hive-metastore/Dockerfile \
#     .
# =============================================================================

# =============================================================================
# Stage 1: dependency-fetcher — curl + Maven are only needed here.
# The downloaded JARs are copied into the final image; curl and Maven
# are not present in the runtime layer.
# =============================================================================
FROM apache/hive:4.0.0 AS fetcher

ARG POSTGRES_JDBC_VERSION=42.7.1
ARG AZURE_IDENTITY_EXTENSIONS_VERSION=1.1.5

USER root

# S360: upgrade OS packages and install build-time tools only in this stage
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends curl maven && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# PostgreSQL JDBC driver
RUN curl -fsSL \
    "https://jdbc.postgresql.org/download/postgresql-${POSTGRES_JDBC_VERSION}.jar" \
    -o /opt/hive/lib/postgresql-${POSTGRES_JDBC_VERSION}.jar

# azure-identity-extensions + transitive deps.
# azure-core-http-netty is EXCLUDED — its reactor-netty dependency conflicts with
# Hadoop's bundled Netty JARs causing HttpClientConfig static initializer to fail.
# azure-core-http-okhttp is used instead; OkHttp has no Netty dependency.
RUN mkdir /tmp/mvn-deps && \
    echo '<?xml version="1.0" encoding="UTF-8"?><project>'                                          > /tmp/mvn-deps/pom.xml && \
    echo '  <modelVersion>4.0.0</modelVersion>'                                                    >> /tmp/mvn-deps/pom.xml && \
    echo '  <groupId>forge</groupId><artifactId>hms-azure-deps</artifactId><version>1</version>'   >> /tmp/mvn-deps/pom.xml && \
    echo '  <dependencies>'                                                                        >> /tmp/mvn-deps/pom.xml && \
    echo '    <dependency>'                                                                        >> /tmp/mvn-deps/pom.xml && \
    echo '      <groupId>com.azure</groupId>'                                                      >> /tmp/mvn-deps/pom.xml && \
    echo '      <artifactId>azure-identity-extensions</artifactId>'                                >> /tmp/mvn-deps/pom.xml && \
    echo "      <version>${AZURE_IDENTITY_EXTENSIONS_VERSION}</version>"                           >> /tmp/mvn-deps/pom.xml && \
    echo '      <exclusions><exclusion>'                                                           >> /tmp/mvn-deps/pom.xml && \
    echo '        <groupId>com.azure</groupId>'                                                    >> /tmp/mvn-deps/pom.xml && \
    echo '        <artifactId>azure-core-http-netty</artifactId>'                                  >> /tmp/mvn-deps/pom.xml && \
    echo '      </exclusion></exclusions>'                                                         >> /tmp/mvn-deps/pom.xml && \
    echo '    </dependency>'                                                                       >> /tmp/mvn-deps/pom.xml && \
    echo '    <dependency>'                                                                        >> /tmp/mvn-deps/pom.xml && \
    echo '      <groupId>com.azure</groupId>'                                                      >> /tmp/mvn-deps/pom.xml && \
    echo '      <artifactId>azure-core-http-okhttp</artifactId>'                                   >> /tmp/mvn-deps/pom.xml && \
    echo '      <version>1.11.17</version>'                                                       >> /tmp/mvn-deps/pom.xml && \
    echo '    </dependency>'                                                                       >> /tmp/mvn-deps/pom.xml && \
    echo '  </dependencies>'                                                                       >> /tmp/mvn-deps/pom.xml && \
    echo '</project>'                                                                              >> /tmp/mvn-deps/pom.xml && \
    mvn --batch-mode -f /tmp/mvn-deps/pom.xml \
        dependency:copy-dependencies \
        -DoutputDirectory=/opt/hive/lib \
        -DexcludeGroupIds=org.slf4j,log4j,org.apache.logging.log4j,ch.qos.logback \
        -DexcludeArtifactIds=postgresql && \
    rm -rf /tmp/mvn-deps /root/.m2

# =============================================================================
# Stage 2: runtime — no curl, no Maven, no build tools
# =============================================================================
FROM apache/hive:4.0.0

ARG POSTGRES_JDBC_VERSION=42.7.1

USER root

# S360: apply OS-level security patches in the final image
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy only the JARs produced by the fetcher stage — no build tools follow
COPY --from=fetcher --chown=hive:hive /opt/hive/lib/postgresql-${POSTGRES_JDBC_VERSION}.jar \
    /opt/hive/lib/postgresql-${POSTGRES_JDBC_VERSION}.jar
COPY --from=fetcher --chown=hive:hive /opt/hive/lib/ /opt/hive/lib/

USER hive

# S360: HEALTHCHECK — HMS exposes Thrift on 9083; use a TCP probe
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD bash -c 'echo > /dev/tcp/localhost/9083' || exit 1

EXPOSE 9083
