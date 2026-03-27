# =============================================================================
# Forge — Airflow 3.1.8 Image
# Base: apache/airflow:3.1.8-python3.11
#
# Additions over the official image:
#   - apache-airflow-providers-cncf-kubernetes (SparkKubernetesOperator)
#   - apache-airflow-providers-microsoft-azure (ADLS, Key Vault backend)
#   - openlineage-airflow (automatic lineage emission for all tasks)
#   - azure-identity, azure-storage-file-datalake (workload identity)
#   - forge-dq wheel (Forge DQ SDK) — from build context if present
#   - forge-lineage wheel (Forge lineage helpers) — from build context if present
#   - All versions pinned in requirements.txt
# =============================================================================

ARG AIRFLOW_VERSION=3.1.8
FROM apache/airflow:${AIRFLOW_VERSION}-python3.11

# Re-declare ARG after FROM (ARGs before FROM are not available after it)
ARG AIRFLOW_VERSION=3.1.8

# ----------------------------------------------------------------------------
# Constraint file URL
# Airflow providers must be installed using the official constraints file to
# prevent resolver conflicts with the Airflow core dependency set.
# ----------------------------------------------------------------------------
ARG CONSTRAINTS_URL="https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-3.11.txt"

# ----------------------------------------------------------------------------
# Switch to root for system-level package installation
# ----------------------------------------------------------------------------
USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        git \
        build-essential \
        libpq-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------------
# Switch back to airflow user for pip installs.
# The official Airflow image requires all pip installs to run as the
# 'airflow' user to keep the virtual environment consistent and avoid
# permission issues with the Airflow-managed virtualenv.
# ----------------------------------------------------------------------------
USER airflow

# ----------------------------------------------------------------------------
# Copy requirements.txt into image
# ----------------------------------------------------------------------------
COPY --chown=airflow:root requirements.txt /opt/airflow/requirements.txt

# ----------------------------------------------------------------------------
# Install providers and dependencies
#
# The --constraint flag ensures all installed packages are compatible with
# the Airflow core constraints. This is the officially supported install
# method for Airflow providers.
# ----------------------------------------------------------------------------
RUN pip install --no-cache-dir \
        "apache-airflow-providers-cncf-kubernetes" \
        "apache-airflow-providers-microsoft-azure" \
        "apache-airflow-providers-openlineage" \
        --constraint "${CONSTRAINTS_URL}"

RUN pip install --no-cache-dir \
        "azure-identity>=1.24.0" \
        "azure-storage-file-datalake>=12.18.0" \
        "azure-keyvault-secrets>=4.8.0"

# ----------------------------------------------------------------------------
# Install Forge SDK wheels (forge-dq, forge-lineage)
#
# These wheels are built from the Forge SDK monorepo (sdk/) and copied
# into the Docker build context before the image is built.
#
# If the wheels/ directory is absent (e.g. during a local dev build without
# the full SDK), create an empty placeholder:
#   mkdir -p infra/docker/airflow/wheels
#   touch infra/docker/airflow/wheels/.gitkeep
# ----------------------------------------------------------------------------
COPY --chown=airflow:root wheels/ /opt/airflow/wheels/

RUN WHEELS_DIR="/opt/airflow/wheels"; \
    \
    FORGE_DQ=$(find "${WHEELS_DIR}" -maxdepth 1 -name "forge_dq-*.whl" 2>/dev/null | head -1); \
    if [ -n "${FORGE_DQ}" ]; then \
        echo "Installing forge-dq: ${FORGE_DQ}"; \
        pip install --no-cache-dir "${FORGE_DQ}"; \
    else \
        echo "INFO: forge-dq wheel not present — skipping (expected during initial bootstrapping)"; \
    fi; \
    \
    FORGE_LINEAGE=$(find "${WHEELS_DIR}" -maxdepth 1 -name "forge_lineage-*.whl" 2>/dev/null | head -1); \
    if [ -n "${FORGE_LINEAGE}" ]; then \
        echo "Installing forge-lineage: ${FORGE_LINEAGE}"; \
        pip install --no-cache-dir "${FORGE_LINEAGE}"; \
    else \
        echo "INFO: forge-lineage wheel not present — skipping (expected during initial bootstrapping)"; \
    fi

# ----------------------------------------------------------------------------
# Copy DAGs and plugins that are baked into the image (platform-level only).
# Domain-specific DAGs are mounted via the ADLS-backed git-sync sidecar at
# runtime — they are NOT baked into this image.
# ----------------------------------------------------------------------------
COPY --chown=airflow:root dags/   /opt/airflow/dags/platform/
COPY --chown=airflow:root plugins/ /opt/airflow/plugins/

# ----------------------------------------------------------------------------
# Environment configuration
# Airflow 3.x: RBAC is always enabled — AIRFLOW__WEBSERVER__RBAC removed.
# Sensitive config (Fernet key, DB connection, secrets backend URL) is
# injected at runtime via Kubernetes Secrets / Azure Key Vault CSI driver.
# ----------------------------------------------------------------------------
ENV AIRFLOW__CORE__LOAD_EXAMPLES="False" \
    AIRFLOW__CORE__EXECUTOR="KubernetesExecutor" \
    AIRFLOW__CORE__PARALLELISM="32" \
    AIRFLOW__CORE__MAX_ACTIVE_RUNS_PER_DAG="3" \
    AIRFLOW__CORE__DAGBAG_IMPORT_TIMEOUT="90" \
    AIRFLOW__SCHEDULER__MIN_FILE_PROCESS_INTERVAL="30" \
    AIRFLOW__SCHEDULER__CATCHUP_BY_DEFAULT="False" \
    AIRFLOW__WEBSERVER__EXPOSE_CONFIG="False" \
    AIRFLOW__OPENLINEAGE__NAMESPACE="forge" \
    PYTHONDONTWRITEBYTECODE="1" \
    PYTHONUNBUFFERED="1"

# ----------------------------------------------------------------------------
# Metadata
# ----------------------------------------------------------------------------
LABEL org.opencontainers.image.title="forge-airflow" \
      org.opencontainers.image.version="3.1.8" \
      org.opencontainers.image.description="Airflow 3.1.8 with Kubernetes, Azure, and OpenLineage providers for the Forge data platform" \
      org.opencontainers.image.vendor="Forge Platform Team"
