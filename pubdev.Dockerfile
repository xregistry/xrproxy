# xRegistry pub.dev (Dart/Flutter) Proxy
FROM node:20-alpine

RUN apk add --no-cache curl bash

WORKDIR /app

# Copy service and shared sources together so relative paths resolve correctly.
COPY pubdev/ pubdev/
COPY shared/ shared/

# Build registry-core first.
# The root .dockerignore excludes **/dist, so registry-core/dist is absent from
# the COPY context; wipe node_modules as well since .dockerignore may have also
# stripped nested dist dirs inside them (e.g. content-type/dist), then do a
# clean install + build to produce a self-contained dist/ inside the image.
WORKDIR /app/shared/registry-core
RUN rm -rf node_modules dist \
 && npm ci --no-audit --no-fund \
 && npm run build \
 && npm cache clean --force

# Now install and build the pubdev proxy.
WORKDIR /app/pubdev
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force

# Create non-root user and directories.
RUN addgroup -g 1001 -S nodejs \
 && adduser -S xregistry -u 1001 \
 && mkdir -p /app/pubdev/cache \
 && chown -R xregistry:nodejs /app

USER xregistry

EXPOSE 4200

ENV CACHE_DIR=/app/pubdev/cache

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD sh -c 'curl -f -s --max-time 5 http://localhost:${PORT:-4200}/health || exit 1'

CMD ["node", "dist/pubdev/src/server.js"]
