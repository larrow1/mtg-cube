/**
 * In-memory room state. A Room owns everything for one group of players:
 * lobby roster, cube, draft state (+ pick timers), post-draft picks, decks,
 * and any number of concurrent 1v1 matches.
 */
import { customAlphabet, nanoid } from "nanoid";
import type {
  CardData,
  Cube,
  DraftCard,
  DraftConfig,
  DraftState,
  GameState,
  MatchSummary,
  RoomPhase,
  RoomState,
  Rng,
} from "@mtg-cube/shared";

/** 6-char room codes without ambiguous characters (no I/L/O/0/1). */
const generateRoomCode = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 6);

export interface RoomPlayer {
  id: string;
  name: string;
  /** Reconnect secret; never broadcast, only returned to its owner. */
  token: string;
  connected: boolean;
  socketId: string | null;
}

/** Deck as stored server-side: picks by instance id + basic lands by name count. */
export interface StoredDeck {
  playerId: string;
  main: DraftCard[];
  sideboard: DraftCard[];
  basics: Record<string, number>;
}

export interface Match {
  id: string;
  playerIds: [string, string];
  game: GameState;
  /** CardData for every card that can appear in this match (deck cards + basics). */
  cardLookup: Record<string, CardData>;
  /** Ranked only: Elo change per player id, filled in when the match ends. */
  ratingDeltas?: Record<string, number>;
}

interface PickTimer {
  deadline: number;
  handle: ReturnType<typeof setTimeout>;
}

export const DEFAULT_DRAFT_CONFIG: DraftConfig = {
  seatCount: 8,
  packsPerPlayer: 3,
  cardsPerPack: 15,
  pickTimerSeconds: null,
  seed: "",
};

export class Room {
  readonly id: string;
  hostId = "";
  phase: RoomPhase = "lobby";
  /**
   * Ranked rooms are created by the matchmaker and auto-run: hostId stays "",
   * timers are forced, endMatch/restart are disabled, Elo applies on finish.
   */
  ranked = false;
  readonly players = new Map<string, RoomPlayer>();
  cube: Cube | null = null;
  draftConfig: DraftConfig = { ...DEFAULT_DRAFT_CONFIG };
  draftState: DraftState | null = null;
  /** RNG driving bot picks for the current draft (seeded from the draft seed). */
  botRng: Rng | null = null;
  /** Each human player's final draft picks, filled in when the draft completes. */
  readonly picksByPlayer = new Map<string, DraftCard[]>();
  readonly decks = new Map<string, StoredDeck>();
  readonly matches = new Map<string, Match>();
  private readonly pickTimers = new Map<number, PickTimer>();
  /** Last time anything happened in this room; used for garbage collection. */
  lastActive = Date.now();

  constructor(id: string) {
    this.id = id;
  }

  /** Generate a room code not already present in the registry. */
  static createId(rooms: ReadonlyMap<string, Room>): string {
    for (;;) {
      const id = generateRoomCode();
      if (!rooms.has(id)) return id;
    }
  }

  touch(): void {
    this.lastActive = Date.now();
  }

  // -- players --------------------------------------------------------------

  addPlayer(name: string, socketId: string): RoomPlayer {
    const player: RoomPlayer = {
      id: nanoid(10),
      name: this.uniqueName(name),
      token: nanoid(24),
      connected: true,
      socketId,
    };
    this.players.set(player.id, player);
    this.touch();
    return player;
  }

  findPlayerByToken(token: string): RoomPlayer | undefined {
    if (!token) return undefined;
    for (const player of this.players.values()) {
      if (player.token === token) return player;
    }
    return undefined;
  }

  private uniqueName(base: string): string {
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // -- draft helpers --------------------------------------------------------

  /** Seat index of a player in the current draft, or -1. */
  seatIndexOf(playerId: string): number {
    return this.draftState?.seats.findIndex((s) => s.playerId === playerId) ?? -1;
  }

  // -- pick timers ----------------------------------------------------------

  setPickTimer(seatIndex: number, deadline: number, handle: ReturnType<typeof setTimeout>): void {
    this.clearPickTimer(seatIndex);
    this.pickTimers.set(seatIndex, { deadline, handle });
  }

  clearPickTimer(seatIndex: number): void {
    const timer = this.pickTimers.get(seatIndex);
    if (timer) {
      clearTimeout(timer.handle);
      this.pickTimers.delete(seatIndex);
    }
  }

  clearAllPickTimers(): void {
    for (const timer of this.pickTimers.values()) clearTimeout(timer.handle);
    this.pickTimers.clear();
  }

  hasPickTimer(seatIndex: number): boolean {
    return this.pickTimers.has(seatIndex);
  }

  getPickDeadline(seatIndex: number): number | null {
    return this.pickTimers.get(seatIndex)?.deadline ?? null;
  }

  // -- matches --------------------------------------------------------------

  matchSummaries(): MatchSummary[] {
    return [...this.matches.values()].map((m) => ({
      id: m.id,
      playerIds: m.playerIds,
      finished: m.game.finished,
      winnerId: m.game.winnerId,
      ...(m.ratingDeltas ? { ratingDeltas: m.ratingDeltas } : {}),
    }));
  }

  playerIsInAnyMatch(playerId: string): boolean {
    for (const match of this.matches.values()) {
      if (match.playerIds.includes(playerId)) return true;
    }
    return false;
  }

  playerIsInActiveMatch(playerId: string): boolean {
    for (const match of this.matches.values()) {
      if (!match.game.finished && match.playerIds.includes(playerId)) return true;
    }
    return false;
  }

  // -- redacted summary -----------------------------------------------------

  toRoomState(): RoomState {
    return {
      id: this.id,
      hostId: this.hostId,
      phase: this.phase,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
      })),
      cube: this.cube
        ? {
            id: this.cube.id,
            name: this.cube.name,
            cardCount: this.cube.cardIds.length,
            unresolved: this.cube.unresolved,
          }
        : null,
      draftConfig: this.draftConfig,
      decksSubmitted: [...this.decks.keys()],
      matches: this.matchSummaries(),
      ranked: this.ranked,
    };
  }
}
