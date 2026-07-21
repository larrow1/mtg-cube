/**
 * v9/v10 regression tests — declarative GameEvent trigger conditions
 * (CardTrigger.when) and the effect task pipeline (replacements, task
 * compilation, log coalescing).
 *
 * Scripted games only: build CardScripts by hand with `when` TriggerConditions
 * (the legacy `event` field is inert when `when` is present) and assert stack
 * contents, zones, life totals, and logs.
 */
import { describe, expect, it } from "vitest";
import type {
  CardData,
  CardScript,
  GameCard,
  GameState,
  TriggerCondition,
  TriggerEffect,
  ZoneName,
} from "../src/types.js";
import { applyAction, createGame } from "../src/game/engine.js";

// ---------------------------------------------------------------------------
// Helpers (modeled on test/game.test.ts)
// ---------------------------------------------------------------------------

function mkCard(owner: string, i: number): GameCard {
  return {
    instanceId: `${owner}_card${i}`,
    cardId: `${owner}-c${i}`,
    ownerId: owner,
    controllerId: owner,
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

function mkDeck(owner: string, size = 40): GameCard[] {
  return Array.from({ length: size }, (_, i) => mkCard(owner, i));
}

function newGame(seed = "events-seed"): GameState {
  return createGame(
    "g1",
    [
      { playerId: "p1", deck: mkDeck("p1") },
      { playerId: "p2", deck: mkDeck("p2") },
    ],
    seed
  );
}

function player(s: GameState, id: string) {
  return s.players.find((p) => p.playerId === id)!;
}

function other(s: GameState, id: string): string {
  return s.players.find((p) => p.playerId !== id)!.playerId;
}

/**
 * v11: resolveTopOfStack/counterTopOfStack require both players to have
 * passed priority in succession (CR 117.4). Keyed off `s.priorityPlayerId`
 * since who passes first depends on who last touched the stack.
 */
function bothPass(s: GameState): GameState {
  const s1 = applyAction(s, s.priorityPlayerId, { type: "passPriority" });
  return applyAction(s1, s1.priorityPlayerId, { type: "passPriority" });
}

/** Put a bespoke card (cardId/instanceId) into a player's zone. */
let putSeq = 900;
function put(s: GameState, owner: string, zone: ZoneName, cardId: string, instanceId: string): GameCard {
  const c = mkCard(owner, putSeq++);
  c.cardId = cardId;
  c.instanceId = instanceId;
  player(s, owner).zones[zone].push(c);
  return c;
}

/** Minimal CardData with an explicit type line (no mana cost = casts free). */
function data(id: string, typeLine: string, producedMana?: string[]): CardData {
  return {
    id,
    name: `Card ${id}`,
    cmc: 0,
    typeLine,
    colors: [],
    colorIdentity: [],
    layout: "normal",
    ...(producedMana ? { producedMana } : {}),
  };
}

/**
 * One-trigger CardScript built from a v9 `when` condition. The legacy `event`
 * field is set to an arbitrary value ("etb") and must be IGNORED by the
 * engine whenever `when` is present.
 */
function whenScript(
  when: TriggerCondition,
  effect: TriggerEffect,
  description = "test when trigger",
  optional = false
): CardScript {
  return { triggers: [{ event: "etb", when, optional, description, effect }] };
}

/** Trigger pseudo-cards on the stack originating from a given source instance. */
function triggersFrom(s: GameState, sourceInstanceId: string): GameCard[] {
  return s.stack.filter((c) => c.isTrigger && c.triggerSourceId === sourceInstanceId);
}

function logCount(s: GameState, re: RegExp): number {
  return s.log.filter((e) => re.test(e.message)).length;
}

// ---------------------------------------------------------------------------
// V9: declarative trigger conditions
// ---------------------------------------------------------------------------

describe("v9 zoneChange other/entersBattlefield observers", () => {
  const observerWhen: TriggerCondition = {
    on: "zoneChange",
    which: "other",
    move: "entersBattlefield",
    controller: "you",
    card: { types: ["Creature"] },
  };

  function setup() {
    const g = newGame();
    put(g, "p1", "battlefield", "watch", "w1");
    const ctx = {
      cards: {
        watch: data("watch", "Creature — Wall"),
        bear: data("bear", "Creature — Bear"),
      },
      scripts: {
        watch: whenScript(observerWhen, { kind: "gainLife", amount: 1 }, "another creature enters"),
      },
    };
    return { g, ctx };
  }

  it("fires when ANOTHER creature I control enters via stack resolution", () => {
    const { g, ctx } = setup();
    put(g, "p1", "hand", "bear", "bear1");
    // Cast (hand -> stack), then resolve — arrival happens at resolution.
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "bear1", from: "hand", to: "stack" }, 0, ctx);
    expect(triggersFrom(s, "w1")).toHaveLength(0); // casting alone is not an arrival
    s = bothPass(s);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p1").zones.battlefield.map((c) => c.instanceId)).toContain("bear1");
    const trig = triggersFrom(s, "w1");
    expect(trig).toHaveLength(1);
    expect(trig[0]!.controllerId).toBe("p1");
    expect(trig[0]!.cardId).toBe("watch");
    // Resolving the observer trigger gains ITS controller the life.
    s = bothPass(s);
    s = applyAction(s, "p2", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p1").life).toBe(21);
  });

  it("does NOT fire when the OPPONENT's creature enters (controller: you)", () => {
    const { g, ctx } = setup();
    put(g, "p2", "hand", "bear", "bear2");
    let s = applyAction(g, "p2", { type: "moveCard", instanceId: "bear2", from: "hand", to: "stack" }, 0, ctx);
    s = bothPass(s);
    s = applyAction(s, "p2", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p2").zones.battlefield.map((c) => c.instanceId)).toContain("bear2");
    expect(triggersFrom(s, "w1")).toHaveLength(0);
  });

  it("does NOT fire for its own arrival (which: other)", () => {
    const g = newGame();
    const ctx = {
      cards: { watch: data("watch", "Creature — Wall") },
      scripts: {
        watch: whenScript(observerWhen, { kind: "gainLife", amount: 1 }, "another creature enters"),
      },
    };
    put(g, "p1", "hand", "watch", "w2");
    // Creature typeLine: hand -> battlefield redirects through the stack (v7).
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "w2", from: "hand", to: "battlefield" }, 0, ctx);
    expect(s.stack.map((c) => c.instanceId)).toContain("w2");
    s = bothPass(s);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p1").zones.battlefield.map((c) => c.instanceId)).toContain("w2");
    expect(s.stack.filter((c) => c.isTrigger)).toHaveLength(0);
  });

  it("sees TOKEN arrivals; a nontoken filter does not", () => {
    const g = newGame();
    put(g, "p1", "battlefield", "watch", "w1");
    put(g, "p1", "battlefield", "strictwatch", "w3");
    const ctx = {
      cards: {
        watch: data("watch", "Creature — Wall"),
        strictwatch: data("strictwatch", "Creature — Wall"),
      },
      scripts: {
        watch: whenScript(observerWhen, { kind: "gainLife", amount: 1 }, "any creature enters"),
        strictwatch: whenScript(
          { ...observerWhen, card: { types: ["Creature"], nontoken: true } },
          { kind: "gainLife", amount: 2 },
          "nontoken creature enters"
        ),
      },
    };
    const s = applyAction(
      g,
      "p1",
      { type: "createToken", name: "Soldier", typeLine: "Token Creature — Soldier", power: "1", toughness: "1" },
      0,
      ctx
    );
    expect(player(s, "p1").zones.battlefield.some((c) => c.isToken)).toBe(true);
    expect(triggersFrom(s, "w1")).toHaveLength(1); // plain filter sees the token
    expect(triggersFrom(s, "w3")).toHaveLength(0); // nontoken:true excludes it
  });
});

