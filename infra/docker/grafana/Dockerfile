# =============================================================================
# Forge — Grafana 10.4.2 Image
# Base: grafana/grafana:10.4.2
#
# Additions over the official image:
#   - Datasource provisioning config (Prometheus + Loki) baked in
#   - Dashboard provider config pointing to /var/lib/grafana/dashboards/
#   - All Forge platform dashboards baked into /var/lib/grafana/dashboards/
#   - Runs as grafana user (GID 472)
# =============================================================================

FROM grafana/grafana:10.4.2

# ----------------------------------------------------------------------------
# Switch to root to write into Grafana's provisioning directories.
# The official Grafana image runs as UID/GID 472 (grafana user).
# We need root to install files into /etc/grafana/ and /var/lib/grafana/.
# ----------------------------------------------------------------------------
USER root

# ----------------------------------------------------------------------------
# Datasource provisioning
# Grafana reads all YAML files in /etc/grafana/provisioning/datasources/
# on startup and creates/updates datasources automatically.
# ----------------------------------------------------------------------------
COPY --chown=472:472 \
     provisioning/datasources/ \
     /etc/grafana/provisioning/datasources/

# ----------------------------------------------------------------------------
# Dashboard provider provisioning
# Grafana reads all YAML files in /etc/grafana/provisioning/dashboards/
# on startup. Each YAML defines a provider that points to a directory of
# dashboard JSON files.
# ----------------------------------------------------------------------------
COPY --chown=472:472 \
     provisioning/dashboards/ \
     /etc/grafana/provisioning/dashboards/

# ----------------------------------------------------------------------------
# Dashboard JSON files
# All Forge platform dashboards are baked into the image so no external
# storage or git sync is required. Each subdirectory corresponds to a folder
# visible in the Grafana UI.
#
# Expected build context layout:
#   infra/docker/grafana/dashboards/
#   ├── spark/
#   │   ├── spark-jobs-overview.json
#   │   └── spark-executor-detail.json
#   ├── airflow/
#   │   ├── airflow-dag-runs.json
#   │   └── airflow-task-duration.json
#   ├── trino/
#   │   └── trino-query-performance.json
#   ├── dq/
#   │   └── dq-pass-rates.json
#   ├── infra/
#   │   ├── kubernetes-cluster.json
#   │   └── node-resources.json
#   └── platform/
#       └── platform-overview.json
# ----------------------------------------------------------------------------
RUN mkdir -p /var/lib/grafana/dashboards

COPY --chown=472:472 \
     dashboards/ \
     /var/lib/grafana/dashboards/

# ----------------------------------------------------------------------------
# Grafana environment defaults
# These configure safe defaults baked into the image. Sensitive config
# (admin password, database URL, Azure AD client secret) is injected at
# runtime via Kubernetes Secrets / Azure Key Vault CSI driver.
# ----------------------------------------------------------------------------
ENV GF_PATHS_PROVISIONING="/etc/grafana/provisioning" \
    GF_PATHS_DASHBOARDS="/var/lib/grafana/dashboards" \
    GF_SECURITY_DISABLE_GRAVATAR="true" \
    GF_ANALYTICS_REPORTING_ENABLED="false" \
    GF_ANALYTICS_CHECK_FOR_UPDATES="false" \
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH="/var/lib/grafana/dashboards/platform/platform-overview.json" \
    GF_USERS_ALLOW_SIGN_UP="false" \
    GF_AUTH_DISABLE_LOGIN_FORM="false" \
    GF_LOG_MODE="console" \
    GF_LOG_LEVEL="info"

# ----------------------------------------------------------------------------
# Switch back to grafana user (UID/GID 472) for runtime
# ----------------------------------------------------------------------------
USER 472

# ----------------------------------------------------------------------------
# Metadata
# ----------------------------------------------------------------------------
LABEL org.opencontainers.image.title="forge-grafana" \
      org.opencontainers.image.version="10.4.2" \
      org.opencontainers.image.description="Grafana 10.4.2 with Forge platform dashboards and datasources baked in" \
      org.opencontainers.image.vendor="Forge Platform Team"
