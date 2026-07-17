FROM node:25-alpine

RUN apk add --no-cache \
    curl \
    wget \
    bash

WORKDIR /app

COPY shared/ shared/
COPY rubygems/ rubygems/

# Install and build registry-core first so rubygems' prepare hook finds it ready
WORKDIR /app/shared/registry-core
RUN npm ci && npm run build

# Install and build the rubygems proxy
WORKDIR /app/rubygems
RUN npm ci && npm run build

RUN addgroup -g 1001 -S nodejs && \
    adduser -S xregistry -u 1001 && \
    mkdir -p /app/logs /app/rubygems/cache && \
    chown -R xregistry:nodejs /app

USER xregistry

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD sh -c 'curl -f -s --max-time 5 http://localhost:${PORT:-4000}/health || exit 1'

CMD ["node", "dist/src/server.js"]