describe("v9 landfall (zoneChange other/entersBattlefield Land)", () => {
  it("fires on a land play (direct hand -> battlefield path)", () => {
    const g = newGame();
    put(g, "p1", "battlefield", "cobra", "cobra1");
    put(g, "p1", "hand", "forest", "forest1");
    const ctx = {
      cards: {
        cobra: data("cobra", "Creature — Snake"),
        forest: data("forest", "Land — Forest"),
      },
      scripts: {
        cobra: whenScript(
          { on: "zoneChange", which: "other", move: "entersBattlefield", controller: "you", card: { types: ["Land"] } },
          { kind: "gainLife", amount: 1 },
          "landfall"
        ),
      },
    };
    const s = applyAction(
      g,
      "p1",
      { type: "moveCard", instanceId: "forest1", from: "hand", to: "battlefield" },
      0,
      ctx
    );
    // Lands never redirect through the stack — direct battlefield arrival.
    expect(player(s, "p1").zones.battlefield.map((c) => c.instanceId)).toContain("forest1");
    expect(s.stack.filter((c) => !c.isTrigger)).toHaveLength(0);
    expect(triggersFrom(s, "cobra1")).toHaveLength(1);
  });
});

describe("v9 other/dies with nontoken creature filter", () => {
  function setup() {
    const g = newGame();
    put(g, "p1", "battlefield", "titania", "tit1");
    put(g, "p1", "battlefield", "bear", "bear1");
    const ctx = {
      cards: {
        titania: data("titania", "Creature — Elemental"),
        bear: data("bear", "Creature — Bear"),
      },
      scripts: {
        titania: whenScript(
          { on: "zoneChange", which: "other", move: "dies", controller: "you", card: { types: ["Creature"], nontoken: true } },
          { kind: "gainLife", amount: 1 },
          "nontoken creature died"
        ),
      },
    };
    return { g, ctx };
  }

  it("fires when my nontoken creature dies", () => {
    const { g, ctx } = setup();
    const s = applyAction(
      g,
      "p1",
      { type: "moveCard", instanceId: "bear1", from: "battlefield", to: "graveyard" },
      0,
      ctx
    );
    expect(player(s, "p1").zones.graveyard.map((c) => c.instanceId)).toContain("bear1");
    expect(triggersFrom(s, "tit1")).toHaveLength(1);
  });

  it("does NOT fire when a token dies", () => {
    const { g, ctx } = setup();
    let s = applyAction(
      g,
      "p1",
      { type: "createToken", name: "Elemental", typeLine: "Token Creature — Elemental" },
      0,
      ctx
    );
    expect(triggersFrom(s, "tit1")).toHaveLength(0); // dies-only condition: arrival is silent
    const token = player(s, "p1").zones.battlefield.find((c) => c.isToken)!;
    s = applyAction(
      s,
      "p1",
      { type: "moveCard", instanceId: token.instanceId, from: "battlefield", to: "graveyard" },
      0,
      ctx
    );
    expect(s.log.some((e) => /ceased to exist/.test(e.message))).toBe(true);
    expect(triggersFrom(s, "tit1")).toHaveLength(0);
  });
});

