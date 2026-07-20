# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

COPY shared/registry-core/ shared/registry-core/
COPY terraform/package*.json terraform/
COPY shared/ shared/

# Build registry-core first (required as file: dependency)
WORKDIR /app/shared/registry-core
RUN npm ci --prefer-offline && npm run build

WORKDIR /app/terraform
COPY terraform/ .

# The build context can contain a host node_modules junction even though its
# contents are ignored. Recreate dependencies after COPY so the local
# registry-core link is valid inside Linux.
RUN rm -rf node_modules && npm ci --prefer-offline && npm run build

# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

RUN apk add --no-cache curl bash

WORKDIR /app

COPY --from=builder /app/terraform/dist ./terraform/dist
COPY --from=builder /app/terraform/model.json ./terraform/model.json
COPY --from=builder /app/terraform/node_modules ./terraform/node_modules
COPY --from=builder /app/shared ./shared

WORKDIR /app/terraform

RUN addgroup -g 1001 -S nodejs && \
    adduser -S xregistry -u 1001 && \
    mkdir -p /app/terraform/cache/platforms /app/logs && \
    chown -R xregistry:nodejs /app

USER xregistry

EXPOSE 3800

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD sh -c 'curl -f -s --max-time 5 http://localhost:${PORT:-3800}/health || exit 1'

CMD ["node", "dist/terraform/src/server.js"]
