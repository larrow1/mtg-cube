/**
 * MTG Cube server: Express + Socket.IO, all state in memory.
 * Env: PORT (default 3001), CORS_ORIGIN (default http://localhost:5173,
 * comma-separated list allowed), SERVE_STATIC_DIR (optional; when set, serves
 * the built web client from that directory with an SPA fallback — single
 * same-origin deployment).
 */
import http from "node:http";
import path from "node:path";
import compression from "compression";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@mtg-cube/shared";
import { registerHandlers } from "./handlers.js";
import type { SocketData } from "./handlers.js";
import { Room } from "./room.js";
import { preloadBasicLands } from "./scryfall.js";

const PORT = Number(process.env.PORT ?? 3001);
const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const rooms = new Map<string, Room>();

const app = express();
app.use(cors({ origin: corsOrigins }));
app.use(compression());

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

// Production: serve the built web client from the same origin as Socket.IO.
const staticDir = process.env.SERVE_STATIC_DIR;
if (staticDir) {
  const resolvedStaticDir = path.resolve(staticDir);
  app.use(express.static(resolvedStaticDir));
  // SPA fallback: any GET that isn't /socket.io or /health gets index.html.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/socket.io") || req.path === "/health") return next();
    res.sendFile(path.join(resolvedStaticDir, "index.html"));
  });
  console.log(`Serving static client from ${resolvedStaticDir}`);
}

const server = http.createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
  server,
  { cors: { origin: corsOrigins, methods: ["GET", "POST"] } }
);

io.on("connection", (socket) => {
  registerHandlers(io, socket, rooms);
});

// Garbage-collect rooms whose players have all been gone for 2 hours.
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const abandoned = [...room.players.values()].every((p) => !p.connected);
    if (abandoned && now - room.lastActive > ROOM_TTL_MS) {
      room.clearAllPickTimers();
      rooms.delete(id);
      console.log(`[room ${id}] garbage-collected after 2h of inactivity`);
    }
  }
}, GC_INTERVAL_MS).unref();

// Warm the basic-land cache; on failure getBasicLandCards() serves fallbacks.
preloadBasicLands()
  .then((cards) => {
    const withImages = cards.filter((c) => c.imageNormal).length;
    console.log(`Basic lands ready (${withImages}/${cards.length} resolved via Scryfall)`);
  })
  .catch((err: unknown) => {
    console.warn("Basic land preload failed; using hardcoded fallbacks:", err);
  });

server.listen(PORT, () => {
  console.log(`mtg-cube server listening on http://localhost:${PORT}`);
  console.log(`CORS origins: ${corsOrigins.join(", ")}`);
});

// Graceful shutdown: stop accepting connections, close sockets, then exit.
// Force-exits after 5s if connections refuse to drain.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  io.close(() => {
    console.log("Socket.IO closed");
  });
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("Shutdown timed out after 5s — forcing exit");
    process.exit(1);
  }, 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
