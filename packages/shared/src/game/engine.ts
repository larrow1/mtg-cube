/**
 * Game engine — createGame + applyAction, the ONLY way GameState changes.
 *
 * Pure: applyAction deep-clones the incoming state, applies the action, bumps
 * seq, appends log entries, runs state-based checks, and returns the new
 * state. Invalid actions throw EngineError before any observable mutation.
 *
 * Card EFFECTS are manual (players move cards / tap / count) — the engine
 * enforces zone integrity, permissions, turn structure, and loss conditions.
 *
 * Stack semantics (the engine has no CardData, so it cannot inspect
 * typeLines):
 *  - `resolveTopOfStack` pops the top of the stack onto its CONTROLLER's
 *    battlefield (the permanent case).
 *  - `counterTopOfStack` pops the top of the stack into its OWNER's graveyard.
 *  - Instants/sorceries that resolve and finish are handled by the client
 *    sending `moveCard {from:"stack", to:"graveyard"}` (or exile), which is
 *    fully supported.
 */
import type {
  GameAction,
  GameCard,
  GameState,
  PlayerGameState,
  TurnStep,
  ZoneName,
} from "../types.js";
import { TURN_STEPS } from "../types.js";
import { createRng, shuffle } from "../rng.js";

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

const ZONE_NAMES: readonly ZoneName[] = [
  "library",
  "hand",
  "battlefield",
  "graveyard",
  "exile",
  "stack",
  "sideboard",
];

const MANA_COLORS = ["W", "U", "B", "R", "G", "C"] as const;

export interface GamePlayerSetup {
  playerId: string;
  /** The already-built main deck; becomes the shuffled library. */
  deck: GameCard[];
}

/**
 * Optional display-name lookups so log entries read "Lightning Bolt" and
 * "Nissa" instead of raw ids. Purely cosmetic — never affects rules.
 */
export interface ActionContext {
  /** cardId -> card name */
  cardNames?: Record<string, string>;
  /** playerId -> player name */
  playerNames?: Record<string, string>;
}

// Set per applyAction call (synchronous), read by log helpers.
let ctx: ActionContext = {};

function playerLabel(playerId: string): string {
  return ctx.playerNames?.[playerId] ?? playerId;
}

function emptyZones(): Record<ZoneName, GameCard[]> {
  return {
    library: [],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    // Per-player "stack" zone stays empty forever — cards on the stack live
    // in GameState.stack (it is a shared zone). The key exists to satisfy
    // Record<ZoneName, GameCard[]>.
    stack: [],
    sideboard: [],
  };
}

/** Normalize a deck card into a clean library card. */
function freshCard(card: GameCard, ownerId: string): GameCard {
  return {
    ...structuredClone(card),
    ownerId,
    controllerId: ownerId,
    tapped: false,
    faceDown: false,
    faceIndex: 0,
    counters: {},
    attachedTo: null,
    damage: 0,
    attacking: false,
    blocking: null,
    sortIndex: 0,
  };
}

/**
 * Shuffle both libraries, roll the starting player from the seed, draw 7
 * each, life 20. `players[i].deck` is each player's built main deck.
 */
