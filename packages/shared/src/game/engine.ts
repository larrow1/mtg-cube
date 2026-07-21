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
 * Triggered abilities (v3): when the server passes `scripts` in the
 * ActionContext, the engine pushes trigger pseudo-cards onto the stack
 * (`isTrigger`, instanceId `tr{seq}-{n}`) at these emission points:
 *  - etb: a card enters the battlefield (moveCard or resolveTopOfStack);
 *  - dies: battlefield -> graveyard;
 *  - leaves: battlefield -> any non-battlefield zone. If the destination is
 *    the graveyard AND the card's script has a "dies" trigger, only "dies"
 *    fires (no double-fire); otherwise "leaves" covers death too;
 *  - upkeep: entering the upkeep step, active player's permanents;
 *  - eachUpkeep: entering the upkeep step, BOTH players' permanents
 *    (controller = the permanent's controller);
 *  - endStep: entering the end step, active player's permanents;
 *  - attack: setAttacking {attacking:true} (never on un-declaring);
 *  - castSpell: moveCard from hand/graveyard/exile/library to the stack fires
 *    castSpell triggers on the caster's own battlefield permanents, honoring
 *    each trigger's castFilter against the cast card's typeLine. Triggers land
 *    ABOVE the cast spell (fire after it, resolve before it);
 *  - combatDamageToPlayer: entering the combatDamage step, each attacking
 *    creature of the active player with no opposing creature blocking it.
 * Trigger pseudo-cards only ever live on the stack: resolve applies the
 * effect, counter removes them, declineTrigger (controller + optional only)
 * removes them from any position, restartGame drops them, and moveCard
 * refuses to touch them.
 */
import type {
  CardData,
  CardScript,
  GameAction,
  GameCard,
  GameState,
  PlayerGameState,
  SearchFilter,
  SpawnZone,
  TargetRef,
  TriggerEffect,
  TriggerEvent,
  TurnStep,
  ZoneName,
} from "../types.js";
import { TURN_STEPS } from "../types.js";
import { createRng, shuffle } from "../rng.js";
import {
  describePoolSpend,
  manaSourcesOf,
  parseManaCost,
  parsedCostSize,
  planManaPayment,
} from "./mana.js";

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
  triggerCounter = 0;
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
      // v6: manual-override draws are real draws — the opponent's permanents
      // see them (opponentDraws), once per card drawn (CR 121.2).
      emitOpponentDrawTriggers(s, actor, drawn, logs);
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
          fetched.controllerId = actor.playerId;
          fetched.tapped = search.entersTapped;
          fetched.sortIndex = actor.zones.battlefield.length;
          actor.zones.battlefield.push(fetched);
          logs.push(
            `searched their library with ${search.sourceName} and put ${cardLabel(fetched)} onto the battlefield${
              search.entersTapped ? " tapped" : ""
            }`
          );
        } else {
          actor.zones.hand.push(fetched);
          logs.push(
            `searched their library with ${search.sourceName} and put ${cardLabel(fetched)} into their hand`
          );
        }
      } else {
        logs.push(`searched their library with ${search.sourceName} and failed to find`);
      }
      if (search.shuffle) {
        actor.zones.library = shuffle(actor.zones.library, createRng(`${s.id}:search:${s.seq + 1}`));
        logs.push("shuffled their library");
      }
      s.pendingSearch = null;
      if (fetched && search.destination === "battlefield") {
        pushTriggers(s, fetched, actor.playerId, "etb", logs);
      }
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
      const card = findControlled(actor, action.instanceId, ["battlefield"]);
      const wasAttacking = card.attacking;
      card.attacking = action.attacking;
      logs.push(`${action.attacking ? "declared" : "removed"} ${cardLabel(card)} as an attacker`);
      // Attack triggers fire on declaring only (never on un-declaring, and
      // not again when a redundant setAttacking(true) repeats the state).
      if (action.attacking && !wasAttacking) {
        pushTriggers(s, card, card.controllerId, "attack", logs);
      }
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
      if (card.isTrigger) {
        // v6: targeted triggers — the CONTROLLER chooses a legal target at
        // resolution (house rule; real Magic picks at stack time, CR 603.3d).
        let target: TargetRef | undefined;
        if (effectNeedsTarget(card.triggerEffect)) {
          if (card.controllerId !== actorId) {
            throw new EngineError("Only the trigger's controller may resolve it (they choose its target)");
          }
          target = action.target;
          if (!target) {
            throw new EngineError(
              `The trigger from ${cardLabel(card)} needs a target — choose a creature, player, or other permanent`
            );
          }
          const allowedKinds = effectTargetKinds(card.triggerEffect);
          if (!allowedKinds.includes(target.kind)) {
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
              throw new EngineError("Only spells can be targeted on the stack (abilities use the Counter button)");
            }
          } else if (!findOnAnyBattlefield(s, target.instanceId)) {
            throw new EngineError(`Target ${target.instanceId} is not on the battlefield`);
          }
        }
        resolveTrigger(s, card, logs, target);
        break;
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
        resetCardState(card);
        owner.zones.graveyard.push(card);
        const effects = ctx.scripts?.[card.cardId]?.onResolve?.effects;
        if (effects && effects.length > 0) {
          // v7: the spell's EFFECT becomes its own stack entry (house model —
          // the card is already in the graveyard); resolving the entry applies
          // the effects through the trigger executor, target picker included.
          const effect: TriggerEffect =
            effects.length === 1 ? effects[0]! : { kind: "seq", effects };
          const entry: GameCard = {
            instanceId: `se${s.seq + 1}-${triggerCounter++}`,
            cardId: card.cardId,
            ownerId: spellController,
            controllerId: spellController,
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
            triggerText: ctx.cards?.[card.cardId]?.oracleText ?? `Effect of ${spellName}`,
            triggerEffect: effect,
            triggerOptional: false,
            triggerSourceId: card.instanceId,
          };
          s.stack.push(entry);
          logs.push(
            `resolved ${spellName} — its effect went on the stack (the card is in the graveyard)`
          );
        } else {
          logs.push(
            `resolved ${cardLabel(card)} — carry out its effects by hand (it was put into the graveyard)`
          );
        }
        break;
      }
      const controller = s.players.find((p) => p.playerId === card.controllerId) ?? actor;
      card.sortIndex = controller.zones.battlefield.length;
      controller.zones.battlefield.push(card);
      logs.push(`resolved ${cardLabel(card)} onto the battlefield`);
      pushTriggers(s, card, controller.playerId, "etb", logs);
      break;
    }

    case "counterTopOfStack": {
      const card = s.stack.pop();
      if (!card) throw new EngineError("The stack is empty");
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
        card.sortIndex = actor.zones.battlefield.length;
        actor.zones.battlefield.push(card);
      } else if (action.zone === "library") {
        actor.zones.library.unshift(card); // top of the library
      } else {
        actor.zones[action.zone].push(card);
      }
      const dest = action.zone === "library" ? "the top of their library" : `their ${action.zone}`;
      logs.push(`conjured ${cardLabel(card)} into ${dest} (sandbox)`);
      if (action.zone === "battlefield") {
        pushTriggers(s, card, actor.playerId, "etb", logs);
      }
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
  }
  logs.push(`${logPrefix}created ${opts.count} ${opts.name} token${opts.count === 1 ? "" : "s"}`);
}

