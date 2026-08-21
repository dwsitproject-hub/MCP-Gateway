# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Dependencies first so a source-only change reuses the layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Reinstall production-only dependencies for the runtime image.
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# curl is only for the container healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY migrations ./migrations

# Run unprivileged. The node image ships a "node" user (uid 1000).
RUN chown -R node:node /app
USER node

EXPOSE 8787

# Liveness only: /livez makes no upstream call, so a KLIP outage does not
# restart-loop the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/livez || exit 1

CMD ["node", "dist/index.js"]
