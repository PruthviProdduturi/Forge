# =============================================================================
# Stratum — Trino 438 Image
# Base: trinodb/trino:438
#
# Additions over the official image:
#   - OpenLineage Trino plugin 1.18.0
#     Installed to /usr/lib/trino/plugin/openlineage/
#   - Custom catalog-discovery plugin (Stratum-built JAR)
#     Installed to /usr/lib/trino/plugin/catalog-discovery/
#     (copied from build context if present; skipped if not found)
#   - Corrected file ownership for all plugin directories
#   - Shell access removed for the trino user (security hardening)
# =============================================================================

FROM trinodb/trino:438

# ----------------------------------------------------------------------------
# Switch to root for installation steps
# ----------------------------------------------------------------------------
USER root

# ----------------------------------------------------------------------------
# Install OpenLineage Trino plugin
#
# The plugin JAR is downloaded from Maven Central and placed in its own
# plugin directory. Trino auto-discovers plugins at startup by scanning
# /usr/lib/trino/plugin/.
#
# Coordinates: io.openlineage:openlineage-trino:1.18.0
# ----------------------------------------------------------------------------
ARG OPENLINEAGE_VERSION=1.18.0
ARG MAVEN_CENTRAL=https://repo1.maven.org/maven2

RUN set -eux; \
    PLUGIN_DIR="/usr/lib/trino/plugin/openlineage"; \
    mkdir -p "${PLUGIN_DIR}"; \
    \
    curl -fsSL \
        "${MAVEN_CENTRAL}/io/openlineage/openlineage-trino/${OPENLINEAGE_VERSION}/openlineage-trino-${OPENLINEAGE_VERSION}.jar" \
        -o "${PLUGIN_DIR}/openlineage-trino-${OPENLINEAGE_VERSION}.jar"; \
    \
    chown -R trino:trino "${PLUGIN_DIR}"

# ----------------------------------------------------------------------------
# Copy Stratum catalog-discovery plugin (optional)
#
# The catalog-discovery plugin enables Trino to dynamically register tenant
# catalogs from a configuration store, avoiding static catalog property files
# for each tenant.
#
# The JAR is built from the Stratum platform SDK and placed in the build
# context at: infra/docker/trino/plugins/catalog-discovery/
#
# If the directory is absent from the build context (e.g., during initial
# bootstrapping), the COPY --chown ... step is skipped via a conditional
# shell block. We use a two-stage approach: try to copy, ignore if missing.
# ----------------------------------------------------------------------------
RUN mkdir -p /usr/lib/trino/plugin/catalog-discovery

COPY --chown=trino:trino \
     plugins/catalog-discovery/ \
     /usr/lib/trino/plugin/catalog-discovery/

# Note: if the plugins/catalog-discovery/ directory does not exist in the
# build context, the COPY above will produce an error. To build without the
# custom plugin, create an empty placeholder:
#   mkdir -p infra/docker/trino/plugins/catalog-discovery
#   touch infra/docker/trino/plugins/catalog-discovery/.gitkeep

# ----------------------------------------------------------------------------
# Verify plugin directory layout
# Expected after build:
#   /usr/lib/trino/plugin/
#   ├── openlineage/
#   │   └── openlineage-trino-1.18.0.jar
#   ├── catalog-discovery/
#   │   └── catalog-discovery-<version>.jar  (if present)
#   ├── delta/                (from base image)
#   ├── hive/                 (from base image)
#   └── ...
# ----------------------------------------------------------------------------
RUN ls -la /usr/lib/trino/plugin/openlineage/ && \
    ls -la /usr/lib/trino/plugin/catalog-discovery/ || true

# ----------------------------------------------------------------------------
# Ensure the trino user owns all plugin directories
# The base image ships plugins owned by root; fix this so the trino user
# can read them at runtime.
# ----------------------------------------------------------------------------
RUN chown -R trino:trino /usr/lib/trino/plugin/

# ----------------------------------------------------------------------------
# Security hardening: disable interactive shell for the trino user.
# Trino is a Java service — it never needs a login shell. Removing shell
# access prevents use of the container's shell if an attacker gains code
# execution as the trino user.
# ----------------------------------------------------------------------------
RUN usermod -s /sbin/nologin trino

# ----------------------------------------------------------------------------
# Switch back to trino user for runtime
# The official trinodb/trino image uses the trino user by default;
# we explicitly declare it here for clarity.
# ----------------------------------------------------------------------------
USER trino

# ----------------------------------------------------------------------------
# Metadata
# ----------------------------------------------------------------------------
LABEL org.opencontainers.image.title="stratum-trino" \
      org.opencontainers.image.version="438" \
      org.opencontainers.image.description="Trino 438 with OpenLineage plugin for the Stratum data platform" \
      org.opencontainers.image.vendor="Stratum Platform Team"
