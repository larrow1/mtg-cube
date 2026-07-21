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
  /**
   * Admin engine sandbox: instant match vs a phantom opponent where spawnCard
   * is allowed and the admin can drive both seats (v4.1).
   */
  sandbox: boolean;
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

/** One row in the admin portal's user table. */
export interface AdminUserRow {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
  /** Currently connected via at least one authenticated socket. */
  online: boolean;
  rating: number;
  rank: RankTier;
  wins: number;
  losses: number;
  draws: number;
  savedCubes: number;
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
  /** Seconds per pick, "dynamic" = shorter as packs empty, null = no timer. */
  pickTimerSeconds: number | "dynamic" | null;
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
// Card scripts — structured logic for triggered abilities. Scripts come from
// oracle-text inference plus a per-card override registry (shared/cardScripts)
// and are applied by the game engine; unparseable-but-recognized triggers fall
// back to `manual` so nothing is silently missed.
// ---------------------------------------------------------------------------

export type TriggerEvent =
  | "etb" // this card enters the battlefield
  | "dies" // battlefield -> graveyard
  | "leaves" // battlefield -> any other zone (fires for death too unless a dies trigger exists)
  | "upkeep" // beginning of the controller's upkeep
  | "eachUpkeep" // beginning of every upkeep
  | "endStep" // beginning of the controller's end step
  | "attack" // this creature is declared as an attacker
  | "castSpell" // controller casts a spell (moveCard -> stack), see castFilter
  | "combatDamageToPlayer" // combat-damage step begins with this creature attacking and unblocked
  /**
   * v6: an OPPONENT of this permanent's controller draws a card — fired once
   * per card drawn (CR 121.2), EXCEPT the turn-based first draw of their draw
   * step and mulligan/setup draws (Orcish Bowmasters wording; that exemption
   * is part of the event's definition).
   */
  | "opponentDraws";

/** v6: what a targeted effect points at, chosen when the trigger resolves.
 *  v7 adds "stack" — a non-trigger spell on the stack (counterspells). */
export type TargetRef =
  | { kind: "player"; playerId: string }
  | { kind: "permanent"; instanceId: string }
  | { kind: "stack"; instanceId: string };

export type TriggerEffect =
  | { kind: "draw"; count: number }
  | { kind: "gainLife"; amount: number }
  | { kind: "loseLife"; amount: number }
  | { kind: "eachOpponentLosesLife"; amount: number }
  | { kind: "damageOpponent"; amount: number }
  | { kind: "addCounters"; counterType: string; count: number }
  | { kind: "createToken"; name: string; typeLine: string; power?: string; toughness?: string; count: number }
  | { kind: "scry"; count: number }
  /**
   * v6: "deals N damage to any target" (CR 115.4: creature, player,
   * planeswalker, battle). Needs a TargetRef when the trigger resolves —
   * player targets lose life, permanent targets take marked damage.
   */
  | { kind: "damageAnyTarget"; amount: number }
  /**
   * v6: amass <subtype> N (CR 701.47a): create a 0/0 black "<subtype> Army"
   * token if the controller has no Army, then put N +1/+1 counters on an
   * Army they control.
   */
  | { kind: "amass"; subtype: string; count: number }
  /** v6: resolve sub-effects in order; a chosen TargetRef is shared by all. */
  | { kind: "seq"; effects: TriggerEffect[] }
  /** v7: counter target spell — removes a non-trigger entry from the stack
   *  (owner's graveyard; tokens cease). Needs a stack TargetRef. */
  | { kind: "counterTarget" }
  /** Recognized trigger with no automated effect: resolve = log; do it by hand. */
  | { kind: "manual"; note: string };

export interface CardTrigger {
  event: TriggerEvent;
  /** "You may…" triggers can be declined by their controller. */
  optional: boolean;
  /** Human-readable ability text shown on the stack. */
  description: string;
  effect: TriggerEffect;
  /**
   * castSpell only: which casts fire this trigger (default "any").
   * "artifact" was added for the recurring cube pattern "Whenever you cast an
   * artifact spell, ..." (Forensic Gadgeteer, Ravenous Robots, Pinnacle
   * Emissary in the LSV list); it matches type lines containing "Artifact".
   */
  castFilter?: "any" | "instantOrSorcery" | "noncreature" | "creature" | "artifact";
}

/** Which library cards are eligible for a pending search. */
export type SearchFilter =
  | { kind: "basicLand" }
  | { kind: "landSubtype"; subtypes: string[] } // e.g. ["Plains","Island"] for Flooded Strand
  | { kind: "any" };

/** v4: activated abilities, currently scoped to fetch-style library searches. */
export interface ActivatedSearchAbility {
  costTap: boolean;
  costSacrifice: boolean;
  costLife: number;
  description: string;
  filter: SearchFilter;
  destination: "battlefield" | "hand";
  entersTapped: boolean;
  shuffle: boolean;
}

/** Effects applied automatically when an instant/sorcery resolves off the stack. */
export interface SpellResolutionScript {
  effects: TriggerEffect[];
}

export interface CardScript {
  triggers: CardTrigger[];
  activated?: ActivatedSearchAbility[];
  onResolve?: SpellResolutionScript;
}

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
  /**
   * Trigger pseudo-objects: engine-created stack entries representing a
   * triggered ability (not a real card). They only ever live on the stack;
   * resolving applies `triggerEffect`, declining (optional only) removes them.
   */
  isTrigger?: boolean;
  triggerText?: string;
  triggerEffect?: TriggerEffect;
  triggerOptional?: boolean;
  /** instanceId of the permanent whose ability triggered (may have left play). */
  triggerSourceId?: string;
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
  /**
   * A library search in progress (fetch land activation). While set, the
   * searching player may only send completeSearch/concede; their own view
   * reveals their library so the client can present eligible cards.
   */
  pendingSearch?: {
    playerId: string;
    filter: SearchFilter;
    destination: "battlefield" | "hand";
    entersTapped: boolean;
    shuffle: boolean;
    sourceName: string;
  } | null;
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

/** Zones a sandbox-conjured card can be spawned into (v4.1). */
export type SpawnZone = "hand" | "battlefield" | "library" | "graveyard" | "exile" | "stack";

export type GameAction =
  /**
   * v4: free draws are no longer allowed — draws come from the draw step,
   * automated effects, or this action WITH `override: true` (a loudly-logged
   * escape hatch for manually-resolved card text). Without override: rejected.
   */
  | { type: "drawCard"; count?: number; override?: boolean }
  /** Activate an ability (v4: fetch-style searches). Pays costs, then either
   *  finishes immediately or opens a pendingSearch. */
  | { type: "activateAbility"; instanceId: string; abilityIndex: number }
  /** Finish a pendingSearch: chosen library card's instanceId, or null to
   *  fail to find. Only the searching player; library shuffles if the
   *  ability says so. */
  | { type: "completeSearch"; instanceId: string | null }
  /**
   * v5: moving a card from HAND to STACK/BATTLEFIELD is a cast — the engine
   * auto-pays its mana cost (pool first, then auto-tapped sources) and throws
   * when it can't be paid; a front-face Land to the battlefield is a land play
   * checked against one-per-turn (CR 305.2). `override: true` skips the cost
   * payment / allows an additional land drop, loudly logged (alternative
   * costs, cost reducers, extra-land effects).
   */
  | { type: "moveCard"; instanceId: string; from: ZoneName; to: ZoneName; toBottom?: boolean; faceDown?: boolean; override?: boolean }
  | { type: "tapCard"; instanceId: string; tapped: boolean }
  /** Tap a mana source and add `color` to your pool in one validated action
   *  (color must be among the card's producedMana; card must be untapped). */
  | { type: "tapForMana"; instanceId: string; color: string }
  /** Remove an optional ("you may") trigger you control from the stack. */
  | { type: "declineTrigger"; instanceId: string }
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
  /** v6: `target` is required (controller only) when the top of the stack is
   *  a trigger whose effect needs one (effectNeedsTarget). */
  | { type: "resolveTopOfStack"; target?: TargetRef }
  | { type: "counterTopOfStack" }
  | { type: "revealHand" }
  | { type: "scry"; count: number }
  | { type: "reorderLibraryTop"; instanceIds: string[]; toBottom: string[] }
  | { type: "concede" }
  | { type: "endMatch" }
  | { type: "restartGame"; seed: string }
  /**
   * v4.1 admin sandbox only (the server rejects it outside sandbox rooms):
   * conjure a fresh copy of `cardId` (must be present in ctx.cards) into the
   * actor's `zone`. Battlefield spawns fire etb triggers; library = top.
   */
  | { type: "spawnCard"; cardId: string; zone: SpawnZone };

// Server augments every action with actor + seq before applying.
export interface AppliedAction {
  action: GameAction;
  actorId: string;
  seq: number;
}
