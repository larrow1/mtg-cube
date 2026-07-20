# Deploying MTG Cube

Production is a **single Node service**: the server bundles Express + Socket.IO
and serves the built web client from the same port/origin (no CORS config
needed). The client auto-connects same-origin in production builds.

## Local production test

```bash
npm install
npm run build:prod    # vite build (web) + esbuild bundle (server → apps/server/dist/index.js)
npm run start:prod    # serves everything on http://localhost:3001
```

Open http://localhost:3001 — the app and the Socket.IO server share the port.
Health check: http://localhost:3001/health.

Env vars (all optional locally):

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Listen port |
| `SERVE_STATIC_DIR` | unset | Path to the built web client (`apps/web/dist`); enables static serving + SPA fallback |
| `CORS_ORIGIN` | `http://localhost:5173` | Only relevant if you host the client on a *different* origin |

## Docker

```bash
docker build -t mtg-cube .
docker run --rm -p 3001:3001 mtg-cube
```

The image is multi-stage: stage 1 runs `npm ci` + `npm run build:prod` (the
exact commands verified locally), stage 2 is a slim `node:22-alpine` runtime
with only the two `dist/` folders (the server is a self-contained esbuild
bundle — no `node_modules` shipped). Runs as non-root, `HEALTHCHECK` on
`/health`.

## Fly.io (needs account + `flyctl` login)

```bash
# One-time: install flyctl, then
fly auth login                      # REQUIRES ACCOUNT
fly launch --no-deploy              # reads fly.toml; accept or rename the app
fly deploy
fly open
```

`fly.toml` already sets `internal_port = 3001`, the `/health` check, and
`auto_stop_machines = false` / `min_machines_running = 1` — **do not enable
autostop**: game state is in-memory, a sleeping machine drops every game.
No extra env vars needed (`SERVE_STATIC_DIR` is baked into the image env).

## Railway (needs account + `railway` CLI login)

```bash
railway login                       # REQUIRES ACCOUNT
railway init                        # create a project from this repo
railway up                          # builds the Dockerfile and deploys
railway domain                      # mint a public URL
```

Railway auto-detects the Dockerfile. In the service settings set the exposed
port to `3001` (or set env `PORT` to Railway's provided port). Disable any
"sleep on idle" option — in-memory state must stay resident.

## Render (needs account; no CLI required)

1. Push the repo to GitHub/GitLab.
2. Render dashboard → **New → Blueprint** → select the repo. `render.yaml`
   defines a Docker web service with `healthCheckPath: /health` on the
   `starter` plan.
3. Deploy. Nothing else to configure — env vars are in the blueprint.

Note: Render's **free** plan spins services down when idle, which drops all
in-memory games — use `starter` or above.

## Scaling later

The current design is intentionally **single-instance**:

- All room/draft/game state lives in one process's memory. Two instances would
  each see half the rooms, and Socket.IO events would not reach players on the
  other instance.
- **Restarts drop all games.** A deploy, crash, or platform migration wipes
  every active room (players can reconnect to nothing). This is acceptable for
  casual drafts; fixing it is future work.

To go multi-instance, in order:

1. **Room state persistence (required first):** move room/draft/game state out
   of the process into Redis (or similar), so any instance — and a restarted
   instance — can load a room. The engines in `packages/shared` are pure
   functions over serializable state, so this is a storage change, not an
   engine change.
2. **Socket.IO Redis adapter:** add
   [`@socket.io/redis-adapter`](https://socket.io/docs/v4/redis-adapter/) so
   broadcasts (`io.to(room).emit(...)`) fan out across instances.
3. **Sticky sessions:** Socket.IO's HTTP long-polling handshake requires that
   all requests from one client hit the same instance — enable sticky sessions
   at the load balancer (or force WebSocket-only transport).

Until step 1 exists, keep exactly one instance running and treat deploys as
maintenance windows.
