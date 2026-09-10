# SV Grandur coupon admin + WhatsApp bridge (Railway / Docker)
FROM node:20-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WHATSAPP_BRIDGE_URL=http://127.0.0.1:3001 \
    WHATSAPP_BRIDGE_PORT=3001 \
    DATA_DIR=/app/data \
    WHATSAPP_AUTH_DIR=/app/data/whatsapp-auth \
    WHATSAPP_CACHE_DIR=/app/data/whatsapp-cache \
    WHATSAPP_ENABLED=1 \
    WEB_CONCURRENCY=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        curl \
        fontconfig \
        fonts-dejavu-core \
        fonts-liberation \
        chromium \
        ca-certificates \
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libasound2 \
        libpango-1.0-0 \
        libcairo2 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxext6 \
        libxi6 \
        libxtst6 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

COPY whatsapp-bridge/package.json whatsapp-bridge/package-lock.json ./whatsapp-bridge/
RUN cd whatsapp-bridge && npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/data/whatsapp-auth /app/data/whatsapp-cache \
    && sed -i 's/\r$//' docker-entrypoint.sh \
    && chmod +x docker-entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=6 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/live" || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
