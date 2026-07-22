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
  CombatState,
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
  canPayFor,
  describePoolSpend,
  hasInstantSpeed,
  manaSourcesOf,
  parseManaCost,
  parsedCostSize,
  planManaPayment,
} from "./mana.js";
import { STEP_INFO, isMainPhase, nextStepFrom } from "./turnFlow.js";

/**
 * v15: how far the flow driver will carry a single action before giving up.
 * A full turn with both players auto-passing is roughly 25 iterations; 200
 * is a runaway backstop, not a working limit.
 */
const FLOW_GUARD = 200;

/**
 * One pending log entry. A bare string is attributed to whoever took the
 * action (the overwhelmingly common case). The object form names the player
 * the message is ABOUT — v15's flow driver can advance several steps of the
 * OTHER player's turn inside one action, and "Bo moved to the upkeep step"
 * during Ada's turn is simply wrong.
 */
type LogLine = string | { playerId: string | null; message: string };

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

/** v15: a closed pair of combat declaration windows (no combat in progress). */
function freshCombat(): CombatState {
  return { attackersDeclared: false, blockersDeclared: false, attackersThisCombat: 0 };
}

/**
 * v15: fill in flow fields that states serialized before v15 don't carry, so
 * an in-flight game keeps working across a deploy. Called once per action on
 * the freshly cloned state, before anything reads them.
 */
