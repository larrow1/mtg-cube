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
 * Stack semantics:
 *  - `resolveTopOfStack` pops the top of the stack. Trigger pseudo-cards apply
 *    their effect mechanically. With a `cards` context, a spell whose
 *    front-face type line is Instant/Sorcery goes to its OWNER's graveyard and
 *    applies its script's `onResolve` effects for its CONTROLLER (or logs a
 *    resolve-by-hand reminder when there is no onResolve script). Everything
 *    else (permanents, or any card without card data) lands on its
 *    CONTROLLER's battlefield and fires ETB triggers.
 *  - `counterTopOfStack` pops the top of the stack into its OWNER's graveyard
 *    (triggers are simply removed).
 *  - `moveCard {from:"stack", to:"graveyard"}` (or exile) stays fully
 *    supported as the manual fallback for finishing a spell.
 *
 * v4 restrictions & fetch searches:
 *  - `drawCard` requires `override:true` (loudly logged); the draw step and
 *    scripted draw effects are engine-internal and unaffected.
 *  - `activateAbility` pays a fetch ability's costs atomically (tap, life,
 *    sacrifice — routed through the normal battlefield-departure machinery so
 *    leaves/dies triggers fire) and opens `GameState.pendingSearch`. While a
 *    search is pending its player may ONLY send completeSearch or concede;
 *    the opponent plays on normally; restartGame/endMatch clear it.
 *  - `completeSearch` validates the chosen card against the search filter via
 *    the `cards` context type line (or takes null = fail to find), moves it to
 *    the destination (entersTapped applies on battlefield), shuffles with a
 *    seeded rng, clears pendingSearch, and fires ETB triggers for battlefield
 *    arrivals.
 *
 * Triggered abilities (v9 — the Arena GRE model): primitive mutations emit
 * GameEvents into a transient per-action buffer (zoneChange, draw, discard,
 * stepEntered, attackDeclared, spellCast, becameTapped,
 * combatDamageToPlayer). ONE matching pass at the end of applyAction walks
 * the buffer in order and, for each event, checks the event's subject card's
 * own script first (self conditions — a card that just left the battlefield
 * still sees its own move) and then battlefield permanents (active player's
 * first, sortIndex order) against each trigger's TriggerCondition
 * (`conditionOf`: `when` or the legacy `event` sugar via
 * `conditionForEvent`). Matches push trigger pseudo-cards onto the stack
 * (`isTrigger`, instanceId `tr{seq}-{n}`) — the same stack shape as v3–v8.
 * Preserved rules: dies suppresses leavesBattlefield on a death when both
 * matched; spellCast triggers land ABOVE the cast spell (events precede
 * matching); the draw-step first draw is exempt from exceptDrawStepFirst
 * conditions; mulligan/setup draws emit no events at all.
 * Trigger pseudo-cards only ever live on the stack: resolve applies the
 * effect, counter removes them, declineTrigger (controller + optional only)
 * removes them from any position, restartGame drops them, and moveCard
 * refuses to touch them.
 */
import type {
  CardData,
  CardScript,
  CardTrigger,
  EffectTask,
  EventCardFilter,
  GameAction,
  GameCard,
  GameEvent,
  GameState,
  PlayerGameState,
  SearchFilter,
  SpawnZone,
  TargetRef,
  TriggerCondition,
  TriggerEffect,
  TriggerEvent,
  TurnStep,
  ZoneName,
} from "../types.js";
import { TURN_STEPS } from "../types.js";
import { createRng, shuffle } from "../rng.js";
import {
  describePoolSpend,
  hasInstantSpeed,
  manaSourcesOf,
  parseManaCost,
  parsedCostSize,
  planManaPayment,
} from "./mana.js";

/**
 * v12: TRANSIT steps run themselves — entering one performs its turn-based
 * actions and trigger emission, then auto-advances while the stack stays
 * empty. MANUAL steps (main1, declareAttackers, declareBlockers,
 * combatDamage, main2, end) hold for player decisions.
 */
const TRANSIT_STEPS: ReadonlySet<TurnStep> = new Set([
  "untap",
  "upkeep",
  "draw",
  "beginCombat",
  "endCombat",
  "cleanup",
]);

/**
 * Actions that can empty the stack and so resume a held transit step.
 * passPriority is NOT listed here even though v13's auto-resolve can empty
 * the stack as a side effect of the second pass — unlike the others, most
 * passPriority calls resolve nothing at all (holding priority with an empty
 * stack is the common case), and autoAdvanceTransit would incorrectly fire
 * on every one of them, re-entering the current transit step and resetting
 * priorityPlayerId out from under the pass that just happened. Instead the
 * passPriority case below calls autoAdvanceTransit itself, ONLY when its
 * own auto-resolve actually ran.
 */
const STACK_EMPTYING_ACTIONS: ReadonlySet<GameAction["type"]> = new Set([
  "resolveTopOfStack",
  "counterTopOfStack",
  "declineTrigger",
  "completeSearch",
]);

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
 * Per-action context the server passes alongside every applyAction call.
 * `cardNames`/`playerNames` are cosmetic (log labels); `cards`/`scripts` are
 * rules-relevant: `cards` validates tapForMana against producedMana and
 * `scripts` drives trigger emission. All optional — a context-less engine
 * still enforces every v1 rule, it just emits no triggers and rejects
 * tapForMana.
 */
export interface ActionContext {
  /** cardId -> card name */
  cardNames?: Record<string, string>;
  /** playerId -> player name */
  playerNames?: Record<string, string>;
  /** cardId -> static card data (tapForMana validation). */
  cards?: Record<string, CardData>;
  /** cardId -> triggered-ability script (trigger emission). */
  scripts?: Record<string, CardScript>;
}

// Set per applyAction call (synchronous), read by log helpers.
let ctx: ActionContext = {};

// Per-action counter giving trigger pseudo-cards unique ids `tr{seq}-{n}`
// (seq is unique per action; n disambiguates multiple triggers in one action).
let triggerCounter = 0;

// v9: the per-action GameEvent buffer (the whiteboard's event side). Primitive
// mutations emit events; ONE matching pass at the end of applyAction turns
// them into trigger pseudo-cards on the stack. Transient — never serialized.
let events: GameEvent[] = [];