/** Does `card`'s script contain at least one trigger of `event`? */
function hasTriggerFor(card: GameCard, event: TriggerEvent): boolean {
  if (card.isToken || card.isTrigger) return false;
  return ctx.scripts?.[card.cardId]?.triggers.some((t) => t.event === event) ?? false;
}

/**
 * Push every scripted trigger of `event` on `source` onto the stack as a
 * pseudo-card controlled by `controllerId`. No-op without a scripts context,
 * for tokens (no CardData), and for cards whose script lacks the event.
 * `accept` (optional) further filters individual triggers (castSpell filters).
 */
function pushTriggers(
  s: GameState,
  source: GameCard,
  controllerId: string,
  event: TriggerEvent,
  logs: string[],
  accept?: (t: CardScript["triggers"][number]) => boolean
): void {
  if (source.isToken || source.isTrigger) return;
  const script = ctx.scripts?.[source.cardId];
  if (!script) return;
  for (const t of script.triggers) {
    if (t.event !== event) continue;
    if (accept && !accept(t)) continue;
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
 * Apply a resolving trigger's effect for its CONTROLLER (not the actor —
 * either player may click resolve, except targeted triggers, which only the
 * controller resolves). State-based checks after the action pick up any
 * resulting loss.
 */
function resolveTrigger(s: GameState, trigger: GameCard, logs: string[], target?: TargetRef): void {
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
  applyEffect(s, controller, opponent, effect, `${cardLabel(trigger)} trigger`, trigger.triggerSourceId, logs, target);
}

/**
 * Mechanically apply one TriggerEffect for `controller` — shared by trigger
 * resolution and instant/sorcery onResolve scripts. `sourceId` is the
 * battlefield permanent counters land on; effects that need one (addCounters)
 * fizzle-log when it is undefined or gone. `label` names the source in the
 * log ("Wall of Omens trigger", "Night's Whisper").
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
  const who = playerLabel(controller.playerId);

  switch (effect.kind) {
    case "draw": {
      const drawn = drawCards(controller, effect.count);
      logs.push(`resolved ${label}: ${who} drew ${drawn} card${drawn === 1 ? "" : "s"}`);
      // v6: a scripted draw is a real draw — the drawer's opponent's
      // permanents see it (once per card, CR 121.2).
      emitOpponentDrawTriggers(s, controller, drawn, logs);
      break;
    }
    case "gainLife": {
      controller.life += effect.amount;
      logs.push(`resolved ${label}: ${who} gained ${effect.amount} life`);
      break;
    }
    case "loseLife": {
      controller.life -= effect.amount;
      logs.push(`resolved ${label}: ${who} lost ${effect.amount} life`);
      break;
    }
    case "eachOpponentLosesLife": {
      opponent.life -= effect.amount;
      logs.push(`resolved ${label}: ${playerLabel(opponent.playerId)} lost ${effect.amount} life`);
      break;
    }
    case "damageOpponent": {
      opponent.life -= effect.amount;
      logs.push(
        `resolved ${label}: dealt ${effect.amount} damage to ${playerLabel(opponent.playerId)}`
      );
      break;
    }
    case "addCounters": {
      // Counters land on the SOURCE permanent — if it already left its
      // controller's battlefield (or never had one: a resolving spell),
      // the effect fizzles (logged, no effect).
      const source = sourceId
        ? controller.zones.battlefield.find((c) => c.instanceId === sourceId)
        : undefined;
      if (!source) {
        logs.push(`${label} fizzled: its source is no longer on the battlefield`);
        break;
      }
      source.counters[effect.counterType] = (source.counters[effect.counterType] ?? 0) + effect.count;
      logs.push(
        `resolved ${label}: put ${effect.count} ${effect.counterType} counter${
          effect.count === 1 ? "" : "s"
        } on ${cardLabel(source)}`
      );
      break;
    }
    case "createToken": {
      spawnTokens(
        s,
        controller,
        {
          name: effect.name,
          typeLine: effect.typeLine,
          ...(effect.power !== undefined ? { power: effect.power } : {}),
          ...(effect.toughness !== undefined ? { toughness: effect.toughness } : {}),
          count: effect.count,
          tapped: false,
        },
        logs,
        `resolved ${label}: `
      );
      break;
    }
    case "scry": {
      // Log-only, like the scry action: the client follows up with
      // scry/reorderLibraryTop to actually look and reorder.
      logs.push(`resolved ${label}: ${who} scries ${effect.count} (use scry to finish)`);
      break;
    }
    case "damageAnyTarget": {
      // Target validated by resolveTopOfStack; defensive fizzle otherwise
      // (spirit of CR 608.2b — a gone target is simply not affected).
      if (!target) {
        logs.push(`${label} fizzled: no target was chosen`);
        break;
      }
      if (target.kind === "player") {
        const p = s.players.find((pl) => pl.playerId === target.playerId);
        if (!p) {
          logs.push(`${label} fizzled: its target player is gone`);
          break;
        }
        p.life -= effect.amount;
        logs.push(`resolved ${label}: dealt ${effect.amount} damage to ${playerLabel(p.playerId)}`);
      } else {
        const permanent = findOnAnyBattlefield(s, target.instanceId);
        if (!permanent) {
          logs.push(`${label} fizzled: its target left the battlefield`);
          break;
        }
        permanent.damage += effect.amount;
        logs.push(`resolved ${label}: dealt ${effect.amount} damage to ${cardLabel(permanent)}`);
      }
      break;
    }
    case "amass": {
      // CR 701.47a. "Army" is matched on the (token)type line; the first Army
      // in battlefield order gets the counters (controller's choice is not
      // modeled). Subtype addition is logged, not tracked.
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
            name: `${effect.subtype} Army`,
            typeLine: `Token Creature — ${effect.subtype} Army`,
            power: "0",
            toughness: "0",
            count: 1,
            tapped: false,
          },
          logs,
          `resolved ${label}: `
        );
        army = controller.zones.battlefield[controller.zones.battlefield.length - 1];
      }
      if (army) {
        army.counters["+1/+1"] = (army.counters["+1/+1"] ?? 0) + effect.count;
        logs.push(
          `amassed ${effect.subtype} ${effect.count}: put ${effect.count} +1/+1 counter${
            effect.count === 1 ? "" : "s"
          } on ${cardLabel(army)}`
        );
      }
      break;
    }
    case "counterTarget": {
      if (!target || target.kind !== "stack") {
        logs.push(`${label} fizzled: no spell was targeted`);
        break;
      }
      const idx = s.stack.findIndex((c) => c.instanceId === target.instanceId);
      const spell = idx === -1 ? undefined : s.stack[idx]!;
      if (!spell || spell.isTrigger) {
        logs.push(`${label} fizzled: its target is no longer a spell on the stack`);
        break;
      }
      s.stack.splice(idx, 1);
      if (spell.isToken) {
        logs.push(`resolved ${label}: countered ${cardLabel(spell)} (token ceased to exist)`);
      } else {
        const spellOwner = s.players.find((p) => p.playerId === spell.ownerId) ?? controller;
        resetCardState(spell);
        spellOwner.zones.graveyard.push(spell);
        logs.push(`resolved ${label}: countered ${cardLabel(spell)}`);
      }
      break;
    }
    case "seq": {
      for (const sub of effect.effects) {
        applyEffect(s, controller, opponent, sub, label, sourceId, logs, target);
      }
      break;
    }
    case "manual": {
      logs.push(`resolved ${label} — carry it out by hand: ${effect.note}`);
      break;
    }
  }
}

/**
 * v6: fire `opponentDraws` triggers on the battlefield of the DRAWER's
 * opponent, once per card actually drawn (CR 121.2). Callers are the real
 * draw events only — the turn-based draw-step draw and mulligan/setup draws
 * are exempt by simply never calling this (the event is defined with the
 * Orcish Bowmasters exemption built in).
 */
function emitOpponentDrawTriggers(
  s: GameState,
  drawer: PlayerGameState,
  count: number,
  logs: string[]
): void {
  if (count <= 0) return;
  const watcher = s.players.find((p) => p.playerId !== drawer.playerId);
  if (!watcher) return;
  const sorted = [...watcher.zones.battlefield].sort((a, b) => a.sortIndex - b.sortIndex);
  for (let i = 0; i < count; i++) {
    for (const permanent of sorted) {
      pushTriggers(s, permanent, permanent.controllerId, "opponentDraws", logs);
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

  // Triggered abilities. (Tokens that ceased to exist returned above and
  // have no scripts anyway.)
  if (to === "battlefield") {
    pushTriggers(s, card, card.controllerId, "etb", logs);
  } else if (wasOnBattlefield) {
    // Leaving the battlefield: death fires "dies" when the script has one;
    // otherwise "leaves" covers every departure, the graveyard included.
    // A script with BOTH events fires only "dies" on death (no double-fire).
    if (to === "graveyard" && hasTriggerFor(card, "dies")) {
      pushTriggers(s, card, actor.playerId, "dies", logs);
    } else {
      pushTriggers(s, card, actor.playerId, "leaves", logs);
    }
  } else if (to === "stack" && (from === "hand" || from === "graveyard" || from === "exile" || from === "library")) {
    // v5: only hand-casts are cost-enforced; note the gap for other zones
    // (flashback, reanimation shortcuts, ...) so it is never silent.
    if (from !== "hand") {
      const castData = ctx.cards?.[card.cardId];
      const rawCost = castData?.faces?.[0]?.manaCost ?? castData?.manaCost;
      if (rawCost) logs.push(`(cost ${rawCost} is not enforced when casting from the ${from})`);
    }
    // Casting a spell: castSpell triggers fire on the caster's OWN battlefield
    // permanents (never on the spell itself), filtered by each trigger's
    // castFilter against the cast card's typeLine. They are pushed after the
    // spell, so they sit ABOVE it on the stack and resolve first.
    const typeLine = frontTypeLine(card);
    const permanents = [...actor.zones.battlefield].sort((a, b) => a.sortIndex - b.sortIndex);
    for (const permanent of permanents) {
      pushTriggers(s, permanent, permanent.controllerId, "castSpell", logs, (t) =>
        castFilterMatches(t.castFilter, typeLine)
      );
    }
  }
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

  if (isLand && to === "battlefield") {
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
      }
    }
    parts.push(`tapped ${names.join(", ")}`);
  }
  const xNote = cost.x > 0 ? " (X not auto-charged)" : "";
  logs.push(`auto-paid ${rawCost} for ${cardLabel(card)}${xNote}${parts.length ? ` — ${parts.join("; ")}` : ""}`);
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

/** Advance to the next step within the turn, applying turn-based effects. */
function enterStep(s: GameState, step: TurnStep, logs: string[]): void {
  s.step = step;
  s.priorityPlayerId = s.activePlayerId;
  // Floating mana empties at EVERY step boundary, for both players.
  for (const p of s.players) p.manaPool = {};
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
      for (const c of p.zones.battlefield) c.damage = 0;
    }
  }
  logs.push(`moved to the ${step} step`);
  emitStepTriggers(s, step, logs);
}