describe("v9 stepEntered conditions", () => {
  it("beginCombat/yours fires for the active player's permanent only; upkeep/opponents for the non-active player's", () => {
    const g = newGame();
    const A = g.activePlayerId;
    const B = other(g, A);
    put(g, A, "battlefield", "a-combat", "ac1");
    put(g, B, "battlefield", "b-combat", "bc1");
    put(g, A, "battlefield", "a-oppupkeep", "ao1");
    put(g, B, "battlefield", "b-oppupkeep", "bo1");
    const ctx = {
      scripts: {
        "a-combat": whenScript({ on: "stepEntered", step: "beginCombat", whose: "yours" }, { kind: "scry", count: 1 }, "my combat"),
        "b-combat": whenScript({ on: "stepEntered", step: "beginCombat", whose: "yours" }, { kind: "scry", count: 1 }, "my combat"),
        "a-oppupkeep": whenScript({ on: "stepEntered", step: "upkeep", whose: "opponents" }, { kind: "scry", count: 1 }, "opp upkeep"),
        "b-oppupkeep": whenScript({ on: "stepEntered", step: "upkeep", whose: "opponents" }, { kind: "scry", count: 1 }, "opp upkeep"),
      },
    };
    // untap -> upkeep: the NON-active player's opponents-upkeep permanent fires.
    let s = applyAction(g, A, { type: "nextStep" }, 0, ctx);
    expect(s.step).toBe("upkeep");
    expect(triggersFrom(s, "bo1")).toHaveLength(1);
    expect(triggersFrom(s, "bo1")[0]!.controllerId).toBe(B);
    expect(triggersFrom(s, "ao1")).toHaveLength(0); // active player's own upkeep is not "an opponent's"
    expect(triggersFrom(s, "ac1")).toHaveLength(0);
    // Advance to beginCombat: only the ACTIVE player's beginCombat/yours fires.
    while (s.step !== "beginCombat") s = applyAction(s, A, { type: "nextStep" }, 0, ctx);
    expect(triggersFrom(s, "ac1")).toHaveLength(1);
    expect(triggersFrom(s, "ac1")[0]!.controllerId).toBe(A);
    expect(triggersFrom(s, "bc1")).toHaveLength(0);
  });
});

