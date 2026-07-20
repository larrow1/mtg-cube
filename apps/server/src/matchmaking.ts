/**
 * Ranked matchmaking: an in-memory queue of authenticated players, a pairing
 * tick, and the full lifecycle of server-driven ranked rooms (join deadline,
 * auto-run draft, deckbuild deadline with auto-submit, auto match start,
 * disconnect concession, Elo settlement).
 *
 * Env overrides (testing): MM_TICK_MS, RANKED_SEATS, RANKED_PACKS,
 * RANKED_CARDS, RANKED_PICK_SECONDS, RANKED_JOIN_SECONDS,
 * RANKED_DECKBUILD_SECONDS, RANKED_DISCONNECT_GRACE_SECONDS.
 */
import { nanoid } from "nanoid";
import { eloDelta, rankFor } from "@mtg-cube/shared";
import type { Color, DraftCard, QueueState } from "@mtg-cube/shared";
import { accountStateFor, socketIdsForUser } from "./auth.js";
import {
  cubeFromRow,
  getCubeById,
  getRating,
  insertRankedMatch,
  listRankedPool,
  upsertRating,
} from "./db.js";
import { ensureDefaultCube } from "./defaultCube.js";
import {
  applyGameActionServer,
  broadcastRoomState,
  startDraftInRoom,
  startMatchInRoom,
} from "./flow.js";
import type { AppServer } from "./flow.js";
import { Room } from "./room.js";
import type { Match } from "./room.js";

// ---------------------------------------------------------------------------
// Env-tunable knobs (read per use so tests can tweak between runs)
// ---------------------------------------------------------------------------

