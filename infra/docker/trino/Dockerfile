# =============================================================================
# Forge — Trino 479 Image
# Base: trinodb/trino:479
#
# Additions over the official image:
#   - Custom catalog-discovery plugin (Forge-built JAR)
#     Installed to /usr/lib/trino/plugin/catalog-discovery/
#     (copied from build context if present; skipped if not found)
#   - Corrected file ownership for all plugin directories
#   - Shell access removed for the trino user (security hardening)
#
# OpenLineage is intentionally NOT included.
# Trino serves interactive SQL queries — lineage is captured upstream at
# the Spark (job) and Airflow (pipeline) layers where it has real value.
# Instrumenting ad-hoc Trino queries produces noise, not signal.
#
# Build context: infra/docker/trino/
# =============================================================================

FROM trinodb/trino:479

# ----------------------------------------------------------------------------
# Switch to root for installation steps
# ----------------------------------------------------------------------------
USER root

# ----------------------------------------------------------------------------
# Copy Forge catalog-discovery plugin (optional)
#
# The catalog-discovery plugin enables Trino to dynamically register tenant
# catalogs from a configuration store, avoiding static catalog property files
# per tenant.
#
# The JAR is built from the Forge platform SDK and placed in the build context
# at: infra/docker/trino/plugins/catalog-discovery/
#
# If absent from the build context (e.g., initial bootstrapping), create an
# empty placeholder before building:
#   mkdir -p infra/docker/trino/plugins/catalog-discovery
#   touch infra/docker/trino/plugins/catalog-discovery/.gitkeep
# ----------------------------------------------------------------------------
RUN mkdir -p /usr/lib/trino/plugin/catalog-discovery

COPY --chown=trino:trino \
     plugins/catalog-discovery/ \
     /usr/lib/trino/plugin/catalog-discovery/

# Remove the entire catalog-discovery directory if it contains no JARs.
# Trino's plugin loader fails on directories with non-JAR files (e.g. .gitkeep).
# When the real plugin JAR is added, remove this RUN line and let the directory persist.
RUN find /usr/lib/trino/plugin/catalog-discovery/ -name '*.jar' | grep -q . \
    || rm -rf /usr/lib/trino/plugin/catalog-discovery

# ----------------------------------------------------------------------------
# Ensure the trino user owns all plugin directories.
# The base image ships plugins owned by root.
# ----------------------------------------------------------------------------
RUN chown -R trino:trino /usr/lib/trino/plugin/

# ----------------------------------------------------------------------------
# Security hardening: disable interactive shell for the trino user.
# Trino is a Java service — it never needs a login shell.
# ----------------------------------------------------------------------------
RUN usermod -s /sbin/nologin trino

# ----------------------------------------------------------------------------
# Switch back to trino user for runtime
# ----------------------------------------------------------------------------
USER trino

# ----------------------------------------------------------------------------
# Metadata
# ----------------------------------------------------------------------------
LABEL org.opencontainers.image.title="forge-trino" \
      org.opencontainers.image.version="479" \
      org.opencontainers.image.description="Trino 479 for the Forge data platform" \
      org.opencontainers.image.vendor="Forge Platform Team"