function emitEvent(e: GameEvent): void {
  events.push(e);
}

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
    priorityPasses: 0,
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
  triggerCounter = 0;
  events = [];
  const actorIdx = state.players.findIndex((p) => p.playerId === actorId);
  if (actorIdx === -1) throw new EngineError(`Unknown player "${actorId}"`);
  if (state.finished && action.type !== "restartGame") {
    throw new EngineError("The game is finished; only restartGame is allowed");
  }
  // A player mid-search is locked to finishing (or conceding); the opponent
  // plays on normally. A finished game is exempt (only restartGame reaches
  // here anyway, and it clears the search).
  if (
    !state.finished &&
    state.pendingSearch &&
    state.pendingSearch.playerId === actorId &&
    action.type !== "completeSearch" &&
    action.type !== "concede"
  ) {
    throw new EngineError("You are searching your library — choose a card (or fail to find) first");
  }

  const s = structuredClone(state);
  const actor = s.players[actorIdx]!;
  const opponent = s.players[actorIdx === 0 ? 1 : 0]!;
  const logs: string[] = [];
  // v11: track consecutive priority passes since the stack's top last changed
  // (CR 117.4). Anything that pushes a new object onto the stack — a cast,
  // a trigger matched by runTriggerMatching below, the admin spawnCard-to-stack
  // path — voids a pending pass sequence; this single diff check covers all
  // of them, checked once runTriggerMatching has had its say (see below).
  const stackLenBefore = s.stack.length;

  switch (action.type) {
    case "drawCard": {
      // v4: free draws are gated. Draws normally come from the draw step or
      // scripted effects (both engine-internal, calling drawCards directly);
      // the override is a loudly-logged escape hatch for manually-resolved
      // card text.
      if (!action.override) {
        throw new EngineError(
          "Draws come from the draw step or card effects. If a manually-resolved card instructs you to draw, use the Draw (manual override) option."
        );
      }
      const count = action.count ?? 1;
      if (!Number.isInteger(count) || count < 1) {
        throw new EngineError(`drawCard count must be a positive integer (got ${count})`);
      }
      const drawn = drawCards(actor, count);
      logs.push(`drew ${drawn} card${drawn === 1 ? "" : "s"} (manual override)`);
      // v9: real draws — drawCards emitted draw events; the matching pass
      // fires observer triggers (opponentDraws et al.), once per card (CR 121.2).
      break;
    }

    case "activateAbility": {
      if (s.pendingSearch) throw new EngineError("A library search is already in progress");
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      const ability = ctx.scripts?.[card.cardId]?.activated?.[action.abilityIndex];
      if (!ability) {
        throw new EngineError(`${cardLabel(card)} has no activated ability to use here`);
      }
      if (ability.costTap && card.tapped) {
        throw new EngineError(`${cardLabel(card)} is already tapped`);
      }
      // Validation done — pay every cost atomically.
      const sourceName = cardLabel(card);
      const costParts: string[] = [];
      if (ability.costTap) {
        card.tapped = true;
        costParts.push("tapping it");
        emitEvent({ kind: "becameTapped", instanceId: card.instanceId, controllerId: card.controllerId });
      }
      if (ability.costLife > 0) {
        actor.life -= ability.costLife;
        costParts.push(`paying ${ability.costLife} life`);
      }
      if (ability.costSacrifice) costParts.push("sacrificing it");
      logs.push(
        `activated ${sourceName}${costParts.length > 0 ? ` (${costParts.join(", ")})` : ""}: ${ability.description}`
      );
      if (ability.costSacrifice) {
        // Route through the normal battlefield-departure machinery so
        // leaves/dies triggers fire exactly like any other death.
        applyMoveCard(
          s,
          actor,
          { type: "moveCard", instanceId: card.instanceId, from: "battlefield", to: "graveyard" },
          logs
        );
      }
      s.pendingSearch = {
        playerId: actorId,
        filter: ability.filter,
        destination: ability.destination,
        entersTapped: ability.entersTapped,
        shuffle: ability.shuffle,
        sourceName,
      };
      break;
    }

    case "completeSearch": {
      const search = s.pendingSearch;
      if (!search) throw new EngineError("No library search is in progress");
      if (search.playerId !== actorId) {
        throw new EngineError("Only the searching player may complete the search");
      }
      let fetched: GameCard | null = null;
      if (action.instanceId !== null) {
        const idx = actor.zones.library.findIndex((c) => c.instanceId === action.instanceId);
        if (idx === -1) {
          throw new EngineError(`Card ${action.instanceId} is not in your library`);
        }
        const card = actor.zones.library[idx]!;
        if (!searchFilterMatches(search.filter, frontTypeLine(card))) {
          throw new EngineError(
            `${cardLabel(card)} does not match the search (${describeSearchFilter(search.filter)})`
          );
        }
        actor.zones.library.splice(idx, 1);
        fetched = card;
      }
      if (fetched) {
        if (search.destination === "battlefield") {
          // v10: the arrival choke point applies the fetch's own tap plus any
          // scripted entersTapped/entersWithCounters replacements, and emits
          // the zoneChange event.
          arriveOnBattlefield(s, fetched, actor, "library", logs, {
            entersTapped: search.entersTapped,
          });
          logs.push(
            `searched their library with ${search.sourceName} and put ${cardLabel(fetched)} onto the battlefield${
              fetched.tapped ? " tapped" : ""
            }`
          );
        } else {
          actor.zones.hand.push(fetched);
          logs.push(
            `searched their library with ${search.sourceName} and put ${cardLabel(fetched)} into their hand`
          );
          emitEvent({
            kind: "zoneChange",
            instanceId: fetched.instanceId,
            cardId: fetched.cardId,
            isToken: false,
            controllerId: actor.playerId,
            from: "library",
            to: "hand",
            died: false,
            ...(typeLineOfCard(fetched) !== undefined ? { typeLine: typeLineOfCard(fetched) } : {}),
          });
        }
      } else {
        logs.push(`searched their library with ${search.sourceName} and failed to find`);
      }
      if (search.shuffle) {
        actor.zones.library = shuffle(actor.zones.library, createRng(`${s.id}:search:${s.seq + 1}`));
        logs.push("shuffled their library");
      }
      s.pendingSearch = null;
      break;
    }

    case "moveCard": {
      applyMoveCard(s, actor, action, logs);
      break;
    }

    case "tapCard": {
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      const wasTapped = card.tapped;
      card.tapped = action.tapped;
      logs.push(`${action.tapped ? "tapped" : "untapped"} ${cardLabel(card)}`);
      if (action.tapped && !wasTapped) {
        emitEvent({ kind: "becameTapped", instanceId: card.instanceId, controllerId: card.controllerId });
      }
      break;
    }

    case "tapForMana": {
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      if (card.tapped) throw new EngineError(`${cardLabel(card)} is already tapped`);
      const produced = ctx.cards?.[card.cardId]?.producedMana;
      if (!produced || produced.length === 0) {
        throw new EngineError(`${cardLabel(card)} is not a mana source`);
      }
      if (!produced.includes(action.color)) {
        throw new EngineError(
          `${cardLabel(card)} cannot produce ${action.color} (produces ${produced.join("/")})`
        );
      }
      card.tapped = true;
      actor.manaPool[action.color] = (actor.manaPool[action.color] ?? 0) + 1;
      logs.push(`tapped ${cardLabel(card)} for {${action.color}}`);
      emitEvent({ kind: "becameTapped", instanceId: card.instanceId, controllerId: card.controllerId });
      break;
    }

    case "declineTrigger": {
      const idx = s.stack.findIndex((c) => c.instanceId === action.instanceId);
      if (idx === -1) throw new EngineError(`Trigger ${action.instanceId} is not on the stack`);
      const trigger = s.stack[idx]!;
      if (!trigger.isTrigger) throw new EngineError("Only triggered abilities can be declined");
      if (trigger.controllerId !== actorId) {
        throw new EngineError("Only the trigger's controller may decline it");
      }
      if (!trigger.triggerOptional) throw new EngineError("That trigger is not optional");
      s.stack.splice(idx, 1);
      logs.push(`declined the optional trigger from ${cardLabel(trigger)}`);
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
      spawnTokens(s, actor, { ...action, count, tapped: action.tapped ?? false }, logs);
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
      // v12 (CR 508.1a/c): attackers are declared in the declare-attackers
      // step, by the active player, and must be untapped; declaring taps the
      // creature unless its text has vigilance.
      if (s.step !== "declareAttackers") {
        throw new EngineError("Attackers are declared during the declare-attackers step (CR 508.1).");
      }
      if (s.activePlayerId !== actorId) {
        throw new EngineError("Only the active player declares attackers (CR 508.1).");
      }
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      const wasAttacking = card.attacking;
      if (action.attacking && !wasAttacking && card.tapped) {
        throw new EngineError(`${cardLabel(card)} is tapped and can't attack (CR 508.1c).`);
      }
      card.attacking = action.attacking;
      logs.push(`${action.attacking ? "declared" : "removed"} ${cardLabel(card)} as an attacker`);
      if (action.attacking && !wasAttacking && !hasVigilance(card)) {
        card.tapped = true;
        logs.push(`${cardLabel(card)} taps as it attacks`);
        emitEvent({ kind: "becameTapped", instanceId: card.instanceId, controllerId: card.controllerId });
      }
      // Attack events fire on declaring only (never on un-declaring, and
      // not again when a redundant setAttacking(true) repeats the state).
      if (action.attacking && !wasAttacking) {
        const firstThisCombat = s.attackDeclaredThisCombat !== true;
        s.attackDeclaredThisCombat = true;
        emitEvent({
          kind: "attackDeclared",
          instanceId: card.instanceId,
          controllerId: card.controllerId,
          firstThisCombat,
        });
      }
      break;
    }

    case "setBlocking": {
      // v12 (CR 509.1a): blockers are declared in the declare-blockers step,
      // by the defending (non-active) player; the blocker must be untapped
      // and the blocked creature must actually be attacking.
      if (s.step !== "declareBlockers") {
        throw new EngineError("Blockers are declared during the declare-blockers step (CR 509.1).");
      }
      if (s.activePlayerId === actorId) {
        throw new EngineError("Only the defending player declares blockers (CR 509.1).");
      }
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      if (action.blocking !== null) {
        if (card.tapped && card.blocking === null) {
          throw new EngineError(`${cardLabel(card)} is tapped and can't block (CR 509.1a).`);
        }
        const blocked = findOnAnyBattlefield(s, action.blocking);
        if (!blocked) {
          throw new EngineError(`Blocked creature ${action.blocking} is not on the battlefield`);
        }
        if (!blocked.attacking) {
          throw new EngineError(`${cardLabel(blocked)} is not attacking — blockers must block an attacker (CR 509.1a).`);
        }
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
      const drawn = drawCards(actor, 7, "silent");
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
      advanceToNextStep(s, logs);
      // v12: flow through transit steps until a manual step or a held trigger.
      autoAdvanceTransit(s, logs);
      break;
    }

    case "nextTurn": {
      requireActive(s, actorId, "nextTurn");
      advanceTurn(s, logs);
      autoAdvanceTransit(s, logs);
      break;
    }

    case "passPriority": {
      if (s.priorityPlayerId !== actorId) {
        throw new EngineError("You do not have priority");
      }
      s.priorityPlayerId = opponent.playerId;
      s.priorityPasses = Math.min(2, s.priorityPasses + 1);
      logs.push("passed priority");
      // v13 (CR 117.4): once both players have passed in succession, the top
      // of the stack resolves automatically — no separate click needed.
      // Exception: an entry still awaiting a FRESH target choice (no
      // chosenTarget from cast time) stops here for its controller to pick.
      if (s.priorityPasses >= 2 && s.stack.length > 0 && !topNeedsFreshTarget(s)) {
        resolveStackTop(s, s.activePlayerId, { type: "resolveTopOfStack" }, logs);
        // v12 integration: if that resolution emptied the stack during a
        // held transit step, resume the auto-advance (see STACK_EMPTYING_ACTIONS
        // — passPriority is deliberately excluded from that blanket set so
        // this only fires when auto-resolve actually did something).
        autoAdvanceTransit(s, logs);
      } else if (
        s.priorityPasses >= 2 &&
        s.stack.length === 0 &&
        !s.finished &&
        !s.pendingSearch &&
        !s.players.some((p) => p.hasLost)
      ) {
        // v14 (CR 500.4/117.5): both players passed with nothing on the
        // stack — the current step/phase ends on its own, no explicit
        // nextStep/nextTurn click required. Mirrors the nextStep action's
        // own advance logic, then lets autoAdvanceTransit chain through any
        // following transit steps exactly as nextStep already does.
        advanceToNextStep(s, logs);
        autoAdvanceTransit(s, logs);
      }
      break;
    }

    case "resolveTopOfStack": {
      if (s.stack.length > 0 && s.priorityPasses < 2) {
        throw new EngineError(
          "Both players must pass priority in succession before the stack resolves (CR 117.4) — pass priority first"
        );
      }
      resolveStackTop(s, actorId, action, logs);
      break;
    }

    case "counterTopOfStack": {
      // v13: NOT gated on priorityPasses — this is a manual house-rule
      // escape hatch with no dedicated button (like declineTrigger), not a
      // CR-modeled player action. Gating it the same as resolveTopOfStack
      // would make it unreachable: a non-targeted top now auto-resolves the
      // instant both players pass (see passPriority), so a counter attempt
      // must be usable before that point too.
      const card = s.stack.pop();
      if (!card) throw new EngineError("The stack is empty");
      // v11 (CR 117.5): the active player receives priority after a resolution.
      s.priorityPasses = 0;
      s.priorityPlayerId = s.activePlayerId;
      if (card.isTrigger) {
        // Triggers are pseudo-cards: countering one simply removes it.
        logs.push(`countered the triggered ability from ${cardLabel(card)}`);
      } else if (card.isToken) {
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

    case "endMatch": {
      // Friendly abandon: either player may end the game with no result.
      s.finished = true;
      s.winnerId = null;
      s.pendingSearch = null;
      logs.push("ended the match (no result)");
      break;
    }

    case "restartGame": {
      restartGame(s, action.seed, logs);
      break;
    }

    case "spawnCard": {
      // v4.1 admin sandbox: conjure a fresh copy of a known card into one of
      // the actor's zones. The SERVER gates this to sandbox rooms; the engine
      // just requires the card data to exist so the spawn is never a blind id.
      if (!ctx.cards?.[action.cardId]) {
        throw new EngineError(`Cannot spawn unknown card "${action.cardId}" (no card data)`);
      }
      const allowed: readonly SpawnZone[] = ["hand", "battlefield", "library", "graveyard", "exile", "stack"];
      if (!allowed.includes(action.zone)) {
        throw new EngineError(`Cannot spawn a card into zone "${action.zone}"`);
      }
      const card: GameCard = {
        instanceId: `sb${s.seq + 1}`,
        cardId: action.cardId,
        ownerId: actor.playerId,
        controllerId: actor.playerId,
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
      if (action.zone === "stack") {
        s.stack.push(card);
      } else if (action.zone === "battlefield") {
        arriveOnBattlefield(s, card, actor, null, logs);
      } else if (action.zone === "library") {
        actor.zones.library.unshift(card); // top of the library
      } else {
        actor.zones[action.zone].push(card);
      }
      const dest = action.zone === "library" ? "the top of their library" : `their ${action.zone}`;
      logs.push(`conjured ${cardLabel(card)} into ${dest} (sandbox)`);
      break;
    }

    default: {
      // Exhaustiveness guard — new GameAction variants must be handled here.
      const never: never = action;
      throw new EngineError(`Unknown action type ${(never as { type: string }).type}`);
    }
  }

  // v9: the matching pass — buffered events become trigger pseudo-cards.
  runTriggerMatching(s, logs);
  // v11 (priority): anything that grew the stack during this action — a cast,
  // or a trigger matched just above — voids a pending priority-pass sequence
  // (CR 117.4).
  if (s.stack.length > stackLenBefore) s.priorityPasses = 0;

  // v12: a stack-emptying action during a held transit step resumes the
  // auto-advance (its own events were just matched — anything they pushed
  // onto the stack holds the step again). passPriority is included because
  // v13's own auto-resolve (above) can empty the stack as a side effect of
  // the second pass, not just an explicit resolve/counter/decline/search.
  if (STACK_EMPTYING_ACTIONS.has(action.type)) {
    autoAdvanceTransit(s, logs);
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
  const name = ctx.cardNames?.[card.cardId] ?? ctx.cards?.[card.cardId]?.name;
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

/**
 * Draw up to `count`; drawing from an empty library flags the loss.
 * v9: emits one draw GameEvent PER CARD (CR 121.2). `kind` controls emission:
 * "effect" = ordinary draws (override action, scripted effects); "drawStep" =
 * the turn-based draw (its first card carries drawStepFirst for the
 * Bowmasters-style exemption); "silent" = mulligan/setup draws (no events —
 * same exemption as pre-v9).
 */
function drawCards(
  p: PlayerGameState,
  count: number,
  kind: "effect" | "drawStep" | "silent" = "effect"
): number {
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
    if (kind !== "silent") {
      emitEvent({
        kind: "draw",
        playerId: p.playerId,
        drawStepFirst: kind === "drawStep" && i === 0,
      });
    }
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
  delete card.chosenTarget; // a cast-time target dies with the stack entry
}

/**
 * v10: THE battlefield-arrival choke point. Every path that puts a card onto
 * the battlefield (moveCard, resolveTopOfStack, completeSearch, spawnCard)
 * routes through here: the card's own replacement rules apply (entersTapped,
 * entersWithCounters — skipped for face-down arrivals, whose identity is
 * hidden), sortIndex is assigned, the card is pushed, and the zoneChange
 * event is emitted for the matching pass. `entersTapped` in opts is a
 * caller-supplied tap (fetch-land "onto the battlefield tapped").
 */
function arriveOnBattlefield(
  s: GameState,
  card: GameCard,
  controller: PlayerGameState,
  from: ZoneName | null,
  logs: string[],
  opts?: { entersTapped?: boolean }
): void {
  card.controllerId = controller.playerId;
  let tapped = opts?.entersTapped === true || card.tapped;
  const script = card.isToken || card.faceDown ? undefined : ctx.scripts?.[card.cardId];
  for (const r of script?.replacements ?? []) {
    if (r.kind === "entersTapped") {
      if (!tapped) {
        tapped = true;
        logs.push(`${cardLabel(card)} enters the battlefield tapped`);
      }
    } else if (r.kind === "entersWithCounters") {
      card.counters[r.counterType] = (card.counters[r.counterType] ?? 0) + r.count;
      logs.push(
        `${cardLabel(card)} enters with ${r.count} ${r.counterType} counter${r.count === 1 ? "" : "s"}`
      );
    }
  }
  card.tapped = tapped;
  card.sortIndex = controller.zones.battlefield.length;
  controller.zones.battlefield.push(card);
  emitEvent({
    kind: "zoneChange",
    instanceId: card.instanceId,
    cardId: card.cardId,
    isToken: card.isToken,
    controllerId: controller.playerId,
    from,
    to: "battlefield",
    died: false,
    ...(typeLineOfCard(card) !== undefined ? { typeLine: typeLineOfCard(card) } : {}),
  });
}

/** Detach every card that was attached to `instanceId`. */
function detachFrom(s: GameState, instanceId: string): void {
  for (const p of s.players) {
    for (const c of p.zones.battlefield) {
      if (c.attachedTo === instanceId) c.attachedTo = null;
    }
  }
}

/**
 * Create `count` tokens on `owner`'s battlefield. Shared by the createToken
 * action and token-creating trigger effects; ids `t{seq}` / `t{seq}_{i}` are
 * unique because seq is unique per action and at most one token batch is
 * created per action.
 */
function spawnTokens(
  s: GameState,
  owner: PlayerGameState,
  opts: { name: string; typeLine: string; power?: string; toughness?: string; count: number; tapped: boolean },
  logs: string[],
  logPrefix = ""
): void {
  const seq = s.seq + 1;
  for (let i = 0; i < opts.count; i++) {
    const token: GameCard = {
      instanceId: opts.count === 1 ? `t${seq}` : `t${seq}_${i}`,
      cardId: "token",
      ownerId: owner.playerId,
      controllerId: owner.playerId,
      tapped: opts.tapped,
      faceDown: false,
      faceIndex: 0,
      counters: {},
      attachedTo: null,
      isToken: true,
      tokenName: opts.name,
      tokenTypeLine: opts.typeLine,
      damage: 0,
      attacking: false,
      blocking: null,
      sortIndex: owner.zones.battlefield.length,
    };
    if (opts.power !== undefined) token.tokenPower = opts.power;
    if (opts.toughness !== undefined) token.tokenToughness = opts.toughness;
    owner.zones.battlefield.push(token);
    // v9: token arrivals are events too — "whenever another creature you
    // control enters" observers see them (nontoken filters exclude them).
    emitEvent({
      kind: "zoneChange",
      instanceId: token.instanceId,
      cardId: token.cardId,
      isToken: true,
      controllerId: owner.playerId,
      from: null,
      to: "battlefield",
      died: false,
      typeLine: opts.typeLine,
    });
  }
  logs.push(`${logPrefix}created ${opts.count} ${opts.name} token${opts.count === 1 ? "" : "s"}`);
}

/**
 * v9: normalize a legacy TriggerEvent into a declarative TriggerCondition.
 * Every pre-v9 script keeps its meaning; new scripts may set `when` directly.
 */
export function conditionForEvent(
  event: TriggerEvent,
  castFilter?: CardTrigger["castFilter"]
): TriggerCondition {
  switch (event) {
    case "etb":
      return { on: "zoneChange", which: "self", move: "entersBattlefield" };
    case "dies":
      return { on: "zoneChange", which: "self", move: "dies" };
    case "leaves":
      return { on: "zoneChange", which: "self", move: "leavesBattlefield" };
    case "upkeep":
      return { on: "stepEntered", step: "upkeep", whose: "yours" };
    case "eachUpkeep":
      return { on: "stepEntered", step: "upkeep", whose: "each" };
    case "endStep":
      return { on: "stepEntered", step: "end", whose: "yours" };
    case "attack":
      return { on: "attackDeclared", which: "self" };
    case "castSpell":
      return { on: "spellCast", caster: "you", ...(castFilter !== undefined ? { castFilter } : {}) };
    case "combatDamageToPlayer":
      return { on: "combatDamageToPlayer", which: "self" };
    case "opponentDraws":
      return { on: "draw", who: "opponent", exceptDrawStepFirst: true };
  }
}

/** The condition a trigger actually matches on (`when` wins over legacy `event`). */
export function conditionOf(t: CardTrigger): TriggerCondition {
  return t.when ?? conditionForEvent(t.event, t.castFilter);
}

/** Does an event's card satisfy an EventCardFilter? Unknown type lines never match. */
function eventCardFilterMatches(
  filter: EventCardFilter | undefined,
  isToken: boolean,
  typeLine: string | undefined
): boolean {
  if (!filter) return true;
  if (filter.nontoken && isToken) return false;
  const words = [...(filter.types ?? []), ...(filter.subtype ? [filter.subtype] : [])];
  if (words.length === 0) return true;
  if (typeLine === undefined) return false; // unknowable — never guess
  return words.every((w) =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(typeLine)
  );
}

/**
 * Does `cond` on an observer card match GameEvent `e`? `which`/"you" are
 * relative to the observer (the card whose script holds the trigger).
 */
function conditionMatches(
  cond: TriggerCondition,
  e: GameEvent,
  observer: GameCard,
  observerControllerId: string
): boolean {
  switch (cond.on) {
    case "zoneChange": {
      if (e.kind !== "zoneChange") return false;
      const isSelf = e.instanceId === observer.instanceId;
      if (cond.which === "self" && !isSelf) return false;
      if (cond.which === "other" && isSelf) return false;
      if (cond.move === "entersBattlefield") {
        if (e.to !== "battlefield") return false;
      } else if (cond.move === "dies") {
        if (!e.died) return false;
      } else {
        // leavesBattlefield covers every departure, death included (the
        // dies-suppresses-leaves rule is applied by the matching pass).
        if (e.from !== "battlefield") return false;
      }
      if (cond.controller === "you" && e.controllerId !== observerControllerId) return false;
      if (cond.controller === "opponent" && e.controllerId === observerControllerId) return false;
      return eventCardFilterMatches(cond.card, e.isToken, e.typeLine);
    }
    case "stepEntered": {
      if (e.kind !== "stepEntered" || e.step !== cond.step) return false;
      if (cond.whose === "yours") return e.activePlayerId === observerControllerId;
      if (cond.whose === "opponents") return e.activePlayerId !== observerControllerId;
      return true;
    }
    case "attackDeclared": {
      if (e.kind !== "attackDeclared") return false;
      if (cond.which === "self") return e.instanceId === observer.instanceId;
      // team = "whenever you attack": once per combat, on the first declaration.
      return e.controllerId === observerControllerId && e.firstThisCombat;
    }
    case "spellCast": {
      if (e.kind !== "spellCast") return false;
      if (cond.caster === "you" && e.casterId !== observerControllerId) return false;
      if (cond.caster === "opponent" && e.casterId === observerControllerId) return false;
      return castFilterMatches(cond.castFilter, e.typeLine);
    }
    case "draw": {
      if (e.kind !== "draw") return false;
      if (cond.who === "you" && e.playerId !== observerControllerId) return false;
      if (cond.who === "opponent" && e.playerId === observerControllerId) return false;
      if (cond.exceptDrawStepFirst && e.drawStepFirst) return false;
      return true;
    }
    case "discard":
      return e.kind === "discard" && e.playerId === observerControllerId;
    case "becameTapped":
      return e.kind === "becameTapped" && e.instanceId === observer.instanceId;
    case "combatDamageToPlayer":
      return e.kind === "combatDamageToPlayer" && e.instanceId === observer.instanceId;
  }
}

/** Find a real card anywhere in the game (all zones of both players + stack). */
function findCardAnywhere(s: GameState, instanceId: string): GameCard | undefined {
  for (const c of s.stack) if (c.instanceId === instanceId) return c;
  for (const p of s.players) {
    for (const zone of ZONE_NAMES) {
      const card = p.zones[zone].find((c) => c.instanceId === instanceId);
      if (card) return card;
    }
  }
  return undefined;
}

/** Build + push one trigger pseudo-card onto the stack (shape unchanged since v3). */
function pushTriggerCard(
  s: GameState,
  source: GameCard,
  controllerId: string,
  t: CardTrigger,
  logs: string[]
): void {
  const trigger: GameCard = {
    instanceId: `tr${s.seq + 1}-${triggerCounter++}`,
    // cardId points at the SOURCE card so clients can render its image.
    cardId: source.cardId,
    ownerId: controllerId,
    controllerId,
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
    isTrigger: true,
    triggerText: t.description,
    triggerEffect: t.effect,
    triggerOptional: t.optional,
    triggerSourceId: source.instanceId,
  };
  s.stack.push(trigger);
  logs.push(`trigger from ${cardLabel(source)} went on the stack: "${t.description}"`);
}

/**
 * v9: THE matching pass. Walks the per-action event buffer in order; for each
 * event checks (1) the event's subject card's own script (wherever the card
 * now is — a card that just left the battlefield still sees its own move),
 * then (2) battlefield permanents (active player's first, sortIndex order).
 * Matching triggers push pseudo-cards exactly like the old per-site emission.
 * Preserved rule: on a death, a script whose dies condition matched fires only
 * dies — its matching leavesBattlefield conditions are suppressed.
 */
function runTriggerMatching(s: GameState, logs: string[]): void {
  const buffered = events;
  events = [];
  if (!ctx.scripts || buffered.length === 0) return;

  const active = s.players.find((p) => p.playerId === s.activePlayerId);
  const inactive = s.players.find((p) => p.playerId !== s.activePlayerId);
  for (const e of buffered) {
    const candidates: GameCard[] = [];
    if (e.kind === "zoneChange") {
      const subject = findCardAnywhere(s, e.instanceId);
      if (subject) candidates.push(subject);
    }
    for (const p of [active, inactive]) {
      if (!p) continue;
      const sorted = [...p.zones.battlefield].sort((a, b) => a.sortIndex - b.sortIndex);
      for (const c of sorted) {
        if (!candidates.some((x) => x.instanceId === c.instanceId)) candidates.push(c);
      }
    }
    for (const cand of candidates) {
      if (cand.isToken || cand.isTrigger) continue;
      const script = ctx.scripts[cand.cardId];
      if (!script) continue;
      const matched = script.triggers.filter((t) =>
        conditionMatches(conditionOf(t), e, cand, cand.controllerId)
      );
      if (matched.length === 0) continue;
      const diesMatched = matched.some((t) => {
        const c2 = conditionOf(t);
        return c2.on === "zoneChange" && c2.move === "dies";
      });
      for (const t of matched) {
        const c2 = conditionOf(t);
        if (
          diesMatched &&
          e.kind === "zoneChange" &&
          e.died &&
          c2.on === "zoneChange" &&
          c2.move === "leavesBattlefield"
        ) {
          continue; // dies suppresses leaves on death (no double-fire)
        }
        pushTriggerCard(s, cand, cand.controllerId, t, logs);
      }
    }
  }
}

/** Throw unless `target` is a currently-legal target of an allowed kind. */
function validateTarget(s: GameState, target: TargetRef, allowedKinds: TargetRef["kind"][]): void {
  if (allowedKinds.length > 0 && !allowedKinds.includes(target.kind)) {
    throw new EngineError(
      `That effect targets ${allowedKinds.join("/")} — a ${target.kind} is not a legal target`
    );
  }
  if (target.kind === "player") {
    const pid = target.playerId;
    if (!s.players.some((p) => p.playerId === pid)) {
      throw new EngineError(`Unknown target player "${pid}"`);
    }
  } else if (target.kind === "stack") {
    const targetId = target.instanceId;
    const spell = s.stack.find((c) => c.instanceId === targetId);
    if (!spell) throw new EngineError(`Target ${targetId} is not on the stack`);
    if (spell.isTrigger) {
      throw new EngineError("Only spells can be targeted on the stack");
    }
  } else if (!findOnAnyBattlefield(s, target.instanceId)) {
    throw new EngineError(`Target ${target.instanceId} is not on the battlefield`);
  }
}

/** Is a previously-chosen target still legal (CR 608.2b re-check)? */
function targetStillLegal(s: GameState, target: TargetRef): boolean {
  if (target.kind === "player") return s.players.some((p) => p.playerId === target.playerId);
  if (target.kind === "stack") {
    const spell = s.stack.find((c) => c.instanceId === target.instanceId);
    return spell !== undefined && spell.isTrigger !== true;
  }
  return findOnAnyBattlefield(s, target.instanceId) !== undefined;
}

/** Human-readable label for a target, for cast/stack logs. */
function targetLabel(s: GameState, target: TargetRef): string {
  if (target.kind === "player") return playerLabel(target.playerId);
  const card =
    target.kind === "stack"
      ? s.stack.find((c) => c.instanceId === target.instanceId)
      : findOnAnyBattlefield(s, target.instanceId);
  return card ? cardLabel(card) : target.instanceId;
}

/** Does an effect (recursing seq) require a TargetRef to resolve? */
export function effectNeedsTarget(effect: TriggerEffect | undefined): boolean {
  if (!effect) return false;
  if (effect.kind === "damageAnyTarget" || effect.kind === "counterTarget") return true;
  if (effect.kind === "seq") return effect.effects.some((e) => effectNeedsTarget(e));
  return false;
}

/** Which TargetRef kinds satisfy this effect (recursing seq)? */
export function effectTargetKinds(effect: TriggerEffect | undefined): TargetRef["kind"][] {
  if (!effect) return [];
  if (effect.kind === "damageAnyTarget") return ["player", "permanent"];
  if (effect.kind === "counterTarget") return ["stack"];
  if (effect.kind === "seq") {
    const kinds = new Set<TargetRef["kind"]>();
    for (const sub of effect.effects) {
      for (const k of effectTargetKinds(sub)) kinds.add(k);
    }
    return [...kinds];
  }
  return [];
}

/**
 * v11: resolve the TargetRef for an effect at resolution time — shared by
 * trigger resolution and instant/sorcery resolution (Lightning Bolt,
 * Counterspell). If the effect needs a target: a FRESH `action.target`
 * requires the actor to be `controllerId` (they choose it); a cast-time
 * `chosenTarget` (v8) resolves for EITHER player, fizzling (logged) if it's
 * no longer legal (CR 608.2b); with neither, only the controller may act,
 * and they must supply one.
 */
function resolveEffectTarget(
  s: GameState,
  effect: TriggerEffect | undefined,
  chosenTarget: TargetRef | undefined,
  controllerId: string,
  actorId: string,
  action: Extract<GameAction, { type: "resolveTopOfStack" }>,
  label: string,
  logs: string[]
): TargetRef | undefined {
  if (!effectNeedsTarget(effect)) return undefined;
  if (action.target) {
    if (controllerId !== actorId) {
      throw new EngineError("Only its controller may resolve it (they choose its target)");
    }
    validateTarget(s, action.target, effectTargetKinds(effect));
    return action.target;
  }
  if (chosenTarget) {
    if (targetStillLegal(s, chosenTarget)) return chosenTarget;
    logs.push(`the chosen target for ${label} is gone — the effect fizzles (CR 608.2b)`);
    return undefined;
  }
  if (controllerId !== actorId) {
    throw new EngineError("Only its controller may resolve it (they choose its target)");
  }
  throw new EngineError(`${label} needs a target — choose a creature, player, or other permanent`);
}

/**
 * Apply a resolving trigger's effect for its CONTROLLER (not the actor —
 * either player may click resolve, except targeted triggers, which only the
 * controller resolves). State-based checks after the action pick up any
 * resulting loss.
 */
function resolveTrigger(
  s: GameState,
  trigger: GameCard,
  logs: string[],
  actorId: string,
  action: Extract<GameAction, { type: "resolveTopOfStack" }>
): void {
  const controller = s.players.find((p) => p.playerId === trigger.controllerId);
  const opponent = s.players.find((p) => p.playerId !== trigger.controllerId);
  if (!controller || !opponent) {
    logs.push(`a trigger from ${cardLabel(trigger)} resolved with no effect (unknown controller)`);
    return;
  }
  const effect = trigger.triggerEffect ?? {
    kind: "manual" as const,
    note: trigger.triggerText ?? "unknown trigger",
  };
  const target = resolveEffectTarget(
    s, effect, trigger.chosenTarget, trigger.controllerId, actorId, action,
    `the trigger from ${cardLabel(trigger)}`, logs
  );
  applyEffect(s, controller, opponent, effect, `${cardLabel(trigger)} trigger`, trigger.triggerSourceId, logs, target);
}

/**
 * v13: the effective TriggerEffect for a stack entry, whether a real trigger
 * or a plain spell card resolving via its onResolve script (v11: no more
 * synthetic effect entry, so a spell itself may need a target at resolution).
 */
function stackTopEffect(card: GameCard): TriggerEffect | undefined {
  if (card.isTrigger) return card.triggerEffect;
  const effects = ctx.scripts?.[card.cardId]?.onResolve?.effects;
  if (!effects || effects.length === 0) return undefined;
  return effects.length === 1 ? effects[0] : { kind: "seq", effects };
}

/** v13: does the stack's top entry still need a FRESH target choice (no chosenTarget yet)? */
function topNeedsFreshTarget(s: GameState): boolean {
  const top = s.stack[s.stack.length - 1];
  if (!top) return false;
  return effectNeedsTarget(stackTopEffect(top)) && !top.chosenTarget;
}

/**
 * v13: pop and resolve the top of the stack — shared by the explicit
 * resolveTopOfStack action and passPriority's automatic resolution (CR
 * 117.4) once both players have passed. `actorId` only matters for a FRESH
 * target choice (action.target); auto-resolution never supplies one, so it
 * is only reached when none is needed (topNeedsFreshTarget gates the call).
 */
function resolveStackTop(
  s: GameState,
  actorId: string,
  action: Extract<GameAction, { type: "resolveTopOfStack" }>,
  logs: string[]
): void {
  const card = s.stack.pop();
  if (!card) throw new EngineError("The stack is empty");
  const actor = s.players.find((p) => p.playerId === actorId)!;
  const opponent = s.players.find((p) => p.playerId !== actorId)!;
  // v11 (CR 117.5): the active player receives priority after a resolution.
  s.priorityPasses = 0;
  s.priorityPlayerId = s.activePlayerId;
  if (card.isTrigger) {
    // v6: targeted triggers — the CONTROLLER chooses a legal target at
    // resolution (house rule; real Magic picks at stack time, CR 603.3d).
    // v8: entries carrying a cast-time chosenTarget resolve without a new
    // choice (either player may click); a stale chosen target fizzles.
    resolveTrigger(s, card, logs, actorId, action);
    return;
  }
  // v4: with card data, instants/sorceries (front-face type line) resolve
  // into their OWNER's graveyard and apply onResolve effects for their
  // CONTROLLER. Real card copies never sit on the stack as tokens, but
  // guard anyway: tokens have no CardData so frontTypeLine is undefined.
  const typeLine = frontTypeLine(card);
  if (!card.isToken && typeLine !== undefined && /\b(?:Instant|Sorcery)\b/i.test(typeLine)) {
    const owner = s.players.find((p) => p.playerId === card.ownerId) ?? actor;
    const spellName = cardLabel(card);
    const spellController = card.controllerId;
    const castTarget = card.chosenTarget; // captured before resetCardState clears it
    resetCardState(card);
    owner.zones.graveyard.push(card);
    const effects = ctx.scripts?.[card.cardId]?.onResolve?.effects;
    if (effects && effects.length > 0) {
      // v11: the spell's effect applies immediately as part of THIS
      // resolution (CR 608) — no more synthetic effect entry on the stack.
      const effect: TriggerEffect =
        effects.length === 1 ? effects[0]! : { kind: "seq", effects };
      const controller = s.players.find((p) => p.playerId === spellController) ?? actor;
      const spellOpponent = s.players.find((p) => p.playerId !== spellController) ?? opponent;
      const target = resolveEffectTarget(
        s, effect, castTarget, spellController, actorId, action, spellName, logs
      );
      logs.push(`resolved ${spellName} (now in the graveyard)`);
      applyEffect(s, controller, spellOpponent, effect, spellName, undefined, logs, target);
    } else {
      logs.push(
        `resolved ${cardLabel(card)} — carry out its effects by hand (it was put into the graveyard)`
      );
    }
    return;
  }
  const controller = s.players.find((p) => p.playerId === card.controllerId) ?? actor;
  arriveOnBattlefield(s, card, controller, "stack", logs);
  logs.push(`resolved ${cardLabel(card)} onto the battlefield`);
}

/**
 * v10: apply one TriggerEffect for `controller` — shared by trigger
 * resolution and instant/sorcery onResolve scripts. The whiteboard model:
 * the effect COMPILES into primitive EffectTasks, the interception pipeline
 * may rewrite them, and the executor runs whatever survives (emitting
 * GameEvents as it goes). `sourceId` is the battlefield permanent counters
 * land on; `label` names the source in the log ("Wall of Omens trigger").
 */
function applyEffect(
  s: GameState,
  controller: PlayerGameState,
  opponent: PlayerGameState,
  effect: TriggerEffect,
  label: string,
  sourceId: string | undefined,
  logs: string[],
  target?: TargetRef
): void {
  runTasks(s, compileEffect(controller, opponent, effect, label, sourceId, target), logs);
}

/** Compile one TriggerEffect into primitive tasks. Pure — no state mutation. */
function compileEffect(
  controller: PlayerGameState,
  opponent: PlayerGameState,
  effect: TriggerEffect,
  label: string,
  sourceId: string | undefined,
  target?: TargetRef
): EffectTask[] {
  const prov = { label, ...(sourceId !== undefined ? { sourceInstanceId: sourceId } : {}) };
  switch (effect.kind) {
    case "draw":
      // One task per card (CR 121.2) — the executor coalesces runs for the log.
      return Array.from({ length: effect.count }, () => ({
        ...prov,
        task: "draw" as const,
        playerId: controller.playerId,
      }));
    case "gainLife":
      return [{ ...prov, task: "gainLife", playerId: controller.playerId, amount: effect.amount }];
    case "loseLife":
      return [{ ...prov, task: "loseLife", playerId: controller.playerId, amount: effect.amount }];
    case "eachOpponentLosesLife":
      return [{ ...prov, task: "loseLife", playerId: opponent.playerId, amount: effect.amount }];
    case "damageOpponent":
      return [{ ...prov, task: "damagePlayer", playerId: opponent.playerId, amount: effect.amount }];
    case "addCounters":
      // Counters land on the SOURCE permanent — a source that never had one
      // (a resolving spell) fizzles at compile time; one that has since left
      // the battlefield fizzles at execution time.
      if (sourceId === undefined) {
        return [{ ...prov, task: "fizzle", reason: "its source is no longer on the battlefield" }];
      }
      return [
        {
          ...prov,
          task: "addCounters",
          instanceId: sourceId,
          counterType: effect.counterType,
          count: effect.count,
        },
      ];
    case "createToken":
      // One task per token — the executor coalesces identical runs.
      return Array.from({ length: effect.count }, () => ({
        ...prov,
        task: "createToken" as const,
        controllerId: controller.playerId,
        name: effect.name,
        typeLine: effect.typeLine,
        ...(effect.power !== undefined ? { power: effect.power } : {}),
        ...(effect.toughness !== undefined ? { toughness: effect.toughness } : {}),
        tapped: false,
      }));
    case "scry":
      return [{ ...prov, task: "scryNote", playerId: controller.playerId, count: effect.count }];
    case "damageAnyTarget":
      if (!target) return [{ ...prov, task: "fizzle", reason: "no target was chosen" }];
      if (target.kind === "player") {
        return [{ ...prov, task: "damagePlayer", playerId: target.playerId, amount: effect.amount }];
      }
      return [{ ...prov, task: "damagePermanent", instanceId: target.instanceId, amount: effect.amount }];
    case "amass":
      return [
        { ...prov, task: "amass", controllerId: controller.playerId, subtype: effect.subtype, count: effect.count },
      ];
    case "counterTarget":
      if (!target || target.kind !== "stack") {
        return [{ ...prov, task: "fizzle", reason: "no spell was targeted" }];
      }
      return [{ ...prov, task: "counterSpell", instanceId: target.instanceId }];
    case "seq":
      return effect.effects.flatMap((sub) =>
        compileEffect(controller, opponent, sub, label, sourceId, target)
      );
    case "manual":
      return [{ ...prov, task: "manualNote", controllerId: controller.playerId, note: effect.note }];
  }
}

/**
 * v10: the interception hook — replacement effects registered by permanents
 * rewrite the task list here before anything executes; the executor never
 * knows who touched it. Battlefield-arrival replacements (entersTapped,
 * entersWithCounters) live at the arriveOnBattlefield choke point; TASK-level
 * replacement kinds (draw substitution, damage prevention/redirect, trigger
 * doubling) plug in here as data when a card needs them. Identity transform
 * until then.
 */
function interceptTasks(_s: GameState, tasks: EffectTask[]): EffectTask[] {
  return tasks;
}

/** Run a compiled task list: intercept, then execute (coalescing draw/token runs for log parity). */
function runTasks(s: GameState, tasks: EffectTask[], logs: string[]): void {
  const finalTasks = interceptTasks(s, tasks);
  let i = 0;
  while (i < finalTasks.length) {
    const t = finalTasks[i]!;
    if (t.task === "draw") {
      // Coalesce a run of same-player same-label draws into one drawCards call
      // (events still emit per card; the log reads "drew N cards").
      let n = 1;
      while (i + n < finalTasks.length) {
        const next = finalTasks[i + n]!;
        if (next.task !== "draw" || next.playerId !== t.playerId || next.label !== t.label) break;
        n += 1;
      }
      const p = s.players.find((pl) => pl.playerId === t.playerId);
      if (p) {
        const drawn = drawCards(p, n);
        logs.push(
          `resolved ${t.label}: ${playerLabel(p.playerId)} drew ${drawn} card${drawn === 1 ? "" : "s"}`
        );
      }
      i += n;
      continue;
    }
    if (t.task === "createToken") {
      // Coalesce identical consecutive token tasks into one spawnTokens batch.
      let n = 1;
      while (i + n < finalTasks.length) {
        const next = finalTasks[i + n]!;
        if (
          next.task !== "createToken" ||
          next.controllerId !== t.controllerId ||
          next.name !== t.name ||
          next.typeLine !== t.typeLine ||
          next.power !== t.power ||
          next.toughness !== t.toughness ||
          next.tapped !== t.tapped ||
          next.label !== t.label
        ) {
          break;
        }
        n += 1;
      }
      const p = s.players.find((pl) => pl.playerId === t.controllerId);
      if (p) {
        spawnTokens(
          s,
          p,
          {
            name: t.name,
            typeLine: t.typeLine,
            ...(t.power !== undefined ? { power: t.power } : {}),
            ...(t.toughness !== undefined ? { toughness: t.toughness } : {}),
            count: n,
            tapped: t.tapped,
          },
          logs,
          `resolved ${t.label}: `
        );
      }
      i += n;
      continue;
    }
    executeTask(s, t, logs);
    i += 1;
  }
}

/** Execute one primitive task. Missing/stale referents fizzle with a log. */
function executeTask(s: GameState, t: EffectTask, logs: string[]): void {
  switch (t.task) {
    case "draw":
    case "createToken":
      // Handled (coalesced) in runTasks; unreachable here.
      break;
    case "gainLife": {
      const p = s.players.find((pl) => pl.playerId === t.playerId);
      if (!p) break;
      p.life += t.amount;
      logs.push(`resolved ${t.label}: ${playerLabel(p.playerId)} gained ${t.amount} life`);
      break;
    }
    case "loseLife": {
      const p = s.players.find((pl) => pl.playerId === t.playerId);
      if (!p) break;
      p.life -= t.amount;
      logs.push(`resolved ${t.label}: ${playerLabel(p.playerId)} lost ${t.amount} life`);
      break;
    }
    case "damagePlayer": {
      const p = s.players.find((pl) => pl.playerId === t.playerId);
      if (!p) {
        logs.push(`${t.label} fizzled: its target player is gone`);
        break;
      }
      p.life -= t.amount;
      logs.push(`resolved ${t.label}: dealt ${t.amount} damage to ${playerLabel(p.playerId)}`);
      break;
    }
    case "damagePermanent": {
      const permanent = findOnAnyBattlefield(s, t.instanceId);
      if (!permanent) {
        logs.push(`${t.label} fizzled: its target left the battlefield`);
        break;
      }
      permanent.damage += t.amount;
      logs.push(`resolved ${t.label}: dealt ${t.amount} damage to ${cardLabel(permanent)}`);
      break;
    }
    case "addCounters": {
      const source = findOnAnyBattlefield(s, t.instanceId);
      if (!source) {
        logs.push(`${t.label} fizzled: its source is no longer on the battlefield`);
        break;
      }
      source.counters[t.counterType] = (source.counters[t.counterType] ?? 0) + t.count;
      logs.push(
        `resolved ${t.label}: put ${t.count} ${t.counterType} counter${
          t.count === 1 ? "" : "s"
        } on ${cardLabel(source)}`
      );
      break;
    }
    case "amass": {
      // CR 701.47a. "Army" is matched on the (token)type line; the first Army
      // in battlefield order gets the counters (controller's choice is not
      // modeled). Subtype addition is logged, not tracked.
      const controller = s.players.find((pl) => pl.playerId === t.controllerId);
      if (!controller) break;
      const typeLineOf = (c: GameCard): string =>
        c.isToken ? c.tokenTypeLine ?? "" : ctx.cards?.[c.cardId]?.typeLine ?? "";
      let army = [...controller.zones.battlefield]
        .sort((a, b) => a.sortIndex - b.sortIndex)
        .find((c) => /\bArmy\b/i.test(typeLineOf(c)));
      if (!army) {
        spawnTokens(
          s,
          controller,
          {
            name: `${t.subtype} Army`,
            typeLine: `Token Creature — ${t.subtype} Army`,
            power: "0",
            toughness: "0",
            count: 1,
            tapped: false,
          },
          logs,
          `resolved ${t.label}: `
        );
        army = controller.zones.battlefield[controller.zones.battlefield.length - 1];
      }
      if (army) {
        army.counters["+1/+1"] = (army.counters["+1/+1"] ?? 0) + t.count;
        logs.push(
          `amassed ${t.subtype} ${t.count}: put ${t.count} +1/+1 counter${
            t.count === 1 ? "" : "s"
          } on ${cardLabel(army)}`
        );
      }
      break;
    }
    case "counterSpell": {
      const idx = s.stack.findIndex((c) => c.instanceId === t.instanceId);
      const spell = idx === -1 ? undefined : s.stack[idx]!;
      if (!spell || spell.isTrigger) {
        logs.push(`${t.label} fizzled: its target is no longer a spell on the stack`);
        break;
      }
      s.stack.splice(idx, 1);
      if (spell.isToken) {
        logs.push(`resolved ${t.label}: countered ${cardLabel(spell)} (token ceased to exist)`);
      } else {
        const spellOwner = s.players.find((p) => p.playerId === spell.ownerId) ?? s.players[0]!;
        resetCardState(spell);
        spellOwner.zones.graveyard.push(spell);
        logs.push(`resolved ${t.label}: countered ${cardLabel(spell)}`);
      }
      break;
    }
    case "scryNote": {
      logs.push(
        `resolved ${t.label}: ${playerLabel(t.playerId)} scries ${t.count} (use scry to finish)`
      );
      break;
    }
    case "manualNote": {
      logs.push(`resolved ${t.label} — carry it out by hand: ${t.note}`);
      break;
    }
    case "fizzle": {
      logs.push(`${t.label} fizzled: ${t.reason}`);
      break;
    }
  }
}

function applyMoveCard(
  s: GameState,
  actor: PlayerGameState,
  action: Extract<GameAction, { type: "moveCard" }>,
  logs: string[]
): void {
  const { instanceId, from } = action;
  let to = action.to;
  if (!ZONE_NAMES.includes(from)) throw new EngineError(`Unknown zone "${from}"`);
  if (!ZONE_NAMES.includes(to)) throw new EngineError(`Unknown zone "${to}"`);

  // v7: nonland cards are CAST — a face-up hand->battlefield play is
  // redirected through the stack so opponents get a response window before
  // ETB ever fires. Lands, morphs, and data-less cards keep the direct path.
  if (from === "hand" && to === "battlefield" && action.faceDown !== true) {
    const played = actor.zones.hand.find((c) => c.instanceId === instanceId);
    const typeLine = played ? frontTypeLine(played) : undefined;
    if (played && typeLine !== undefined && !/\bLand\b/i.test(typeLine)) {
      to = "stack";
      logs.push(`(nonland cards are cast — ${cardLabel(played)} goes to the stack first)`);
    }
  }
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

  // v5: leaving the hand for the stack or battlefield is the cast/play path —
  // enforce land drops (CR 305.2) and pay mana costs (CR 601.2h) up front.
  // Face-down plays (morph) stay fully manual.
  if (from === "hand" && (to === "stack" || to === "battlefield") && action.faceDown !== true) {
    const handCard = actor.zones.hand.find((c) => c.instanceId === instanceId);
    if (handCard) enforceCastFromHand(s, actor, handCard, to, action.override === true, logs);
  }

  // Remove the card from exactly the stated `from` zone.
  let card: GameCard;
  if (from === "stack") {
    const idx = s.stack.findIndex((c) => c.instanceId === instanceId);
    if (idx === -1) throw new EngineError(`Card ${instanceId} is not on the stack`);
    const found = s.stack[idx]!;
    if (found.isTrigger) {
      throw new EngineError(
        "Triggered abilities cannot be moved; resolve, counter, or decline them"
      );
    }
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
  // Their departure is still an event (observers like "whenever a creature
  // you control dies" see token deaths; nontoken filters exclude them).
  if (card.isToken && to !== "battlefield" && to !== "stack") {
    logs.push(`moved ${cardLabel(card)} to ${to}; the token ceased to exist`);
    emitEvent({
      kind: "zoneChange",
      instanceId: card.instanceId,
      cardId: card.cardId,
      isToken: true,
      controllerId: card.controllerId,
      from,
      to,
      died: wasOnBattlefield && to === "graveyard",
      ...(card.tokenTypeLine !== undefined ? { typeLine: card.tokenTypeLine } : {}),
    });
    return;
  }

  if (from === "battlefield" || from === "stack") resetCardState(card);
  if (action.faceDown !== undefined) card.faceDown = action.faceDown;

  switch (to) {
    case "stack":
      card.controllerId = actor.playerId;
      s.stack.push(card);
      // v11: the caster retains priority after casting (CR 117.3b/601.2i) —
      // both players must still explicitly pass before it resolves.
      s.priorityPlayerId = actor.playerId;
      // v8: a target chosen at cast time (CR 601.2c) rides on the entry.
      if (action.target) {
        if (action.target.kind === "stack" && action.target.instanceId === card.instanceId) {
          throw new EngineError("A spell cannot target itself");
        }
        const spellEffects = ctx.scripts?.[card.cardId]?.onResolve?.effects ?? [];
        const kinds = new Set<TargetRef["kind"]>();
        for (const e of spellEffects) for (const k of effectTargetKinds(e)) kinds.add(k);
        validateTarget(s, action.target, [...kinds]);
        card.chosenTarget = action.target;
        logs.push(`chose ${targetLabel(s, action.target)} as the target of ${cardLabel(card)}`);
      }
      break;
    case "library":
      if (action.toBottom) actor.zones.library.push(card);
      else actor.zones.library.unshift(card);
      break;
    case "battlefield":
      // v10: arrival choke point (replacements + sortIndex + zoneChange event).
      arriveOnBattlefield(s, card, actor, from, logs);
      break;
    default:
      actor.zones[to].push(card);
      break;
  }

  const dest = to === "library" ? (action.toBottom ? "the bottom of their library" : "their library") : to;
  logs.push(`moved ${moveLabel(card, from, to)} from ${from} to ${dest}`);

  // v9: every move is an event; the end-of-action matching pass turns events
  // into triggers (self etb/dies/leaves, other-permanent observers, ...).
  // (Battlefield arrivals already emitted inside arriveOnBattlefield.)
  if (to !== "battlefield") {
    emitEvent({
      kind: "zoneChange",
      instanceId: card.instanceId,
      cardId: card.cardId,
      isToken: card.isToken,
      controllerId: card.controllerId,
      from,
      to,
      died: wasOnBattlefield && to === "graveyard",
      ...(typeLineOfCard(card) !== undefined ? { typeLine: typeLineOfCard(card) } : {}),
    });
  }
  if (from === "hand" && to === "graveyard") {
    emitEvent({ kind: "discard", playerId: actor.playerId, instanceId: card.instanceId });
  }

  if (to === "stack" && (from === "hand" || from === "graveyard" || from === "exile" || from === "library")) {
    // v5: only hand-casts are cost-enforced; note the gap for other zones
    // (flashback, reanimation shortcuts, ...) so it is never silent.
    if (from !== "hand") {
      const castData = ctx.cards?.[card.cardId];
      const rawCost = castData?.faces?.[0]?.manaCost ?? castData?.manaCost;
      if (rawCost) logs.push(`(cost ${rawCost} is not enforced when casting from the ${from})`);
    }
    // Casting a spell: the spellCast event fires observer triggers (the
    // caster's own permanents for caster:"you" conditions), which land ABOVE
    // the cast spell on the stack because matching runs after the mutation.
    emitEvent({
      kind: "spellCast",
      instanceId: card.instanceId,
      cardId: card.cardId,
      casterId: actor.playerId,
      ...(frontTypeLine(card) !== undefined ? { typeLine: frontTypeLine(card) } : {}),
    });
  }
}

/** Type line for event payloads: token type line or front-face card data. */
function typeLineOfCard(card: GameCard): string | undefined {
  return card.isToken ? card.tokenTypeLine : frontTypeLine(card);
}

/**
 * v5 cast/play enforcement, called before a card leaves the hand for the
 * stack or battlefield. Mutates only on success paths (payments tap sources
 * and drain the pool on the CLONED state); throws EngineError otherwise.
 *
 *  - Front-face Land -> battlefield: a land play. Rejected once
 *    landsPlayedThisTurn >= 1 unless `override` (CR 305.2a-b); the count
 *    increments either way. Lands never pay mana costs.
 *  - Anything else: parse the mana cost. Unparseable-but-present costs are
 *    allowed and loudly logged as unenforced (wrong automation is worse than
 *    none); missing card data stays silent (context-less engine, tokens).
 *    Parseable costs are paid from the pool first, then by auto-tapping
 *    untapped producers (CR 106.4, 601.2g-h); failure throws. `override`
 *    skips payment entirely (alternative costs), loudly logged.
 */
function enforceCastFromHand(
  s: GameState,
  actor: PlayerGameState,
  card: GameCard,
  to: "stack" | "battlefield",
  override: boolean,
  logs: string[]
): void {
  const typeLine = frontTypeLine(card);
  const isLand = typeLine !== undefined && /\bLand\b/i.test(typeLine);
  const inMainPhase = s.step === "main1" || s.step === "main2";
  const isActive = s.activePlayerId === actor.playerId;

  if (isLand && to === "battlefield") {
    // v12 timing (CR 305.1): your turn, a main phase, empty stack.
    if (!override) {
      if (!isActive) {
        throw new EngineError("You may only play lands during your own turn (CR 305.1).");
      }
      if (!inMainPhase || s.stack.length > 0) {
        throw new EngineError(
          "Lands are played during your main phases while the stack is empty (CR 305.1). (Effects that break this rule: use the override.)"
        );
      }
    }
    if (actor.landsPlayedThisTurn >= 1 && !override) {
      throw new EngineError(
        "You have already played a land this turn (CR 305.2). If an effect grants additional land plays, use the additional-land override."
      );
    }
    actor.landsPlayedThisTurn += 1;
    if (actor.landsPlayedThisTurn > 1) {
      logs.push(`played an additional land (override) — land #${actor.landsPlayedThisTurn} this turn`);
    }
    return;
  }
  if (isLand) return; // lands aren't spells; nothing to pay wherever they go

  const data = ctx.cards?.[card.cardId];
  if (!data) return; // no card data — the context-less engine stays permissive

  if (override) {
    logs.push(`cast ${cardLabel(card)} without paying its mana cost (override)`);
    return;
  }

  // v12 timing (CR 117.1a): sorcery-speed spells (no Instant type, no Flash)
  // are cast during your own main phases with an empty stack. Instant-speed
  // casts stay open to either player (house response-window model).
  if (!hasInstantSpeed(data)) {
    if (!isActive) {
      throw new EngineError(
        `${cardLabel(card)} is a sorcery-speed spell — you can only cast it during your own turn (CR 117.1a). (Effects that grant flash-like timing: use the override.)`
      );
    }
    if (!inMainPhase || s.stack.length > 0) {
      throw new EngineError(
        `${cardLabel(card)} is a sorcery-speed spell — cast it during a main phase while the stack is empty (CR 117.1a). (Effects that grant flash-like timing: use the override.)`
      );
    }
  }

  const rawCost = data.faces?.[0]?.manaCost ?? data.manaCost;
  const cost = parseManaCost(rawCost);
  if (!cost) {
    if (rawCost) logs.push(`cast ${cardLabel(card)} — its cost ${rawCost} is not auto-enforced`);
    return;
  }
  if (parsedCostSize(cost) === 0) return; // {0} / X-only: nothing fixed to pay

  const plan = planManaPayment(cost, actor.manaPool, manaSourcesOf(actor, ctx.cards ?? {}));
  if (!plan) {
    throw new EngineError(
      `You can't pay ${rawCost} for ${cardLabel(card)} — not enough mana in your pool or untapped sources. ` +
        "(Alternative or reduced costs: use the cast-without-paying override.)"
    );
  }

  // Execute the plan: drain the pool, tap the chosen sources.
  const parts: string[] = [];
  const poolSpend = describePoolSpend(plan.fromPool);
  for (const [color, count] of Object.entries(plan.fromPool)) {
    const left = (actor.manaPool[color] ?? 0) - (count ?? 0);
    if (left <= 0) delete actor.manaPool[color];
    else actor.manaPool[color] = left;
  }
  if (poolSpend) parts.push(`spent ${poolSpend} from their pool`);
  if (plan.taps.length > 0) {
    const names: string[] = [];
    for (const tap of plan.taps) {
      const source = actor.zones.battlefield.find((c) => c.instanceId === tap.instanceId);
      if (source) {
        source.tapped = true;
        names.push(cardLabel(source));
        emitEvent({ kind: "becameTapped", instanceId: source.instanceId, controllerId: source.controllerId });
      }
    }
    parts.push(`tapped ${names.join(", ")}`);
  }
  const xNote = cost.x > 0 ? " (X not auto-charged)" : "";
  logs.push(`auto-paid ${rawCost} for ${cardLabel(card)}${xNote}${parts.length ? ` — ${parts.join("; ")}` : ""}`);
}

/**
 * v12: does the card's own printed text include Vigilance (CR 702.21)?
 * Reminder text is stripped; granted vigilance (anthems, auras) is invisible
 * here — the player untaps the attacker by hand in that case.
 */
function hasVigilance(card: GameCard): boolean {
  const data = ctx.cards?.[card.cardId];
  if (!data) return false;
  const oracle = (data.faces?.[0]?.oracleText ?? data.oracleText ?? "").replace(/\([^)]*\)/g, "");
  return /\bvigilance\b/i.test(oracle);
}

/** Front-face type line of a card (DFC-aware); undefined without card data. */
function frontTypeLine(card: GameCard): string | undefined {
  const data = ctx.cards?.[card.cardId];
  if (!data) return undefined;
  return data.faces?.[0]?.typeLine ?? data.typeLine;
}

/** Does a library card's type line satisfy a pending search's filter? */
function searchFilterMatches(filter: SearchFilter, typeLine: string | undefined): boolean {
  if (filter.kind === "any") return true;
  // Without card data the card's type is unknowable — reject rather than guess.
  if (typeLine === undefined) return false;
  if (filter.kind === "basicLand") {
    return /\bBasic\b/i.test(typeLine) && /\bLand\b/i.test(typeLine);
  }
  return filter.subtypes.some((st) =>
    new RegExp(`\\b${st.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(typeLine)
  );
}

/** Human-readable filter description for error messages. */
function describeSearchFilter(filter: SearchFilter): string {
  switch (filter.kind) {
    case "basicLand":
      return "a basic land card";
    case "landSubtype":
      return `a ${filter.subtypes.join(" or ")} card`;
    case "any":
      return "any card";
  }
}

/** Does a castSpell trigger's filter accept a spell with this type line? */
function castFilterMatches(
  filter: "any" | "instantOrSorcery" | "noncreature" | "creature" | "artifact" | undefined,
  typeLine: string | undefined
): boolean {
  if (filter === undefined || filter === "any") return true;
  // Without card data the spell's type is unknowable — filtered triggers
  // stay silent rather than guess.
  if (typeLine === undefined) return false;
  switch (filter) {
    case "instantOrSorcery":
      return /\b(?:Instant|Sorcery)\b/i.test(typeLine);
    case "noncreature":
      return !/\bCreature\b/i.test(typeLine);
    case "creature":
      return /\bCreature\b/i.test(typeLine);
    case "artifact":
      return /\bArtifact\b/i.test(typeLine);
  }
}

/**
 * v12: while the current step is TRANSIT and nothing needs a player (empty
 * stack, no search, nobody lost), keep advancing — cleanup advances the turn.
 * Trigger matching runs INSIDE the loop so triggers emitted by a step land on
 * the stack before the continue/hold decision (the v9 end-of-action pass
 * would otherwise decide too late). The guard bounds runaway chains.
 */
/** Advance from the current step to the next one (cleanup ends the turn). */
function advanceToNextStep(s: GameState, logs: string[]): void {
  if (s.step === "cleanup") {
    advanceTurn(s, logs);
  } else {
    const idx = TURN_STEPS.indexOf(s.step);
    const next = TURN_STEPS[idx + 1];
    if (next === undefined) throw new EngineError(`Cannot advance past step "${s.step}"`);
    enterStep(s, next, logs);
  }
}

function autoAdvanceTransit(s: GameState, logs: string[]): void {
  let guard = 0;
  for (;;) {
    runTriggerMatching(s, logs);
    if (
      guard++ > 30 ||
      s.finished ||
      s.pendingSearch ||
      s.stack.length > 0 ||
      !TRANSIT_STEPS.has(s.step) ||
      s.players.some((p) => p.hasLost)
    ) {
      return;
    }
    if (s.step === "cleanup") {
      advanceTurn(s, logs);
    } else {
      const next = TURN_STEPS[TURN_STEPS.indexOf(s.step) + 1]!;
      enterStep(s, next, logs);
    }
  }
}

/** Advance to the next step within the turn, applying turn-based effects. */
function enterStep(s: GameState, step: TurnStep, logs: string[]): void {
  s.step = step;
  s.priorityPlayerId = s.activePlayerId;
  s.priorityPasses = 0;
  // Floating mana empties at EVERY step boundary, for both players.
  for (const p of s.players) p.manaPool = {};
  const active = s.players.find((p) => p.playerId === s.activePlayerId)!;
  const inactive = s.players.find((p) => p.playerId !== s.activePlayerId)!;

  // A new combat (or leaving one) re-arms the "whenever you attack" trigger.
  if (step === "beginCombat" || step === "endCombat") s.attackDeclaredThisCombat = false;

  emitEvent({ kind: "stepEntered", step, activePlayerId: s.activePlayerId });

  if (step === "untap") {
    for (const c of active.zones.battlefield) c.tapped = false;
  } else if (step === "draw") {
    const skipFirstDraw = s.turnNumber === 1 && s.activePlayerId === s.startingPlayerId;
    if (!skipFirstDraw) {
      const drawn = drawCards(active, 1, "drawStep");
      logs.push(`moved to the draw step and drew ${drawn} card${drawn === 1 ? "" : "s"}`);
      return;
    }
  } else if (step === "combatDamage") {
    // Each attacking creature of the active player with no opposing creature
    // blocking it deals its combat damage to the player. The resulting
    // triggers are ordinary stack entries, so they can be countered/declined
    // when the damage was actually prevented.
    const sorted = [...active.zones.battlefield].sort((a, b) => a.sortIndex - b.sortIndex);
    for (const c of sorted) {
      if (!c.attacking) continue;
      const blocked = inactive.zones.battlefield.some((b) => b.blocking === c.instanceId);
      if (!blocked) {
        emitEvent({
          kind: "combatDamageToPlayer",
          instanceId: c.instanceId,
          controllerId: c.controllerId,
        });
      }
    }
  } else if (step === "cleanup") {
    for (const p of s.players) {
      for (const c of p.zones.battlefield) c.damage = 0;
    }
  }
  logs.push(`moved to the ${step} step`);
}

/** End the current turn: swap active player, apply untap-step effects. */
function advanceTurn(s: GameState, logs: string[]): void {
  // Cleanup semantics apply even when the turn is ended early via nextTurn
  // (mana pools also empty here — every step transition clears them).
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
  s.priorityPasses = 0;
  if (next.playerId === s.startingPlayerId) s.turnNumber += 1;
  current.landsPlayedThisTurn = 0;
  next.landsPlayedThisTurn = 0;
  s.attackDeclaredThisCombat = false;

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

  // Collect owned, non-token cards from the shared stack first (trigger
  // pseudo-cards are not real cards and simply vanish on restart).
  const stackByOwner = new Map<string, GameCard[]>();
  for (const c of s.stack) {
    if (c.isToken || c.isTrigger) continue;
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
  s.priorityPasses = 0;
  s.turnNumber = 1;
  s.step = "untap";
  s.finished = false;
  s.winnerId = null;
  s.pendingSearch = null;
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
