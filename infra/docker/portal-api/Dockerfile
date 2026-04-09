# =============================================================================
# Forge — Portal API Image
# Base: python:3.12-slim
#
# FastAPI backend for the Forge Developer Portal.
# Runs as a non-root user, exposes port 8080.
#
# Build context: portal/backend/
#
# Build:
#   az acr build --registry forgeacr{alias} \
#     --image portal-api:1.0 \
#     --file infra/docker/portal-api/Dockerfile \
#     portal/backend/
# =============================================================================

FROM python:3.12-slim

# S360: apply OS-level security patches
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# S360: create non-root user early so COPY --chown is available
RUN addgroup --system --gid 1001 appgroup \
 && adduser  --system --uid 1001 --ingroup appgroup appuser

# Install dependencies first (layer caching)
COPY --chown=appuser:appgroup requirements.txt .
# S360: upgrade pip itself before installing deps (fixes GHSA-4xh5, GHSA-6vgw)
RUN pip install --no-cache-dir "pip>=25.0"
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source with correct ownership
COPY --chown=appuser:appgroup app/ ./app/

# S360: switch to non-root user before CMD
USER appuser

EXPOSE 8080

# S360: HEALTHCHECK — FastAPI exposes /health
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

LABEL org.opencontainers.image.title="forge-portal-api" \
      org.opencontainers.image.version="1.0" \
      org.opencontainers.image.description="Forge Developer Portal FastAPI backend"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", \
     "--workers", "2", "--access-log", "--log-level", "info"]
