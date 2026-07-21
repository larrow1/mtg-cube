/**
 * Socket.IO event wiring. Every handler is wrapped so a thrown error acks
 * {ok:false, error} instead of crashing the process. Draft/match flow lives in
 * flow.ts (shared with the ranked matchmaker); accounts in auth.ts; queue +
 * ranked room lifecycle in matchmaking.ts.
 */
import { nanoid } from "nanoid";
import { BASIC_LAND_NAMES, normalizeCubeLines, parseCubeList, rankFor } from "@mtg-cube/shared";
import type {
  Account,
  Ack,
  AdminStats,
  AdminUserRow,
  CardData,
  DraftCard,
  GameAction,
  RankedMatchRecord,
  RatingInfo,
  SavedCubeSummary,
  SpawnZone,
  SystemCubeSummary,
} from "@mtg-cube/shared";
import {
  accountStateFor,
  bindSocket,
  bindingForSocket,
  loginUser,
  ratingInfoFor,
  registerUser,
  revokeSessionByHash,
  socketIdsForUser,
  unbindSocket,
  userIdForSocket,
  validatePassword,
  validateUsername,
  verifyToken,
} from "./auth.js";
import {
  SYSTEM_OWNER_ID,
  countCubesByOwner,
  countRankedMatches,
  countSavedCubes,
  countUserEligibleCubes,
  countUsers,
  cubeFromRow,
  deleteCube,
  deleteUserCascade,
  findUserById,
  getCubeById,
  insertCube,
  listCubesByOwner,
  listRankedHistory,
  listSystemCubes,
  listUsersWithDetails,
  setCubeActive,
  setCubeRankedEligible,
  setUserAdmin,
} from "./db.js";
import type { CubeSummaryRow, StoredCubeCards } from "./db.js";
import {
  applyGameActionServer,
  broadcastRoomState,
  emitDraftViewTo,
  emitDraftViews,
  finishDraft,
  performPick,
  reconcilePickTimers,
  startDraftInRoom,
  startMatchInRoom,
  startSandboxMatchInRoom,
  registerMatchCard,
  advanceDraft,
  emitMatchViewsTo,
} from "./flow.js";
import type { AppServer, AppSocket, SocketData } from "./flow.js";
import {
  cleanupRankedRoom,
  isRankedDeckbuildClosed,
  onRankedDeckSubmitted,
  onRankedDisconnect,
  onRankedPlayerLeft,
  onRankedReconnect,
  onRankedSeatClaimed,
  onUserOffline,
  queueJoin,
  queueLeave,
  queueSize,
  rankedUserFor,
} from "./matchmaking.js";
import { resolveCardNames } from "./scryfall.js";
import { Room } from "./room.js";
import type { RoomPlayer } from "./room.js";

export type { AppServer, AppSocket, SocketData } from "./flow.js";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

type AckFn<T = undefined> = (r: Ack<T>) => void;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Make an ack safe: tolerate a missing callback and never fire twice. */
function once<T>(ack: unknown): AckFn<T> {
  const fn = typeof ack === "function" ? (ack as AckFn<T>) : undefined;
  let called = false;
  return (r) => {
    if (called) return;
    called = true;
    fn?.(r);
  };
}

function guard<T>(reply: AckFn<T>, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    reply({ ok: false, error: errorMessage(err) });
  }
}

function guardAsync<T>(reply: AckFn<T>, fn: () => Promise<void>): void {
  fn().catch((err: unknown) => {
    console.error("async handler error:", err);
    reply({ ok: false, error: errorMessage(err) });
  });
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function validateName(raw: unknown): string {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 20) throw new Error("Name must be 1-20 characters");
  return name;
}

function getContext(rooms: Map<string, Room>, socket: AppSocket): { room: Room; player: RoomPlayer } {
  const { roomId, playerId } = socket.data;
  const room = roomId ? rooms.get(roomId) : undefined;
  const player = room && playerId ? room.players.get(playerId) : undefined;
  if (!room || !player) throw new Error("You are not in a room");
  return { room, player };
}

/** The account bound to this socket, or throw for account-only features. */
function requireUserId(socket: AppSocket): string {
  const userId = userIdForSocket(socket.id);
  if (!userId) throw new Error("Sign in to use this feature");
  return userId;
}

/** Admin-only features: authenticated AND is_admin (checked per call). */
function requireAdmin(socket: AppSocket): string {
  const userId = requireUserId(socket);
  const user = findUserById(userId);
  if (!user || user.is_admin === 0) throw new Error("Admin access required");
  return userId;
}

