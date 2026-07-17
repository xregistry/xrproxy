# Use official Node.js 20 Alpine image
FROM node:20-alpine

# Install diagnostic tools
RUN apk add --no-cache \
    curl \
    jq \
    bash

LABEL org.xregistry.name="xregistry-packagist-bridge"
LABEL org.xregistry.description="xRegistry API proxy for Packagist/Composer"

WORKDIR /app

# Copy package manifests and source
COPY packagist/ packagist/
COPY shared/ shared/

# Build the shared registry-core file: dependency first. Its dist/ is excluded
# by .dockerignore and its prepare script is skipped below (--ignore-scripts),
# so it must be compiled explicitly before the packagist build consumes it.
WORKDIR /app/shared/registry-core
RUN npm ci --ignore-scripts --no-audit --no-fund && \
    npm run build && \
    npm cache clean --force

WORKDIR /app/packagist

RUN npm ci --ignore-scripts && npm cache clean --force

RUN npm run build

WORKDIR /app/shared/logging
# Only install if logging/package.json exists
RUN test -f package.json && npm install && npm cache clean --force || true

WORKDIR /app/packagist

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S xregistry -u 1001

RUN mkdir -p /app/logs /app/packagist/cache && \
    chown -R xregistry:nodejs /app

USER xregistry

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD sh -c 'curl -f -s --max-time 5 "http://localhost:${PORT:-4100}/health" || exit 1'

CMD ["node", "dist/packagist/src/server.js"]
