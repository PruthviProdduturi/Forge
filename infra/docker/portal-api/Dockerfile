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

WORKDIR /app

# Install dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY app/ ./app/

# Security: run as non-root
RUN addgroup --system --gid 1001 appgroup \
 && adduser  --system --uid 1001 --ingroup appgroup appuser

USER appuser

EXPOSE 8080

LABEL org.opencontainers.image.title="forge-portal-api" \
      org.opencontainers.image.version="1.0" \
      org.opencontainers.image.description="Forge Developer Portal FastAPI backend"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", \
     "--workers", "2", "--access-log", "--log-level", "info"]
