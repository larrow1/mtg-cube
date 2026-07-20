# ---- Stage 1: build web client + bundle server -----------------------------
FROM node:22-alpine AS builder
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
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    SERVE_STATIC_DIR=/app/apps/web/dist \
    PORT=3001

# Server is a self-contained esbuild bundle — no node_modules needed.
COPY --from=builder /app/apps/server/dist/ apps/server/dist/
COPY --from=builder /app/apps/web/dist/ apps/web/dist/

# Run as the non-root "node" user shipped with the official image.
USER node

EXPOSE 3001

# wget ships with alpine's busybox; hits the JSON health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