function envInt(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const tickMs = () => envInt("MM_TICK_MS", 100, 60_000) ?? 5000;
const joinDeadlineMs = () => (envInt("RANKED_JOIN_SECONDS", 5, 600) ?? 60) * 1000;
const deckbuildMs = () => (envInt("RANKED_DECKBUILD_SECONDS", 10, 3600) ?? 300) * 1000;
const disconnectGraceMs = () => (envInt("RANKED_DISCONNECT_GRACE_SECONDS", 5, 3600) ?? 180) * 1000;

interface RankedDraftSettings {
  seatCount: number;
  packsPerPlayer: number;
  cardsPerPack: number;
  pickTimerSeconds: number;
}

/** seatCount = min(8, max(4, floor(cubeSize/45))), 3x15 packs, 60s forced picks. */
function rankedConfigFor(cubeSize: number): RankedDraftSettings {
  return {
    seatCount: envInt("RANKED_SEATS", 2, 8) ?? Math.min(8, Math.max(4, Math.floor(cubeSize / 45))),
    packsPerPlayer: envInt("RANKED_PACKS", 1, 6) ?? 3,
    cardsPerPack: envInt("RANKED_CARDS", 3, 30) ?? 15,
    pickTimerSeconds: envInt("RANKED_PICK_SECONDS", 5, 600) ?? 60,
  };
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface QueueEntry {
  userId: string;
  username: string;
  rating: number;
  joinedAt: number;
}

interface RankedUser {
  userId: string;
  username: string;
  rating: number;
  /** Room player id once this user has joined the ranked room. */
  playerId: string | null;
  /** Explicitly left mid-draft/deckbuild — cannot return. */
  abandoned: boolean;
}

type RankedStage = "joining" | "drafting" | "deckbuild" | "playing" | "finished";

interface RankedCtl {
  roomId: string;
  users: [RankedUser, RankedUser];
  stage: RankedStage;
  config: RankedDraftSettings;
  joinTimer: ReturnType<typeof setTimeout> | null;
  deckbuildTimer: ReturnType<typeof setTimeout> | null;
  deckbuildDeadline: number | null;
  /** playerId -> disconnect-concession timer while a match is in progress. */
  graceTimers: Map<string, ReturnType<typeof setTimeout>>;
  matchId: string | null;
  /** Elo has been applied — never settle twice. */
  settled: boolean;
}

const queue = new Map<string, QueueEntry>();
const rankedRooms = new Map<string, RankedCtl>();

let io: AppServer | null = null;
let rooms: Map<string, Room> | null = null;

export function initMatchmaking(ioIn: AppServer, roomsIn: Map<string, Room>): void {
  io = ioIn;
  rooms = roomsIn;
  setInterval(tick, tickMs()).unref();
  console.log(`Matchmaking ready (tick ${tickMs()}ms)`);
}

function requireInit(): { io: AppServer; rooms: Map<string, Room> } {
  if (!io || !rooms) throw new Error("Matchmaking not initialized");
  return { io, rooms };
}

// ---------------------------------------------------------------------------
// Emits to all of a user's sockets
// ---------------------------------------------------------------------------

function emitQueueState(userId: string, state: QueueState | null): void {
  if (!io) return;
  for (const socketId of socketIdsForUser(userId)) io.to(socketId).emit("queueState", state);
}

function emitError(userId: string, message: string): void {
  if (!io) return;
  for (const socketId of socketIdsForUser(userId)) io.to(socketId).emit("errorMsg", message);
}

function pushAccountState(userId: string): void {
  if (!io) return;
  const payload = accountStateFor(userId);
  for (const socketId of socketIdsForUser(userId)) io.to(socketId).emit("accountState", payload);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** ±100 widening by +50 per 10s waited, capped at ±500. */
function windowFor(entry: QueueEntry, now: number): number {
  const waited = Math.max(0, now - entry.joinedAt);
  return Math.min(500, 100 + 50 * Math.floor(waited / 10_000));
}

function queueStateFor(entry: QueueEntry, now: number): QueueState {
  return {
    inQueue: true,
    waitSeconds: Math.floor((now - entry.joinedAt) / 1000),
    windowNow: windowFor(entry, now),
    playersInQueue: queue.size,
  };
}

/** Is this user tied up in a ranked room that has not finished yet? */
function activeRankedRoomFor(userId: string): RankedCtl | undefined {
  for (const ctl of rankedRooms.values()) {
    if (ctl.stage !== "finished" && ctl.users.some((u) => u.userId === userId)) return ctl;
  }
  return undefined;
}

export function queueJoin(userId: string, username: string): void {
  requireInit();
  if (activeRankedRoomFor(userId)) {
    throw new Error("Finish your current ranked match before queueing again");
  }
  const existing = queue.get(userId);
  if (!existing) {
    queue.set(userId, {
      userId,
      username,
      rating: getRating(userId).rating,
      joinedAt: Date.now(),
    });
  }
  const entry = queue.get(userId);
  if (entry) emitQueueState(userId, queueStateFor(entry, Date.now()));
}

export function queueLeave(userId: string): void {
  if (queue.delete(userId)) emitQueueState(userId, null);
}

/** All of a user's sockets are gone — silently drop them from the queue. */
export function onUserOffline(userId: string): void {
  queue.delete(userId);
}

/** Number of players currently searching (for admin stats). */
export function queueSize(): number {
  return queue.size;
}

function tick(): void {
  if (!io || !rooms) return;
  const now = Date.now();

  // Drop queued users with no connected sockets.
  for (const userId of [...queue.keys()]) {
    if (socketIdsForUser(userId).size === 0) queue.delete(userId);
  }

  // Pair the closest-rated mutually-eligible players, repeatedly.
  const entries = [...queue.values()].sort((a, b) => a.rating - b.rating);
  for (;;) {
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i + 1 < entries.length; i++) {
      const a = entries[i]!;
      const b = entries[i + 1]!;
      const diff = b.rating - a.rating;
      if (diff <= Math.min(windowFor(a, now), windowFor(b, now)) && diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const [a, b] = entries.splice(bestIdx, 2) as [QueueEntry, QueueEntry];
    queue.delete(a.userId);
    queue.delete(b.userId);
    emitQueueState(a.userId, null);
    emitQueueState(b.userId, null);
    void pairUp(a, b);
  }

  // Status update for everyone still searching.
  for (const entry of queue.values()) emitQueueState(entry.userId, queueStateFor(entry, now));
}

function requeue(userId: string, username: string): void {
  if (socketIdsForUser(userId).size === 0) return;
  if (!queue.has(userId)) {
    queue.set(userId, { userId, username, rating: getRating(userId).rating, joinedAt: Date.now() });
  }
  const entry = queue.get(userId);
  if (entry) emitQueueState(userId, queueStateFor(entry, Date.now()));
}

// ---------------------------------------------------------------------------
// Cube selection
// ---------------------------------------------------------------------------

function feasible(cardCount: number): boolean {
  const c = rankedConfigFor(cardCount);
  return c.seatCount * c.packsPerPlayer * c.cardsPerPack <= cardCount;
}

/** Random cube among ACTIVE system cubes + user ranked-eligible saved cubes. */
async function chooseRankedCubeId(): Promise<string> {
  // Seed the bundled default cube on first use so the pool starts non-empty
  // (admins may later deactivate or delete it in favor of their own cubes).
  try {
    await ensureDefaultCube();
  } catch (err) {
    console.error("[matchmaking] default cube unavailable:", err);
  }
  const pool = listRankedPool()
    .filter((row) => feasible(row.card_count))
    .map((row) => row.id);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (!pick) throw new Error("No ranked-eligible cube is available");
  return pick;
}

// ---------------------------------------------------------------------------
// Ranked room lifecycle
// ---------------------------------------------------------------------------

async function pairUp(a: QueueEntry, b: QueueEntry): Promise<void> {
  const { io, rooms } = requireInit();
  try {
    const cubeId = await chooseRankedCubeId();
    const row = getCubeById(cubeId);
    if (!row) throw new Error("Chosen cube disappeared");

    // Players may have vanished while the cube resolved.
    const aOnline = socketIdsForUser(a.userId).size > 0;
    const bOnline = socketIdsForUser(b.userId).size > 0;
    if (!aOnline || !bOnline) {
      if (aOnline) requeue(a.userId, a.username);
      if (bOnline) requeue(b.userId, b.username);
      return;
    }

    const room = new Room(Room.createId(rooms));
    room.ranked = true; // hostId stays "" — the server drives this room
    room.cube = cubeFromRow(row);
    rooms.set(room.id, room);

    const ctl: RankedCtl = {
      roomId: room.id,
      users: [
        { userId: a.userId, username: a.username, rating: a.rating, playerId: null, abandoned: false },
        { userId: b.userId, username: b.username, rating: b.rating, playerId: null, abandoned: false },
      ],
      stage: "joining",
      config: rankedConfigFor(room.cube.cardIds.length),
      joinTimer: setTimeout(() => onJoinDeadline(room.id), joinDeadlineMs()),
      deckbuildTimer: null,
      deckbuildDeadline: null,
      graceTimers: new Map(),
      matchId: null,
      settled: false,
    };
    rankedRooms.set(room.id, ctl);

    const matchedInfo = (opponent: QueueEntry) => ({
      roomId: room.id,
      opponentUsername: opponent.username,
      opponentRank: rankFor(getRating(opponent.userId).rating) as string,
    });
    for (const socketId of socketIdsForUser(a.userId)) {
      io.to(socketId).emit("queueMatched", matchedInfo(b));
    }
    for (const socketId of socketIdsForUser(b.userId)) {
      io.to(socketId).emit("queueMatched", matchedInfo(a));
    }
    console.log(
      `[room ${room.id}] ranked pairing: ${a.username} (${a.rating}) vs ${b.username} (${b.rating}), ` +
        `cube "${room.cube.name}" (${room.cube.cardIds.length} cards), ` +
        `${ctl.config.seatCount} seats ${ctl.config.packsPerPlayer}x${ctl.config.cardsPerPack}`
    );
  } catch (err) {
    console.error("[matchmaking] pairing failed:", err);
    emitError(a.userId, "Matchmaking failed — you are back in the queue");
    emitError(b.userId, "Matchmaking failed — you are back in the queue");
    requeue(a.userId, a.username);
    requeue(b.userId, b.username);
  }
}

function clearTimers(ctl: RankedCtl): void {
  if (ctl.joinTimer) clearTimeout(ctl.joinTimer);
  ctl.joinTimer = null;
  if (ctl.deckbuildTimer) clearTimeout(ctl.deckbuildTimer);
  ctl.deckbuildTimer = null;
  for (const timer of ctl.graceTimers.values()) clearTimeout(timer);
  ctl.graceTimers.clear();
}

/** Drop all matchmaking bookkeeping for a room (timers included). */
export function cleanupRankedRoom(roomId: string): void {
  const ctl = rankedRooms.get(roomId);
  if (!ctl) return;
  clearTimers(ctl);
  rankedRooms.delete(roomId);
}

function destroyRankedRoom(room: Room): void {
  const { rooms } = requireInit();
  cleanupRankedRoom(room.id);
  room.clearAllPickTimers();
  rooms.delete(room.id);
}

function onJoinDeadline(roomId: string): void {
  const { io, rooms } = requireInit();
  const room = rooms.get(roomId);
  const ctl = rankedRooms.get(roomId);
  if (!room || !ctl || ctl.stage !== "joining") return;
  console.log(`[room ${roomId}] ranked join deadline hit; aborting`);
  for (const u of ctl.users) {
    if (u.playerId) {
      // Present player: pull them out of the dead room and requeue them.
      const player = room.players.get(u.playerId);
      if (player?.socketId) {
        const sock = io.sockets.sockets.get(player.socketId);
        if (sock) {
          sock.leave(room.id);
          sock.data.roomId = undefined;
          sock.data.playerId = undefined;
        }
      }
      emitError(u.userId, "Your opponent did not show up — you are back in the ranked queue");
      requeue(u.userId, u.username);
    } else {
      emitError(u.userId, "Ranked match aborted: you did not join in time");
    }
  }
  destroyRankedRoom(room);
}

/** The ranked-room seat reservation for this account, or throw. */
export function rankedUserFor(room: Room, userId: string | undefined): RankedUser {
  const ctl = rankedRooms.get(room.id);
  if (!ctl || ctl.stage === "finished") throw new Error("This ranked room is closed");
  if (!userId) throw new Error("Sign in to join a ranked room");
  const user = ctl.users.find((u) => u.userId === userId);
  if (!user) throw new Error("This ranked room belongs to other players");
  if (user.abandoned) throw new Error("You left this ranked match");
  return user;
}

/** A matched user just claimed their seat; start the draft once both are in. */
export function onRankedSeatClaimed(io: AppServer, room: Room, userId: string, playerId: string): void {
  const ctl = rankedRooms.get(room.id);
  if (!ctl) return;
  const user = ctl.users.find((u) => u.userId === userId);
  if (!user) return;
  user.playerId = playerId;
  if (ctl.stage !== "joining") return;
  if (!ctl.users.every((u) => u.playerId && room.players.has(u.playerId))) return;
  if (ctl.joinTimer) clearTimeout(ctl.joinTimer);
  ctl.joinTimer = null;
  ctl.stage = "drafting";
  // Defer past the joinRoom ack so the joining client is fully in the room.
  setImmediate(() => {
    try {
      startDraftInRoom(io, room, { ...ctl.config });
    } catch (err) {
      console.error(`[room ${room.id}] ranked draft failed to start:`, err);
      for (const u of ctl.users) {
        emitError(u.userId, "Ranked draft failed to start — you are back in the queue");
        requeue(u.userId, u.username);
      }
      destroyRankedRoom(room);
    }
  });
}

/** Reconnect (rejoin) of a ranked player: cancel any pending concession. */
export function onRankedReconnect(room: Room, playerId: string): void {
  const ctl = rankedRooms.get(room.id);
  if (!ctl) return;
  const timer = ctl.graceTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    ctl.graceTimers.delete(playerId);
    console.log(`[room ${room.id}] ranked player reconnected; concession timer cancelled`);
  }
}

/**
 * Explicit leaveRoom in a ranked room (outside an active match — the handler
 * converts mid-match leaves into disconnects). Mid-draft/deckbuild this is an
 * abandonment; the opponent wins by concession once decks are due.
 */
export function onRankedPlayerLeft(io: AppServer, room: Room, playerId: string): void {
  const ctl = rankedRooms.get(room.id);
  if (!ctl || ctl.settled) return;
  const user = ctl.users.find((u) => u.playerId === playerId);
  if (!user) return;
  if (ctl.stage === "joining") {
    user.playerId = null; // seat is open again until the join deadline
    return;
  }
  if (ctl.stage === "drafting") {
    user.abandoned = true; // seat already went bot; resolved at draft end
    return;
  }
  if (ctl.stage === "deckbuild") {
    user.abandoned = true;
    resolveDeckbuildAbandonment(io, room, ctl);
  }
}

/** Disconnect of a ranked player mid-match: opponent wins after a grace period. */
export function onRankedDisconnect(io: AppServer, room: Room, playerId: string): void {
  const ctl = rankedRooms.get(room.id);
  if (!ctl || ctl.stage !== "playing" || !ctl.matchId || ctl.settled) return;
  const match = room.matches.get(ctl.matchId);
  if (!match || match.game.finished || !match.playerIds.includes(playerId)) return;
  if (ctl.graceTimers.has(playerId)) return;
  const graceMs = disconnectGraceMs();
  ctl.graceTimers.set(
    playerId,
    setTimeout(() => forceConcede(room.id, playerId), graceMs)
  );
  console.log(
    `[room ${room.id}] ranked player disconnected mid-match; ` +
      `concession in ${Math.round(graceMs / 1000)}s unless they return`
  );
}

function forceConcede(roomId: string, playerId: string): void {
  const { io, rooms } = requireInit();
  const room = rooms.get(roomId);
  const ctl = rankedRooms.get(roomId);
  if (!room || !ctl || !ctl.matchId || ctl.settled) return;
  ctl.graceTimers.delete(playerId);
  const match = room.matches.get(ctl.matchId);
  if (!match || match.game.finished) return;
  console.log(`[room ${roomId}] disconnect grace expired; conceding for the absent player`);
  try {
    applyGameActionServer(io, room, match, playerId, { type: "concede" });
  } catch (err) {
    console.error(`[room ${roomId}] forced concession failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// Deckbuild stage (5-minute deadline, auto-submit) and match start
// ---------------------------------------------------------------------------

const COLOR_ORDER: readonly Color[] = ["W", "U", "B", "R", "G"];
const BASIC_FOR_COLOR: Record<Color, string> = {
  W: "Plains",
  U: "Island",
  B: "Swamp",
  R: "Mountain",
  G: "Forest",
};

/**
 * 17 basics split proportionally to the mana colors of the picked cards, with
 * at least 1 of each represented color. Colorless pools split evenly.
 */
export function autoBasicsSplit(colorCounts: Record<Color, number>, total = 17): Record<string, number> {
  const counts = { ...colorCounts };
  let colors = COLOR_ORDER.filter((c) => (counts[c] ?? 0) > 0);
  if (colors.length === 0) {
    colors = [...COLOR_ORDER];
    for (const c of colors) counts[c] = 1;
  }
  const sum = colors.reduce((n, c) => n + counts[c], 0);
  const perColor: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const remaining = Math.max(0, total - colors.length);
  for (const c of colors) perColor[c] = 1; // min 1 of each represented color
  const shares = colors.map((c) => ({ c, exact: (remaining * counts[c]) / sum }));
  let used = 0;
  for (const s of shares) {
    const whole = Math.floor(s.exact);
    perColor[s.c] += whole;
    used += whole;
  }
  shares.sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)));
  for (let leftover = remaining - used, i = 0; leftover > 0; leftover--, i = (i + 1) % shares.length) {
    perColor[shares[i]!.c] += 1;
  }
  const basics: Record<string, number> = {};
  for (const c of COLOR_ORDER) basics[BASIC_FOR_COLOR[c]] = perColor[c];
  return basics;
}

function autoSubmitDeck(io: AppServer, room: Room, playerId: string): boolean {
  const picks: DraftCard[] = room.picksByPlayer.get(playerId) ?? [];
  if (picks.length === 0) return false;
  const colorCounts: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const pick of picks) {
    for (const color of room.cube?.cards[pick.cardId]?.colors ?? []) colorCounts[color] += 1;
  }
  room.decks.set(playerId, {
    playerId,
    main: picks.map((p) => ({ instanceId: p.instanceId, cardId: p.cardId })),
    sideboard: [],
    basics: autoBasicsSplit(colorCounts),
  });
  console.log(`[room ${room.id}] auto-submitted deck for ${room.players.get(playerId)?.name ?? playerId}`);
  return true;
}

/** Ranked deckbuild is closed once the deadline has passed (or match started). */
export function isRankedDeckbuildClosed(room: Room): boolean {
  const ctl = rankedRooms.get(room.id);
  if (!ctl) return false;
  if (ctl.stage === "playing" || ctl.stage === "finished") return true;
  return ctl.deckbuildDeadline !== null && Date.now() > ctl.deckbuildDeadline;
}

/** Called by the shared flow when a ranked room's draft completes. */
export function onRankedDraftComplete(io: AppServer, room: Room): void {
  const ctl = rankedRooms.get(room.id);
  if (!ctl || ctl.settled) return;
  ctl.stage = "deckbuild";
  if (resolveDeckbuildAbandonment(io, room, ctl)) return;
  const ms = deckbuildMs();
  ctl.deckbuildDeadline = Date.now() + ms;
  ctl.deckbuildTimer = setTimeout(() => onDeckbuildDeadline(room.id), ms);
  console.log(`[room ${room.id}] ranked deckbuild: ${Math.round(ms / 1000)}s until auto-submit`);
}

/** Called by the submitDeck handler after a deck lands in a ranked room. */
export function onRankedDeckSubmitted(io: AppServer, room: Room): void {
  const ctl = rankedRooms.get(room.id);
  if (!ctl || ctl.stage !== "deckbuild") return;
  const allIn = ctl.users.every((u) => u.playerId && room.decks.has(u.playerId));
  if (allIn) startRankedMatch(io, room, ctl);
}

function onDeckbuildDeadline(roomId: string): void {
  const { io, rooms } = requireInit();
  const room = rooms.get(roomId);
  const ctl = rankedRooms.get(roomId);
  if (!room || !ctl || ctl.stage !== "deckbuild") return;
  console.log(`[room ${roomId}] ranked deckbuild deadline; auto-submitting missing decks`);
  for (const u of ctl.users) {
    if (u.playerId && !u.abandoned && !room.decks.has(u.playerId)) autoSubmitDeck(io, room, u.playerId);
  }
  broadcastRoomState(io, room);
  startRankedMatch(io, room, ctl);
}

/** A user is still in contention if seated, present, and not abandoned. */
function inContention(room: Room, user: RankedUser): boolean {
  return Boolean(
    user.playerId &&
      !user.abandoned &&
      room.players.has(user.playerId) &&
      (room.picksByPlayer.get(user.playerId)?.length ?? 0) > 0
  );
}

/** Handle one (or both) sides having abandoned before the match could start. */
function resolveDeckbuildAbandonment(io: AppServer, room: Room, ctl: RankedCtl): boolean {
  const [a, b] = ctl.users;
  const aOk = inContention(room, a);
  const bOk = inContention(room, b);
  if (aOk && bOk) return false;
  if (!aOk && !bOk) {
    voidRankedRoom(io, room, ctl, "both players left");
    return true;
  }
  finishWalkover(io, room, ctl, aOk ? a : b, aOk ? b : a, "opponent left the match");
  return true;
}

function startRankedMatch(io: AppServer, room: Room, ctl: RankedCtl): void {
  if (ctl.stage !== "deckbuild") return;
  if (ctl.deckbuildTimer) clearTimeout(ctl.deckbuildTimer);
  ctl.deckbuildTimer = null;
  if (resolveDeckbuildAbandonment(io, room, ctl)) return;
  const [a, b] = ctl.users;
  const pidA = a.playerId;
  const pidB = b.playerId;
  const deckA = pidA ? room.decks.get(pidA) : undefined;
  const deckB = pidB ? room.decks.get(pidB) : undefined;
  if (!pidA || !pidB || !deckA || !deckB) {
    // A player with picks somehow has no deck (auto-submit failed): walk over.
    const aReady = Boolean(pidA && deckA);
    if (aReady === Boolean(pidB && deckB)) voidRankedRoom(io, room, ctl, "no decks were available");
    else finishWalkover(io, room, ctl, aReady ? a : b, aReady ? b : a, "no deck was submitted");
    return;
  }
  try {
    ctl.matchId = startMatchInRoom(io, room, pidA, pidB);
    ctl.stage = "playing";
  } catch (err) {
    console.error(`[room ${room.id}] ranked match failed to start:`, err);
    voidRankedRoom(io, room, ctl, "the match could not be started");
    return;
  }
  // Anyone already disconnected at match start is on the concession clock.
  for (const u of ctl.users) {
    const player = u.playerId ? room.players.get(u.playerId) : undefined;
    if (u.playerId && player && !player.connected) onRankedDisconnect(io, room, u.playerId);
  }
}

// ---------------------------------------------------------------------------
// Settlement (Elo)
// ---------------------------------------------------------------------------

function applyRatingChange(
  userId: string,
  delta: number,
  result: "win" | "loss" | "draw"
): void {
  const row = getRating(userId);
  upsertRating({
    user_id: userId,
    rating: row.rating + delta,
    wins: row.wins + (result === "win" ? 1 : 0),
    losses: row.losses + (result === "loss" ? 1 : 0),
    draws: row.draws + (result === "draw" ? 1 : 0),
  });
}

function settle(
  ctl: RankedCtl,
  winnerUserId: string | null
): { deltaA: number; deltaB: number } {
  const [a, b] = ctl.users;
  const ratingA = getRating(a.userId).rating;
  const ratingB = getRating(b.userId).rating;
  const scoreA: 0 | 0.5 | 1 = winnerUserId === null ? 0.5 : winnerUserId === a.userId ? 1 : 0;
  const deltaA = eloDelta(ratingA, ratingB, scoreA);
  const deltaB = -deltaA;
  const resultA = scoreA === 1 ? "win" : scoreA === 0 ? "loss" : "draw";
  const resultB = scoreA === 1 ? "loss" : scoreA === 0 ? "win" : "draw";
  applyRatingChange(a.userId, deltaA, resultA);
  applyRatingChange(b.userId, deltaB, resultB);
  insertRankedMatch({
    id: nanoid(12),
    user_a: a.userId,
    user_b: b.userId,
    winner_user_id: winnerUserId,
    delta_a: deltaA,
    delta_b: deltaB,
    ts: Date.now(),
  });
  ctl.settled = true;
  ctl.stage = "finished";
  clearTimers(ctl);
  pushAccountState(a.userId);
  pushAccountState(b.userId);
  console.log(
    `[room ${ctl.roomId}] ranked settled: ${a.username} ${deltaA >= 0 ? "+" : ""}${deltaA}, ` +
      `${b.username} ${deltaB >= 0 ? "+" : ""}${deltaB}`
  );
  return { deltaA, deltaB };
}

/** Called by the shared flow when a ranked room's match finishes. */
export function onRankedMatchFinished(io: AppServer, room: Room, match: Match): void {
  const ctl = rankedRooms.get(room.id);
  if (!ctl || ctl.settled || ctl.matchId !== match.id) {
    broadcastRoomState(io, room);
    return;
  }
  const [a, b] = ctl.users;
  // A finished ranked game with winnerId null shouldn't happen; treat as draw.
  const winnerPlayerId = match.game.winnerId;
  const winnerUserId =
    winnerPlayerId === null
      ? null
      : a.playerId === winnerPlayerId
        ? a.userId
        : b.playerId === winnerPlayerId
          ? b.userId
          : null;
  const { deltaA, deltaB } = settle(ctl, winnerUserId);
  if (a.playerId && b.playerId) {
    match.ratingDeltas = { [a.playerId]: deltaA, [b.playerId]: deltaB };
  }
  broadcastRoomState(io, room);
}

function finishWalkover(
  io: AppServer,
  room: Room,
  ctl: RankedCtl,
  winner: RankedUser,
  loser: RankedUser,
  reason: string
): void {
  if (ctl.settled) return;
  settle(ctl, winner.userId);
  io.to(room.id).emit(
    "errorMsg",
    `${winner.username} wins the ranked match by concession (${reason})`
  );
  emitError(loser.userId, `You conceded the ranked match (${reason})`);
  broadcastRoomState(io, room);
  console.log(`[room ${room.id}] ranked walkover: ${winner.username} over ${loser.username} (${reason})`);
}

function voidRankedRoom(io: AppServer, room: Room, ctl: RankedCtl, reason: string): void {
  ctl.settled = true;
  ctl.stage = "finished";
  clearTimers(ctl);
  io.to(room.id).emit("errorMsg", `Ranked match voided: ${reason}. No rating change.`);
  broadcastRoomState(io, room);
  console.log(`[room ${room.id}] ranked match voided (${reason})`);
}