describe("v9 attackDeclared team vs self", () => {
  it("team fires once per combat on the first declaration; self (legacy) fires per creature; a new turn re-arms team", () => {
    const g = newGame();
    const A = g.activePlayerId;
    put(g, A, "battlefield", "adeline", "adl1");
    const a1 = put(g, A, "battlefield", "atk1", "atk1a");
    const a2 = put(g, A, "battlefield", "atk2", "atk2a");
    const ctx = {
      scripts: {
        adeline: whenScript({ on: "attackDeclared", which: "team" }, { kind: "gainLife", amount: 1 }, "whenever you attack"),
        atk1: { triggers: [{ event: "attack" as const, optional: false, description: "self attack 1", effect: { kind: "scry", count: 1 } as TriggerEffect }] },
        atk2: { triggers: [{ event: "attack" as const, optional: false, description: "self attack 2", effect: { kind: "scry", count: 1 } as TriggerEffect }] },
      },
    };
    let s = applyAction(g, A, { type: "setAttacking", instanceId: a1.instanceId, attacking: true }, 0, ctx);
    expect(triggersFrom(s, "adl1")).toHaveLength(1); // team fired on the FIRST declaration
    expect(triggersFrom(s, a1.instanceId)).toHaveLength(1); // legacy self attack still fires

    s = applyAction(s, A, { type: "setAttacking", instanceId: a2.instanceId, attacking: true }, 0, ctx);
    expect(triggersFrom(s, "adl1")).toHaveLength(1); // second attacker same combat: no refire
    expect(triggersFrom(s, a2.instanceId)).toHaveLength(1); // but its own self trigger fires

    // New turn (attackers cleared, team flag re-armed) -> new declaration fires again.
    s = applyAction(s, A, { type: "nextTurn" }, 0, ctx);
    s = applyAction(s, A, { type: "setAttacking", instanceId: a1.instanceId, attacking: true }, 0, ctx);
    expect(triggersFrom(s, "adl1")).toHaveLength(2);
    expect(triggersFrom(s, a1.instanceId)).toHaveLength(2);
  });
});

describe("v9 becameTapped self", () => {
  it("fires on tapCard(true) and tapForMana, not on untap or re-tapping a tapped card", () => {
    const g = newGame();
    put(g, "p1", "battlefield", "hawk", "hawk1");
    const ctx = {
      cards: { hawk: data("hawk", "Artifact Creature — Bird", ["C"]) },
      scripts: {
        hawk: whenScript({ on: "becameTapped", which: "self" }, { kind: "scry", count: 1 }, "became tapped"),
      },
    };
    let s = applyAction(g, "p1", { type: "tapCard", instanceId: "hawk1", tapped: true }, 0, ctx);
    expect(triggersFrom(s, "hawk1")).toHaveLength(1);
    // Tapping an already-tapped card is not a transition.
    s = applyAction(s, "p1", { type: "tapCard", instanceId: "hawk1", tapped: true }, 0, ctx);
    expect(triggersFrom(s, "hawk1")).toHaveLength(1);
    // Untapping never fires.
    s = applyAction(s, "p1", { type: "tapCard", instanceId: "hawk1", tapped: false }, 0, ctx);
    expect(triggersFrom(s, "hawk1")).toHaveLength(1);
    // tapForMana is a tap transition too.
    s = applyAction(s, "p1", { type: "tapForMana", instanceId: "hawk1", color: "C" }, 0, ctx);
    expect(triggersFrom(s, "hawk1")).toHaveLength(2);
    expect(player(s, "p1").manaPool["C"]).toBe(1);
  });
});