function toSavedCubeSummary(row: CubeSummaryRow): SavedCubeSummary {
  return {
    id: row.id,
    name: row.name,
    cardCount: row.card_count,
    unresolvedCount: row.unresolved.length,
    rankedEligible: row.ranked_eligible,
    updatedAt: row.updated_at,
  };
}

function toSystemCubeSummary(row: CubeSummaryRow): SystemCubeSummary {
  return {
    id: row.id,
    name: row.name,
    cardCount: row.card_count,
    unresolvedCount: row.unresolved.length,
    active: row.active,
    updatedAt: row.updated_at,
  };
}

/** Parse + resolve a raw cube list (shared by uploadCube and saveCube). */
async function resolveCubeList(rawList: string): Promise<{
  cards: StoredCubeCards;
  unresolved: string[];
}> {
  if (rawList.length > 500_000) throw new Error("Cube list is too large");
  const lines = normalizeCubeLines(parseCubeList(rawList));
  if (lines.length === 0) throw new Error("The cube list contains no cards");
  if (lines.length > 2000) throw new Error("Cube list is too large (max 2000 distinct cards)");
  const { byName, unresolved } = await resolveCardNames(lines.map((l) => l.name));
  const cardIds: string[] = [];
  const cards: Record<string, CardData> = {};
  for (const line of lines) {
    const card = byName.get(line.name);
    if (!card) continue;
    cards[card.id] = card;
    for (let i = 0; i < line.count; i++) cardIds.push(card.id);
  }
  return { cards: { cardIds, cards }, unresolved };
}

// ---------------------------------------------------------------------------
// Leave / cleanup
// ---------------------------------------------------------------------------

