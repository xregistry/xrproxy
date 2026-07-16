# Use official Node.js 24 Alpine image
FROM node:24-alpine

# Install diagnostic tools
RUN apk add --no-cache curl bash

# Create app directory
WORKDIR /app

# Copy shared/registry-core and crates sources
COPY shared/registry-core/ shared/registry-core/
COPY crates/ crates/

# Build registry-core
WORKDIR /app/shared/registry-core
RUN npm ci && npm run build && npm cache clean --force

# Build crates proxy
WORKDIR /app/crates
RUN npm ci && npm run build && npm cache clean --force

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S xregistry -u 1001

# Create directories
RUN mkdir -p /app/logs /app/crates/cache && \
    chown -R xregistry:nodejs /app

USER xregistry

EXPOSE 3700

ENV CACHE_DIR=/app/crates/cache

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f -s --max-time 5 http://localhost:${PORT:-3700}/health || exit 1

CMD ["node", "dist/src/server.js"]
