/**
 * Server-side draft & match flow shared by the socket handlers (human-driven
 * rooms) and the matchmaker (ranked rooms, server-driven). Hidden information
 * never leaves this module except through getDraftView / buildGameView.
 */
import { nanoid } from "nanoid";
import type { Server, Socket } from "socket.io";
import {
  applyAction,
  applyPick,
  buildGameView,
  createDraft,
  createGame,
  createRng,
  getDraftView,
  openNextPacks,
  runBotPicks,
  shuffle,
} from "@mtg-cube/shared";
import type {
  CardData,
  ClientToServerEvents,
  DraftConfig,
  DraftState,
  GameAction,
  GameCard,
  GameState,
  ServerToClientEvents,
} from "@mtg-cube/shared";
import { getBasicLandCards } from "./scryfall.js";
import { Room } from "./room.js";
import type { Match, StoredDeck } from "./room.js";
import { onRankedDraftComplete, onRankedMatchFinished } from "./matchmaking.js";

export interface SocketData {
  roomId?: string;
  playerId?: string;
}

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Viewer id that matches neither player: buildGameView hides both hands. */
export const SPECTATOR_VIEWER_ID = "$spectator";

// ---------------------------------------------------------------------------
// Emit helpers — the ONLY places views leave the server
// ---------------------------------------------------------------------------

export function broadcastRoomState(io: AppServer, room: Room): void {
  io.to(room.id).emit("roomState", room.toRoomState());
}

function seatNames(room: Room, state: DraftState): (string | null)[] {
  return state.seats.map((s) => (s.playerId ? room.players.get(s.playerId)?.name ?? null : null));
}

/** Emit each human seat its personal DraftView. Never broadcasts full DraftState. */
export function emitDraftViews(io: AppServer, room: Room): void {
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

export function emitDraftViewTo(io: AppServer, room: Room, playerId: string): void {
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
export function emitGameViews(io: AppServer, room: Room, match: Match): void {
  const spectatorView = buildGameView(match.game, SPECTATOR_VIEWER_ID, match.cardLookup);
  for (const player of room.players.values()) {
    if (!player.socketId || !player.connected) continue;
    const view = match.playerIds.includes(player.id)
      ? buildGameView(match.game, player.id, match.cardLookup)
      : spectatorView;
    io.to(player.socketId).emit("gameState", view);
  }
}

/**
 * Re-emit every unfinished match to one (re)joining socket. Finished games are
 * skipped: a reload should land in the room, not back on the game-over banner
 * (results live in RoomState.matches).
 */
export function emitMatchViewsTo(io: AppServer, room: Room, playerId: string, socketId: string): void {
  for (const match of room.matches.values()) {
    if (match.game.finished) continue;
    const viewerId = match.playerIds.includes(playerId) ? playerId : SPECTATOR_VIEWER_ID;
    io.to(socketId).emit("gameState", buildGameView(match.game, viewerId, match.cardLookup));
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
export function advanceDraft(room: Room): void {
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
export function reconcilePickTimers(io: AppServer, room: Room): void {
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
export function performPick(io: AppServer, room: Room, seatIndex: number, instanceId: string): void {
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

export function finishDraft(io: AppServer, room: Room): void {
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
  if (room.ranked) onRankedDraftComplete(io, room);
}

/**
 * Configure and start the draft in a room (host action in casual rooms,
 * matchmaker action in ranked rooms). Throws if the cube is missing/too small.
 */
export function startDraftInRoom(
  io: AppServer,
  room: Room,
  args: { seatCount: number; packsPerPlayer: number; cardsPerPack: number; pickTimerSeconds: number | null }
): void {
  if (room.phase !== "lobby") throw new Error("The draft can only be started from the lobby");
  const cube = room.cube;
  if (!cube) throw new Error("Upload a cube before starting the draft");

  const humans = [...room.players.values()];
  if (humans.length > 8) throw new Error("Too many players for a draft (max 8 seats)");

  const seatCount = Math.max(args.seatCount, humans.length, 2);
  const seed = nanoid(16);
  const config: DraftConfig = {
    seatCount,
    packsPerPlayer: args.packsPerPlayer,
    cardsPerPack: args.cardsPerPack,
    pickTimerSeconds: args.pickTimerSeconds,
    seed,
  };

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
  console.log(
    `[room ${room.id}] draft started${room.ranked ? " (ranked)" : ""}: ${seatCount} seats ` +
      `(${humans.length} human), ${config.packsPerPlayer}x${config.cardsPerPack}, ` +
      `timer ${config.pickTimerSeconds ?? "off"}`
  );
  if (room.draftState?.complete) {
    finishDraft(io, room);
  } else {
    reconcilePickTimers(io, room);
    emitDraftViews(io, room);
    broadcastRoomState(io, room);
  }
}

// ---------------------------------------------------------------------------
// Match construction
// ---------------------------------------------------------------------------

export function makeGameCard(instanceId: string, cardId: string, playerId: string): GameCard {
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

/**
 * Create and start a 1v1 match between two players with submitted decks.
 * Shared by the host's startMatch and ranked auto-start. Returns the match id.
 */
export function startMatchInRoom(io: AppServer, room: Room, idA: string, idB: string): string {
  if (room.phase !== "deckbuild" && room.phase !== "playing") {
    throw new Error("Matches can only start after deckbuilding begins");
  }
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
  emitGameViews(io, room, match);
  broadcastRoomState(io, room);
  console.log(
    `[room ${room.id}] match ${matchId}${room.ranked ? " (ranked)" : ""}: ` +
      `${playerA.name} vs ${playerB.name}`
  );
  return matchId;
}

// ---------------------------------------------------------------------------
// Game actions
// ---------------------------------------------------------------------------

/**
 * Validate + apply a game action through the shared reducer, stamp log
 * timestamps, emit views, and handle finish side effects (incl. ranked Elo).
 * Throws on invalid actions without mutating state.
 */
export function applyGameActionServer(
  io: AppServer,
  room: Room,
  match: Match,
  actorId: string,
  action: GameAction
): void {
  const previousLogLength = match.game.log.length;
  const wasFinished = match.game.finished;

  const cardNames: Record<string, string> = {};
  for (const [id, card] of Object.entries(match.cardLookup)) cardNames[id] = card.name;
  const playerNames: Record<string, string> = {};
  for (const p of room.players.values()) playerNames[p.id] = p.name;
  const next = applyAction(match.game, actorId, action, Date.now(), { cardNames, playerNames });

  // The pure engine can't call Date.now(); stamp new log entries here.
  const now = Date.now();
  for (let i = previousLogLength; i < next.log.length; i++) {
    const entry = next.log[i];
    if (entry) entry.ts = now;
  }

  match.game = next;
  room.touch();
  emitGameViews(io, room, match);
  if (next.finished !== wasFinished && next.finished) {
    if (room.ranked) onRankedMatchFinished(io, room, match); // also broadcasts roomState
    else broadcastRoomState(io, room); // MatchSummary picks up finished/winnerId
    const winner = next.winnerId ? room.players.get(next.winnerId)?.name ?? next.winnerId : "nobody";
    console.log(`[room ${room.id}] match ${match.id} finished; winner: ${winner}`);
  }
}
