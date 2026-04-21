# =============================================================================
# Forge — Custom Spark Operator Image
# Base: ghcr.io/kubeflow/spark-operator/controller:2.5.0
#
# Adds hadoop-azure to the operator's bundled Spark jars so that spark-submit
# (which runs inside the operator pod during SparkApplication submission) can
# resolve abfss:// paths for mainApplicationFile and pyFiles without failing
# with ClassNotFoundException: SecureAzureBlobFileSystem.
#
# The base kubeflow image ships hadoop-client but NOT hadoop-azure. Any
# SparkApplication that references abfss:// at submit time requires this jar.
# =============================================================================

FROM ghcr.io/kubeflow/spark-operator/controller:2.5.0

ARG HADOOP_AZURE_VERSION=3.4.1

USER root

# Download hadoop-azure into the operator's bundled Spark jars directory.
# The operator uses /opt/spark/jars when it invokes spark-submit.
RUN set -eux; \
    MAVEN_CENTRAL="https://repo1.maven.org/maven2"; \
    JARS_DIR="/opt/spark/jars"; \
    \
    # hadoop-azure provides SecureAzureBlobFileSystem (abfss://) and AzureBlobFileSystem (abfs://)
    wget -q \
        "${MAVEN_CENTRAL}/org/apache/hadoop/hadoop-azure/${HADOOP_AZURE_VERSION}/hadoop-azure-${HADOOP_AZURE_VERSION}.jar" \
        -O "${JARS_DIR}/hadoop-azure-${HADOOP_AZURE_VERSION}.jar"; \
    \
    # azure-storage-blob is a required runtime dependency of hadoop-azure 3.4.x
    wget -q \
        "${MAVEN_CENTRAL}/com/azure/azure-storage-blob/12.25.0/azure-storage-blob-12.25.0.jar" \
        -O "${JARS_DIR}/azure-storage-blob-12.25.0.jar"; \
    \
    # wildfly-openssl is required by hadoop-azure for SSL context
    wget -q \
        "${MAVEN_CENTRAL}/org/wildfly/openssl/wildfly-openssl/2.2.5.Final/wildfly-openssl-2.2.5.Final.jar" \
        -O "${JARS_DIR}/wildfly-openssl-2.2.5.Final.jar"

USER 185