export function createGame(
  id: string,
  players: [GamePlayerSetup, GamePlayerSetup],
  seed: string
): GameState {
  const rng = createRng(seed);
  const states = players.map((p) => {
    const zones = emptyZones();
    zones.library = shuffle(
      p.deck.map((c) => freshCard(c, p.playerId)),
      rng
    );
    zones.hand = zones.library.splice(0, 7);
    const ps: PlayerGameState = {
      playerId: p.playerId,
      life: 20,
      poison: 0,
      manaPool: {},
      zones,
      landsPlayedThisTurn: 0,
      hasLost: false,
    };
    return ps;
  }) as [PlayerGameState, PlayerGameState];

  const startingIndex = rng() < 0.5 ? 0 : 1;
  const startingPlayerId = states[startingIndex]!.playerId;

  return {
    id,
    players: states,
    activePlayerId: startingPlayerId,
    priorityPlayerId: startingPlayerId,
    turnNumber: 1,
    step: "untap",
    stack: [],
    startingPlayerId,
    finished: false,
    winnerId: null,
    seq: 0,
    log: [
      {
        seq: 0,
        playerId: startingPlayerId,
        message: "won the roll and is on the play; both players drew 7",
        ts: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------

/**
 * Apply one action for `actorId`. Pure — throws EngineError on any invalid
 * action without touching the input. `now` is the log timestamp (the server
 * passes Date.now(); defaults to 0).
 */
export function applyAction(
  state: GameState,
  actorId: string,
  action: GameAction,
  now = 0,
  context: ActionContext = {}
): GameState {
  ctx = context;
  const actorIdx = state.players.findIndex((p) => p.playerId === actorId);
  if (actorIdx === -1) throw new EngineError(`Unknown player "${actorId}"`);
  if (state.finished && action.type !== "restartGame") {
    throw new EngineError("The game is finished; only restartGame is allowed");
  }

  const s = structuredClone(state);
  const actor = s.players[actorIdx]!;
  const opponent = s.players[actorIdx === 0 ? 1 : 0]!;
  const logs: string[] = [];

  switch (action.type) {
    case "drawCard": {
      const count = action.count ?? 1;
      if (!Number.isInteger(count) || count < 1) {
        throw new EngineError(`drawCard count must be a positive integer (got ${count})`);
      }
      const drawn = drawCards(actor, count);
      logs.push(`drew ${drawn} card${drawn === 1 ? "" : "s"}`);
      break;
    }

    case "moveCard": {
      applyMoveCard(s, actor, action, logs);
      break;
    }

    case "tapCard": {
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      card.tapped = action.tapped;
      logs.push(`${action.tapped ? "tapped" : "untapped"} ${cardLabel(card)}`);
      break;
    }

    case "untapAll": {
      for (const c of actor.zones.battlefield) c.tapped = false;
      logs.push("untapped all their permanents");
      break;
    }

    case "setLife": {
      if (action.playerId !== actorId) {
        throw new EngineError("You may only set your own life total");
      }
      if (!Number.isInteger(action.life)) {
        throw new EngineError(`life must be an integer (got ${action.life})`);
      }
      actor.life = action.life;
      logs.push(`set their life total to ${action.life}`);
      break;
    }

    case "setPoison": {
      if (action.playerId !== actorId) {
        throw new EngineError("You may only set your own poison counters");
      }
      if (!Number.isInteger(action.poison) || action.poison < 0) {
        throw new EngineError(`poison must be a non-negative integer (got ${action.poison})`);
      }
      actor.poison = action.poison;
      logs.push(`set their poison counters to ${action.poison}`);
      break;
    }

    case "addMana": {
      if (!(MANA_COLORS as readonly string[]).includes(action.color)) {
        throw new EngineError(`Unknown mana color "${action.color}"`);
      }
      if (!Number.isInteger(action.amount) || action.amount === 0) {
        throw new EngineError(`addMana amount must be a non-zero integer (got ${action.amount})`);
      }
      const next = (actor.manaPool[action.color] ?? 0) + action.amount;
      if (next < 0) {
        throw new EngineError(`Cannot remove more ${action.color} mana than is in the pool`);
      }
      if (next === 0) delete actor.manaPool[action.color];
      else actor.manaPool[action.color] = next;
      logs.push(
        action.amount > 0
          ? `added ${action.amount} ${action.color} to their mana pool`
          : `removed ${-action.amount} ${action.color} from their mana pool`
      );
      break;
    }

    case "emptyManaPool": {
      actor.manaPool = {};
      logs.push("emptied their mana pool");
      break;
    }

    case "setCounters": {
      if (!Number.isInteger(action.count) || action.count < 0) {
        throw new EngineError(`counter count must be a non-negative integer (got ${action.count})`);
      }
      const card = findControlled(actor, action.instanceId, ["battlefield", "graveyard", "exile"]);
      if (action.count === 0) delete card.counters[action.counterType];
      else card.counters[action.counterType] = action.count;
      logs.push(`set ${action.counterType} counters on ${cardLabel(card)} to ${action.count}`);
      break;
    }

    case "setDamage": {
      if (!Number.isInteger(action.damage) || action.damage < 0) {
        throw new EngineError(`damage must be a non-negative integer (got ${action.damage})`);
      }
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      card.damage = action.damage;
      logs.push(`set damage on ${cardLabel(card)} to ${action.damage}`);
      break;
    }

    case "attach": {
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      if (action.targetInstanceId === null) {
        card.attachedTo = null;
        logs.push(`detached ${cardLabel(card)}`);
        break;
      }
      if (action.targetInstanceId === action.instanceId) {
        throw new EngineError("A card cannot be attached to itself");
      }
      const target = findOnAnyBattlefield(s, action.targetInstanceId);
      if (!target) {
        throw new EngineError(`Attachment target ${action.targetInstanceId} is not on the battlefield`);
      }
      if (target.attachedTo === card.instanceId) {
        throw new EngineError("Cannot create an attachment loop");
      }
      card.attachedTo = target.instanceId;
      logs.push(`attached ${cardLabel(card)} to ${cardLabel(target)}`);
      break;
    }

    case "createToken": {
      const count = action.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new EngineError(`token count must be an integer between 1 and 100 (got ${count})`);
      }
      const seq = s.seq + 1;
      for (let i = 0; i < count; i++) {
        const token: GameCard = {
          instanceId: count === 1 ? `t${seq}` : `t${seq}_${i}`,
          cardId: "token",
          ownerId: actorId,
          controllerId: actorId,
          tapped: action.tapped ?? false,
          faceDown: false,
          faceIndex: 0,
          counters: {},
          attachedTo: null,
          isToken: true,
          tokenName: action.name,
          tokenTypeLine: action.typeLine,
          damage: 0,
          attacking: false,
          blocking: null,
          sortIndex: actor.zones.battlefield.length,
        };
        if (action.power !== undefined) token.tokenPower = action.power;
        if (action.toughness !== undefined) token.tokenToughness = action.toughness;
        actor.zones.battlefield.push(token);
      }
      logs.push(`created ${count} ${action.name} token${count === 1 ? "" : "s"}`);
      break;
    }

    case "flipCard": {
      if (!Number.isInteger(action.faceIndex) || action.faceIndex < 0) {
        throw new EngineError(`faceIndex must be a non-negative integer (got ${action.faceIndex})`);
      }
      const card = findControlled(actor, action.instanceId, ["battlefield", "hand", "exile", "graveyard"]);
      card.faceIndex = action.faceIndex;
      logs.push(`turned ${cardLabel(card)} to face ${action.faceIndex}`);
      break;
    }

    case "setAttacking": {
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      card.attacking = action.attacking;
      logs.push(`${action.attacking ? "declared" : "removed"} ${cardLabel(card)} as an attacker`);
      break;
    }

    case "setBlocking": {
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      if (action.blocking !== null && !findOnAnyBattlefield(s, action.blocking)) {
        throw new EngineError(`Blocked creature ${action.blocking} is not on the battlefield`);
      }
      card.blocking = action.blocking;
      logs.push(
        action.blocking === null
          ? `removed ${cardLabel(card)} from blocking`
          : `declared ${cardLabel(card)} as a blocker`
      );
      break;
    }

    case "shuffleLibrary": {
      actor.zones.library = shuffle(actor.zones.library, createRng(`${s.id}:shuffle:${s.seq + 1}`));
      logs.push("shuffled their library");
      break;
    }

    case "mulligan": {
      const mullCount =
        s.log.filter((e) => e.playerId === actorId && e.message.startsWith("took a mulligan")).length + 1;
      actor.zones.library.push(...actor.zones.hand.splice(0));
      actor.zones.library = shuffle(actor.zones.library, createRng(`${s.id}:mulligan:${s.seq + 1}`));
      const drawn = drawCards(actor, 7);
      logs.push(`took a mulligan (#${mullCount}) and drew ${drawn}`);
      break;
    }

    case "keepHand": {
      const { bottomCount, bottomInstanceIds } = action;
      if (!Number.isInteger(bottomCount) || bottomCount < 0) {
        throw new EngineError(`bottomCount must be a non-negative integer (got ${bottomCount})`);
      }
      if (bottomInstanceIds.length !== bottomCount) {
        throw new EngineError(
          `keepHand: bottomCount (${bottomCount}) does not match bottomInstanceIds length (${bottomInstanceIds.length})`
        );
      }
      if (new Set(bottomInstanceIds).size !== bottomInstanceIds.length) {
        throw new EngineError("keepHand: duplicate instanceIds");
      }
      for (const id of bottomInstanceIds) {
        const idx = actor.zones.hand.findIndex((c) => c.instanceId === id);
        if (idx === -1) throw new EngineError(`keepHand: ${id} is not in your hand`);
        const [card] = actor.zones.hand.splice(idx, 1);
        if (card) actor.zones.library.push(card);
      }
      logs.push(
        bottomCount === 0
          ? "kept their hand"
          : `kept their hand, putting ${bottomCount} card${bottomCount === 1 ? "" : "s"} on the bottom`
      );
      break;
    }

    case "nextStep": {
      requireActive(s, actorId, "nextStep");
      if (s.step === "cleanup") {
        advanceTurn(s, logs);
      } else {
        const idx = TURN_STEPS.indexOf(s.step);
        const next = TURN_STEPS[idx + 1];
        if (next === undefined) throw new EngineError(`Cannot advance past step "${s.step}"`);
        enterStep(s, next, logs);
      }
      break;
    }

    case "nextTurn": {
      requireActive(s, actorId, "nextTurn");
      advanceTurn(s, logs);
      break;
    }

    case "passPriority": {
      if (s.priorityPlayerId !== actorId) {
        throw new EngineError("You do not have priority");
      }
      s.priorityPlayerId = opponent.playerId;
      logs.push("passed priority");
      break;
    }

    case "resolveTopOfStack": {
      const card = s.stack.pop();
      if (!card) throw new EngineError("The stack is empty");
      const controller = s.players.find((p) => p.playerId === card.controllerId) ?? actor;
      card.sortIndex = controller.zones.battlefield.length;
      controller.zones.battlefield.push(card);
      logs.push(`resolved ${cardLabel(card)} onto the battlefield`);
      break;
    }

    case "counterTopOfStack": {
      const card = s.stack.pop();
      if (!card) throw new EngineError("The stack is empty");
      if (card.isToken) {
        logs.push(`countered ${cardLabel(card)} (token ceased to exist)`);
      } else {
        const owner = s.players.find((p) => p.playerId === card.ownerId) ?? actor;
        resetCardState(card);
        owner.zones.graveyard.push(card);
        logs.push(`countered ${cardLabel(card)}`);
      }
      break;
    }

    case "revealHand": {
      // Log-only in v1: the engine keeps no reveal flag (PlayerGameState has
      // none); clients surface the reveal via the log / a server toast.
      logs.push(`revealed their hand (${actor.zones.hand.length} cards)`);
      break;
    }

    case "scry": {
      if (!Number.isInteger(action.count) || action.count < 1) {
        throw new EngineError(`scry count must be a positive integer (got ${action.count})`);
      }
      // Log-only: the client shows its own top-N and follows up with
      // reorderLibraryTop to commit the new order.
      logs.push(`looked at the top ${action.count} card${action.count === 1 ? "" : "s"} of their library (scry)`);
      break;
    }

    case "reorderLibraryTop": {
      const { instanceIds, toBottom } = action;
      const total = instanceIds.length + toBottom.length;
      if (total < 1) throw new EngineError("reorderLibraryTop: no cards given");
      if (total > actor.zones.library.length) {
        throw new EngineError("reorderLibraryTop: more cards than are in your library");
      }
      const all = [...instanceIds, ...toBottom];
      if (new Set(all).size !== all.length) {
        throw new EngineError("reorderLibraryTop: duplicate instanceIds");
      }
      const top = actor.zones.library.slice(0, total);
      const topIds = new Set(top.map((c) => c.instanceId));
      for (const id of all) {
        if (!topIds.has(id)) {
          throw new EngineError(`reorderLibraryTop: ${id} is not among the top ${total} cards of your library`);
        }
      }
      const byId = new Map(top.map((c) => [c.instanceId, c]));
      const rest = actor.zones.library.slice(total);
      actor.zones.library = [
        ...instanceIds.map((id) => byId.get(id)!),
        ...rest,
        ...toBottom.map((id) => byId.get(id)!),
      ];
      logs.push(
        toBottom.length > 0
          ? `reordered the top of their library (${toBottom.length} to the bottom)`
          : "reordered the top of their library"
      );
      break;
    }

    case "concede": {
      actor.hasLost = true;
      actor.lossReason = "conceded";
      logs.push("conceded the game");
      break;
    }

    case "restartGame": {
      restartGame(s, action.seed, logs);
      break;
    }

    default: {
      // Exhaustiveness guard — new GameAction variants must be handled here.
      const never: never = action;
      throw new EngineError(`Unknown action type ${(never as { type: string }).type}`);
    }
  }

  s.seq += 1;
  for (const message of logs) {
    s.log.push({ seq: s.seq, playerId: actorId, message, ts: now });
  }
  runStateBasedChecks(s, now);
  return s;
}

// ---------------------------------------------------------------------------
// Helpers (all operate on the already-cloned state)
// ---------------------------------------------------------------------------

function cardLabel(card: GameCard): string {
  if (card.isToken && card.tokenName) return `${card.tokenName} token`;
  const name = ctx.cardNames?.[card.cardId];
  return name ?? `a card (${card.instanceId})`;
}

/** Label for a card moving between zones — stays opaque while it is hidden. */
function moveLabel(card: GameCard, from: ZoneName, to: ZoneName): string {
  const hidden = (z: ZoneName) => z === "hand" || z === "library" || z === "sideboard";
  if (hidden(from) && hidden(to)) return "a card";
  return cardLabel(card);
}

function requireActive(s: GameState, actorId: string, what: string): void {
  if (s.activePlayerId !== actorId) {
    throw new EngineError(`Only the active player may use ${what}`);
  }
}

/** Draw up to `count`; drawing from an empty library flags the loss. */
function drawCards(p: PlayerGameState, count: number): number {
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const card = p.zones.library.shift();
    if (!card) {
      p.hasLost = true;
      p.lossReason = "tried to draw from an empty library";
      break;
    }
    p.zones.hand.push(card);
    drawn += 1;
  }
  return drawn;
}

/** Find a card the actor controls in one of the given zones of their own board. */
function findControlled(
  actor: PlayerGameState,
  instanceId: string,
  zones: ZoneName[]
): GameCard {
  for (const zone of zones) {
    const card = actor.zones[zone].find((c) => c.instanceId === instanceId);
    if (card) return card;
  }
  throw new EngineError(
    `Card ${instanceId} was not found in your ${zones.join("/")} (you may only act on cards you own or control)`
  );
}

function findOnAnyBattlefield(s: GameState, instanceId: string): GameCard | undefined {
  for (const p of s.players) {
    const card = p.zones.battlefield.find((c) => c.instanceId === instanceId);
    if (card) return card;
  }
  return undefined;
}

/** Clear battlefield-only state when a card changes zones. */
function resetCardState(card: GameCard): void {
  card.tapped = false;
  card.faceDown = false;
  card.faceIndex = 0;
  card.counters = {};
  card.attachedTo = null;
  card.damage = 0;
  card.attacking = false;
  card.blocking = null;
  card.sortIndex = 0;
}

/** Detach every card that was attached to `instanceId`. */
function detachFrom(s: GameState, instanceId: string): void {
  for (const p of s.players) {
    for (const c of p.zones.battlefield) {
      if (c.attachedTo === instanceId) c.attachedTo = null;
    }
  }
}

function applyMoveCard(
  s: GameState,
  actor: PlayerGameState,
  action: Extract<GameAction, { type: "moveCard" }>,
  logs: string[]
): void {
  const { instanceId, from, to } = action;
  if (!ZONE_NAMES.includes(from)) throw new EngineError(`Unknown zone "${from}"`);
  if (!ZONE_NAMES.includes(to)) throw new EngineError(`Unknown zone "${to}"`);
  if (from === to && from === "battlefield") {
    // In-place face-down/face-up toggle (morph-style); no zone change, no state reset.
    const zone = actor.zones.battlefield;
    const card = zone.find((c) => c.instanceId === instanceId);
    if (!card) {
      throw new EngineError(
        `Card ${instanceId} is not on your battlefield (you may only move cards you own, or tokens you control)`
      );
    }
    if (action.faceDown === undefined) {
      throw new EngineError(`moveCard: from and to are both "${from}"`);
    }
    card.faceDown = action.faceDown;
    logs.push(action.faceDown ? `turned ${cardLabel(card)} face down` : `turned a card face up: ${cardLabel(card)}`);
    return;
  }
  if (from === to && from !== "library") {
    throw new EngineError(`moveCard: from and to are both "${from}"`);
  }

  // Remove the card from exactly the stated `from` zone.
  let card: GameCard;
  if (from === "stack") {
    const idx = s.stack.findIndex((c) => c.instanceId === instanceId);
    if (idx === -1) throw new EngineError(`Card ${instanceId} is not on the stack`);
    const found = s.stack[idx]!;
    if (found.ownerId !== actor.playerId && !(found.isToken && found.controllerId === actor.playerId)) {
      throw new EngineError(`You do not own ${instanceId} (you may only move cards you own, or tokens you control)`);
    }
    s.stack.splice(idx, 1);
    card = found;
  } else {
    const zone = actor.zones[from];
    const idx = zone.findIndex((c) => c.instanceId === instanceId);
    if (idx === -1) {
      throw new EngineError(
        `Card ${instanceId} is not in your ${from} (you may only move cards you own, or tokens you control)`
      );
    }
    card = zone.splice(idx, 1)[0]!;
  }

  const wasOnBattlefield = from === "battlefield";
  if (wasOnBattlefield) detachFrom(s, card.instanceId);

  // Tokens cease to exist anywhere except the battlefield or the stack.
  if (card.isToken && to !== "battlefield" && to !== "stack") {
    logs.push(`moved ${cardLabel(card)} to ${to}; the token ceased to exist`);
    return;
  }

  if (from === "battlefield" || from === "stack") resetCardState(card);
  if (action.faceDown !== undefined) card.faceDown = action.faceDown;

  switch (to) {
    case "stack":
      card.controllerId = actor.playerId;
      s.stack.push(card);
      break;
    case "library":
      if (action.toBottom) actor.zones.library.push(card);
      else actor.zones.library.unshift(card);
      break;
    case "battlefield":
      card.controllerId = actor.playerId;
      card.sortIndex = actor.zones.battlefield.length;
      actor.zones.battlefield.push(card);
      break;
    default:
      actor.zones[to].push(card);
      break;
  }

  const dest = to === "library" ? (action.toBottom ? "the bottom of their library" : "their library") : to;
  logs.push(`moved ${moveLabel(card, from, to)} from ${from} to ${dest}`);
}

/** Advance to the next step within the turn, applying turn-based effects. */
function enterStep(s: GameState, step: TurnStep, logs: string[]): void {
  s.step = step;
  s.priorityPlayerId = s.activePlayerId;
  const active = s.players.find((p) => p.playerId === s.activePlayerId)!;

  if (step === "untap") {
    for (const c of active.zones.battlefield) c.tapped = false;
  } else if (step === "draw") {
    const skipFirstDraw = s.turnNumber === 1 && s.activePlayerId === s.startingPlayerId;
    if (!skipFirstDraw) {
      const drawn = drawCards(active, 1);
      logs.push(`moved to the draw step and drew ${drawn} card${drawn === 1 ? "" : "s"}`);
      return;
    }
  } else if (step === "cleanup") {
    for (const p of s.players) {
      p.manaPool = {};
      for (const c of p.zones.battlefield) c.damage = 0;
    }
  }
  logs.push(`moved to the ${step} step`);
}

/** End the current turn: swap active player, apply untap-step effects. */
function advanceTurn(s: GameState, logs: string[]): void {
  // Cleanup semantics apply even when the turn is ended early via nextTurn.
  for (const p of s.players) {
    p.manaPool = {};
    for (const c of p.zones.battlefield) {
      c.damage = 0;
      c.attacking = false;
      c.blocking = null;
    }
  }

  const current = s.players.find((p) => p.playerId === s.activePlayerId)!;
  const next = s.players.find((p) => p.playerId !== s.activePlayerId)!;
  s.activePlayerId = next.playerId;
  s.priorityPlayerId = next.playerId;
  if (next.playerId === s.startingPlayerId) s.turnNumber += 1;
  current.landsPlayedThisTurn = 0;
  next.landsPlayedThisTurn = 0;

  s.step = "untap";
  for (const c of next.zones.battlefield) c.tapped = false;
  logs.push(`ended their turn; turn ${s.turnNumber}, ${playerLabel(next.playerId)} is now active`);
}

/**
 * Rebuild both libraries from every non-token card each player owns across
 * all zones except sideboard (sideboards are preserved), reshuffle with the
 * new seed, redraw 7, reset life/poison/mana/turn. The starting player flips.
 */
function restartGame(s: GameState, seed: string, logs: string[]): void {
  const rng = createRng(seed);

  // Collect owned, non-token cards from the shared stack first.
  const stackByOwner = new Map<string, GameCard[]>();
  for (const c of s.stack) {
    if (c.isToken) continue;
    const list = stackByOwner.get(c.ownerId) ?? [];
    list.push(c);
    stackByOwner.set(c.ownerId, list);
  }
  s.stack = [];

  for (const p of s.players) {
    const collected: GameCard[] = [];
    for (const zone of ZONE_NAMES) {
      if (zone === "sideboard" || zone === "stack") continue;
      for (const c of p.zones[zone]) {
        if (!c.isToken) collected.push(c);
      }
      p.zones[zone] = [];
    }
    collected.push(...(stackByOwner.get(p.playerId) ?? []));
    for (const c of collected) {
      resetCardState(c);
      c.controllerId = p.playerId;
    }
    p.zones.library = shuffle(collected, rng);
    p.zones.hand = p.zones.library.splice(0, 7);
    p.life = 20;
    p.poison = 0;
    p.manaPool = {};
    p.landsPlayedThisTurn = 0;
    p.hasLost = false;
    delete p.lossReason;
  }

  const newStarter = s.players.find((p) => p.playerId !== s.startingPlayerId)!;
  s.startingPlayerId = newStarter.playerId;
  s.activePlayerId = newStarter.playerId;
  s.priorityPlayerId = newStarter.playerId;
  s.turnNumber = 1;
  s.step = "untap";
  s.finished = false;
  s.winnerId = null;
  logs.push(`restarted the game; ${newStarter.playerId} is on the play`);
}

/** Loss conditions after every action: life <= 0, poison >= 10, empty draw, concede. */
function runStateBasedChecks(s: GameState, now: number): void {
  for (const p of s.players) {
    if (p.hasLost) continue;
    if (p.life <= 0) {
      p.hasLost = true;
      p.lossReason = `life total is ${p.life}`;
    } else if (p.poison >= 10) {
      p.hasLost = true;
      p.lossReason = `has ${p.poison} poison counters`;
    }
  }
  if (s.finished) return;
  const losers = s.players.filter((p) => p.hasLost);
  if (losers.length === 0) return;
  s.finished = true;
  const survivor = s.players.find((p) => !p.hasLost);
  s.winnerId = losers.length === 1 && survivor ? survivor.playerId : null;
  for (const loser of losers) {
    s.log.push({
      seq: s.seq,
      playerId: loser.playerId,
      message: `loses the game (${loser.lossReason ?? "unknown reason"})`,
      ts: now,
    });
  }
  if (s.winnerId) {
    s.log.push({ seq: s.seq, playerId: s.winnerId, message: "wins the game", ts: now });
  }
}
