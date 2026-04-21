# Backup API for stocksaathi.co.in — runs on Fly.io as failover for Vercel.
# Build context must be app/ (so COPY can reach ../api/).
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install deps first for layer caching.
COPY api-backup/requirements.txt /app/api-backup/requirements.txt
RUN pip install --no-cache-dir -r /app/api-backup/requirements.txt

# Copy handlers (unchanged) and the shim.
COPY api/         /app/api/
COPY api-backup/  /app/api-backup/

WORKDIR /app/api-backup

ENV RUNTIME=fly \
    PORT=8080

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
