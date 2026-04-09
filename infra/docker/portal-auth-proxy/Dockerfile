FROM python:3.12-slim

# S360: apply OS-level security patches
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# S360: create a non-root user to run the application
RUN addgroup --system --gid 1001 appgroup \
 && adduser  --system --uid 1001 --ingroup appgroup appuser

COPY --chown=appuser:appgroup requirements.txt .
# S360: upgrade pip itself before installing deps (fixes GHSA-4xh5, GHSA-6vgw)
RUN pip install --no-cache-dir "pip>=25.0"
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=appuser:appgroup app.py .

# S360: switch to non-root user before CMD
USER appuser

EXPOSE 8080

# S360: HEALTHCHECK
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

CMD ["gunicorn", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "4", \
     "--timeout", "60", \
     "--access-logfile", "-", \
     "app:app"]