/** Step-entry trigger emission (upkeep/eachUpkeep/endStep/combatDamageToPlayer). */
function emitStepTriggers(s: GameState, step: TurnStep, logs: string[]): void {
  const active = s.players.find((p) => p.playerId === s.activePlayerId)!;
  const inactive = s.players.find((p) => p.playerId !== s.activePlayerId)!;
  const sorted = (p: PlayerGameState) =>
    [...p.zones.battlefield].sort((a, b) => a.sortIndex - b.sortIndex);

  if (step === "upkeep") {
    // "upkeep" is controller-only (the active player); "eachUpkeep" fires for
    // BOTH players' permanents, each controlled by its own controller.
    for (const c of sorted(active)) {
      pushTriggers(s, c, c.controllerId, "upkeep", logs);
      pushTriggers(s, c, c.controllerId, "eachUpkeep", logs);
    }
    for (const c of sorted(inactive)) pushTriggers(s, c, c.controllerId, "eachUpkeep", logs);
  } else if (step === "end") {
    for (const c of sorted(active)) pushTriggers(s, c, c.controllerId, "endStep", logs);
  } else if (step === "combatDamage") {
    // Each attacking creature of the active player with no opposing creature
    // blocking it. These are ordinary stack triggers, so they can be
    // countered/declined when the damage was actually prevented.
    for (const c of sorted(active)) {
      if (!c.attacking) continue;
      const blocked = inactive.zones.battlefield.some((b) => b.blocking === c.instanceId);
      if (!blocked) pushTriggers(s, c, c.controllerId, "combatDamageToPlayer", logs);
    }
  }
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
