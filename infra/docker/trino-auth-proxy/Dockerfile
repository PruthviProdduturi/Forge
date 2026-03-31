FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8080

# Plain HTTP — TLS and auth are handled by port-forward + Azure AD OAuth2 proxy.
# Azure AD natively permits http://localhost redirect URIs, so no TLS cert is needed.
CMD ["gunicorn", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "4", \
     "--timeout", "60", \
     "--access-logfile", "-", \
     "app:app"]
