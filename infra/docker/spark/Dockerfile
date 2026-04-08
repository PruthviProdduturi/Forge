# =============================================================================
# Forge — Spark 4.1.1 Image
# Base: eclipse-temurin:17-jre-jammy
#
# Included:
#   - Apache Spark 4.1.1 (Hadoop 3 distribution)
#   - Delta Lake 4.1.0
#   - Apache Iceberg 1.10.1 (spark-runtime-4.0_2.13)
#   - hadoop-azure 3.4.1 (ABFS / ADLS Gen2 driver)
#   - azure-identity + azure-storage-file-datalake (workload identity)
#   - openlineage-spark 1.39.0
#   - Python 3.11 + PySpark + delta-spark + pandas + pyarrow + azure-identity
#   - spark-defaults.conf baked in (ADLS + workload identity + OpenLineage)
#   - forge_sdk + forge_dq baked in (no zip distribution at runtime)
#   - Non-root spark user (UID 185)
#
# Build context: REPO ROOT — required so COPY sdk/python resolves correctly.
#   az acr build must be run from the repo root with -f infra/docker/spark/Dockerfile
# =============================================================================

FROM eclipse-temurin:17-jre-jammy

# ----------------------------------------------------------------------------
# Build arguments — override at build time if needed
# ----------------------------------------------------------------------------
ARG SPARK_VERSION=4.1.1
ARG HADOOP_VERSION=3
ARG DELTA_VERSION=4.1.0
ARG ICEBERG_VERSION=1.10.1
ARG HADOOP_AZURE_VERSION=3.4.1
ARG OPENLINEAGE_VERSION=1.39.0
ARG PYTHON_VERSION=3.11

# ----------------------------------------------------------------------------
# Environment variables
# ----------------------------------------------------------------------------
ENV SPARK_VERSION=${SPARK_VERSION} \
    SPARK_HOME=/opt/spark \
    JAVA_HOME=/opt/java/openjdk \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

ENV PATH="${SPARK_HOME}/bin:${SPARK_HOME}/sbin:${JAVA_HOME}/bin:${PATH}"

# ----------------------------------------------------------------------------
# System packages: Python 3.11, curl, procps (for Spark scripts)
# ----------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-venv \
        python3-pip \
        python3.11-dev \
        curl \
        procps \
        tini \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------------
# Create spark user (non-root, UID 185 — matches spark-operator convention)
# ----------------------------------------------------------------------------
RUN groupadd --gid 185 spark \
    && useradd --uid 185 --gid 185 --no-create-home --shell /bin/bash spark

# ----------------------------------------------------------------------------
# Download and verify Apache Spark
#
# Checksums sourced from https://downloads.apache.org/spark/
# Using SHA-512 checksum for Spark 4.1.0 with Hadoop 3
# ----------------------------------------------------------------------------
RUN set -eux; \
    SPARK_TGZ="spark-${SPARK_VERSION}-bin-hadoop${HADOOP_VERSION}.tgz"; \
    SPARK_URL="https://downloads.apache.org/spark/spark-${SPARK_VERSION}/${SPARK_TGZ}"; \
    SPARK_SHA512_URL="${SPARK_URL}.sha512"; \
    \
    curl -fsSL "${SPARK_URL}" -o "/tmp/${SPARK_TGZ}"; \
    curl -fsSL "${SPARK_SHA512_URL}" -o "/tmp/${SPARK_TGZ}.sha512"; \
    \
    # Verify checksum
    cd /tmp && sha512sum -c "${SPARK_TGZ}.sha512"; \
    \
    # Extract to /opt/spark
    tar -xzf "/tmp/${SPARK_TGZ}" -C /opt/; \
    mv "/opt/spark-${SPARK_VERSION}-bin-hadoop${HADOOP_VERSION}" "${SPARK_HOME}"; \
    \
    # Cleanup
    rm -f "/tmp/${SPARK_TGZ}" "/tmp/${SPARK_TGZ}.sha512"

