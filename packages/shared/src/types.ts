/**
 * Core domain types shared by server and client.
 * These are the single source of truth for the whole app.
 */

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type Color = "W" | "U" | "B" | "R" | "G";

export interface CardFace {
  name: string;
  manaCost?: string;
  typeLine: string;
  oracleText?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  imageNormal?: string;
  imageSmall?: string;
}

/** Static card data, resolved from Scryfall once per cube upload. */
export interface CardData {
  /** Scryfall card id. */
  id: string;
  name: string;
  manaCost?: string;
  cmc: number;
  typeLine: string;
  oracleText?: string;
  colors: Color[];
  colorIdentity: Color[];
  power?: string;
  toughness?: string;
  loyalty?: string;
  imageSmall?: string;
  imageNormal?: string;
  layout: string;
  /** Present for double-faced / split / adventure cards. */
  faces?: CardFace[];
  producedMana?: string[];
}

export interface Cube {
  id: string;
  name: string;
  /** Card ids in the cube; duplicates allowed (a cube may run multiples). */
  cardIds: string[];
  /** Lookup table for every distinct card in the cube. */
  cards: Record<string, CardData>;
  /** Lines from the uploaded list that could not be resolved on Scryfall. */
  unresolved: string[];
}

// ---------------------------------------------------------------------------
// Players & rooms
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  id: string;
  name: string;
  connected: boolean;
}

export type RoomPhase = "lobby" | "drafting" | "deckbuild" | "playing";

export interface RoomState {
  id: string;
  hostId: string;
  phase: RoomPhase;
  players: PlayerInfo[];
  cube: { id: string; name: string; cardCount: number; unresolved: string[] } | null;
  draftConfig: DraftConfig;
  /** Player ids that have submitted a deck during deckbuild. */
  decksSubmitted: string[];
  /** Active match pairings: player id -> match id. */
  matches: MatchSummary[];
  /**
   * Ranked rooms are created by the matchmaker and auto-run: no host, forced
   * timers, endMatch disabled, Elo applied on completion.
   */
  ranked: boolean;
}

export interface MatchSummary {
  id: string;
  playerIds: [string, string];
  finished: boolean;
  winnerId?: string | null;
  /** Ranked only: rating change applied per player id when the match ended. */
  ratingDeltas?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Accounts, saved cubes & ranked play
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  username: string;
  createdAt: number;
  /** Admins manage the preloaded ranked cube pool via the admin portal. */
  isAdmin: boolean;
}

/** An admin-managed preloaded cube; active ones form the ranked cube pool. */
export interface SystemCubeSummary {
  id: string;
  name: string;
  cardCount: number;
  unresolvedCount: number;
  active: boolean;
  updatedAt: number;
}

export interface AdminStats {
  users: number;
  savedCubes: number;
  rankedMatchesPlayed: number;
  activeRooms: number;
  playersInQueue: number;
  /** User-owned cubes currently opted into the ranked pool. */
  userEligibleCubes: number;
}

export const RANK_TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Mythic"] as const;
export type RankTier = (typeof RANK_TIERS)[number];

export interface RatingInfo {
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
  rank: RankTier;
}

export interface SavedCubeSummary {
  id: string;
  name: string;
  cardCount: number;
  unresolvedCount: number;
  /** Owner opted this cube into the ranked matchmaking cube pool. */
  rankedEligible: boolean;
  updatedAt: number;
}

export interface RankedMatchRecord {
  id: string;
  opponentUsername: string;
  /** From the viewer's perspective. */
  result: "win" | "loss" | "draw";
  ratingDelta: number;
  ratingAfter: number;
  ts: number;
}

