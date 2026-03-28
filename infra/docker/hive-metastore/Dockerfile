# =============================================================================
# Forge — Hive Metastore 3.1.3 Image
# Base: apache/hive:3.1.3 (official Docker Hub image — HMS pre-installed)
#
# Added on top:
#   - PostgreSQL JDBC 42.7.1 (replaces Derby for production metadata backend)
#   - azure-identity-extensions 1.1.5 + transitive deps via Maven
#     HTTP transport: azure-core-http-okhttp (NOT netty — Hadoop's Netty JARs
#     conflict with reactor-netty causing HttpClientConfig to fail to initialize)
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

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl maven && \
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
    echo '      <version>1.11.17</version>'                                                        >> /tmp/mvn-deps/pom.xml && \
    echo '    </dependency>'                                                                       >> /tmp/mvn-deps/pom.xml && \
    echo '  </dependencies>'                                                                       >> /tmp/mvn-deps/pom.xml && \
    echo '</project>'                                                                              >> /tmp/mvn-deps/pom.xml && \
    mvn --batch-mode -f /tmp/mvn-deps/pom.xml \
        dependency:copy-dependencies \
        -DoutputDirectory=/opt/hive/lib \
        -DexcludeGroupIds=org.slf4j,log4j,org.apache.logging.log4j,ch.qos.logback \
        -DexcludeArtifactIds=postgresql && \
    rm -rf /tmp/mvn-deps /root/.m2

USER hive

EXPOSE 9083
