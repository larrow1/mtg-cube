/**
 * Socket.IO event wiring. Every handler is wrapped so a thrown error acks
 * {ok:false, error} instead of crashing the process. Hidden information never
 * leaves this module except through getDraftView / buildGameView.
 */
import { nanoid } from "nanoid";
import type { Server, Socket } from "socket.io";
import {
  BASIC_LAND_NAMES,
  applyAction,
  applyPick,
  buildGameView,
  createDraft,
  createGame,
  createRng,
  getDraftView,
  normalizeCubeLines,
  openNextPacks,
  parseCubeList,
  runBotPicks,
  shuffle,
} from "@mtg-cube/shared";
import type {
  Ack,
  CardData,
  ClientToServerEvents,
  DraftCard,
  DraftConfig,
  DraftState,
  GameAction,
  GameCard,
  GameState,
  ServerToClientEvents,
} from "@mtg-cube/shared";
import { getBasicLandCards, resolveCardNames } from "./scryfall.js";
import { Room } from "./room.js";
import type { Match, RoomPlayer, StoredDeck } from "./room.js";

export interface SocketData {
  roomId?: string;
  playerId?: string;
}

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Viewer id that matches neither player: buildGameView hides both hands. */
const SPECTATOR_VIEWER_ID = "$spectator";

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

// ---------------------------------------------------------------------------
// Emit helpers — the ONLY places views leave the server
// ---------------------------------------------------------------------------

function broadcastRoomState(io: AppServer, room: Room): void {
  io.to(room.id).emit("roomState", room.toRoomState());
}

function seatNames(room: Room, state: DraftState): (string | null)[] {
  return state.seats.map((s) => (s.playerId ? room.players.get(s.playerId)?.name ?? null : null));
}

/** Emit each human seat its personal DraftView. Never broadcasts full DraftState. */
function emitDraftViews(io: AppServer, room: Room): void {
  const state = room.draftState;
  if (!state) return;
  const names = seatNames(room, state);
  for (const seat of state.seats) {
    if (!seat.playerId) continue;
    const player = room.players.get(seat.playerId);
    if (!player?.socketId) continue;
    const view = getDraftView(state, seat.seatIndex, names, room.getPickDeadline(seat.seatIndex));
    io.to(player.socketId).emit("draftState", view);
  }
}

function emitDraftViewTo(io: AppServer, room: Room, playerId: string): void {
  const state = room.draftState;
  if (!state) return;
  const seatIndex = room.seatIndexOf(playerId);
  if (seatIndex < 0) return;
  const player = room.players.get(playerId);
  if (!player?.socketId) return;
  const view = getDraftView(state, seatIndex, seatNames(room, state), room.getPickDeadline(seatIndex));
  io.to(player.socketId).emit("draftState", view);
}

/** Players in the match get their own view; everyone else a both-hands-hidden one. */
function emitGameViews(io: AppServer, room: Room, match: Match): void {
  const spectatorView = buildGameView(match.game, SPECTATOR_VIEWER_ID, match.cardLookup);
  for (const player of room.players.values()) {
    if (!player.socketId || !player.connected) continue;
    const view = match.playerIds.includes(player.id)
      ? buildGameView(match.game, player.id, match.cardLookup)
      : spectatorView;
    io.to(player.socketId).emit("gameState", view);
  }
}

// ---------------------------------------------------------------------------
// Draft flow
// ---------------------------------------------------------------------------

function draftSignature(state: DraftState): string {
  const picks = state.seats.reduce((n, s) => n + s.picks.length, 0);
  const queued = state.seats.reduce((n, s) => n + s.packQueue.length, 0);
  const unopened = state.unopened.reduce((n, packs) => n + packs.length, 0);
  return `${picks}:${queued}:${unopened}:${state.packNumber}:${state.complete}`;
}

/**
 * Drive the draft forward: let bots pick everything they can, and open the
 * next round's packs whenever every queue is empty. Progress-checked so a
 * misbehaving engine can never hang the server.
 */
function advanceDraft(room: Room): void {
  let state = room.draftState;
  const rng = room.botRng;
  if (!state || !rng) return;
  for (let i = 0; i < 10_000; i++) {
    if (state.complete) break;
    const before = draftSignature(state);
    if (state.seats.every((s) => s.packQueue.length === 0)) {
      if (!state.unopened.some((packs) => packs.length > 0)) break;
      state = openNextPacks(state);
    } else if (state.seats.some((s) => s.isBot && s.packQueue.length > 0)) {
      state = runBotPicks(state, rng, room.cube?.cards);
    } else {
      break; // only humans hold packs; wait for them
    }
    if (draftSignature(state) === before) break;
  }
  room.draftState = state;
}

