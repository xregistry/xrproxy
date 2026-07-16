# syntax=docker/dockerfile:1
# xRegistry Go Module Proxy
FROM node:25-alpine

RUN apk add --no-cache curl bash

LABEL org.xregistry.name="xregistry-gomod-proxy"
LABEL org.xregistry.description="xRegistry API proxy for the Go Module ecosystem"

WORKDIR /app

COPY gomod/ gomod/
COPY shared/ shared/

# Build the shared registry-core package cleanly. The copied node_modules can be
# missing files stripped by .dockerignore's "**/dist" rule (e.g. nested
# content-type/dist), and registry-core's prepare script skips reinstall when a
# node_modules directory is already present — so wipe and reinstall to guarantee
# a complete, self-contained package that resolves at runtime.
WORKDIR /app/shared/registry-core
RUN rm -rf node_modules dist && npm ci --no-audit --no-fund && npm run build && npm cache clean --force

WORKDIR /app/gomod
RUN npm ci && npm cache clean --force
RUN npm run build

WORKDIR /app/shared/logging
RUN npm install && npm cache clean --force

WORKDIR /app/gomod

# Restart wrapper for crash recovery
COPY <<'EOF' /app/gomod/restart-wrapper.sh
#!/bin/bash
LOG_FILE="/app/logs/gomod-server.log"
mkdir -p /app/logs

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

RESTART_COUNT=0
log "Go Module proxy wrapper started"

while true; do
    log "Starting server (attempt $((++RESTART_COUNT)))"
    node dist/gomod/src/server.js 2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 0 ]; then
        log "Server exited normally"
        break
    fi
    log "Server crashed (exit $EXIT_CODE); retrying in 5s"
    sleep 5
done
EOF

RUN chmod +x /app/gomod/restart-wrapper.sh && sed -i 's/\r$//' /app/gomod/restart-wrapper.sh

RUN addgroup -g 1001 -S nodejs && adduser -S xregistry -u 1001
RUN mkdir -p /app/logs /app/gomod/cache && chown -R xregistry:nodejs /app
USER xregistry

ENV CACHE_DIR=./cache

EXPOSE 3900

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD sh -c 'curl -f -s --max-time 5 http://localhost:${PORT:-3900}/health || exit 1'

CMD ["bash", "/app/gomod/restart-wrapper.sh"]