function doLeaveRoom(io: AppServer, rooms: Map<string, Room>, socket: AppSocket): void {
  const { roomId, playerId } = socket.data;
  socket.data.roomId = undefined;
  socket.data.playerId = undefined;
  if (!roomId || !playerId) return;
  socket.leave(roomId);
  const room = rooms.get(roomId);
  if (!room) return;
  const player = room.players.get(playerId);
  if (!player) return;

  // Sandbox rooms live and die with the admin driving them: any leave tears
  // the whole room down (the phantom opponent can never keep it alive).
  if (room.sandbox) {
    room.clearAllPickTimers();
    rooms.delete(room.id);
    console.log(`[room ${room.id}] engine sandbox closed`);
    return;
  }

  // Ranked + match in progress: a "leave" is just a disconnect — the seat is
  // kept so the 3-minute concession clock (and any reconnect) governs it.
  if (room.ranked && room.playerIsInActiveMatch(playerId)) {
    player.connected = false;
    player.socketId = null;
    room.touch();
    broadcastRoomState(io, room);
    onRankedDisconnect(io, room, playerId);
    console.log(`[room ${room.id}] ${player.name} left mid-ranked-match; concession clock running`);
    return;
  }

  room.players.delete(playerId);
  room.decks.delete(playerId);
  room.touch();
  console.log(`[room ${room.id}] ${player.name} left`);

  // A drafter who leaves for good hands their seat to a bot so the draft flows on.
  if (room.phase === "drafting" && room.draftState) {
    const seatIndex = room.seatIndexOf(playerId);
    if (seatIndex >= 0) {
      room.clearPickTimer(seatIndex);
      room.draftState = {
        ...room.draftState,
        seats: room.draftState.seats.map((s) =>
          s.playerId === playerId ? { ...s, playerId: null, isBot: true } : s
        ),
      };
      advanceDraft(room);
      if (room.draftState?.complete) {
        finishDraft(io, room);
      } else {
        reconcilePickTimers(io, room);
        emitDraftViews(io, room);
      }
    }
  }

  if (room.ranked) onRankedPlayerLeft(io, room, playerId);

  if (room.players.size === 0) {
    room.clearAllPickTimers();
    cleanupRankedRoom(room.id);
    rooms.delete(room.id);
    console.log(`[room ${room.id}] empty after explicit leave; removed`);
    return;
  }

  // Ranked rooms have no host to reassign (hostId stays "").
  if (!room.ranked && room.hostId === playerId) {
    const nextHostId = [...room.players.keys()][0];
    if (nextHostId) {
      room.hostId = nextHostId;
      console.log(`[room ${room.id}] host is now ${room.players.get(nextHostId)?.name}`);
    }
  }
  broadcastRoomState(io, room);
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerHandlers(io: AppServer, socket: AppSocket, rooms: Map<string, Room>): void {
  // -- createRoom -----------------------------------------------------------
  socket.on("createRoom", (playerName, ack) => {
    const reply = once<{ roomId: string; playerId: string; token: string }>(ack);
    guard(reply, () => {
      const name = validateName(playerName);
      doLeaveRoom(io, rooms, socket);
      const room = new Room(Room.createId(rooms));
      rooms.set(room.id, room);
      const player = room.addPlayer(name, socket.id);
      room.hostId = player.id;
      socket.data.roomId = room.id;
      socket.data.playerId = player.id;
      socket.join(room.id);
      reply({ ok: true, data: { roomId: room.id, playerId: player.id, token: player.token } });
      broadcastRoomState(io, room);
      console.log(`[room ${room.id}] created by ${player.name}`);
    });
  });

  // -- joinRoom (fresh join or reconnect-by-token) --------------------------
  socket.on("joinRoom", (args, ack) => {
    const reply = once<{ playerId: string; token: string }>(ack);
    guard(reply, () => {
      const roomId = String(args?.roomId ?? "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) throw new Error("Room not found");

      if (socket.data.roomId && socket.data.roomId !== room.id) doLeaveRoom(io, rooms, socket);

      const token = typeof args?.token === "string" ? args.token : "";
      let player = room.findPlayerByToken(token);
      if (!player && socket.data.roomId === room.id && socket.data.playerId) {
        // Same socket re-joining its own room.
        player = room.players.get(socket.data.playerId);
      }
      let claimedRankedSeat = false;
      if (player) {
        player.connected = true;
        player.socketId = socket.id;
        if (room.ranked) onRankedReconnect(room, player.id);
        console.log(`[room ${room.id}] ${player.name} reconnected`);
      } else if (room.ranked) {
        // Ranked rooms admit only the two matched accounts (no spectators).
        const userId = userIdForSocket(socket.id);
        const rankedUser = rankedUserFor(room, userId);
        const existing = rankedUser.playerId ? room.players.get(rankedUser.playerId) : undefined;
        if (existing) {
          // Same account from a new connection: reclaim the reserved seat.
          player = existing;
          player.connected = true;
          player.socketId = socket.id;
          onRankedReconnect(room, player.id);
          console.log(`[room ${room.id}] ${player.name} reclaimed their ranked seat`);
        } else {
          player = room.addPlayer(validateName(args?.playerName), socket.id);
          claimedRankedSeat = true;
          console.log(`[room ${room.id}] ${player.name} joined (ranked)`);
        }
      } else {
        player = room.addPlayer(validateName(args?.playerName), socket.id);
        console.log(`[room ${room.id}] ${player.name} joined`);
      }
      socket.data.roomId = room.id;
      socket.data.playerId = player.id;
      socket.join(room.id);
      room.touch();
      reply({ ok: true, data: { playerId: player.id, token: player.token } });
      if (claimedRankedSeat) {
        const userId = userIdForSocket(socket.id);
        if (userId) onRankedSeatClaimed(io, room, userId, player.id); // may auto-start the draft
      }
      broadcastRoomState(io, room);

      // Re-emit current views so a reconnecting client is fully caught up.
      emitDraftViewTo(io, room, player.id);
      emitMatchViewsTo(io, room, player.id, socket.id);
    });
  });

  // -- leaveRoom ------------------------------------------------------------
  socket.on("leaveRoom", (ack) => {
    const reply = once(ack);
    guard(reply, () => {
      doLeaveRoom(io, rooms, socket);
      reply({ ok: true });
    });
  });

  // -- uploadCube (host, lobby only) ----------------------------------------
  socket.on("uploadCube", (args, ack) => {
    const reply = once<{ cardCount: number; unresolved: string[] }>(ack);
    guardAsync(reply, async () => {
      const { room, player } = getContext(rooms, socket);
      if (room.ranked) throw new Error("Ranked rooms are server-driven");
      if (player.id !== room.hostId) throw new Error("Only the host can upload a cube");
      if (room.phase !== "lobby") throw new Error("The cube can only be changed in the lobby");

      const cubeName = String(args?.name ?? "").trim().slice(0, 60) || "Untitled Cube";
      const { cards, unresolved } = await resolveCubeList(String(args?.list ?? ""));

      // Re-validate after the await: the room may have moved on.
      if (rooms.get(room.id) !== room) throw new Error("Room no longer exists");
      if (room.phase !== "lobby") throw new Error("The cube can only be changed in the lobby");

      room.cube = { id: nanoid(8), name: cubeName, cardIds: cards.cardIds, cards: cards.cards, unresolved };
      room.touch();
      reply({ ok: true, data: { cardCount: cards.cardIds.length, unresolved } });
      broadcastRoomState(io, room);
      console.log(
        `[room ${room.id}] cube "${cubeName}": ${cards.cardIds.length} cards, ${unresolved.length} unresolved`
      );
    });
  });

  // -- startDraft (host, lobby, cube required) ------------------------------
  socket.on("startDraft", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const { room, player } = getContext(rooms, socket);
      if (room.ranked) throw new Error("Ranked rooms are server-driven");
      if (player.id !== room.hostId) throw new Error("Only the host can start the draft");
      const rawTimer = args?.pickTimerSeconds;
      startDraftInRoom(io, room, {
        seatCount: clampInt(args?.seatCount, 2, 8, 8),
        packsPerPlayer: clampInt(args?.packsPerPlayer, 1, 6, 3),
        cardsPerPack: clampInt(args?.cardsPerPack, 3, 30, 15),
        pickTimerSeconds: rawTimer === "dynamic" ? "dynamic" : rawTimer == null ? null : clampInt(rawTimer, 5, 600, 60),
      });
      reply({ ok: true });
    });
  });

  // -- makePick -------------------------------------------------------------
  socket.on("makePick", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const { room, player } = getContext(rooms, socket);
      if (room.phase !== "drafting" || !room.draftState) throw new Error("No draft in progress");
      const seatIndex = room.seatIndexOf(player.id);
      if (seatIndex < 0) throw new Error("You are not seated in this draft");
      const instanceId = String(args?.instanceId ?? "");
      performPick(io, room, seatIndex, instanceId);
      room.touch();
      reply({ ok: true });
    });
  });

  // -- submitDeck -----------------------------------------------------------
  socket.on("submitDeck", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const { room, player } = getContext(rooms, socket);
      if (room.phase !== "deckbuild" && room.phase !== "playing") {
        throw new Error("Decks can only be submitted after the draft");
      }
      if (room.playerIsInAnyMatch(player.id)) {
        throw new Error("Your deck is locked once your first match has started");
      }
      if (room.ranked && isRankedDeckbuildClosed(room)) {
        throw new Error("The ranked deckbuild deadline has passed");
      }

      const picks = room.picksByPlayer.get(player.id) ?? [];
      const picksById = new Map(picks.map((p) => [p.instanceId, p]));
      const seen = new Set<string>();
      const sanitizeList = (list: unknown, label: string): DraftCard[] => {
        if (!Array.isArray(list)) throw new Error(`Invalid ${label} list`);
        return list.map((entry: unknown) => {
          const rawId = (entry as { instanceId?: unknown } | null | undefined)?.instanceId;
          const instanceId = typeof rawId === "string" ? rawId : "";
          const pick = picksById.get(instanceId);
          if (!pick) throw new Error(`A ${label} card is not among your draft picks`);
          if (seen.has(instanceId)) throw new Error("The same card appears twice in your deck");
          seen.add(instanceId);
          // Rebuild from the server-side pick; never trust the client's cardId.
          return { instanceId: pick.instanceId, cardId: pick.cardId };
        });
      };
      const main = sanitizeList(args?.main, "main deck");
      const sideboard = sanitizeList(args?.sideboard, "sideboard");

      const rawBasics: unknown = args?.basics ?? {};
      if (typeof rawBasics !== "object" || rawBasics === null || Array.isArray(rawBasics)) {
        throw new Error("Invalid basic lands");
      }
      const basics: Record<string, number> = {};
      for (const [name, value] of Object.entries(rawBasics as Record<string, unknown>)) {
        if (!(BASIC_LAND_NAMES as readonly string[]).includes(name)) {
          throw new Error(`Unknown basic land "${name}"`);
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error("Basic land counts must be numbers");
        }
        const count = Math.floor(value);
        if (count < 0 || count > 40) throw new Error("Basic land counts must be between 0 and 40");
        basics[name] = count;
      }
      for (const name of BASIC_LAND_NAMES) basics[name] ??= 0;

      room.decks.set(player.id, { playerId: player.id, main, sideboard, basics });
      room.touch();
      reply({ ok: true });
      broadcastRoomState(io, room);
      const basicCount = Object.values(basics).reduce((a, b) => a + b, 0);
      console.log(
        `[room ${room.id}] ${player.name} submitted a deck ` +
          `(${main.length} main + ${basicCount} basics, ${sideboard.length} side)`
      );
      if (room.ranked) onRankedDeckSubmitted(io, room); // may auto-start the match
    });
  });

  // -- startMatch (host) ----------------------------------------------------
  socket.on("startMatch", (args, ack) => {
    const reply = once<{ matchId: string }>(ack);
    guard(reply, () => {
      const { room, player } = getContext(rooms, socket);
      if (room.ranked) throw new Error("Ranked rooms are server-driven");
      if (player.id !== room.hostId) throw new Error("Only the host can start a match");
      const matchId = startMatchInRoom(io, room, String(args?.playerA ?? ""), String(args?.playerB ?? ""));
      reply({ ok: true, data: { matchId } });
    });
  });

  // -- gameAction -----------------------------------------------------------
  socket.on("gameAction", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const { room, player } = getContext(rooms, socket);
      const match = room.matches.get(String(args?.matchId ?? ""));
      if (!match) throw new Error("Match not found");
      if (!match.playerIds.includes(player.id)) throw new Error("You are not a player in this match");
      const action = args?.action;
      if (!action || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string") {
        throw new Error("Invalid action");
      }
      const type = (action as { type: string }).type;
      if (room.ranked && (type === "endMatch" || type === "restartGame")) {
        throw new Error("That action is disabled in ranked matches");
      }
      if (type === "spawnCard" && !room.sandbox) {
        throw new Error("spawnCard is only available in the admin engine sandbox");
      }
      // EngineError (or anything else): reply {ok:false}, keep state, emit nothing.
      applyGameActionServer(io, room, match, player.id, action as GameAction);
      reply({ ok: true });
    });
  });

  // -- chat -----------------------------------------------------------------
  socket.on("chat", (message) => {
    try {
      const { room, player } = getContext(rooms, socket);
      const text = String(message ?? "").trim().slice(0, 500);
      if (!text) return;
      room.touch();
      io.to(room.id).emit("chat", {
        playerId: player.id,
        playerName: player.name,
        message: text,
        ts: Date.now(),
      });
    } catch {
      // Chat from a socket not in a room: ignore.
    }
  });

  // -- accounts -------------------------------------------------------------
  socket.on("register", (args, ack) => {
    const reply = once<{ token: string; account: Account; rating: RatingInfo }>(ack);
    guardAsync(reply, async () => {
      const username = validateUsername(args?.username);
      const password = validatePassword(args?.password);
      const { token, tokenHash, account } = await registerUser(username, password);
      bindSocket(socket.id, account.id, tokenHash);
      const rating = ratingInfoFor(account.id);
      reply({ ok: true, data: { token, account, rating } });
      socket.emit("accountState", { account, rating });
      console.log(`account registered: ${account.username}`);
    });
  });

  socket.on("login", (args, ack) => {
    const reply = once<{ token: string; account: Account; rating: RatingInfo }>(ack);
    guardAsync(reply, async () => {
      const username = validateUsername(args?.username);
      const password = validatePassword(args?.password);
      const ip = socket.handshake.address || "unknown";
      const { token, tokenHash, account } = await loginUser(username, password, ip);
      bindSocket(socket.id, account.id, tokenHash);
      const rating = ratingInfoFor(account.id);
      reply({ ok: true, data: { token, account, rating } });
      socket.emit("accountState", { account, rating });
      console.log(`account login: ${account.username}`);
    });
  });

  socket.on("authenticate", (args, ack) => {
    const reply = once<{ account: Account; rating: RatingInfo }>(ack);
    guard(reply, () => {
      const result = verifyToken(String(args?.token ?? ""));
      if (!result) throw new Error("Invalid or expired session");
      bindSocket(socket.id, result.account.id, result.tokenHash);
      const rating = ratingInfoFor(result.account.id);
      reply({ ok: true, data: { account: result.account, rating } });
      socket.emit("accountState", { account: result.account, rating });
    });
  });

  socket.on("logout", (ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const binding = bindingForSocket(socket.id);
      if (binding) {
        revokeSessionByHash(binding.tokenHash); // invalidate the token itself
        const userId = unbindSocket(socket.id);
        if (userId && socketIdsForUser(userId).size === 0) onUserOffline(userId);
      }
      reply({ ok: true });
      socket.emit("accountState", null);
    });
  });

  socket.on("getProfile", (ack) => {
    const reply = once<{ account: Account; rating: RatingInfo; history: RankedMatchRecord[] }>(ack);
    guard(reply, () => {
      const userId = requireUserId(socket);
      const state = accountStateFor(userId);
      if (!state) throw new Error("Account not found");
      const history: RankedMatchRecord[] = [];
      let ratingAfter = state.rating.rating; // walk backwards from the current rating
      for (const row of listRankedHistory(userId, 20)) {
        const viewerIsA = row.user_a === userId;
        const ratingDelta = viewerIsA ? row.delta_a : row.delta_b;
        history.push({
          id: row.id,
          opponentUsername: viewerIsA ? row.username_b : row.username_a,
          result:
            row.winner_user_id === null ? "draw" : row.winner_user_id === userId ? "win" : "loss",
          ratingDelta,
          ratingAfter,
          ts: row.ts,
        });
        ratingAfter -= ratingDelta;
      }
      reply({ ok: true, data: { account: state.account, rating: state.rating, history } });
    });
  });

  // -- saved cubes (authenticated) ------------------------------------------
  socket.on("saveCube", (args, ack) => {
    const reply = once<{ cube: SavedCubeSummary }>(ack);
    guardAsync(reply, async () => {
      const userId = requireUserId(socket);
      const name = String(args?.name ?? "").trim().slice(0, 60) || "Untitled Cube";
      const rankedEligible = Boolean(args?.rankedEligible);
      const listText = String(args?.list ?? "");
      if (countCubesByOwner(userId) >= 30) throw new Error("Cube limit reached (30 per account)");
      const { cards, unresolved } = await resolveCubeList(listText);
      if (countCubesByOwner(userId) >= 30) throw new Error("Cube limit reached (30 per account)");
      const row = insertCube({
        ownerId: userId,
        name,
        listText,
        cards,
        unresolved,
        rankedEligible,
      });
      reply({ ok: true, data: { cube: toSavedCubeSummary(row) } });
      console.log(`cube saved: "${name}" (${row.card_count} cards) for user ${userId}`);
    });
  });

  socket.on("listMyCubes", (ack) => {
    const reply = once<{ cubes: SavedCubeSummary[] }>(ack);
    guard(reply, () => {
      const userId = requireUserId(socket);
      reply({ ok: true, data: { cubes: listCubesByOwner(userId).map(toSavedCubeSummary) } });
    });
  });

  socket.on("deleteCube", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const userId = requireUserId(socket);
      if (!deleteCube(String(args?.cubeId ?? ""), userId)) throw new Error("Cube not found");
      reply({ ok: true });
    });
  });

  socket.on("setCubeRankedEligible", (args, ack) => {
    const reply = once<{ cube: SavedCubeSummary }>(ack);
    guard(reply, () => {
      const userId = requireUserId(socket);
      const row = setCubeRankedEligible(
        String(args?.cubeId ?? ""),
        userId,
        Boolean(args?.rankedEligible)
      );
      if (!row) throw new Error("Cube not found");
      reply({ ok: true, data: { cube: toSavedCubeSummary(row) } });
    });
  });

  socket.on("loadCubeIntoRoom", (args, ack) => {
    const reply = once<{ cardCount: number }>(ack);
    guard(reply, () => {
      const userId = requireUserId(socket);
      const { room, player } = getContext(rooms, socket);
      if (room.ranked) throw new Error("Ranked rooms are server-driven");
      if (player.id !== room.hostId) throw new Error("Only the host can set the cube");
      if (room.phase !== "lobby") throw new Error("The cube can only be changed in the lobby");
      const row = getCubeById(String(args?.cubeId ?? ""));
      if (!row || row.owner_id !== userId) throw new Error("Cube not found");
      room.cube = cubeFromRow(row); // stored resolved JSON — no Scryfall hit
      room.touch();
      reply({ ok: true, data: { cardCount: room.cube.cardIds.length } });
      broadcastRoomState(io, room);
      console.log(`[room ${room.id}] cube "${row.name}" loaded from saved cubes`);
    });
  });

  // -- ranked matchmaking (authenticated) -----------------------------------
  socket.on("queueJoin", (ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const userId = requireUserId(socket);
      const state = accountStateFor(userId);
      if (!state) throw new Error("Account not found");
      queueJoin(userId, state.account.username);
      reply({ ok: true });
    });
  });

  socket.on("queueLeave", (ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const userId = requireUserId(socket);
      queueLeave(userId);
      reply({ ok: true });
    });
  });

  // -- admin portal (authenticated admins only; flag verified per call) -----
  socket.on("adminListSystemCubes", (ack) => {
    const reply = once<{ cubes: SystemCubeSummary[] }>(ack);
    guard(reply, () => {
      requireAdmin(socket);
      reply({ ok: true, data: { cubes: listSystemCubes().map(toSystemCubeSummary) } });
    });
  });

  socket.on("adminUploadSystemCube", (args, ack) => {
    const reply = once<{ cube: SystemCubeSummary }>(ack);
    guardAsync(reply, async () => {
      requireAdmin(socket);
      const name = String(args?.name ?? "").trim().slice(0, 60) || "Untitled Cube";
      const active = Boolean(args?.active);
      const listText = String(args?.list ?? "");
      // Same limits as saveCube (via resolveCubeList) minus the per-owner cap.
      const { cards, unresolved } = await resolveCubeList(listText);
      const row = insertCube({
        ownerId: SYSTEM_OWNER_ID,
        name,
        listText,
        cards,
        unresolved,
        rankedEligible: false, // system cubes are pooled via `active`, not this
        active,
      });
      reply({ ok: true, data: { cube: toSystemCubeSummary(row) } });
      console.log(
        `[admin] system cube uploaded: "${name}" ` +
          `(${row.card_count} cards, ${unresolved.length} unresolved, active=${active})`
      );
    });
  });

  socket.on("adminSetSystemCubeActive", (args, ack) => {
    const reply = once<{ cube: SystemCubeSummary }>(ack);
    guard(reply, () => {
      requireAdmin(socket);
      const row = setCubeActive(String(args?.cubeId ?? ""), Boolean(args?.active));
      if (!row) throw new Error("System cube not found");
      reply({ ok: true, data: { cube: toSystemCubeSummary(row) } });
      console.log(`[admin] system cube "${row.name}" active=${row.active}`);
    });
  });

  socket.on("adminDeleteSystemCube", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      requireAdmin(socket);
      const cubeId = String(args?.cubeId ?? "");
      const cubes = listSystemCubes();
      const target = cubes.find((c) => c.id === cubeId);
      if (!target) throw new Error("System cube not found");
      // The ranked pool must never be empty: deleting the last ACTIVE system
      // cube requires another active system cube or a user-eligible cube.
      if (target.active) {
        const anotherActive = cubes.some((c) => c.id !== cubeId && c.active);
        if (!anotherActive && countUserEligibleCubes() === 0) {
          throw new Error(
            "Cannot delete the last active system cube — the ranked pool would be empty. " +
              "Activate another system cube first."
          );
        }
      }
      if (!deleteCube(cubeId, SYSTEM_OWNER_ID)) throw new Error("System cube not found");
      reply({ ok: true });
      console.log(`[admin] system cube deleted: "${target.name}"`);
    });
  });

  socket.on("adminGetStats", (ack) => {
    const reply = once<{ stats: AdminStats }>(ack);
    guard(reply, () => {
      requireAdmin(socket);
      const stats: AdminStats = {
        users: countUsers(),
        savedCubes: countSavedCubes(),
        rankedMatchesPlayed: countRankedMatches(),
        activeRooms: rooms.size,
        playersInQueue: queueSize(),
        userEligibleCubes: countUserEligibleCubes(),
      };
      reply({ ok: true, data: { stats } });
    });
  });

  socket.on("adminListUsers", (ack) => {
    const reply = once<{ users: AdminUserRow[] }>(ack);
    guard(reply, () => {
      requireAdmin(socket);
      const users: AdminUserRow[] = listUsersWithDetails().map((row) => ({
        id: row.id,
        username: row.username,
        isAdmin: row.is_admin !== 0,
        createdAt: row.created_at,
        online: socketIdsForUser(row.id).size > 0,
        rating: row.rating,
        rank: rankFor(row.rating),
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        savedCubes: row.cube_count,
      }));
      reply({ ok: true, data: { users } });
    });
  });

  socket.on("adminDeleteUser", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const adminId = requireAdmin(socket);
      const userId = String(args?.userId ?? "");
      if (userId === adminId) throw new Error("You cannot delete your own account");
      const target = findUserById(userId);
      if (!target) throw new Error("User not found");
      queueLeave(userId); // pull them out of the matchmaking queue first
      if (!deleteUserCascade(userId)) throw new Error("User not found");
      // Sign out every live socket the deleted account has open. Room seats
      // are left alone: the player simply continues as an anonymous guest.
      for (const socketId of [...socketIdsForUser(userId)]) {
        unbindSocket(socketId);
        io.to(socketId).emit("accountState", null);
      }
      reply({ ok: true });
      console.log(`[admin] user deleted: ${target.username} (${userId})`);
    });
  });

  // -- adminSetUserAdmin (v7.1) --------------------------------------------
  socket.on("adminSetUserAdmin", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const adminId = requireAdmin(socket);
      const userId = String(args?.userId ?? "");
      const isAdmin = Boolean(args?.isAdmin);
      if (userId === adminId && !isAdmin) {
        throw new Error("You cannot revoke your own admin access — ask another admin");
      }
      const target = findUserById(userId);
      if (!target) throw new Error("User not found");
      setUserAdmin(userId, isAdmin);
      // Live sessions learn immediately — no re-login needed.
      const state = accountStateFor(userId);
      if (state) {
        for (const socketId of socketIdsForUser(userId)) {
          io.to(socketId).emit("accountState", state);
        }
      }
      reply({ ok: true });
      console.log(
        `[admin] ${isAdmin ? "granted" : "revoked"} admin for ${target.username} (${userId})` +
          (isAdmin ? "" : " — note: ADMIN_USERNAMES re-grants listed names on next sign-in")
      );
    });
  });

  // -- admin engine sandbox (v4.1; admin verified per call) -----------------
  socket.on("sandboxStart", (ack) => {
    const reply = once<{ roomId: string; playerId: string; token: string }>(ack);
    guard(reply, () => {
      const adminId = requireAdmin(socket);
      const username = findUserById(adminId)?.username ?? "Admin";
      doLeaveRoom(io, rooms, socket);
      const room = new Room(Room.createId(rooms));
      room.sandbox = true;
      rooms.set(room.id, room);
      const player = room.addPlayer(validateName(username), socket.id);
      room.hostId = player.id;
      const phantom = room.addPlayer("Goldfish", "");
      phantom.connected = false;
      phantom.socketId = null;
      socket.data.roomId = room.id;
      socket.data.playerId = player.id;
      socket.join(room.id);
      startSandboxMatchInRoom(io, room, player.id, phantom.id);
      reply({ ok: true, data: { roomId: room.id, playerId: player.id, token: player.token } });
      console.log(`[room ${room.id}] engine sandbox started by ${player.name}`);
    });
  });

  socket.on("sandboxAddCard", (args, ack) => {
    const reply = once<{ cardName: string }>(ack);
    guardAsync(reply, async () => {
      requireAdmin(socket);
      const { room, player } = getContext(rooms, socket);
      if (!room.sandbox) throw new Error("You are not in an engine sandbox");
      const match = [...room.matches.values()].find((m) => !m.game.finished);
      if (!match) throw new Error("The sandbox match is finished — restart the game first");
      const name = String(args?.name ?? "").trim();
      if (name.length < 1 || name.length > 200) throw new Error("Enter a card name");
      const zone = String(args?.zone ?? "hand") as SpawnZone; // engine re-validates
      const targetId = args?.playerId ? String(args.playerId) : player.id;
      if (!match.playerIds.includes(targetId)) {
        throw new Error("The target player is not in the sandbox match");
      }

      const { byName } = await resolveCardNames([name]);
      const card = byName.get(name);
      if (!card) throw new Error(`No card found on Scryfall for "${name}"`);

      // Re-validate after the await: the sandbox may have been torn down.
      if (rooms.get(room.id) !== room || !room.matches.has(match.id)) {
        throw new Error("The sandbox no longer exists");
      }
      registerMatchCard(match, card);
      applyGameActionServer(io, room, match, targetId, { type: "spawnCard", cardId: card.id, zone });
      reply({ ok: true, data: { cardName: card.name } });
      console.log(`[room ${room.id}] sandbox: conjured "${card.name}" into ${zone}`);
    });
  });

  socket.on("sandboxSwitchSeat", (ack) => {
    const reply = once<{ playerId: string; token: string; name: string }>(ack);
    guard(reply, () => {
      requireAdmin(socket);
      const { room, player } = getContext(rooms, socket);
      if (!room.sandbox) throw new Error("You are not in an engine sandbox");
      const next = [...room.players.values()].find((p) => p.id !== player.id);
      if (!next) throw new Error("There is no other seat to switch to");
      player.connected = false;
      player.socketId = null;
      next.connected = true;
      next.socketId = socket.id;
      socket.data.playerId = next.id;
      room.touch();
      reply({ ok: true, data: { playerId: next.id, token: next.token, name: next.name } });
      broadcastRoomState(io, room);
      emitMatchViewsTo(io, room, next.id, socket.id);
      console.log(`[room ${room.id}] sandbox: seat switched to ${next.name}`);
    });
  });

  // -- disconnect -----------------------------------------------------------
  socket.on("disconnect", () => {
    const userId = unbindSocket(socket.id);
    if (userId && socketIdsForUser(userId).size === 0) onUserOffline(userId);

    const { roomId, playerId } = socket.data;
    if (!roomId || !playerId) return;
    const room = rooms.get(roomId);
    const player = room?.players.get(playerId);
    if (!room || !player) return;
    if (player.socketId !== socket.id) return; // an old socket superseded by a reconnect
    player.connected = false;
    player.socketId = null;
    room.touch();
    broadcastRoomState(io, room);
    if (room.ranked) onRankedDisconnect(io, room, playerId);
    console.log(`[room ${room.id}] ${player.name} disconnected`);
  });
}