/** Start/stop per-seat auto-pick timers to match who currently has a pack. */
function reconcilePickTimers(io: AppServer, room: Room): void {
  const state = room.draftState;
  const seconds = state?.config.pickTimerSeconds;
  if (!state || state.complete || room.phase !== "drafting" || !seconds) {
    room.clearAllPickTimers();
    return;
  }
  for (const seat of state.seats) {
    if (seat.isBot || !seat.playerId) {
      room.clearPickTimer(seat.seatIndex);
      continue;
    }
    const waiting = seat.packQueue.length > 0;
    if (waiting && !room.hasPickTimer(seat.seatIndex)) {
      const deadline = Date.now() + seconds * 1000;
      const handle = setTimeout(() => autoPick(io, room, seat.seatIndex), seconds * 1000);
      room.setPickTimer(seat.seatIndex, deadline, handle);
    } else if (!waiting) {
      room.clearPickTimer(seat.seatIndex);
    }
  }
}

/** Timer expiry: pick the first card of the waiting pack for that seat. */
function autoPick(io: AppServer, room: Room, seatIndex: number): void {
  try {
    room.clearPickTimer(seatIndex);
    const state = room.draftState;
    if (!state || state.complete || room.phase !== "drafting") return;
    const seat = state.seats[seatIndex];
    const first = seat?.packQueue[0]?.cards[0];
    if (!seat || seat.isBot || !first) return;
    console.log(`[room ${room.id}] seat ${seatIndex} timed out; auto-picking`);
    performPick(io, room, seatIndex, first.instanceId);
  } catch (err) {
    console.error(`[room ${room.id}] auto-pick failed:`, err);
  }
}

/** Apply one human pick, run bots, open packs, re-emit views, manage timers. */
function performPick(io: AppServer, room: Room, seatIndex: number, instanceId: string): void {
  const state = room.draftState;
  if (!state || room.phase !== "drafting") throw new Error("No draft in progress");
  if (state.complete) throw new Error("The draft is already complete");
  const seat = state.seats[seatIndex];
  if (!seat) throw new Error("Invalid seat");
  const head = seat.packQueue[0];
  if (!head) throw new Error("You have no pack to pick from");
  if (!head.cards.some((c) => c.instanceId === instanceId)) {
    throw new Error("That card is not in your current pack");
  }
  room.draftState = applyPick(state, seatIndex, instanceId);
  room.clearPickTimer(seatIndex);
  advanceDraft(room);
  if (room.draftState?.complete) {
    finishDraft(io, room);
  } else {
    reconcilePickTimers(io, room);
    emitDraftViews(io, room);
  }
}

function finishDraft(io: AppServer, room: Room): void {
  room.clearAllPickTimers();
  const state = room.draftState;
  if (state) {
    for (const seat of state.seats) {
      if (seat.playerId) room.picksByPlayer.set(seat.playerId, seat.picks);
    }
  }
  room.phase = "deckbuild";
  emitDraftViews(io, room);
  broadcastRoomState(io, room);
  console.log(`[room ${room.id}] draft complete; entering deckbuild`);
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

  if (room.players.size === 0) {
    room.clearAllPickTimers();
    rooms.delete(room.id);
    console.log(`[room ${room.id}] empty after explicit leave; removed`);
    return;
  }

  if (room.hostId === playerId) {
    const nextHostId = [...room.players.keys()][0];
    if (nextHostId) {
      room.hostId = nextHostId;
      console.log(`[room ${room.id}] host is now ${room.players.get(nextHostId)?.name}`);
    }
  }
  broadcastRoomState(io, room);
}

// ---------------------------------------------------------------------------
// Match construction
// ---------------------------------------------------------------------------

