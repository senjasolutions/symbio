# Agent image keeps build tools out of runtime while supporting native SQLite on both target architectures.
FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production SYMBIO_AGENT_DATABASE_PATH=/data/agent.sqlite
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
# Pre-created targets let Compose mount only the two host metadata files the
# collector reads instead of exposing the complete host root filesystem.
RUN mkdir -p /data /host/etc \
  && touch /host/etc/os-release /host/etc/hostname \
  && chown node:node /data \
  # Create docker group for optional Docker socket access. The actual GID is
  # mapped at runtime via group_add in compose.yaml (SYMBIO_DOCKER_GROUP_GID).
    && groupadd -g 999 docker 2>/dev/null; exit 0

# Install util-linux for nsenter (host command execution for HTTPS setup)
RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux \
  && rm -rf /var/lib/apt/lists/*

# Run as root for nsenter host namespace access (required for HTTPS certbot/nginx operations)
# USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SYMBIO_AGENT_HEALTH_PORT||18767)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "mkdir -p /data/logs && node src/index.js 2>&1 | tee /data/logs/agent.log"]