export interface QueueState {
  inQueue: boolean;
  waitSeconds: number;
  /** Current rating search window (± around your rating). */
  windowNow: number;
  playersInQueue: number;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export interface DraftConfig {
  seatCount: number;       // total seats incl. bots (2-8)
  packsPerPlayer: number;  // default 3
  cardsPerPack: number;    // default 15
  /** Seconds per pick, null = no timer. */
  pickTimerSeconds: number | null;
  seed: string;
}

/** A single card instance inside a draft (cube may contain duplicates). */
export interface DraftCard {
  instanceId: string;
  cardId: string;
}

export interface Pack {
  id: string;
  cards: DraftCard[];
}

export interface DraftSeat {
  seatIndex: number;
  /** null until a human claims the seat; bots have null forever. */
  playerId: string | null;
  isBot: boolean;
  picks: DraftCard[];
  /** Packs queued up waiting for this seat (FIFO). Head = current pack. */
  packQueue: Pack[];
}

export interface DraftState {
  id: string;
  config: DraftConfig;
  seats: DraftSeat[];
  /** 1-based index of the current pack round. */
  packNumber: number;
  /** Pack rounds alternate passing direction: odd = left, even = right. */
  complete: boolean;
  /** Packs not yet opened, per seat, for future rounds. */
  unopened: Pack[][];
}

/** What one player is allowed to see of the draft. */
export interface DraftView {
  draftId: string;
  seatIndex: number;
  packNumber: number;
  packsPerPlayer: number;
  cardsPerPack: number;
  /** The pack currently in front of you, null if waiting. */
  currentPack: Pack | null;
  /** How many packs are queued behind the current one. */
  queuedPacks: number;
  picks: DraftCard[];
  /** Per-seat public info: pick counts and queue sizes. */
  seats: { seatIndex: number; playerName: string | null; isBot: boolean; pickCount: number; queuedPacks: number }[];
  complete: boolean;
  pickDeadline: number | null;
}

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

export interface Deck {
  playerId: string;
  /** Card instance ids in the main deck (from picks + basic lands). */
  main: DraftCard[];
  sideboard: DraftCard[];
}

/** Names of basic lands the server always makes available in deckbuild. */
export const BASIC_LAND_NAMES = ["Plains", "Island", "Swamp", "Mountain", "Forest"] as const;

// ---------------------------------------------------------------------------
// Game (1v1 match)
// ---------------------------------------------------------------------------

export type ZoneName =
  | "library"
  | "hand"
  | "battlefield"
  | "graveyard"
  | "exile"
  | "stack"
  | "sideboard";

export const TURN_STEPS = [
  "untap",
  "upkeep",
  "draw",
  "main1",
  "beginCombat",
  "declareAttackers",
  "declareBlockers",
  "combatDamage",
  "endCombat",
  "main2",
  "end",
  "cleanup",
] as const;
export type TurnStep = (typeof TURN_STEPS)[number];

export interface GameCard {
  instanceId: string;
  cardId: string;
  ownerId: string;
  controllerId: string;
  tapped: boolean;
  faceDown: boolean;
  /** Which face of a DFC is showing (0 = front). */
  faceIndex: number;
  counters: Record<string, number>;
  /** instanceId of the permanent this is attached to (auras/equipment). */
  attachedTo: string | null;
  isToken: boolean;
  /** For tokens: display name/stats since they have no CardData. */
  tokenName?: string;
  tokenTypeLine?: string;
  tokenPower?: string;
  tokenToughness?: string;
  /** Marked damage this turn (cleared at cleanup). */
  damage: number;
  attacking: boolean;
  blocking: string | null;
  /** Client-driven ordering hint within a battlefield row. */
  sortIndex: number;
}

export interface PlayerGameState {
  playerId: string;
  life: number;
  poison: number;
  /** Mana pool: color or "C" for colorless. */
  manaPool: Record<string, number>;
  zones: Record<ZoneName, GameCard[]>;
  landsPlayedThisTurn: number;
  hasLost: boolean;
  lossReason?: string;
}

export interface GameState {
  id: string;
  players: [PlayerGameState, PlayerGameState];
  /** Whose turn it is. */
  activePlayerId: string;
  /** Who currently holds priority. */
  priorityPlayerId: string;
  turnNumber: number;
  step: TurnStep;
  /** Cards on the shared stack, top last. */
  stack: GameCard[];
  startingPlayerId: string;
  finished: boolean;
  winnerId: string | null;
  /** Monotonic sequence number: every applied action bumps it. */
  seq: number;
  /** Log of human-readable events for the game log panel. */
  log: GameLogEntry[];
}

export interface GameLogEntry {
  seq: number;
  playerId: string | null;
  message: string;
  ts: number;
}

/**
 * Redacted view sent to each client. Own hand visible; opponent hand and both
 * libraries are counts only (card backs).
 */
export interface GameView {
  gameId: string;
  viewerId: string;
  state: GameState; // with hidden zones replaced by placeholder cards
  /** Card data lookup for everything visible. */
  cards: Record<string, CardData>;
}

// ---------------------------------------------------------------------------
// Game actions — the ONLY way game state changes. Server validates + applies
// through the shared reducer, then broadcasts.
// ---------------------------------------------------------------------------

export type GameAction =
  | { type: "drawCard"; count?: number }
  | { type: "moveCard"; instanceId: string; from: ZoneName; to: ZoneName; toBottom?: boolean; faceDown?: boolean }
  | { type: "tapCard"; instanceId: string; tapped: boolean }
  | { type: "untapAll" }
  | { type: "setLife"; playerId: string; life: number }
  | { type: "setPoison"; playerId: string; poison: number }
  | { type: "addMana"; color: string; amount: number }
  | { type: "emptyManaPool" }
  | { type: "setCounters"; instanceId: string; counterType: string; count: number }
  | { type: "setDamage"; instanceId: string; damage: number }
  | { type: "attach"; instanceId: string; targetInstanceId: string | null }
  | { type: "createToken"; name: string; typeLine: string; power?: string; toughness?: string; count?: number; tapped?: boolean }
  | { type: "flipCard"; instanceId: string; faceIndex: number }
  | { type: "setAttacking"; instanceId: string; attacking: boolean }
  | { type: "setBlocking"; instanceId: string; blocking: string | null }
  | { type: "shuffleLibrary" }
  | { type: "mulligan" }
  | { type: "keepHand"; bottomCount: number; bottomInstanceIds: string[] }
  | { type: "nextStep" }
  | { type: "nextTurn" }
  | { type: "passPriority" }
  | { type: "resolveTopOfStack" }
  | { type: "counterTopOfStack" }
  | { type: "revealHand" }
  | { type: "scry"; count: number }
  | { type: "reorderLibraryTop"; instanceIds: string[]; toBottom: string[] }
  | { type: "concede" }
  | { type: "endMatch" }
  | { type: "restartGame"; seed: string };

// Server augments every action with actor + seq before applying.
export interface AppliedAction {
  action: GameAction;
  actorId: string;
  seq: number;
}
