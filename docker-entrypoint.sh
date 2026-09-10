#!/bin/sh
set -e

PORT="${PORT:-8080}"
BRIDGE_PORT="${WHATSAPP_BRIDGE_PORT:-3001}"
DATA="${DATA_DIR:-/app/data}"
WA_AUTH="${WHATSAPP_AUTH_DIR:-$DATA/whatsapp-auth}"
WA_CACHE="${WHATSAPP_CACHE_DIR:-$DATA/whatsapp-cache}"

mkdir -p "$DATA" "$WA_AUTH" "$WA_CACHE"
touch "$DATA/.persistent_volume" 2>/dev/null || true
rm -f "$WA_AUTH/.bridge.lock" 2>/dev/null || true

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024}"
export WHATSAPP_CLIENT_ID="${WHATSAPP_CLIENT_ID:-sv-grandur}"
export WHATSAPP_AUTH_DIR="$WA_AUTH"
export WHATSAPP_CACHE_DIR="$WA_CACHE"
export WHATSAPP_BRIDGE_PORT="$BRIDGE_PORT"
export DATA_DIR="$DATA"

bridge_healthy() {
  curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" >/dev/null 2>&1
}

start_bridge_background() {
  if [ "${WHATSAPP_ENABLED:-1}" = "0" ]; then
    echo "WhatsApp bridge disabled (WHATSAPP_ENABLED=0)"
    return 0
  fi

  (
    cd /app/whatsapp-bridge
    backoff=5
    while true; do
      if bridge_healthy; then
        sleep 30
        continue
      fi

      if [ -f "$WA_AUTH/.bridge.lock" ]; then
        pid="$(cat "$WA_AUTH/.bridge.lock" 2>/dev/null || echo "")"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
          echo "Bridge pid $pid exists but /health failed — clearing stale lock"
        fi
        rm -f "$WA_AUTH/.bridge.lock"
      fi

      echo "Starting WhatsApp bridge (auth: $WA_AUTH)..."
      node server.js >> "$DATA/whatsapp-bridge.log" 2>&1
      echo "WhatsApp bridge exited — restarting in ${backoff}s..."
      sleep "$backoff"
      if [ "$backoff" -lt 60 ]; then
        backoff=$((backoff + 5))
      fi
    done
  ) &
}

start_bridge_background

if [ "${WHATSAPP_ENABLED:-1}" != "0" ]; then
  echo "Waiting for WhatsApp bridge to start..."
  waited=0
  while [ "$waited" -lt 45 ]; do
    if bridge_healthy; then
      echo "WhatsApp bridge is up (session restores automatically if already linked)."
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done
fi

if [ ! -f "$DATA/.persistent_volume" ]; then
  echo "WARNING: Railway Volume may not be mounted at /app/data — WhatsApp will need QR scan after every deploy."
fi

echo "Starting Gunicorn on port ${PORT}..."
echo "Persistent data: $DATA (mount a Railway Volume at /app/data)"
exec gunicorn \
  --bind "0.0.0.0:${PORT}" \
  --workers "${WEB_CONCURRENCY:-1}" \
  --threads 8 \
  --timeout 90 \
  --access-logfile - \
  --error-logfile - \
  --chdir /app/server \
  app:app