# ----------------------------------------------------------------------------
# Download additional JARs into $SPARK_HOME/jars/
#
# Maven Central coordinates:
#   delta-spark:             io.delta:delta-spark_2.13:4.1.0
#   delta-storage:           io.delta:delta-storage:4.1.0
#   iceberg:                 org.apache.iceberg:iceberg-spark-runtime-4.0_2.13:1.10.1
#   hadoop-azure:            org.apache.hadoop:hadoop-azure:3.4.1
#   azure-identity:          com.azure:azure-identity:1.13.0
#   azure-storage-datalake:  com.azure:azure-storage-file-datalake:12.20.0
#   azure-core:              com.azure:azure-core:1.49.0
#   openlineage-spark:       io.openlineage:openlineage-spark_2.12:1.39.0
# ----------------------------------------------------------------------------
RUN set -eux; \
    MAVEN_CENTRAL="https://repo1.maven.org/maven2"; \
    JARS_DIR="${SPARK_HOME}/jars"; \
    \
    # Delta Lake 4.1.0 (default table format)
    curl -fsSL \
        "${MAVEN_CENTRAL}/io/delta/delta-spark_2.13/${DELTA_VERSION}/delta-spark_2.13-${DELTA_VERSION}.jar" \
        -o "${JARS_DIR}/delta-spark_2.13-${DELTA_VERSION}.jar"; \
    \
    # Delta Lake storage library (required by delta-spark)
    curl -fsSL \
        "${MAVEN_CENTRAL}/io/delta/delta-storage/${DELTA_VERSION}/delta-storage-${DELTA_VERSION}.jar" \
        -o "${JARS_DIR}/delta-storage-${DELTA_VERSION}.jar"; \
    \
    # Apache Iceberg 1.10.1 runtime (opt-in table format; 4.0_2.13 artifact is Spark 4.x compatible)
    curl -fsSL \
        "${MAVEN_CENTRAL}/org/apache/iceberg/iceberg-spark-runtime-4.0_2.13/${ICEBERG_VERSION}/iceberg-spark-runtime-4.0_2.13-${ICEBERG_VERSION}.jar" \
        -o "${JARS_DIR}/iceberg-spark-runtime-${ICEBERG_VERSION}.jar"; \
    \
    # Hadoop Azure 3.4.1 (ABFS driver for ADLS Gen2)
    curl -fsSL \
        "${MAVEN_CENTRAL}/org/apache/hadoop/hadoop-azure/${HADOOP_AZURE_VERSION}/hadoop-azure-${HADOOP_AZURE_VERSION}.jar" \
        -o "${JARS_DIR}/hadoop-azure-${HADOOP_AZURE_VERSION}.jar"; \
    \
    # Azure Identity 1.13.0 (workload identity credential provider)
    curl -fsSL \
        "${MAVEN_CENTRAL}/com/azure/azure-identity/1.13.0/azure-identity-1.13.0.jar" \
        -o "${JARS_DIR}/azure-identity-1.13.0.jar"; \
    \
    # Azure Storage File DataLake 12.20.0
    curl -fsSL \
        "${MAVEN_CENTRAL}/com/azure/azure-storage-file-datalake/12.20.0/azure-storage-file-datalake-12.20.0.jar" \
        -o "${JARS_DIR}/azure-storage-file-datalake-12.20.0.jar"; \
    \
    # Azure Core 1.49.0 (transitive dep for azure-identity)
    curl -fsSL \
        "${MAVEN_CENTRAL}/com/azure/azure-core/1.49.0/azure-core-1.49.0.jar" \
        -o "${JARS_DIR}/azure-core-1.49.0.jar"; \
    \
    # Azure Core HTTP Netty (required for azure-identity HTTP calls)
    curl -fsSL \
        "${MAVEN_CENTRAL}/com/azure/azure-core-http-netty/1.15.0/azure-core-http-netty-1.15.0.jar" \
        -o "${JARS_DIR}/azure-core-http-netty-1.15.0.jar"; \
    \
    # OpenLineage Spark integration 1.39.0
    curl -fsSL \
        "${MAVEN_CENTRAL}/io/openlineage/openlineage-spark_2.12/${OPENLINEAGE_VERSION}/openlineage-spark_2.12-${OPENLINEAGE_VERSION}.jar" \
        -o "${JARS_DIR}/openlineage-spark_2.12-${OPENLINEAGE_VERSION}.jar"

