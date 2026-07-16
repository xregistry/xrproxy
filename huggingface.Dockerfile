# Hugging Face Hub xRegistry proxy
FROM node:20-alpine

RUN apk add --no-cache curl jq

LABEL org.xregistry.name="xregistry-huggingface-bridge"
LABEL org.xregistry.description="Anonymous xRegistry proxy for Hugging Face Hub models, datasets, and spaces"

WORKDIR /app

# Build @xregistry/registry-core first (local file dependency)
COPY shared/registry-core/ shared/registry-core/
WORKDIR /app/shared/registry-core
RUN npm ci && npm run build && npm cache clean --force

# Build the huggingface proxy
WORKDIR /app
COPY huggingface/ huggingface/
WORKDIR /app/huggingface
RUN npm ci && npm run build && npm cache clean --force

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S xregistry -u 1001
RUN mkdir -p /app/huggingface/cache /app/logs && chown -R xregistry:nodejs /app
USER xregistry

WORKDIR /app/huggingface

EXPOSE 4300

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD curl -f -s --max-time 5 "http://localhost:${PORT:-4300}/health" || exit 1

CMD ["node", "dist/src/server.js"]