function ensureFlowState(s: GameState): void {
  s.combat ??= freshCombat();
  s.openingHandKept ??= [];
  s.openingMulligans ??= {};
  if (!s.autoPass) {
    // Absent = the pre-v15 default, which is what v15 defaults to anyway.
    s.autoPass = { [s.players[0].playerId]: true, [s.players[1].playerId]: true };
  }
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
    combat: freshCombat(),
    // v15: auto-pass is ON for both players by default (CR 732 shortcut).
    autoPass: { [states[0].playerId]: true, [states[1].playerId]: true },
    openingHandKept: [],
    openingMulligans: {},
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
  ensureFlowState(s);
  const actor = s.players[actorIdx]!;
  const opponent = s.players[actorIdx === 0 ? 1 : 0]!;
  const logs: LogLine[] = [];
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
      // v15: the declaration is a single turn-based action — once committed
      // it is locked in for the combat (CR 508.1k/506.4a).
      if (s.combat!.attackersDeclared) {
        throw new EngineError("Attackers are already declared this combat (CR 508.1k).");
      }
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      const wasAttacking = card.attacking;
      if (action.attacking && !wasAttacking && card.tapped) {
        throw new EngineError(`${cardLabel(card)} is tapped and can't attack (CR 508.1c).`);
      }
      card.attacking = action.attacking;
      logs.push(`${action.attacking ? "declared" : "removed"} ${cardLabel(card)} as an attacker`);
      // CR 508.1f: tapping to attack is not a cost, so taking the attack back
      // while the window is still open takes the tap back with it.
      if (!hasVigilance(card) && action.attacking !== wasAttacking) {
        card.tapped = action.attacking;
        if (action.attacking) {
          logs.push(`${cardLabel(card)} taps as it attacks`);
          emitEvent({ kind: "becameTapped", instanceId: card.instanceId, controllerId: card.controllerId });
        }
      }
      // v15: the attackDeclared event fires at commitAttackers, once, for the
      // whole declaration (CR 508.1m) — not per click, which double-fired
      // "whenever this attacks" triggers whenever a player changed their mind.
      break;
    }

    case "commitAttackers": {
      requireOpenAttackWindow(s, actorId);
      commitDeclaration(s, "attackers", logs);
      break;
    }

    case "declareAllAttackers": {
      requireOpenAttackWindow(s, actorId);
      const added: string[] = [];
      for (const card of actor.zones.battlefield) {
        if (card.attacking || card.tapped || !isCreature(card)) continue;
        card.attacking = true;
        added.push(cardLabel(card));
        if (!hasVigilance(card)) {
          card.tapped = true;
          emitEvent({ kind: "becameTapped", instanceId: card.instanceId, controllerId: card.controllerId });
        }
      }
      logs.push(
        added.length === 0 ? "had no creatures able to attack" : `sent ${added.join(", ")} to attack`
      );
      break;
    }

    case "clearAttackers": {
      requireOpenAttackWindow(s, actorId);
      let removed = 0;
      for (const card of actor.zones.battlefield) {
        if (!card.attacking) continue;
        card.attacking = false;
        removed += 1;
        // CR 508.1f: the attack tap was never a cost, so it comes back off.
        if (!hasVigilance(card)) card.tapped = false;
      }
      logs.push(removed === 0 ? "cleared the attack (nothing was declared)" : "took back the whole attack");
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
      if (s.combat!.blockersDeclared) {
        throw new EngineError("Blockers are already declared this combat (CR 509.1g).");
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

    case "commitBlockers": {
      if (s.step !== "declareBlockers") {
        throw new EngineError("Blockers are declared during the declare-blockers step (CR 509.1).");
      }
      if (s.activePlayerId === actorId) {
        throw new EngineError("Only the defending player declares blockers (CR 509.1).");
      }
      if (s.combat!.blockersDeclared) {
        throw new EngineError("Blockers are already declared this combat (CR 509.1g).");
      }
      commitDeclaration(s, "blockers", logs);
      break;
    }

    case "setAutoPass": {
      // v15 (CR 732): the player's own shortcut setting. Turning it off is
      // "hold full control" — every priority window will stop for them.
      s.autoPass = { ...s.autoPass, [actorId]: action.enabled };
      logs.push(action.enabled ? "turned auto-pass on" : "turned auto-pass off (holding full control)");
      break;
    }

    case "shuffleLibrary": {
      actor.zones.library = shuffle(actor.zones.library, createRng(`${s.id}:shuffle:${s.seq + 1}`));
      logs.push("shuffled their library");
      break;
    }

    case "mulligan": {
      // v15.1: counted on the state, not by scanning the log — the log is not
      // cleared by restartGame, so the old scan kept climbing across restarts
      // and would have handed the client a wrong London bottom-count.
      if (s.openingHandKept!.includes(actorId)) {
        throw new EngineError("You have already kept your opening hand");
      }
      const mullCount = (s.openingMulligans![actorId] ?? 0) + 1;
      s.openingMulligans![actorId] = mullCount;
      actor.zones.library.push(...actor.zones.hand.splice(0));
      actor.zones.library = shuffle(actor.zones.library, createRng(`${s.id}:mulligan:${s.seq + 1}`));
      const drawn = drawCards(actor, 7, "silent");
      logs.push(`took a mulligan (#${mullCount}) and drew ${drawn}`);
      break;
    }

    case "keepHand": {
      // v15.1: keeping twice would bottom a second batch of cards. Reloading
      // the page used to resurrect the keep/mulligan overlay (its "have I
      // kept?" memory lived only in the tab), which made that reachable.
      if (s.openingHandKept!.includes(actorId)) {
        throw new EngineError("You have already kept your opening hand");
      }
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
      // v15: the flow driver holds at turn-1 untap until BOTH players have
      // kept, so nothing advances underneath the mulligan UI.
      if (!s.openingHandKept!.includes(actorId)) s.openingHandKept!.push(actorId);
      break;
    }

    case "nextStep": {
      // Explicit "skip ahead" shortcut for the active player — the ordinary
      // route out of a step is both players passing (CR 500.2), which the
      // flow driver handles. An open declaration window must be committed
      // first, or the declaration would be silently skipped.
      requireActive(s, actorId, "nextStep");
      if (openDeclaration(s)) {
        throw new EngineError(
          s.step === "declareAttackers"
            ? "Finish declaring attackers first (CR 508.1)."
            : "Blockers are still being declared (CR 509.1)."
        );
      }
      advanceToNextStep(s, logs);
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
      // v15: a declaration window is a turn-based action, not a priority
      // window — nobody holds priority until it closes (CR 508.1/509.1).
      const pending = openDeclaration(s);
      if (pending) {
        throw new EngineError(
          pending.kind === "attackers"
            ? "Attackers are still being declared — commit the attack first (CR 508.1)."
            : "Blockers are still being declared — commit the blocks first (CR 509.1)."
        );
      }
      passPriorityFor(s, actorId, logs, false);
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

  // v15: ONE flow driver, run after every action. It completes priority-less
  // steps, closes empty declaration windows, auto-passes for players with
  // nothing to do, and resolves the stack when both have passed — replacing
  // v12's transit chain, v13's inline auto-resolve and v14's inline advance.
  runFlow(s, logs);

  s.seq += 1;
  for (const line of logs) {
    if (typeof line === "string") {
      s.log.push({ seq: s.seq, playerId: actorId, message: line, ts: now });
    } else {
      s.log.push({ seq: s.seq, playerId: line.playerId, message: line.message, ts: now });
    }
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
  logs: LogLine[],
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
  logs: LogLine[],
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
  logs: LogLine[]
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
function runTriggerMatching(s: GameState, logs: LogLine[]): void {
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
  logs: LogLine[]
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
  logs: LogLine[],
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
  logs: LogLine[]
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
  logs: LogLine[],
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
function runTasks(s: GameState, tasks: EffectTask[], logs: LogLine[]): void {
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
function executeTask(s: GameState, t: EffectTask, logs: LogLine[]): void {
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
  logs: LogLine[]
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
  logs: LogLine[]
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
 * Advance from the current step to the next one, honouring CR 508.8's skip
 * (see `nextStepFrom`). Leaving cleanup ends the turn.
 */
function advanceToNextStep(s: GameState, logs: LogLine[]): void {
  const next = nextStepFrom(s);
  // CR 511.3: everything is removed from combat as soon as the end of combat
  // step ENDS — after any "at end of combat" window, before the next step.
  if (s.step === "endCombat") removeFromCombat(s);
  if (next === null) {
    advanceTurn(s, logs);
    return;
  }
  if (next === "endCombat" && s.step === "declareAttackers") {
    logs.push({
      playerId: s.activePlayerId,
      message: "declared no attackers — skipping the declare-blockers and combat-damage steps (CR 508.8)",
    });
  }
  enterStep(s, next, logs);
}

/** Shared guard for the three attack-declaration actions (CR 508.1). */
function requireOpenAttackWindow(s: GameState, actorId: string): void {
  if (s.step !== "declareAttackers") {
    throw new EngineError("Attackers are declared during the declare-attackers step (CR 508.1).");
  }
  if (s.activePlayerId !== actorId) {
    throw new EngineError("Only the active player declares attackers (CR 508.1).");
  }
  if (s.combat!.attackersDeclared) {
    throw new EngineError("Attackers are already declared this combat (CR 508.1k).");
  }
}

/** CR 506.4/511.3: clear every creature's attacking/blocking state. */
function removeFromCombat(s: GameState): void {
  for (const p of s.players) {
    for (const c of p.zones.battlefield) {
      c.attacking = false;
      c.blocking = null;
    }
  }
}

/**
 * CR 502.3 turn-based action: "the active player determines which permanents
 * they control will untap. Then they untap them all simultaneously. Normally,
 * all of a player's permanents untap, but effects can keep one or more of a
 * player's permanents from untapping."
 *
 * Two restrictions are modelled, both declarative:
 *  - a `doesNotUntap` replacement rule on the card's own script (printed
 *    "this permanent doesn't untap during your untap step" text), and
 *  - stun counters (CR 701.53a): a permanent with one untaps by removing a
 *    stun counter instead.
 */
function untapStep(active: PlayerGameState, logs: LogLine[]): void {
  const held: string[] = [];
  const stunned: string[] = [];
  for (const c of active.zones.battlefield) {
    if (!c.tapped) continue;
    if (untapRestricted(c)) {
      held.push(cardLabel(c));
      continue;
    }
    const stun = c.counters["stun"] ?? 0;
    if (stun > 0) {
      // CR 701.53a: removing the counter REPLACES the untap.
      if (stun === 1) delete c.counters["stun"];
      else c.counters["stun"] = stun - 1;
      stunned.push(cardLabel(c));
      continue;
    }
    c.tapped = false;
  }
  if (held.length > 0) {
    logs.push({ playerId: active.playerId, message: `${held.join(", ")} did not untap` });
  }
  if (stunned.length > 0) {
    logs.push({
      playerId: active.playerId,
      message: `${stunned.join(", ")} stayed tapped, removing a stun counter instead (CR 701.53a)`,
    });
  }
}

/** Does this permanent's own script keep it from untapping (CR 502.3)? */
function untapRestricted(card: GameCard): boolean {
  const rules = ctx.scripts?.[card.cardId]?.replacements ?? [];
  return rules.some((r) => r.kind === "doesNotUntap");
}

// ---------------------------------------------------------------------------
// v15: the flow driver — ONE mechanism where v12/v13/v14 had three
// ---------------------------------------------------------------------------

/**
 * Is the turn-1 mulligan window still open? While it is, the flow driver does
 * nothing at all: no step advances, no priority passes, nothing runs
 * underneath the keep/mulligan UI. It closes as soon as both players have
 * kept — or the moment anything leaves the untap step by another route (an
 * explicit `nextStep`, or a test driving the state directly).
 */
function openingWindowOpen(s: GameState): boolean {
  return (
    s.turnNumber === 1 &&
    s.step === "untap" &&
    // The very FIRST untap of the game — not the second player's turn-1 untap,
    // which is an ordinary step the flow should walk straight through.
    s.activePlayerId === s.startingPlayerId &&
    (s.openingHandKept?.length ?? 0) < 2
  );
}

/** v15: auto-pass is opt-OUT — an absent flag means on. */
function autoPassOn(s: GameState, playerId: string): boolean {
  return s.autoPass?.[playerId] !== false;
}

/**
 * v15: which player, if either, currently owes a combat declaration. CR
 * 508.1/509.1 make declaring a TURN-BASED action, so while a window is open
 * nobody has priority and the step cannot end.
 */
function openDeclaration(s: GameState): { kind: "attackers" | "blockers"; playerId: string } | null {
  const combat = s.combat;
  if (!combat) return null;
  if (s.step === "declareAttackers" && !combat.attackersDeclared) {
    return { kind: "attackers", playerId: s.activePlayerId };
  }
  if (s.step === "declareBlockers" && !combat.blockersDeclared) {
    const defender = s.players.find((p) => p.playerId !== s.activePlayerId);
    if (defender) return { kind: "blockers", playerId: defender.playerId };
  }
  return null;
}

/**
 * Does this open declaration window need a human? Auto-pass may only close a
 * window that offers no decision at all — nothing already declared AND
 * nothing left that could be declared. Once a player has put even one
 * creature in, the commit is always theirs to make: the tap happens as you
 * click (CR 508.1f), so "everything I own is now tapped" must not be mistaken
 * for "I have nothing to decide" and confirm the attack out from under them.
 */
export function declarationNeedsPlayer(
  s: GameState,
  playerId: string,
  kind: "attackers" | "blockers"
): boolean {
  const p = s.players.find((x) => x.playerId === playerId);
  if (!p) return false;
  const alreadyDeclared = p.zones.battlefield.some((c) =>
    kind === "attackers" ? c.attacking : c.blocking !== null
  );
  if (alreadyDeclared) return true;
  // Nothing to block if nothing is attacking.
  if (kind === "blockers" && !anyAttackers(s)) return false;
  return p.zones.battlefield.some((c) => !c.tapped && isCreature(c));
}

function anyAttackers(s: GameState): boolean {
  return s.players.some((p) => p.zones.battlefield.some((c) => c.attacking));
}

/** Type-line creature check (token-aware); false without card data. */
function isCreature(card: GameCard): boolean {
  const tl = typeLineOfCard(card);
  return tl !== undefined && /\bCreature\b/i.test(tl);
}

/**
 * v15: "stops" — priority windows the engine never auto-passes through, even
 * with nothing to do. The active player always gets a beat in their own main
 * phases, which is what makes the single Next button meaningful (main1 →
 * combat is a deliberate press, not something the flow blows past).
 * Everything else is governed by `hasLegalAction`.
 */
function isStop(s: GameState, playerId: string): boolean {
  return playerId === s.activePlayerId && isMainPhase(s.step) && s.stack.length === 0;
}

/**
 * v15: does this player have ANY action available right now? This is the one
 * definition of "can act", shared by the engine's auto-pass and the client's
 * action button — before v15 the client kept its own copy and the two could
 * disagree.
 *
 * Deliberately CONSERVATIVE where the engine can't tell: without card data
 * (a context-less engine) nothing can be classified as castable, so this
 * returns false and auto-pass keeps the game flowing. Casting itself stays
 * permissive in that situation, exactly as v5 cost enforcement does — a
 * player can still act manually, they just aren't waited for.
 */
export function hasLegalAction(s: GameState, playerId: string, context: ActionContext = ctx): boolean {
  const p = s.players.find((x) => x.playerId === playerId);
  if (!p || p.hasLost || s.finished) return false;

  // A target choice this player owes is an action — never auto-pass past it,
  // or the stack would deadlock at priorityPasses 2 with nothing resolving.
  const top = s.stack[s.stack.length - 1];
  if (top && top.controllerId === playerId && topNeedsFreshTarget(s)) return true;

  const cards = context.cards;
  if (!cards) return false;

  const isActive = s.activePlayerId === playerId;
  const sorcerySpeedOk = isActive && isMainPhase(s.step) && s.stack.length === 0;

  for (const gc of p.zones.hand) {
    const data = cards[gc.cardId];
    if (!data) continue;
    const tl = data.faces?.[0]?.typeLine ?? data.typeLine;
    if (/\bLand\b/i.test(tl)) {
      // CR 305.1/305.2: own main phase, empty stack, land drop unspent.
      if (sorcerySpeedOk && p.landsPlayedThisTurn < 1) return true;
      continue;
    }
    if (!hasInstantSpeed(data) && !sorcerySpeedOk) continue;
    if (canPayFor(data, p, cards)) return true;
  }

  for (const gc of p.zones.battlefield) {
    if (gc.isToken || gc.faceDown) continue;
    const activated = context.scripts?.[gc.cardId]?.activated ?? [];
    if (activated.some((a) => !a.costTap || !gc.tapped)) return true;
  }
  return false;
}

/**
 * v15: the single post-action driver. Replaces v12's `autoAdvanceTransit`,
 * v13's inline auto-resolve call and v14's inline step advance.
 *
 * Each iteration: put triggers on the stack (CR 117.5), then take the one
 * automatic thing the rules or the players' shortcuts call for — completing a
 * priority-less step (CR 500.3), closing an empty declaration window, or
 * passing priority for a player who has nothing to do (CR 732). It stops the
 * moment a real decision is owed by a human.
 */
function runFlow(s: GameState, logs: LogLine[]): void {
  for (let guard = 0; guard < FLOW_GUARD; guard++) {
    runTriggerMatching(s, logs);
    if (s.finished || s.pendingSearch || s.players.some((p) => p.hasLost)) return;
    if (openingWindowOpen(s)) return;

    // CR 500.3: untap and (normally) cleanup grant no priority — they end as
    // soon as their turn-based actions are done. CR 514.3a: a cleanup that
    // put triggers on the stack DOES grant priority, and is followed by
    // another cleanup step.
    if (!STEP_INFO[s.step].grantsPriority && !(s.step === "cleanup" && s.stack.length > 0)) {
      advanceToNextStep(s, logs);
      continue;
    }

    const declaration = openDeclaration(s);
    if (declaration) {
      // A declaration window is not a priority window — only the declaring
      // player can end it, and only auto-pass may do so on their behalf when
      // they have nothing to declare.
      if (!autoPassOn(s, declaration.playerId)) return;
      if (declarationNeedsPlayer(s, declaration.playerId, declaration.kind)) return;
      commitDeclaration(s, declaration.kind, logs);
      continue;
    }

    // Deadlock guard: both players have passed but the top of the stack is
    // waiting on a target choice its controller must make by hand.
    if (s.priorityPasses >= 2 && s.stack.length > 0) return;

    const holder = s.priorityPlayerId;
    if (!autoPassOn(s, holder)) return;
    if (isStop(s, holder)) return;
    if (hasLegalAction(s, holder)) return;
    passPriorityFor(s, holder, logs, true);
  }
}

/**
 * The consequences of one player passing priority (CR 117.4): with both
 * players passed in succession, either the top of the stack resolves or — on
 * an empty stack — the step ends. Shared by the `passPriority` action and the
 * flow driver's auto-pass.
 */
function passPriorityFor(s: GameState, playerId: string, logs: LogLine[], automatic: boolean): void {
  const other = s.players.find((p) => p.playerId !== playerId);
  if (!other) return;
  s.priorityPlayerId = other.playerId;
  s.priorityPasses = Math.min(2, s.priorityPasses + 1);
  if (!automatic) logs.push("passed priority");

  if (s.priorityPasses < 2) return;
  if (s.stack.length > 0) {
    // CR 117.4: the top of the stack resolves — it is not a separate action.
    // An entry still awaiting a fresh target choice waits for its controller.
    if (!topNeedsFreshTarget(s)) {
      resolveStackTop(s, s.activePlayerId, { type: "resolveTopOfStack" }, logs);
    }
    return;
  }
  // CR 117.4/500.2: all players passed with an empty stack — the step ends.
  advanceToNextStep(s, logs);
}

/** Close an open declaration window (CR 508.1 / 509.1). */
function commitDeclaration(s: GameState, kind: "attackers" | "blockers", logs: LogLine[]): void {
  const combat = s.combat!;
  if (kind === "attackers") {
    const active = s.players.find((p) => p.playerId === s.activePlayerId)!;
    const declared = [...active.zones.battlefield]
      .filter((c) => c.attacking)
      .sort((a, b) => a.sortIndex - b.sortIndex);
    combat.attackersDeclared = true;
    combat.attackersThisCombat = declared.length;
    // CR 508.1m/508.2b: attack triggers fire once, here, after the whole
    // declaration — not per click, which would double-fire on a re-toggle.
    for (const c of declared) {
      const firstThisCombat = s.attackDeclaredThisCombat !== true;
      s.attackDeclaredThisCombat = true;
      emitEvent({
        kind: "attackDeclared",
        instanceId: c.instanceId,
        controllerId: c.controllerId,
        firstThisCombat,
      });
    }
    logs.push({
      playerId: active.playerId,
      message:
        declared.length === 0
          ? "declared no attackers"
          : `declared ${declared.length} attacker${declared.length === 1 ? "" : "s"}: ${declared
              .map((c) => cardLabel(c))
              .join(", ")}`,
    });
  } else {
    const defender = s.players.find((p) => p.playerId !== s.activePlayerId)!;
    const declared = defender.zones.battlefield.filter((c) => c.blocking !== null);
    combat.blockersDeclared = true;
    logs.push({
      playerId: defender.playerId,
      message:
        declared.length === 0
          ? "declared no blockers"
          : `declared ${declared.length} blocker${declared.length === 1 ? "" : "s"}: ${declared
              .map((c) => cardLabel(c))
              .join(", ")}`,
    });
  }
  // CR 508.2 / 509.2: the ACTIVE player receives priority once the
  // declaration is complete — for blockers too, not the defender who just
  // declared them.
  s.priorityPlayerId = s.activePlayerId;
  s.priorityPasses = 0;
}

/** Advance to the next step within the turn, applying turn-based effects. */
function enterStep(s: GameState, step: TurnStep, logs: LogLine[]): void {
  s.step = step;
  s.priorityPlayerId = s.activePlayerId;
  s.priorityPasses = 0;
  // Floating mana empties at EVERY step boundary, for both players.
  for (const p of s.players) p.manaPool = {};
  const active = s.players.find((p) => p.playerId === s.activePlayerId)!;
  const inactive = s.players.find((p) => p.playerId !== s.activePlayerId)!;

  // A new combat (or leaving one) re-arms the "whenever you attack" trigger
  // and re-opens both declaration windows (CR 508.1/509.1).
  if (step === "beginCombat" || step === "endCombat") {
    s.attackDeclaredThisCombat = false;
    s.combat = freshCombat();
  }

  emitEvent({ kind: "stepEntered", step, activePlayerId: s.activePlayerId });

  if (step === "untap") {
    untapStep(active, logs);
  } else if (step === "draw") {
    const skipFirstDraw = s.turnNumber === 1 && s.activePlayerId === s.startingPlayerId;
    if (!skipFirstDraw) {
      const drawn = drawCards(active, 1, "drawStep");
      logs.push({
        playerId: s.activePlayerId,
        message: `moved to the draw step and drew ${drawn} card${drawn === 1 ? "" : "s"}`,
      });
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
  logs.push({ playerId: s.activePlayerId, message: `moved to the ${step} step` });
}

/** End the current turn: swap active player, then run the new untap step. */
function advanceTurn(s: GameState, logs: LogLine[]): void {
  // Cleanup semantics apply even when the turn is ended early via nextTurn
  // (mana pools also empty here — every step transition clears them).
  for (const p of s.players) {
    p.manaPool = {};
    for (const c of p.zones.battlefield) c.damage = 0;
  }
  removeFromCombat(s);

  const current = s.players.find((p) => p.playerId === s.activePlayerId)!;
  const next = s.players.find((p) => p.playerId !== s.activePlayerId)!;
  s.activePlayerId = next.playerId;
  if (next.playerId === s.startingPlayerId) s.turnNumber += 1;
  current.landsPlayedThisTurn = 0;
  next.landsPlayedThisTurn = 0;
  s.attackDeclaredThisCombat = false;
  s.combat = freshCombat();

  logs.push({
    playerId: current.playerId,
    message: `ended their turn; turn ${s.turnNumber}, ${playerLabel(next.playerId)} is now active`,
  });
  // v15: the incoming untap step runs through the same path as any other
  // step entry (turn-based actions + stepEntered event), instead of the
  // hand-rolled untap advanceTurn used to inline.
  enterStep(s, "untap", logs);
}

/**
 * Rebuild both libraries from every non-token card each player owns across
 * all zones except sideboard (sideboards are preserved), reshuffle with the
 * new seed, redraw 7, reset life/poison/mana/turn. The starting player flips.
 */
function restartGame(s: GameState, seed: string, logs: LogLine[]): void {
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
  // v15: a restart re-opens the mulligan window and clears any live combat.
  s.combat = freshCombat();
  s.openingHandKept = [];
  s.openingMulligans = {};
  s.attackDeclaredThisCombat = false;
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