# ----------------------------------------------------------------------------
# Python packages
#   - pyspark must match Spark version exactly
#   - delta-spark must match Delta Lake version exactly
# ----------------------------------------------------------------------------
RUN pip3 install --upgrade pip && \
    pip3 install \
        "pyspark==${SPARK_VERSION}" \
        "delta-spark==${DELTA_VERSION}" \
        "pandas==2.2.2" \
        "pyarrow==16.1.0" \
        "azure-identity==1.17.1" \
        "azure-storage-file-datalake==12.18.0" \
        "openlineage-python==1.39.0" \
        "pydantic==2.7.4" \
        "pyyaml==6.0.2"

# ----------------------------------------------------------------------------
# forge-sdk + forge-dq — installed from source packages baked into the image.
#
# Each is a proper pip-installable package with pyproject.toml and declared
# dependencies. No zip upload or ADLS dependency at job startup.
#
# Build context must be the repo root for these COPY paths to resolve.
#
# PROD MIGRATION: Replace the COPY+pip block below with:
#   RUN pip3 install forge-sdk==1.0.0 forge-dq==1.0.0 \
#       --index-url https://pkgs.dev.azure.com/L1R/.../_packaging/forge/pypi/simple/
# once packages are published to Azure Artifacts (run sdk/python/publish.sh).
# ----------------------------------------------------------------------------
COPY sdk/python/forge_sdk /tmp/forge_sdk
COPY sdk/python/forge_dq  /tmp/forge_dq
RUN pip3 install /tmp/forge_sdk /tmp/forge_dq \
    && rm -rf /tmp/forge_sdk /tmp/forge_dq

# ----------------------------------------------------------------------------
# spark-defaults.conf — baked-in defaults for ADLS, workload identity,
# Delta Lake, and OpenLineage. Runtime values can override via SparkConf
# in the job submission or Helm chart configmap.
# ----------------------------------------------------------------------------
COPY infra/docker/spark/spark-defaults.conf "${SPARK_HOME}/conf/spark-defaults.conf"

# ----------------------------------------------------------------------------
# Logging configuration — reduce verbosity for Azure/Hadoop noise
# ----------------------------------------------------------------------------
COPY infra/docker/spark/log4j2.properties "${SPARK_HOME}/conf/log4j2.properties"

# ----------------------------------------------------------------------------
# Entrypoint script — routes Spark K8s driver/executor modes.
# Spark K8s sets executor pod args to ["executor", "--driver-url", ...],
# so this script must be the ENTRYPOINT (not spark-class directly).
# Matches the official Apache Spark Docker image convention.
# ----------------------------------------------------------------------------
COPY infra/docker/spark/entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

# ----------------------------------------------------------------------------
# Directory layout and permissions
#   /opt/spark/work-dir  — job working directory (SparkApplication CRD mounts here)
#   /opt/spark/logs      — driver/executor log output
# ----------------------------------------------------------------------------
RUN mkdir -p \
        "${SPARK_HOME}/work-dir" \
        "${SPARK_HOME}/logs" \
        /home/spark \
    && chown -R spark:spark \
        "${SPARK_HOME}" \
        /home/spark

WORKDIR ${SPARK_HOME}/work-dir

# ----------------------------------------------------------------------------
# Switch to non-root spark user
# ----------------------------------------------------------------------------
USER spark

# ----------------------------------------------------------------------------
# Expose Spark UI ports
#   4040  — SparkContext web UI (driver)
#   7077  — Spark standalone master (not used in K8s mode, but exported for compat)
#   8080  — Spark history server
# ----------------------------------------------------------------------------
EXPOSE 4040 7077 8080

# ----------------------------------------------------------------------------
# ENTRYPOINT
# Use tini as init to reap zombie processes and forward signals correctly.
# The CMD is set to the Spark entrypoint script which handles both
# driver mode (spark-submit) and executor mode based on SPARK_EXECUTOR_ID
# being set.
# ----------------------------------------------------------------------------
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/entrypoint.sh"]
CMD ["driver"]
