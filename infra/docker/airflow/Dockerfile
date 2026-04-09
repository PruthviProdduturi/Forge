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

# S360: upgrade OS packages and install only the minimal build-time packages
# needed to compile native Python extensions (e.g. psycopg2).
# curl and git are NOT needed — pip handles HTTP downloads internally and
# DAG sources are synced via the git-sync sidecar at runtime, not at build time.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
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
# ----------------------------------------------------------------------------
# S360 compliance: remove packages not required by Forge that are flagged by
# Microsoft security scanning. These are transitive dependencies pulled in by
# the apache/airflow base image or its providers — not used by this platform.
# ----------------------------------------------------------------------------
RUN pip uninstall -y litellm ray || true

# S360: security-fix pip overrides (April 2026)
# The apache/airflow:3.1.8 base image ships several packages at vulnerable
# versions via its own constraint set. Installing newer versions here takes
# precedence over the base image copies. Java-bundled CVEs (jackson-core,
# commons-lang, log4j-core) cannot be fixed via pip — they require an
# Airflow base image upgrade when apache/airflow ships a patched build.
# ray is uninstalled above because it bundles its own aiohttp 3.x copy;
# removing ray eliminates that bundled copy entirely.
#
#   pip>=25.0           — GHSA-4xh5-x5gv-qwph, GHSA-6vgw-5pg2-w6jp
#   tornado>=6.5.5      — GHSA-78cv-mqj4-43f7, GHSA-qjxf-f2mg-c6mc
#   PyJWT>=2.12.0       — GHSA-752w-5fwx-jx9f
#   pyasn1>=0.6.3       — GHSA-jr27-m4p2-rc6r
#   requests>=2.32.4    — GHSA-9hjg-9r4m-mvj7
#   ecdsa>=0.19.2       — GHSA-9f5j-8jwj-x28g
#   aiohttp>=3.13.4     — GHSA-54jq, GHSA-69f9, GHSA-6jhg, GHSA-6mq8,
#                         GHSA-9548, GHSA-fh55, GHSA-g84x, GHSA-jj3x,
#                         GHSA-mqqc (9 CVEs; also removes ray-bundled copy)
#   werkzeug>=3.0.6     — GHSA-2g68, GHSA-87hc, GHSA-f9vj (3 CVEs)
#   starlette>=0.36.3   — GHSA-7f5h
#   protobuf>=4.25.5    — GHSA-7gcm
#   wheel>=0.44.0       — GHSA-8rrh
#   jaraco.context>=6.0 — GHSA-58pv
RUN pip install --no-cache-dir \
        "pip>=25.0" \
        "tornado>=6.5.5" \
        "PyJWT>=2.12.0" \
        "pyasn1>=0.6.3" \
        "requests>=2.32.4" \
        "ecdsa>=0.19.2" \
        "aiohttp>=3.13.4" \
        "werkzeug>=3.0.6" \
        "starlette>=0.36.3" \
        "protobuf>=4.25.5" \
        "wheel>=0.44.0" \
        "jaraco.context>=6.0"

# S360: HEALTHCHECK — Airflow webserver exposes /health
# Uses Python's built-in urllib so curl is not required in the image.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

LABEL org.opencontainers.image.title="forge-airflow" \
      org.opencontainers.image.version="3.1.8" \
      org.opencontainers.image.description="Airflow 3.1.8 with Kubernetes, Azure, and OpenLineage providers for the Forge data platform" \
      org.opencontainers.image.vendor="Forge Platform Team"