function makeGameCard(instanceId: string, cardId: string, playerId: string): GameCard {
  return {
    instanceId,
    cardId,
    ownerId: playerId,
    controllerId: playerId,
    tapped: false,
    faceDown: false,
    faceIndex: 0,
    counters: {},
    attachedTo: null,
    isToken: false,
    damage: 0,
    attacking: false,
    blocking: null,
    sortIndex: 0,
  };
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
      if (player) {
        player.connected = true;
        player.socketId = socket.id;
        console.log(`[room ${room.id}] ${player.name} reconnected`);
      } else {
        player = room.addPlayer(validateName(args?.playerName), socket.id);
        console.log(`[room ${room.id}] ${player.name} joined`);
      }
      socket.data.roomId = room.id;
      socket.data.playerId = player.id;
      socket.join(room.id);
      room.touch();
      reply({ ok: true, data: { playerId: player.id, token: player.token } });
      broadcastRoomState(io, room);

      // Re-emit current views so a reconnecting client is fully caught up.
      emitDraftViewTo(io, room, player.id);
      for (const match of room.matches.values()) {
        // Finished games are not re-emitted: a reload should land in the room,
        // not back on the game-over banner (results live in RoomState.matches).
        if (match.game.finished) continue;
        if (match.playerIds.includes(player.id)) {
          io.to(socket.id).emit("gameState", buildGameView(match.game, player.id, match.cardLookup));
        } else if (!match.game.finished) {
          io.to(socket.id).emit("gameState", buildGameView(match.game, SPECTATOR_VIEWER_ID, match.cardLookup));
        }
      }
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
      if (player.id !== room.hostId) throw new Error("Only the host can upload a cube");
      if (room.phase !== "lobby") throw new Error("The cube can only be changed in the lobby");

      const rawList = String(args?.list ?? "");
      if (rawList.length > 500_000) throw new Error("Cube list is too large");
      const cubeName = String(args?.name ?? "").trim().slice(0, 60) || "Untitled Cube";
      const lines = normalizeCubeLines(parseCubeList(rawList));
      if (lines.length === 0) throw new Error("The cube list contains no cards");
      if (lines.length > 2000) throw new Error("Cube list is too large (max 2000 distinct cards)");

      const { byName, unresolved } = await resolveCardNames(lines.map((l) => l.name));

      // Re-validate after the await: the room may have moved on.
      if (rooms.get(room.id) !== room) throw new Error("Room no longer exists");
      if (room.phase !== "lobby") throw new Error("The cube can only be changed in the lobby");

      const cardIds: string[] = [];
      const cards: Record<string, CardData> = {};
      for (const line of lines) {
        const card = byName.get(line.name);
        if (!card) continue;
        cards[card.id] = card;
        for (let i = 0; i < line.count; i++) cardIds.push(card.id);
      }
      room.cube = { id: nanoid(8), name: cubeName, cardIds, cards, unresolved };
      room.touch();
      reply({ ok: true, data: { cardCount: cardIds.length, unresolved } });
      broadcastRoomState(io, room);
      console.log(
        `[room ${room.id}] cube "${cubeName}": ${cardIds.length} cards, ${unresolved.length} unresolved`
      );
    });
  });

  // -- startDraft (host, lobby, cube required) ------------------------------
  socket.on("startDraft", (args, ack) => {
    const reply = once(ack);
    guard(reply, () => {
      const { room, player } = getContext(rooms, socket);
      if (player.id !== room.hostId) throw new Error("Only the host can start the draft");
      if (room.phase !== "lobby") throw new Error("The draft can only be started from the lobby");
      const cube = room.cube;
      if (!cube) throw new Error("Upload a cube before starting the draft");

      const humans = [...room.players.values()];
      if (humans.length > 8) throw new Error("Too many players for a draft (max 8 seats)");

      const seatCount = Math.max(clampInt(args?.seatCount, 2, 8, 8), humans.length, 2);
      const packsPerPlayer = clampInt(args?.packsPerPlayer, 1, 6, 3);
      const cardsPerPack = clampInt(args?.cardsPerPack, 3, 30, 15);
      const rawTimer = args?.pickTimerSeconds;
      const pickTimerSeconds = rawTimer == null ? null : clampInt(rawTimer, 5, 600, 60);
      const seed = nanoid(16);
      const config: DraftConfig = { seatCount, packsPerPlayer, cardsPerPack, pickTimerSeconds, seed };

      let state = createDraft(cube, config); // throws if the cube is too small

      // Seat humans at random (shuffled seat order), bots everywhere else.
      const seatOrder = shuffle(state.seats.map((s) => s.seatIndex), createRng(`${seed}:seats`));
      const assignment = new Map<number, string>();
      humans.forEach((p, i) => {
        const seatIndex = seatOrder[i];
        if (seatIndex !== undefined) assignment.set(seatIndex, p.id);
      });
      state = {
        ...state,
        seats: state.seats.map((seat) => {
          const pid = assignment.get(seat.seatIndex);
          return pid
            ? { ...seat, playerId: pid, isBot: false }
            : { ...seat, playerId: null, isBot: true };
        }),
      };

      room.draftConfig = config;
      room.botRng = createRng(`${seed}:bots`);
      room.draftState = state;
      room.picksByPlayer.clear();
      room.decks.clear();
      room.phase = "drafting";
      advanceDraft(room); // opens round 1 if needed + lets bots pick
      room.touch();
      reply({ ok: true });
      console.log(
        `[room ${room.id}] draft started: ${seatCount} seats (${humans.length} human), ` +
          `${packsPerPlayer}x${cardsPerPack}, timer ${pickTimerSeconds ?? "off"}`
      );
      if (room.draftState?.complete) {
        finishDraft(io, room);
      } else {
        reconcilePickTimers(io, room);
        emitDraftViews(io, room);
        broadcastRoomState(io, room);
      }
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
    });
  });

  // -- startMatch (host) ----------------------------------------------------
  socket.on("startMatch", (args, ack) => {
    const reply = once<{ matchId: string }>(ack);
    guard(reply, () => {
      const { room, player } = getContext(rooms, socket);
      if (player.id !== room.hostId) throw new Error("Only the host can start a match");
      if (room.phase !== "deckbuild" && room.phase !== "playing") {
        throw new Error("Matches can only start after deckbuilding begins");
      }
      const idA = String(args?.playerA ?? "");
      const idB = String(args?.playerB ?? "");
      if (idA === idB) throw new Error("A match needs two different players");
      const playerA = room.players.get(idA);
      const playerB = room.players.get(idB);
      if (!playerA || !playerB) throw new Error("Both players must be in the room");
      const deckA = room.decks.get(idA);
      const deckB = room.decks.get(idB);
      if (!deckA) throw new Error(`${playerA.name} has not submitted a deck`);
      if (!deckB) throw new Error(`${playerB.name} has not submitted a deck`);
      if (room.playerIsInActiveMatch(idA)) throw new Error(`${playerA.name} is already in an active match`);
      if (room.playerIsInActiveMatch(idB)) throw new Error(`${playerB.name} is already in an active match`);

      const basicsByName = new Map(getBasicLandCards().map((c) => [c.name, c]));
      let basicCounter = 0;
      const buildLibrary = (deck: StoredDeck): GameCard[] => {
        const library = deck.main.map((c) => makeGameCard(c.instanceId, c.cardId, deck.playerId));
        for (const [name, count] of Object.entries(deck.basics)) {
          const data = basicsByName.get(name);
          if (!data) continue;
          for (let i = 0; i < count; i++) {
            basicCounter += 1;
            library.push(makeGameCard(`b${basicCounter}`, data.id, deck.playerId));
          }
        }
        if (library.length === 0) {
          throw new Error(`${room.players.get(deck.playerId)?.name ?? "A player"} has an empty deck`);
        }
        return library;
      };
      const libraryA = buildLibrary(deckA);
      const libraryB = buildLibrary(deckB);

      // Lookup limited to cards that can actually appear in this match.
      const cardLookup: Record<string, CardData> = {};
      for (const basic of getBasicLandCards()) cardLookup[basic.id] = basic;
      for (const card of [...libraryA, ...libraryB]) {
        const data = room.cube?.cards[card.cardId];
        if (data) cardLookup[data.id] = data;
      }

      const matchId = nanoid(8);
      const game = createGame(
        matchId,
        [
          { playerId: idA, deck: libraryA },
          { playerId: idB, deck: libraryB },
        ],
        nanoid(16)
      );
      const match: Match = { id: matchId, playerIds: [idA, idB], game, cardLookup };
      room.matches.set(matchId, match);
      room.phase = "playing";
      room.touch();
      reply({ ok: true, data: { matchId } });
      emitGameViews(io, room, match);
      broadcastRoomState(io, room);
      console.log(`[room ${room.id}] match ${matchId}: ${playerA.name} vs ${playerB.name}`);
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

      const previousLogLength = match.game.log.length;
      const wasFinished = match.game.finished;
      let next: GameState;
      try {
        const cardNames: Record<string, string> = {};
        for (const [id, card] of Object.entries(match.cardLookup)) cardNames[id] = card.name;
        const playerNames: Record<string, string> = {};
        for (const p of room.players.values()) playerNames[p.id] = p.name;
        next = applyAction(match.game, player.id, action as GameAction, Date.now(), {
          cardNames,
          playerNames,
        });
      } catch (err) {
        // EngineError (or anything else): reject, keep state, emit nothing.
        reply({ ok: false, error: errorMessage(err) });
        return;
      }

      // The pure engine can't call Date.now(); stamp new log entries here.
      const now = Date.now();
      for (let i = previousLogLength; i < next.log.length; i++) {
        const entry = next.log[i];
        if (entry) entry.ts = now;
      }

      match.game = next;
      room.touch();
      reply({ ok: true });
      emitGameViews(io, room, match);
      if (next.finished !== wasFinished) {
        broadcastRoomState(io, room); // MatchSummary picks up finished/winnerId
        if (next.finished) {
          const winner = next.winnerId ? room.players.get(next.winnerId)?.name ?? next.winnerId : "nobody";
          console.log(`[room ${room.id}] match ${match.id} finished; winner: ${winner}`);
        }
      }
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

  // -- disconnect -----------------------------------------------------------
  socket.on("disconnect", () => {
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
    console.log(`[room ${room.id}] ${player.name} disconnected`);
  });
}