describe("v9 draw conditions (you/opponent, exceptDrawStepFirst)", () => {
  function setup() {
    const g = newGame();
    const A = g.activePlayerId;
    const B = other(g, A);
    put(g, A, "battlefield", "mydraw", "md1"); // A: whenever YOU draw
    put(g, B, "battlefield", "oppdraw", "od1"); // B: whenever an opponent draws (no exemption)
    put(g, B, "battlefield", "bow", "bow1"); // B: legacy opponentDraws (exceptDrawStepFirst)
    const ctx = {
      scripts: {
        mydraw: whenScript({ on: "draw", who: "you" }, { kind: "gainLife", amount: 1 }, "you drew"),
        oppdraw: whenScript({ on: "draw", who: "opponent" }, { kind: "scry", count: 1 }, "opponent drew"),
        bow: { triggers: [{ event: "opponentDraws" as const, optional: false, description: "bowmasters", effect: { kind: "scry", count: 1 } as TriggerEffect }] },
      },
    };
    return { g, A, B, ctx };
  }

  it("draw-step draws fire you/opponent conditions; the legacy exemption skips the first draw-step draw", () => {
    const { g, A, ctx } = setup();
    // Turn 1 active player skips the draw; go around to A's turn 2 draw step.
    let s = applyAction(g, A, { type: "nextTurn" }, 0, ctx);
    s = applyAction(s, s.activePlayerId, { type: "nextTurn" }, 0, ctx);
    expect(s.activePlayerId).toBe(A);
    expect(s.turnNumber).toBe(2);
    s = applyAction(s, A, { type: "nextStep" }, 0, ctx); // upkeep
    s = applyAction(s, A, { type: "nextStep" }, 0, ctx); // draw (A draws 1)
    expect(s.step).toBe("draw");
    expect(triggersFrom(s, "md1")).toHaveLength(1); // who:"you", drawer = controller
    expect(triggersFrom(s, "od1")).toHaveLength(1); // who:"opponent" WITHOUT the exemption
    expect(triggersFrom(s, "bow1")).toHaveLength(0); // legacy opponentDraws exempts the draw-step first draw

    // An override (scripted-style) draw fires all three, preserving v6 semantics.
    s = applyAction(s, A, { type: "drawCard", override: true }, 0, ctx);
    expect(triggersFrom(s, "md1")).toHaveLength(2);
    expect(triggersFrom(s, "od1")).toHaveLength(2);
    expect(triggersFrom(s, "bow1")).toHaveLength(1);
  });

  it("who:'you' does not fire on the opponent's draws", () => {
    const { g, B, ctx } = setup();
    const s = applyAction(g, B, { type: "drawCard", override: true }, 0, ctx);
    expect(triggersFrom(s, "md1")).toHaveLength(0); // A's watcher: B is not "you"
    expect(triggersFrom(s, "od1")).toHaveLength(0); // B's own draw is not "an opponent's"
    expect(triggersFrom(s, "bow1")).toHaveLength(0);
  });
});

describe("v9 discard who:'you'", () => {
  it("fires when the observer's controller discards, not when the opponent does", () => {
    const g = newGame();
    put(g, "p1", "battlefield", "converter", "conv1");
    const ctx = {
      scripts: {
        converter: whenScript({ on: "discard", who: "you" }, { kind: "gainLife", amount: 1 }, "you discarded"),
      },
    };
    const mine = player(g, "p1").zones.hand[0]!.instanceId;
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: mine, from: "hand", to: "graveyard" }, 0, ctx);
    expect(triggersFrom(s, "conv1")).toHaveLength(1);

    const theirs = player(s, "p2").zones.hand[0]!.instanceId;
    s = applyAction(s, "p2", { type: "moveCard", instanceId: theirs, from: "hand", to: "graveyard" }, 0, ctx);
    expect(triggersFrom(s, "conv1")).toHaveLength(1); // unchanged — not my discard
  });
});

