# ---- Stage 1: build web client + bundle server -----------------------------
# node:24 is required: the server uses the built-in node:sqlite module.
FROM node:24-alpine AS builder
WORKDIR /app

# Copy workspace manifests first so npm ci layer caches across source changes.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci

# Copy source and build: vite build (web) + esbuild bundle (server + shared).
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/server/ apps/server/
COPY apps/web/ apps/web/
RUN npm run build:prod

# ---- Stage 2: minimal runtime ----------------------------------------------
FROM node:24-alpine
WORKDIR /app

# SQLite database lives under /app/data — mount a persistent volume there
# (e.g. `docker run -v mtg-cube-data:/app/data ...` or a Railway/Fly volume),
# otherwise accounts/cubes/ratings are lost on every container restart.
ENV NODE_ENV=production \
    SERVE_STATIC_DIR=/app/apps/web/dist \
    PORT=3001 \
    DB_PATH=/app/data/mtg-cube.db

# Server is a self-contained esbuild bundle — no node_modules needed.
COPY --from=builder /app/apps/server/dist/ apps/server/dist/
COPY --from=builder /app/apps/web/dist/ apps/web/dist/

# Pre-create the data dir. Platform volumes (Railway/Fly) mount OVER this dir
# as root, so ownership must be fixed at RUNTIME, not build time: the container
# starts as root, chowns the mount, then drops to the non-root "node" user via
# su-exec for the actual server process.
RUN mkdir -p /app/data && chown node:node /app/data && apk add --no-cache su-exec

EXPOSE 3001

# wget ships with alpine's busybox; hits the JSON health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/health || exit 1

CMD ["/bin/sh", "-c", "chown -R node:node /app/data && exec su-exec node node apps/server/dist/index.js"]