describe("v9 chained events within one action", () => {
  it("a resolving draw-2 trigger pushes TWO opponent draw-watcher triggers (CR 121.2)", () => {
    const g = newGame();
    put(g, "p1", "hand", "wall", "wall1");
    put(g, "p2", "battlefield", "sheol", "sheol1");
    const ctx = {
      scripts: {
        wall: whenScript(
          { on: "zoneChange", which: "self", move: "entersBattlefield" },
          { kind: "draw", count: 2 },
          "draw two"
        ),
        sheol: whenScript({ on: "draw", who: "opponent" }, { kind: "scry", count: 1 }, "opponent drew"),
      },
    };
    // No card data for wall -> direct battlefield arrival; its self-ETB fires.
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "wall1", from: "hand", to: "battlefield" }, 0, ctx);
    expect(triggersFrom(s, "wall1")).toHaveLength(1);
    const handBefore = player(s, "p1").zones.hand.length;
    // Resolving the draw-2 trigger draws twice in ONE action -> two watcher triggers.
    s = bothPass(s);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p1").zones.hand).toHaveLength(handBefore + 2);
    expect(triggersFrom(s, "sheol1")).toHaveLength(2);
    expect(s.stack.filter((c) => c.isTrigger)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// V10: effect task pipeline & replacements
// ---------------------------------------------------------------------------

describe("v10 entersTapped replacement", () => {
  it("a Land with entersTapped arrives tapped from hand -> battlefield, with the log line", () => {
    const g = newGame();
    put(g, "p1", "hand", "gate", "gate1");
    const ctx = {
      cards: { gate: data("gate", "Land — Gate") },
      scripts: { gate: { triggers: [], replacements: [{ kind: "entersTapped" as const }] } },
    };
    const s = applyAction(g, "p1", { type: "moveCard", instanceId: "gate1", from: "hand", to: "battlefield" }, 0, ctx);
    const land = player(s, "p1").zones.battlefield.find((c) => c.instanceId === "gate1")!;
    expect(land.tapped).toBe(true);
    expect(s.log.some((e) => /enters the battlefield tapped/.test(e.message))).toBe(true);
  });

  it("a creature cast through the stack arrives tapped at resolution", () => {
    const g = newGame();
    put(g, "p1", "hand", "sleeper", "slp1");
    const ctx = {
      cards: { sleeper: data("sleeper", "Creature — Beast") },
      scripts: { sleeper: { triggers: [], replacements: [{ kind: "entersTapped" as const }] } },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "slp1", from: "hand", to: "stack" }, 0, ctx);
    const onStack = s.stack.find((c) => c.instanceId === "slp1")!;
    expect(onStack.tapped).toBe(false); // replacement applies on ARRIVAL, not on the stack
    s = bothPass(s);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    const beast = player(s, "p1").zones.battlefield.find((c) => c.instanceId === "slp1")!;
    expect(beast.tapped).toBe(true);
    expect(s.log.some((e) => /enters the battlefield tapped/.test(e.message))).toBe(true);
  });
});

describe("v10 entersWithCounters replacement", () => {
  it("arrives with the scripted counters", () => {
    const g = newGame();
    put(g, "p1", "hand", "walker", "wlk1");
    const ctx = {
      scripts: {
        walker: {
          triggers: [],
          replacements: [{ kind: "entersWithCounters" as const, counterType: "charge", count: 3 }],
        },
      },
    };
    const s = applyAction(g, "p1", { type: "moveCard", instanceId: "wlk1", from: "hand", to: "battlefield" }, 0, ctx);
    const walker = player(s, "p1").zones.battlefield.find((c) => c.instanceId === "wlk1")!;
    expect(walker.counters["charge"]).toBe(3);
    expect(s.log.some((e) => /enters with 3 charge counters/.test(e.message))).toBe(true);
  });
});

describe("v10 draw coalescing log parity", () => {
  it("a draw-2 trigger logs one 'drew 2 cards' line, not two single-draw lines", () => {
    const g = newGame();
    put(g, "p1", "hand", "whisper", "whisp1");
    const ctx = {
      scripts: {
        whisper: whenScript(
          { on: "zoneChange", which: "self", move: "entersBattlefield" },
          { kind: "draw", count: 2 },
          "draw two"
        ),
      },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "whisp1", from: "hand", to: "battlefield" }, 0, ctx);
    s = bothPass(s);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(logCount(s, /drew 2 cards/)).toBe(1);
    expect(logCount(s, /drew 1 card\b/)).toBe(0);
  });
});

describe("v10 existing effect behavior unchanged (spot checks)", () => {
  it("gainLife applies to the trigger's controller", () => {
    const g = newGame();
    put(g, "p1", "hand", "healer", "heal1");
    const ctx = {
      scripts: {
        healer: whenScript(
          { on: "zoneChange", which: "self", move: "entersBattlefield" },
          { kind: "gainLife", amount: 4 },
          "gain 4"
        ),
      },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "heal1", from: "hand", to: "battlefield" }, 0, ctx);
    s = bothPass(s);
    s = applyAction(s, "p2", { type: "resolveTopOfStack" }, 0, ctx); // either player may click
    expect(player(s, "p1").life).toBe(24);
    expect(player(s, "p2").life).toBe(20);
  });

  it("addCounters fizzles when the source left the battlefield", () => {
    const g = newGame();
    put(g, "p1", "hand", "grower", "grow1");
    const ctx = {
      scripts: {
        grower: whenScript(
          { on: "zoneChange", which: "self", move: "entersBattlefield" },
          { kind: "addCounters", counterType: "+1/+1", count: 2 },
          "grow"
        ),
      },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "grow1", from: "hand", to: "battlefield" }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    // Source dies while its trigger waits on the stack.
    s = applyAction(s, "p1", { type: "moveCard", instanceId: "grow1", from: "battlefield", to: "graveyard" }, 0, ctx);
    s = bothPass(s);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(s.log.some((e) => /fizzled: its source is no longer on the battlefield/.test(e.message))).toBe(true);
    expect(player(s, "p1").zones.graveyard.find((c) => c.instanceId === "grow1")!.counters).toEqual({});
  });

  it("counterTarget counters a spell on the stack in one resolution (v11)", () => {
    const g = newGame();
    put(g, "p1", "hand", "bear", "bear1");
    put(g, "p2", "hand", "csp", "csp1");
    const ctx = {
      cards: {
        bear: data("bear", "Creature — Bear"),
        csp: data("csp", "Instant"),
      },
      scripts: {
        csp: { triggers: [], onResolve: { effects: [{ kind: "counterTarget" as const }] } },
      },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "bear1", from: "hand", to: "stack" }, 0, ctx);
    s = applyAction(s, "p2", { type: "moveCard", instanceId: "csp1", from: "hand", to: "stack" }, 0, ctx);
    expect(s.stack.map((c) => c.instanceId)).toEqual(["bear1", "csp1"]);
    // Counterspell resolves in ONE action: card to graveyard AND the bear is
    // countered immediately — no intermediate stack entry.
    s = bothPass(s);
    s = applyAction(s, "p2", { type: "resolveTopOfStack", target: { kind: "stack", instanceId: "bear1" } }, 0, ctx);
    expect(player(s, "p2").zones.graveyard.some((c) => c.instanceId === "csp1")).toBe(true);
    expect(s.stack).toHaveLength(0);
    expect(player(s, "p1").zones.graveyard.some((c) => c.instanceId === "bear1")).toBe(true);
    expect(player(s, "p1").zones.battlefield).toHaveLength(0); // it never entered
  });
});

describe("trigger pseudo-card shape (new-style `when` triggers)", () => {
  it("keeps the v3 stack-entry shape: tr id, source cardId, triggerSourceId, controller", () => {
    const g = newGame();
    put(g, "p1", "battlefield", "watch", "w1");
    put(g, "p1", "hand", "bear", "bear1");
    const ctx = {
      cards: {
        watch: data("watch", "Creature — Wall"),
        bear: data("bear", "Creature — Bear"),
      },
      scripts: {
        watch: whenScript(
          { on: "zoneChange", which: "other", move: "entersBattlefield", controller: "you", card: { types: ["Creature"] } },
          { kind: "gainLife", amount: 1 },
          "another creature enters"
        ),
      },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: "bear1", from: "hand", to: "stack" }, 0, ctx);
    s = bothPass(s);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    const trig = triggersFrom(s, "w1")[0]!;
    expect(trig.isTrigger).toBe(true);
    expect(trig.instanceId).toMatch(/^tr\d+-\d+$/);
    expect(trig.cardId).toBe("watch"); // renders the SOURCE card's art
    expect(trig.triggerSourceId).toBe("w1");
    expect(trig.controllerId).toBe("p1"); // the source's controller
    expect(trig.triggerText).toBe("another creature enters");
    expect(trig.triggerOptional).toBe(false);
  });
});
