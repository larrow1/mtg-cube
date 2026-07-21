import { describe, expect, it } from "vitest";
import type {
  ActivatedSearchAbility,
  CardData,
  CardScript,
  GameCard,
  GameState,
  TriggerEffect,
  TriggerEvent,
} from "../src/types.js";
import { EngineError, applyAction, createGame } from "../src/game/engine.js";

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

function newGame(seed = "game-seed"): GameState {
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

/** First instanceId in a player's hand. */
function handCard(s: GameState, id: string): string {
  return player(s, id).zones.hand[0]!.instanceId;
}

/** One-trigger CardScript for engine tests. */
function mkScript(event: TriggerEvent, effect: TriggerEffect, optional = false): CardScript {
  return { triggers: [{ event, optional, description: `test ${event} trigger`, effect }] };
}

/** Minimal CardData (only tapForMana reads it — via producedMana). */
function mkCardData(id: string, producedMana?: string[]): CardData {
  return {
    id,
    name: `Card ${id}`,
    cmc: 0,
    typeLine: "Land",
    colors: [],
    colorIdentity: [],
    layout: "normal",
    ...(producedMana ? { producedMana } : {}),
  };
}

function lastLog(s: GameState): string {
  return s.log[s.log.length - 1]!.message;
}

describe("createGame", () => {
  it("sets up life 20, 7-card hands, shuffled 33-card libraries", () => {
    const g = newGame();
    for (const p of g.players) {
      expect(p.life).toBe(20);
      expect(p.poison).toBe(0);
      expect(p.zones.hand).toHaveLength(7);
      expect(p.zones.library).toHaveLength(33);
      expect(p.zones.battlefield).toHaveLength(0);
      expect(p.zones.graveyard).toHaveLength(0);
      expect(p.hasLost).toBe(false);
    }
    expect(g.turnNumber).toBe(1);
    expect(g.step).toBe("untap");
    expect(g.seq).toBe(0);
    expect(g.finished).toBe(false);
    expect([g.players[0].playerId, g.players[1].playerId]).toContain(g.startingPlayerId);
    expect(g.activePlayerId).toBe(g.startingPlayerId);
    expect(g.priorityPlayerId).toBe(g.startingPlayerId);
  });

  it("shuffles deterministically by seed", () => {
    expect(newGame("a")).toEqual(newGame("a"));
    const libA = newGame("a").players[0].zones.library.map((c) => c.instanceId);
    const libB = newGame("b").players[0].zones.library.map((c) => c.instanceId);
    expect(libA).not.toEqual(libB);
  });
});

describe("applyAction basics", () => {
  it("bumps seq and appends a log entry, without mutating the input", () => {
    const g = newGame();
    const before = structuredClone(g);
    const next = applyAction(g, "p1", { type: "drawCard", override: true }, 777);
    expect(g).toEqual(before);
    expect(next.seq).toBe(1);
    const entry = next.log[next.log.length - 1]!;
    expect(entry.seq).toBe(1);
    expect(entry.playerId).toBe("p1");
    expect(entry.ts).toBe(777);
    expect(entry.message).toMatch(/drew 1 card/);
  });

  it("rejects unknown actors", () => {
    expect(() => applyAction(newGame(), "nobody", { type: "drawCard", override: true })).toThrow(EngineError);
  });
});

describe("drawCard", () => {
  it("is rejected without override (v4 draw restriction)", () => {
    expect(() => applyAction(newGame(), "p1", { type: "drawCard" })).toThrow(
      /Draws come from the draw step or card effects/
    );
    expect(() => applyAction(newGame(), "p1", { type: "drawCard", count: 2 })).toThrow(EngineError);
    expect(() => applyAction(newGame(), "p1", { type: "drawCard", override: false })).toThrow(EngineError);
  });

  it("with override moves the top of the library to hand and logs the override loudly", () => {
    const g = newGame();
    const top = player(g, "p1").zones.library[0]!.instanceId;
    const next = applyAction(g, "p1", { type: "drawCard", count: 2, override: true });
    const p = player(next, "p1");
    expect(p.zones.hand).toHaveLength(9);
    expect(p.zones.library).toHaveLength(31);
    expect(p.zones.hand[7]!.instanceId).toBe(top);
    expect(lastLog(next)).toBe("drew 2 cards (manual override)");
  });

  it("rejects non-positive counts", () => {
    expect(() => applyAction(newGame(), "p1", { type: "drawCard", count: 0, override: true })).toThrow(EngineError);
    expect(() => applyAction(newGame(), "p1", { type: "drawCard", count: -3, override: true })).toThrow(EngineError);
  });

  it("drawing from an empty library loses the game", () => {
    const g = newGame();
    const next = applyAction(g, "p1", { type: "drawCard", count: 999, override: true });
    const p = player(next, "p1");
    expect(p.hasLost).toBe(true);
    expect(p.lossReason).toMatch(/empty library/);
    expect(next.finished).toBe(true);
    expect(next.winnerId).toBe("p2");
  });

  it("the draw-step auto-draw is unaffected by the gate", () => {
    const g = newGame();
    const active = g.activePlayerId;
    const inactive = other(g, active);
    let s = applyAction(g, active, { type: "nextTurn" });
    s = applyAction(s, inactive, { type: "nextStep" }); // upkeep
    s = applyAction(s, inactive, { type: "nextStep" }); // draw
    expect(player(s, inactive).zones.hand).toHaveLength(8);
    expect(lastLog(s)).not.toMatch(/override/);
  });
});

describe("moveCard", () => {
  it("plays a card from hand to battlefield", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const next = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" });
    const p = player(next, "p1");
    expect(p.zones.hand).toHaveLength(6);
    expect(p.zones.battlefield.map((c) => c.instanceId)).toEqual([id]);
    expect(p.zones.battlefield[0]!.controllerId).toBe("p1");
  });

  it("enforces the stated from zone", () => {
    const g = newGame();
    const libraryCard = player(g, "p1").zones.library[0]!.instanceId;
    expect(() =>
      applyAction(g, "p1", { type: "moveCard", instanceId: libraryCard, from: "hand", to: "battlefield" })
    ).toThrow(EngineError);
  });

  it("cannot move cards the actor does not own", () => {
    const g = newGame();
    const theirs = handCard(g, "p2");
    expect(() =>
      applyAction(g, "p1", { type: "moveCard", instanceId: theirs, from: "hand", to: "graveyard" })
    ).toThrow(EngineError);
  });

  it("moves from library by instanceId (index 0 = top)", () => {
    const g = newGame();
    const top = player(g, "p1").zones.library[0]!.instanceId;
    const next = applyAction(g, "p1", { type: "moveCard", instanceId: top, from: "library", to: "exile" });
    expect(player(next, "p1").zones.exile.map((c) => c.instanceId)).toEqual([top]);
    expect(player(next, "p1").zones.library).toHaveLength(32);
  });

  it("to library goes to the top, or bottom with toBottom", () => {
    const g = newGame();
    const a = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: a, from: "hand", to: "library" });
    expect(player(s, "p1").zones.library[0]!.instanceId).toBe(a);

    const b = handCard(s, "p1");
    s = applyAction(s, "p1", { type: "moveCard", instanceId: b, from: "hand", to: "library", toBottom: true });
    const lib = player(s, "p1").zones.library;
    expect(lib[lib.length - 1]!.instanceId).toBe(b);
  });

  it("clears tapped/counters/damage/attacking when leaving the battlefield", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" });
    s = applyAction(s, "p1", { type: "tapCard", instanceId: id, tapped: true });
    s = applyAction(s, "p1", { type: "setCounters", instanceId: id, counterType: "+1/+1", count: 2 });
    s = applyAction(s, "p1", { type: "setDamage", instanceId: id, damage: 3 });
    s = applyAction(s, "p1", { type: "setAttacking", instanceId: id, attacking: true });
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "graveyard" });
    const card = player(s, "p1").zones.graveyard.find((c) => c.instanceId === id)!;
    expect(card.tapped).toBe(false);
    expect(card.counters).toEqual({});
    expect(card.damage).toBe(0);
    expect(card.attacking).toBe(false);
    expect(card.attachedTo).toBeNull();
  });

  it("detaches attachments when the host leaves the battlefield", () => {
    const g = newGame();
    const creature = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: creature, from: "hand", to: "battlefield" });
    const aura = handCard(s, "p1");
    s = applyAction(s, "p1", { type: "moveCard", instanceId: aura, from: "hand", to: "battlefield" });
    s = applyAction(s, "p1", { type: "attach", instanceId: aura, targetInstanceId: creature });
    expect(player(s, "p1").zones.battlefield.find((c) => c.instanceId === aura)!.attachedTo).toBe(creature);

    s = applyAction(s, "p1", { type: "moveCard", instanceId: creature, from: "battlefield", to: "graveyard" });
    expect(player(s, "p1").zones.battlefield.find((c) => c.instanceId === aura)!.attachedTo).toBeNull();
  });

  it("tokens cease to exist when leaving the battlefield", () => {
    const g = newGame();
    let s = applyAction(g, "p1", { type: "createToken", name: "Soldier", typeLine: "Token Creature — Soldier", power: "1", toughness: "1" });
    const token = player(s, "p1").zones.battlefield[0]!;
    expect(token.isToken).toBe(true);
    s = applyAction(s, "p1", { type: "moveCard", instanceId: token.instanceId, from: "battlefield", to: "graveyard" });
    const p = player(s, "p1");
    expect(p.zones.graveyard).toHaveLength(0);
    expect(p.zones.battlefield).toHaveLength(0);
  });
});

describe("tap / mana / counters / attack", () => {
  it("taps and untaps own permanents only", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" });
    s = applyAction(s, "p1", { type: "tapCard", instanceId: id, tapped: true });
    expect(player(s, "p1").zones.battlefield[0]!.tapped).toBe(true);
    expect(() => applyAction(s, "p2", { type: "tapCard", instanceId: id, tapped: false })).toThrow(EngineError);

    s = applyAction(s, "p1", { type: "untapAll" });
    expect(player(s, "p1").zones.battlefield[0]!.tapped).toBe(false);
  });

  it("manages the mana pool with validation", () => {
    const g = newGame();
    let s = applyAction(g, "p1", { type: "addMana", color: "G", amount: 3 });
    expect(player(s, "p1").manaPool).toEqual({ G: 3 });
    s = applyAction(s, "p1", { type: "addMana", color: "G", amount: -1 });
    expect(player(s, "p1").manaPool).toEqual({ G: 2 });
    expect(() => applyAction(s, "p1", { type: "addMana", color: "G", amount: -5 })).toThrow(EngineError);
    expect(() => applyAction(s, "p1", { type: "addMana", color: "Q", amount: 1 })).toThrow(EngineError);
    s = applyAction(s, "p1", { type: "emptyManaPool" });
    expect(player(s, "p1").manaPool).toEqual({});
  });

  it("rejects negative counter and damage counts", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" });
    expect(() => applyAction(s, "p1", { type: "setCounters", instanceId: id, counterType: "charge", count: -1 })).toThrow(EngineError);
    expect(() => applyAction(s, "p1", { type: "setDamage", instanceId: id, damage: -2 })).toThrow(EngineError);
  });

  it("supports attack and block declarations", () => {
    const g = newGame();
    const attacker = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: attacker, from: "hand", to: "battlefield" });
    const blocker = handCard(s, "p2");
    s = applyAction(s, "p2", { type: "moveCard", instanceId: blocker, from: "hand", to: "battlefield" });

    s = applyAction(s, "p1", { type: "setAttacking", instanceId: attacker, attacking: true });
    s = applyAction(s, "p2", { type: "setBlocking", instanceId: blocker, blocking: attacker });
    expect(player(s, "p1").zones.battlefield[0]!.attacking).toBe(true);
    expect(player(s, "p2").zones.battlefield[0]!.blocking).toBe(attacker);
    expect(() => applyAction(s, "p2", { type: "setBlocking", instanceId: blocker, blocking: "ghost" })).toThrow(EngineError);
  });
});

describe("life / poison permissions", () => {
  it("players may only set their own totals", () => {
    const g = newGame();
    const s = applyAction(g, "p1", { type: "setLife", playerId: "p1", life: 17 });
    expect(player(s, "p1").life).toBe(17);
    expect(() => applyAction(s, "p1", { type: "setLife", playerId: "p2", life: 1 })).toThrow(EngineError);
    expect(() => applyAction(s, "p1", { type: "setPoison", playerId: "p2", poison: 3 })).toThrow(EngineError);
    expect(() => applyAction(s, "p1", { type: "setPoison", playerId: "p1", poison: -1 })).toThrow(EngineError);
  });
});

describe("turn structure", () => {
  it("walks steps with auto draw and cleanup, only for the active player", () => {
    const g = newGame();
    const active = g.activePlayerId;
    const inactive = other(g, active);
    expect(() => applyAction(g, inactive, { type: "nextStep" })).toThrow(EngineError);

    // untap -> upkeep -> draw: starting player skips the turn-1 draw.
    let s = applyAction(g, active, { type: "nextStep" });
    expect(s.step).toBe("upkeep");
    s = applyAction(s, active, { type: "nextStep" });
    expect(s.step).toBe("draw");
    expect(player(s, active).zones.hand).toHaveLength(7);

    // Mana pools empty at every step boundary (v3 rule), so floating mana
    // never survives a walk to cleanup; damage also clears at cleanup.
    s = applyAction(s, active, { type: "addMana", color: "R", amount: 2 });
    while (s.step !== "cleanup") s = applyAction(s, active, { type: "nextStep" });
    expect(player(s, active).manaPool).toEqual({});

    // nextStep from cleanup = turn passes.
    s = applyAction(s, active, { type: "nextStep" });
    expect(s.activePlayerId).toBe(inactive);
    expect(s.priorityPlayerId).toBe(inactive);
    expect(s.step).toBe("untap");
    expect(s.turnNumber).toBe(1); // increments when it comes back to the starter

    // Non-starting player DOES draw on their turn-1 draw step.
    s = applyAction(s, inactive, { type: "nextStep" }); // upkeep
    s = applyAction(s, inactive, { type: "nextStep" }); // draw
    expect(player(s, inactive).zones.hand).toHaveLength(8);
  });

  it("nextTurn swaps active player, untaps, and increments the turn count on wraparound", () => {
    const g = newGame();
    const first = g.activePlayerId;
    const second = other(g, first);

    // Give the first player a tapped permanent.
    const id = handCard(g, first);
    let s = applyAction(g, first, { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" });
    s = applyAction(s, first, { type: "tapCard", instanceId: id, tapped: true });

    s = applyAction(s, first, { type: "nextTurn" });
    expect(s.activePlayerId).toBe(second);
    expect(s.turnNumber).toBe(1);
    expect(s.step).toBe("untap");
    expect(() => applyAction(s, first, { type: "nextTurn" })).toThrow(EngineError);

    s = applyAction(s, second, { type: "nextTurn" });
    expect(s.activePlayerId).toBe(first);
    expect(s.turnNumber).toBe(2);
    // The returning active player's permanents untapped on their untap step.
    expect(player(s, first).zones.battlefield[0]!.tapped).toBe(false);
  });

  it("passPriority toggles priority and validates the holder", () => {
    const g = newGame();
    const active = g.activePlayerId;
    const inactive = other(g, active);
    expect(() => applyAction(g, inactive, { type: "passPriority" })).toThrow(EngineError);
    const s = applyAction(g, active, { type: "passPriority" });
    expect(s.priorityPlayerId).toBe(inactive);
  });
});

describe("mulligans", () => {
  it("shuffles the hand away and redraws 7 (London), tracking mulligan count in the log", () => {
    const g = newGame();
    let s = applyAction(g, "p1", { type: "mulligan" });
    let p = player(s, "p1");
    expect(p.zones.hand).toHaveLength(7);
    expect(p.zones.library).toHaveLength(33);
    expect(s.log[s.log.length - 1]!.message).toMatch(/#1/);

    s = applyAction(s, "p1", { type: "mulligan" });
    expect(s.log[s.log.length - 1]!.message).toMatch(/#2/);

    // Keep, bottoming 2 (down to 5 cards).
    const bottom = player(s, "p1").zones.hand.slice(0, 2).map((c) => c.instanceId);
    s = applyAction(s, "p1", { type: "keepHand", bottomCount: 2, bottomInstanceIds: bottom });
    p = player(s, "p1");
    expect(p.zones.hand).toHaveLength(5);
    expect(p.zones.library).toHaveLength(35);
    expect(p.zones.library.slice(-2).map((c) => c.instanceId)).toEqual(bottom);
  });

  it("validates keepHand inputs", () => {
    const g = newGame();
    const inHand = handCard(g, "p1");
    expect(() =>
      applyAction(g, "p1", { type: "keepHand", bottomCount: 2, bottomInstanceIds: [inHand] })
    ).toThrow(EngineError);
    expect(() =>
      applyAction(g, "p1", { type: "keepHand", bottomCount: 1, bottomInstanceIds: ["ghost"] })
    ).toThrow(EngineError);
  });
});

describe("library manipulation", () => {
  it("shuffleLibrary is deterministic and keeps the same cards", () => {
    const g = newGame();
    const before = player(g, "p1").zones.library.map((c) => c.instanceId);
    const a = applyAction(g, "p1", { type: "shuffleLibrary" });
    const b = applyAction(g, "p1", { type: "shuffleLibrary" });
    expect(a).toEqual(b);
    const after = player(a, "p1").zones.library.map((c) => c.instanceId);
    expect(after.slice().sort()).toEqual(before.slice().sort());
    expect(after).not.toEqual(before);
  });

  it("scry logs and reorderLibraryTop rewrites the top", () => {
    const g = newGame();
    const s1 = applyAction(g, "p1", { type: "scry", count: 3 });
    expect(s1.log[s1.log.length - 1]!.message).toMatch(/top 3/);
    expect(player(s1, "p1").zones.library).toEqual(player(g, "p1").zones.library);

    const top3 = player(s1, "p1").zones.library.slice(0, 3).map((c) => c.instanceId);
    const s2 = applyAction(s1, "p1", {
      type: "reorderLibraryTop",
      instanceIds: [top3[2]!, top3[0]!],
      toBottom: [top3[1]!],
    });
    const lib = player(s2, "p1").zones.library.map((c) => c.instanceId);
    expect(lib[0]).toBe(top3[2]);
    expect(lib[1]).toBe(top3[0]);
    expect(lib[lib.length - 1]).toBe(top3[1]);
    expect(lib).toHaveLength(33);

    expect(() =>
      applyAction(s2, "p1", { type: "reorderLibraryTop", instanceIds: ["ghost"], toBottom: [] })
    ).toThrow(EngineError);
    const deep = player(s2, "p1").zones.library[10]!.instanceId;
    expect(() =>
      applyAction(s2, "p1", { type: "reorderLibraryTop", instanceIds: [deep], toBottom: [] })
    ).toThrow(EngineError);
  });
});

describe("stack", () => {
  it("casting via moveCard to stack, resolving to the battlefield", () => {
    const g = newGame();
    const spell = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" });
    expect(s.stack.map((c) => c.instanceId)).toEqual([spell]);
    expect(s.stack[0]!.controllerId).toBe("p1");

    // Either player may resolve.
    s = applyAction(s, "p2", { type: "resolveTopOfStack" });
    expect(s.stack).toHaveLength(0);
    expect(player(s, "p1").zones.battlefield.map((c) => c.instanceId)).toEqual([spell]);
  });

  it("counterTopOfStack sends the spell to its owner's graveyard", () => {
    const g = newGame();
    const spell = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" });
    s = applyAction(s, "p2", { type: "counterTopOfStack" });
    expect(s.stack).toHaveLength(0);
    expect(player(s, "p1").zones.graveyard.map((c) => c.instanceId)).toEqual([spell]);
    expect(() => applyAction(s, "p1", { type: "resolveTopOfStack" })).toThrow(EngineError);
  });

  it("instants/sorceries finish via moveCard stack -> graveyard", () => {
    const g = newGame();
    const spell = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" });
    s = applyAction(s, "p1", { type: "moveCard", instanceId: spell, from: "stack", to: "graveyard" });
    expect(s.stack).toHaveLength(0);
    expect(player(s, "p1").zones.graveyard.map((c) => c.instanceId)).toEqual([spell]);
    // But you cannot move an opponent's spell off the stack.
    const theirs = handCard(s, "p2");
    s = applyAction(s, "p2", { type: "moveCard", instanceId: theirs, from: "hand", to: "stack" });
    expect(() =>
      applyAction(s, "p1", { type: "moveCard", instanceId: theirs, from: "stack", to: "graveyard" })
    ).toThrow(EngineError);
  });
});

describe("state-based losses and game end", () => {
  it("life <= 0 ends the game", () => {
    const g = newGame();
    const s = applyAction(g, "p1", { type: "setLife", playerId: "p1", life: 0 });
    expect(player(s, "p1").hasLost).toBe(true);
    expect(s.finished).toBe(true);
    expect(s.winnerId).toBe("p2");
  });

  it("10+ poison ends the game", () => {
    const g = newGame();
    const s = applyAction(g, "p2", { type: "setPoison", playerId: "p2", poison: 10 });
    expect(player(s, "p2").hasLost).toBe(true);
    expect(s.winnerId).toBe("p1");
  });

  it("concede ends the game", () => {
    const g = newGame();
    const s = applyAction(g, "p1", { type: "concede" });
    expect(player(s, "p1").lossReason).toBe("conceded");
    expect(s.finished).toBe(true);
    expect(s.winnerId).toBe("p2");
  });

  it("endMatch finishes with no winner, from either player, and stays no-result", () => {
    const g = newGame();
    const s = applyAction(g, "p2", { type: "endMatch" });
    expect(s.finished).toBe(true);
    expect(s.winnerId).toBeNull();
    expect(player(s, "p1").hasLost).toBe(false);
    expect(player(s, "p2").hasLost).toBe(false);
    // Finished game rejects further actions (except restart)...
    expect(() => applyAction(s, "p1", { type: "endMatch" })).toThrow(/finished/);
    // ...and a restart works from the no-result state.
    const restarted = applyAction(s, "p1", { type: "restartGame", seed: "again" });
    expect(restarted.finished).toBe(false);
  });

  it("rejects every action except restartGame once finished", () => {
    const g = newGame();
    const done = applyAction(g, "p1", { type: "concede" });
    expect(() => applyAction(done, "p2", { type: "drawCard" })).toThrow(EngineError);
    expect(() => applyAction(done, "p1", { type: "nextStep" })).toThrow(/finished/);
    const restarted = applyAction(done, "p1", { type: "restartGame", seed: "again" });
    expect(restarted.finished).toBe(false);
  });
});

describe("restartGame", () => {
  it("recollects every owned card (tokens vanish), resets totals, flips the starter", () => {
    const g = newGame();
    const firstStarter = g.startingPlayerId;
    let s = g;
    // Scatter cards around.
    const bf = handCard(s, "p1");
    s = applyAction(s, "p1", { type: "moveCard", instanceId: bf, from: "hand", to: "battlefield" });
    const gy = handCard(s, "p1");
    s = applyAction(s, "p1", { type: "moveCard", instanceId: gy, from: "hand", to: "graveyard" });
    const ex = handCard(s, "p2");
    s = applyAction(s, "p2", { type: "moveCard", instanceId: ex, from: "hand", to: "exile" });
    const st = handCard(s, "p2");
    s = applyAction(s, "p2", { type: "moveCard", instanceId: st, from: "hand", to: "stack" });
    s = applyAction(s, "p1", { type: "createToken", name: "Goblin", typeLine: "Token Creature — Goblin" });
    s = applyAction(s, "p1", { type: "setLife", playerId: "p1", life: 4 });
    s = applyAction(s, "p2", { type: "addMana", color: "U", amount: 2 });
    const seqBefore = s.seq;

    s = applyAction(s, "p2", { type: "restartGame", seed: "rematch" });
    expect(s.seq).toBe(seqBefore + 1);
    expect(s.finished).toBe(false);
    expect(s.winnerId).toBeNull();
    expect(s.turnNumber).toBe(1);
    expect(s.step).toBe("untap");
    expect(s.stack).toHaveLength(0);
    expect(s.startingPlayerId).toBe(other(g, firstStarter));
    expect(s.activePlayerId).toBe(s.startingPlayerId);
    for (const p of s.players) {
      expect(p.life).toBe(20);
      expect(p.poison).toBe(0);
      expect(p.manaPool).toEqual({});
      expect(p.hasLost).toBe(false);
      expect(p.zones.hand).toHaveLength(7);
      expect(p.zones.library).toHaveLength(33); // all 40 cards recollected
      expect(p.zones.battlefield).toHaveLength(0);
      expect(p.zones.graveyard).toHaveLength(0);
      expect(p.zones.exile).toHaveLength(0);
      const all = [...p.zones.hand, ...p.zones.library];
      expect(all.some((c) => c.isToken)).toBe(false);
      expect(new Set(all.map((c) => c.instanceId)).size).toBe(40);
    }
  });
});

describe("revealHand", () => {
  it("is log-only", () => {
    const g = newGame();
    const s = applyAction(g, "p1", { type: "revealHand" });
    expect(s.log[s.log.length - 1]!.message).toMatch(/revealed their hand \(7 cards\)/);
    expect(player(s, "p1").zones).toEqual(player(g, "p1").zones);
  });
});

describe("triggered abilities", () => {
  it("ETB via moveCard pushes a trigger pseudo-card; resolving draws for the controller", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("etb", { kind: "draw", count: 1 }) } };

    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    const trigger = s.stack[0]!;
    expect(trigger.isTrigger).toBe(true);
    expect(trigger.instanceId).toMatch(/^tr\d+-0$/);
    expect(trigger.cardId).toBe(cardId);
    expect(trigger.controllerId).toBe("p1");
    expect(trigger.triggerSourceId).toBe(id);
    expect(trigger.triggerOptional).toBe(false);

    // Either player may resolve; the effect applies to the CONTROLLER.
    const handBefore = player(s, "p1").zones.hand.length;
    s = applyAction(s, "p2", { type: "resolveTopOfStack" }, 0, ctx);
    expect(s.stack).toHaveLength(0);
    expect(player(s, "p1").zones.hand).toHaveLength(handBefore + 1);
    expect(player(s, "p1").zones.battlefield.map((c) => c.instanceId)).toEqual([id]);
  });

  it("ETB fires when a permanent resolves from the stack too", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("etb", { kind: "gainLife", amount: 4 }) } };

    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "stack" }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    // The permanent landed and its ETB trigger replaced it on the stack.
    expect(player(s, "p1").zones.battlefield.map((c) => c.instanceId)).toEqual([id]);
    expect(s.stack).toHaveLength(1);
    expect(s.stack[0]!.isTrigger).toBe(true);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p1").life).toBe(24);
  });

  it("no scripts context means no triggers", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" });
    expect(s.stack).toHaveLength(0);
  });

  it("dies triggers fire on battlefield -> graveyard", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("dies", { kind: "eachOpponentLosesLife", amount: 2 }) } };

    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    expect(s.stack).toHaveLength(0); // dies-only script: nothing on ETB
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "graveyard" }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p2").life).toBe(18);
  });

  it("upkeep triggers fire for the active player's permanents only, in sortIndex order", () => {
    const g = newGame();
    const active = g.activePlayerId;
    const inactive = other(g, active);
    const first = handCard(g, active);
    const firstCardId = player(g, active).zones.hand[0]!.cardId;
    let s = applyAction(g, active, { type: "moveCard", instanceId: first, from: "hand", to: "battlefield" });
    const second = handCard(s, active);
    const secondCardId = player(s, active).zones.hand[0]!.cardId;
    s = applyAction(s, active, { type: "moveCard", instanceId: second, from: "hand", to: "battlefield" });
    const theirs = handCard(s, inactive);
    const theirsCardId = player(s, inactive).zones.hand[0]!.cardId;
    s = applyAction(s, inactive, { type: "moveCard", instanceId: theirs, from: "hand", to: "battlefield" });

    const ctx = {
      scripts: {
        [firstCardId]: mkScript("upkeep", { kind: "scry", count: 1 }),
        [secondCardId]: mkScript("upkeep", { kind: "gainLife", amount: 1 }),
        [theirsCardId]: mkScript("upkeep", { kind: "draw", count: 1 }),
      },
    };
    s = applyAction(s, active, { type: "nextStep" }, 0, ctx); // untap -> upkeep
    expect(s.step).toBe("upkeep");
    // Only the active player's two permanents triggered, in battlefield order.
    expect(s.stack).toHaveLength(2);
    expect(s.stack.map((c) => c.triggerSourceId)).toEqual([first, second]);
    expect(s.stack.every((c) => c.isTrigger && c.controllerId === active)).toBe(true);
  });

  it("optional triggers can be declined by their controller at any stack position", () => {
    const g = newGame();
    const optionalId = handCard(g, "p1");
    const optionalCardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx1 = { scripts: { [optionalCardId]: mkScript("etb", { kind: "draw", count: 1 }, true) } };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: optionalId, from: "hand", to: "battlefield" }, 0, ctx1);
    const optionalTrigger = s.stack[0]!.instanceId;
    expect(s.stack[0]!.triggerOptional).toBe(true);

    // Pile a second (mandatory) trigger on top so the optional one is buried.
    const mandatoryId = handCard(s, "p1");
    const mandatoryCardId = player(s, "p1").zones.hand[0]!.cardId;
    const ctx2 = { scripts: { [mandatoryCardId]: mkScript("etb", { kind: "gainLife", amount: 1 }) } };
    s = applyAction(s, "p1", { type: "moveCard", instanceId: mandatoryId, from: "hand", to: "battlefield" }, 0, ctx2);
    expect(s.stack).toHaveLength(2);

    // Non-controller cannot decline; mandatory triggers cannot be declined.
    expect(() => applyAction(s, "p2", { type: "declineTrigger", instanceId: optionalTrigger })).toThrow(
      /controller/
    );
    expect(() => applyAction(s, "p1", { type: "declineTrigger", instanceId: s.stack[1]!.instanceId })).toThrow(
      /not optional/
    );
    expect(() => applyAction(s, "p1", { type: "declineTrigger", instanceId: "ghost" })).toThrow(EngineError);
    // Declining a real card on the stack is rejected too.
    const spell = handCard(s, "p1");
    const s2 = applyAction(s, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" });
    expect(() => applyAction(s2, "p1", { type: "declineTrigger", instanceId: spell })).toThrow(
      /triggered abilities/i
    );

    // Controller declines the buried optional trigger; the other one remains.
    s = applyAction(s, "p1", { type: "declineTrigger", instanceId: optionalTrigger });
    expect(s.stack).toHaveLength(1);
    expect(s.stack[0]!.triggerSourceId).toBe(mandatoryId);
    expect(lastLog(s)).toMatch(/declined/);
  });

  it("addCounters resolves onto the source, or fizzles when it left the battlefield", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = {
      scripts: { [cardId]: mkScript("etb", { kind: "addCounters", counterType: "+1/+1", count: 2 }) },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    expect(s.stack).toHaveLength(1);

    // Happy path: source still on the battlefield.
    const resolved = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(resolved, "p1").zones.battlefield[0]!.counters).toEqual({ "+1/+1": 2 });

    // Fizzle: source left the battlefield while the trigger waited.
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "graveyard" }, 0, ctx);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(lastLog(s)).toMatch(/fizzled/);
    expect(player(s, "p1").zones.graveyard[0]!.counters).toEqual({});
  });

  it("token triggers use the token machinery (tokens land on the controller's battlefield)", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = {
      scripts: {
        [cardId]: mkScript("dies", {
          kind: "createToken",
          name: "Zombie",
          typeLine: "Token Creature — Zombie",
          power: "2",
          toughness: "2",
          count: 2,
        }),
      },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "graveyard" }, 0, ctx);
    s = applyAction(s, "p2", { type: "resolveTopOfStack" }, 0, ctx);
    const tokens = player(s, "p1").zones.battlefield;
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.isToken && t.tokenName === "Zombie" && t.tokenPower === "2")).toBe(true);
  });

  it("damageOpponent hits the controller's opponent and can end the game", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("etb", { kind: "damageOpponent", amount: 3 }) } };
    let s = applyAction(g, "p2", { type: "setLife", playerId: "p2", life: 3 });
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p2").life).toBe(0);
    expect(s.finished).toBe(true);
    expect(s.winnerId).toBe("p1");
  });

  it("manual and scry trigger effects are log-only", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("etb", { kind: "manual", note: "do the thing" }) } };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    const zonesBefore = structuredClone(player(s, "p1").zones);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(lastLog(s)).toMatch(/do the thing/);
    expect(player(s, "p1").zones).toEqual(zonesBefore);
  });

  it("counterTopOfStack removes a trigger without touching graveyards", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("etb", { kind: "draw", count: 1 }) } };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    const handBefore = player(s, "p1").zones.hand.length;
    s = applyAction(s, "p2", { type: "counterTopOfStack" }, 0, ctx);
    expect(s.stack).toHaveLength(0);
    expect(player(s, "p1").zones.graveyard).toHaveLength(0);
    expect(player(s, "p1").zones.hand).toHaveLength(handBefore);
    expect(lastLog(s)).toMatch(/countered the triggered ability/);
  });

  it("trigger pseudo-cards cannot be moved with moveCard", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("etb", { kind: "draw", count: 1 }) } };
    const s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    const trigger = s.stack[0]!.instanceId;
    expect(() =>
      applyAction(s, "p1", { type: "moveCard", instanceId: trigger, from: "stack", to: "graveyard" })
    ).toThrow(/resolve, counter, or decline/);
  });

  it("leaves triggers fire on battlefield -> exile / hand / library", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("leaves", { kind: "draw", count: 1 }) } };

    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    expect(s.stack).toHaveLength(0); // leaves-only script: nothing on ETB
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "exile" }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    expect(s.stack[0]!.isTrigger).toBe(true);

    // Returning to the battlefield and bouncing to hand fires it again.
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "exile", to: "battlefield" }, 0, ctx);
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "hand" }, 0, ctx);
    expect(s.stack).toHaveLength(1);
  });

  it("leaves fires on death when the script has NO dies trigger", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("leaves", { kind: "gainLife", amount: 5 }) } };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    s = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "graveyard" }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p1").life).toBe(25);
  });

  it("dies/leaves precedence: a script with BOTH fires only dies on death, only leaves elsewhere", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const script: CardScript = {
      triggers: [
        { event: "dies", optional: false, description: "dies trigger", effect: { kind: "loseLife", amount: 1 } },
        { event: "leaves", optional: false, description: "leaves trigger", effect: { kind: "draw", count: 1 } },
      ],
    };
    const ctx = { scripts: { [cardId]: script } };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);

    // Death: only the dies trigger, no double-fire.
    const dead = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "graveyard" }, 0, ctx);
    expect(dead.stack).toHaveLength(1);
    expect(dead.stack[0]!.triggerText).toBe("dies trigger");

    // Exile: only the leaves trigger.
    const exiled = applyAction(s, "p1", { type: "moveCard", instanceId: id, from: "battlefield", to: "exile" }, 0, ctx);
    expect(exiled.stack).toHaveLength(1);
    expect(exiled.stack[0]!.triggerText).toBe("leaves trigger");
  });

  it("eachUpkeep fires for BOTH players' permanents; upkeep stays active-only", () => {
    const g = newGame();
    const active = g.activePlayerId;
    const inactive = other(g, active);
    const mine = handCard(g, active);
    const mineCardId = player(g, active).zones.hand[0]!.cardId;
    let s = applyAction(g, active, { type: "moveCard", instanceId: mine, from: "hand", to: "battlefield" });
    const theirs = handCard(s, inactive);
    const theirsCardId = player(s, inactive).zones.hand[0]!.cardId;
    s = applyAction(s, inactive, { type: "moveCard", instanceId: theirs, from: "hand", to: "battlefield" });

    const ctx = {
      scripts: {
        [mineCardId]: mkScript("eachUpkeep", { kind: "gainLife", amount: 1 }),
        [theirsCardId]: mkScript("eachUpkeep", { kind: "draw", count: 1 }),
      },
    };
    s = applyAction(s, active, { type: "nextStep" }, 0, ctx); // untap -> upkeep
    expect(s.step).toBe("upkeep");
    expect(s.stack).toHaveLength(2);
    // Active player's permanents first, then the opponent's; each trigger is
    // controlled by its permanent's controller.
    expect(s.stack.map((c) => c.triggerSourceId)).toEqual([mine, theirs]);
    expect(s.stack.map((c) => c.controllerId)).toEqual([active, inactive]);

    // Resolving the opponent's trigger draws for the OPPONENT.
    const theirHand = player(s, inactive).zones.hand.length;
    s = applyAction(s, active, { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, inactive).zones.hand).toHaveLength(theirHand + 1);
  });

  it("endStep triggers fire for the active player's permanents on entering the end step", () => {
    const g = newGame();
    const active = g.activePlayerId;
    const inactive = other(g, active);
    const mine = handCard(g, active);
    const mineCardId = player(g, active).zones.hand[0]!.cardId;
    let s = applyAction(g, active, { type: "moveCard", instanceId: mine, from: "hand", to: "battlefield" });
    const theirs = handCard(s, inactive);
    const theirsCardId = player(s, inactive).zones.hand[0]!.cardId;
    s = applyAction(s, inactive, { type: "moveCard", instanceId: theirs, from: "hand", to: "battlefield" });

    const ctx = {
      scripts: {
        [mineCardId]: mkScript("endStep", { kind: "gainLife", amount: 2 }),
        [theirsCardId]: mkScript("endStep", { kind: "gainLife", amount: 2 }),
      },
    };
    while (s.step !== "end") s = applyAction(s, active, { type: "nextStep" }, 0, ctx);
    // Only the active player's permanent triggered.
    expect(s.stack).toHaveLength(1);
    expect(s.stack[0]!.triggerSourceId).toBe(mine);
    expect(s.stack[0]!.controllerId).toBe(active);
  });

  it("attack triggers fire on declaring only — not on un-declaring or redundant re-declares", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("attack", { kind: "gainLife", amount: 1 }) } };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);

    s = applyAction(s, "p1", { type: "setAttacking", instanceId: id, attacking: true }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    // Redundant re-declare: no second trigger.
    s = applyAction(s, "p1", { type: "setAttacking", instanceId: id, attacking: true }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    // Un-declaring never fires.
    s = applyAction(s, "p1", { type: "setAttacking", instanceId: id, attacking: false }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    // Declaring again after un-declaring fires again.
    s = applyAction(s, "p1", { type: "setAttacking", instanceId: id, attacking: true }, 0, ctx);
    expect(s.stack).toHaveLength(2);
  });

  it("castSpell triggers fire on the caster's own permanents, above the cast spell", () => {
    const g = newGame();
    const source = handCard(g, "p1");
    const sourceCardId = player(g, "p1").zones.hand[0]!.cardId;
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: source, from: "hand", to: "battlefield" });
    // Opponent has a castSpell permanent too — it must NOT fire on p1's cast.
    const theirs = handCard(s, "p2");
    const theirsCardId = player(s, "p2").zones.hand[0]!.cardId;
    s = applyAction(s, "p2", { type: "moveCard", instanceId: theirs, from: "hand", to: "battlefield" });

    const ctx = {
      scripts: {
        [sourceCardId]: mkScript("castSpell", { kind: "createToken", name: "Monk", typeLine: "Token Creature — Monk", power: "1", toughness: "1", count: 1 }),
        [theirsCardId]: mkScript("castSpell", { kind: "draw", count: 1 }),
      },
    };
    const spell = handCard(s, "p1");
    s = applyAction(s, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" }, 0, ctx);
    expect(s.stack).toHaveLength(2);
    expect(s.stack[0]!.instanceId).toBe(spell); // spell below
    expect(s.stack[1]!.isTrigger).toBe(true); // trigger above (resolves first)
    expect(s.stack[1]!.triggerSourceId).toBe(source);
    expect(s.stack[1]!.controllerId).toBe("p1");
  });

  it("castSpell fires from graveyard/exile casts but not battlefield moves; the spell itself does not trigger", () => {
    const g = newGame();
    const source = handCard(g, "p1");
    const sourceCardId = player(g, "p1").zones.hand[0]!.cardId;
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: source, from: "hand", to: "battlefield" });
    const ctx = { scripts: { [sourceCardId]: mkScript("castSpell", { kind: "draw", count: 1 }) } };

    // Cast from graveyard (flashback-style): fires.
    const spell = handCard(s, "p1");
    s = applyAction(s, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "graveyard" }, 0, ctx);
    expect(s.stack).toHaveLength(0);
    s = applyAction(s, "p1", { type: "moveCard", instanceId: spell, from: "graveyard", to: "stack" }, 0, ctx);
    expect(s.stack.filter((c) => c.isTrigger)).toHaveLength(1);

    // Moving the SOURCE from battlefield to the stack is not a cast: no
    // castSpell trigger (and with a castSpell-only script, no leaves either).
    const s2 = applyAction(s, "p1", { type: "moveCard", instanceId: source, from: "battlefield", to: "stack" }, 0, ctx);
    expect(s2.stack.filter((c) => c.isTrigger)).toHaveLength(1); // unchanged
  });

  it("castSpell honors castFilter against the cast card's typeLine", () => {
    const g = newGame();
    const source = handCard(g, "p1");
    const sourceCardId = player(g, "p1").zones.hand[0]!.cardId;
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: source, from: "hand", to: "battlefield" });

    const script: CardScript = {
      triggers: [
        { event: "castSpell", optional: false, description: "any", effect: { kind: "gainLife", amount: 1 } },
        { event: "castSpell", optional: false, description: "ios", effect: { kind: "draw", count: 1 }, castFilter: "instantOrSorcery" },
        { event: "castSpell", optional: false, description: "noncreature", effect: { kind: "scry", count: 1 }, castFilter: "noncreature" },
        { event: "castSpell", optional: false, description: "creature", effect: { kind: "loseLife", amount: 1 }, castFilter: "creature" },
        { event: "castSpell", optional: false, description: "artifact", effect: { kind: "gainLife", amount: 2 }, castFilter: "artifact" },
      ],
    };

    const castAndCollect = (typeLine: string | undefined) => {
      const spell = handCard(s, "p1");
      const spellCardId = player(s, "p1").zones.hand[0]!.cardId;
      const ctx = {
        scripts: { [sourceCardId]: script },
        ...(typeLine !== undefined ? { cards: { [spellCardId]: { ...mkCardData(spellCardId), typeLine } } } : {}),
      };
      const next = applyAction(s, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" }, 0, ctx);
      return next.stack.filter((c) => c.isTrigger).map((c) => c.triggerText);
    };

    expect(castAndCollect("Instant")).toEqual(["any", "ios", "noncreature"]);
    expect(castAndCollect("Creature — Bear")).toEqual(["any", "creature"]);
    expect(castAndCollect("Artifact — Equipment")).toEqual(["any", "noncreature", "artifact"]);
    expect(castAndCollect("Artifact Creature — Golem")).toEqual(["any", "creature", "artifact"]);
    // No card data for the spell: only unfiltered triggers fire.
    expect(castAndCollect(undefined)).toEqual(["any"]);
  });

  it("combatDamageToPlayer fires for unblocked attackers when the combatDamage step begins", () => {
    const g = newGame();
    const active = g.activePlayerId;
    const inactive = other(g, active);
    const attacker1 = handCard(g, active);
    const attacker1CardId = player(g, active).zones.hand[0]!.cardId;
    let s = applyAction(g, active, { type: "moveCard", instanceId: attacker1, from: "hand", to: "battlefield" });
    const attacker2 = handCard(s, active);
    const attacker2CardId = player(s, active).zones.hand[0]!.cardId;
    s = applyAction(s, active, { type: "moveCard", instanceId: attacker2, from: "hand", to: "battlefield" });
    const bystander = handCard(s, active);
    const bystanderCardId = player(s, active).zones.hand[0]!.cardId;
    s = applyAction(s, active, { type: "moveCard", instanceId: bystander, from: "hand", to: "battlefield" });
    const blocker = handCard(s, inactive);
    s = applyAction(s, inactive, { type: "moveCard", instanceId: blocker, from: "hand", to: "battlefield" });

    const ctx = {
      scripts: {
        [attacker1CardId]: mkScript("combatDamageToPlayer", { kind: "draw", count: 1 }),
        [attacker2CardId]: mkScript("combatDamageToPlayer", { kind: "gainLife", amount: 1 }),
        [bystanderCardId]: mkScript("combatDamageToPlayer", { kind: "scry", count: 1 }),
      },
    };
    s = applyAction(s, active, { type: "setAttacking", instanceId: attacker1, attacking: true }, 0, ctx);
    s = applyAction(s, active, { type: "setAttacking", instanceId: attacker2, attacking: true }, 0, ctx);
    // attacker2 gets blocked; attacker1 is unblocked; bystander stays home.
    s = applyAction(s, inactive, { type: "setBlocking", instanceId: blocker, blocking: attacker2 }, 0, ctx);

    while (s.step !== "combatDamage") s = applyAction(s, active, { type: "nextStep" }, 0, ctx);
    const triggers = s.stack.filter((c) => c.isTrigger);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.triggerSourceId).toBe(attacker1);
    expect(triggers[0]!.controllerId).toBe(active);
  });

  it("restartGame drops pending triggers and recollects only real cards", () => {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { scripts: { [cardId]: mkScript("etb", { kind: "draw", count: 1 }) } };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    expect(s.stack).toHaveLength(1);
    s = applyAction(s, "p1", { type: "restartGame", seed: "again" }, 0, ctx);
    expect(s.stack).toHaveLength(0);
    for (const p of s.players) {
      const all = [...p.zones.hand, ...p.zones.library];
      expect(all).toHaveLength(40);
      expect(all.some((c) => c.isTrigger)).toBe(false);
    }
  });
});

describe("tapForMana", () => {
  /** Fresh game with p1's first hand card on the battlefield + its CardData. */
  function withSource(producedMana?: string[]) {
    const g = newGame();
    const id = handCard(g, "p1");
    const cardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = { cards: { [cardId]: mkCardData(cardId, producedMana) } };
    const s = applyAction(g, "p1", { type: "moveCard", instanceId: id, from: "hand", to: "battlefield" }, 0, ctx);
    return { s, id, ctx };
  }

  it("taps the source and adds one mana of the chosen color", () => {
    const { s, id, ctx } = withSource(["G", "W"]);
    const next = applyAction(s, "p1", { type: "tapForMana", instanceId: id, color: "G" }, 0, ctx);
    expect(player(next, "p1").zones.battlefield[0]!.tapped).toBe(true);
    expect(player(next, "p1").manaPool).toEqual({ G: 1 });
    expect(lastLog(next)).toMatch(/tapped .* for \{G\}/);
  });

  it("allows colorless when the card produces it", () => {
    const { s, id, ctx } = withSource(["C"]);
    const next = applyAction(s, "p1", { type: "tapForMana", instanceId: id, color: "C" }, 0, ctx);
    expect(player(next, "p1").manaPool).toEqual({ C: 1 });
  });

  it("rejects colors the card does not produce", () => {
    const { s, id, ctx } = withSource(["G"]);
    expect(() => applyAction(s, "p1", { type: "tapForMana", instanceId: id, color: "U" }, 0, ctx)).toThrow(
      /cannot produce U/
    );
  });

  it("rejects already-tapped sources", () => {
    const { s, id, ctx } = withSource(["G"]);
    const tapped = applyAction(s, "p1", { type: "tapCard", instanceId: id, tapped: true });
    expect(() => applyAction(tapped, "p1", { type: "tapForMana", instanceId: id, color: "G" }, 0, ctx)).toThrow(
      /already tapped/
    );
  });

  it("rejects non-sources and missing card context", () => {
    // producedMana missing entirely.
    const noMana = withSource();
    expect(() =>
      applyAction(noMana.s, "p1", { type: "tapForMana", instanceId: noMana.id, color: "G" }, 0, noMana.ctx)
    ).toThrow(/not a mana source/);
    // No cards context at all.
    expect(() =>
      applyAction(noMana.s, "p1", { type: "tapForMana", instanceId: noMana.id, color: "G" })
    ).toThrow(/not a mana source/);
  });

  it("only works on your own battlefield cards", () => {
    const { s, id, ctx } = withSource(["G"]);
    expect(() => applyAction(s, "p2", { type: "tapForMana", instanceId: id, color: "G" }, 0, ctx)).toThrow(
      EngineError
    );
  });
});

describe("spell resolution scripts (v4)", () => {
  /** Put p1's first hand card on the stack with the given typeLine + script. */
  function castSpell(typeLine: string, script?: CardScript) {
    const g = newGame();
    const spell = handCard(g, "p1");
    const spellCardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = {
      cards: { [spellCardId]: { ...mkCardData(spellCardId), typeLine } },
      ...(script ? { scripts: { [spellCardId]: script } } : {}),
    };
    const s = applyAction(g, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" }, 0, ctx);
    return { s, ctx, spell };
  }

  it("a sorcery with onResolve goes to the owner's graveyard and applies effects for the controller", () => {
    // Night's Whisper-style script: draw 2, lose 2.
    const { s, ctx, spell } = castSpell("Sorcery", {
      triggers: [],
      onResolve: { effects: [{ kind: "draw", count: 2 }, { kind: "loseLife", amount: 2 }] },
    });
    const handBefore = player(s, "p1").zones.hand.length;
    // Either player may click resolve; effects apply to the CONTROLLER (p1).
    const next = applyAction(s, "p2", { type: "resolveTopOfStack" }, 0, ctx);
    expect(next.stack).toHaveLength(0);
    expect(player(next, "p1").zones.graveyard.map((c) => c.instanceId)).toEqual([spell]);
    expect(player(next, "p1").zones.battlefield).toHaveLength(0);
    expect(player(next, "p1").zones.hand).toHaveLength(handBefore + 2);
    expect(player(next, "p1").life).toBe(18);
    expect(player(next, "p2").life).toBe(20);
    expect(next.log.map((e) => e.message).join("\n")).toMatch(/drew 2 cards/);
  });

  it("an instant WITHOUT onResolve goes to the graveyard with a resolve-by-hand log (targeted spells stay manual)", () => {
    const { s, ctx, spell } = castSpell("Instant");
    const next = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(next, "p1").zones.graveyard.map((c) => c.instanceId)).toEqual([spell]);
    expect(player(next, "p1").zones.battlefield).toHaveLength(0);
    expect(lastLog(next)).toMatch(/carry out its effects by hand/);
  });

  it("permanents keep the battlefield + ETB path even with a cards context", () => {
    const { s, ctx, spell } = castSpell("Creature — Bear", {
      triggers: [{ event: "etb", optional: false, description: "etb", effect: { kind: "gainLife", amount: 1 } }],
    });
    const next = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(next, "p1").zones.battlefield.map((c) => c.instanceId)).toEqual([spell]);
    expect(next.stack).toHaveLength(1);
    expect(next.stack[0]!.isTrigger).toBe(true);
  });

  it("onResolve addCounters fizzle-logs (a spell has no battlefield source)", () => {
    const { s, ctx, spell } = castSpell("Sorcery", {
      triggers: [],
      onResolve: { effects: [{ kind: "addCounters", counterType: "+1/+1", count: 1 }] },
    });
    const next = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(next, "p1").zones.graveyard.map((c) => c.instanceId)).toEqual([spell]);
    expect(lastLog(next)).toMatch(/fizzled/);
  });

  it("onResolve uses the FRONT-face type line for DFC spells", () => {
    const g = newGame();
    const spell = handCard(g, "p1");
    const spellCardId = player(g, "p1").zones.hand[0]!.cardId;
    const ctx = {
      cards: {
        [spellCardId]: {
          ...mkCardData(spellCardId),
          typeLine: "Sorcery // Land",
          faces: [
            { name: "Front", typeLine: "Sorcery" },
            { name: "Back", typeLine: "Land" },
          ],
        },
      },
      scripts: { [spellCardId]: { triggers: [], onResolve: { effects: [{ kind: "gainLife", amount: 3 }] } } as CardScript },
    };
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" }, 0, ctx);
    s = applyAction(s, "p1", { type: "resolveTopOfStack" }, 0, ctx);
    expect(player(s, "p1").zones.graveyard.map((c) => c.instanceId)).toEqual([spell]);
    expect(player(s, "p1").life).toBe(23);
  });

  it("without a cards context the legacy battlefield path applies", () => {
    const g = newGame();
    const spell = handCard(g, "p1");
    let s = applyAction(g, "p1", { type: "moveCard", instanceId: spell, from: "hand", to: "stack" });
    s = applyAction(s, "p1", { type: "resolveTopOfStack" });
    expect(player(s, "p1").zones.battlefield.map((c) => c.instanceId)).toEqual([spell]);
  });
});

describe("activated fetch searches (v4)", () => {
  function fetchAbility(overrides: Partial<ActivatedSearchAbility> = {}): ActivatedSearchAbility {
    return {
      costTap: true,
      costSacrifice: true,
      costLife: 1,
      description: "Search your library for a Plains or Island card, put it onto the battlefield, then shuffle.",
      filter: { kind: "landSubtype", subtypes: ["Plains", "Island"] },
      destination: "battlefield",
      entersTapped: false,
      shuffle: true,
      ...overrides,
    };
  }

  /**
   * p1's first hand card becomes a fetch land on the battlefield. Two of
   * p1's library cards get card data: one matching Plains, one Instant.
   */
  function fetchSetup(
    ability = fetchAbility(),
    extraScripts: Record<string, CardScript> = {}
  ) {
    const g = newGame();
    const fetchId = handCard(g, "p1");
    const fetchCardId = player(g, "p1").zones.hand[0]!.cardId;
    const lib = player(g, "p1").zones.library;
    const plains = lib[5]!;
    const bolt = lib[6]!;
    const cards: Record<string, CardData> = {
      [fetchCardId]: { ...mkCardData(fetchCardId), typeLine: "Land" },
      [plains.cardId]: { ...mkCardData(plains.cardId), typeLine: "Basic Land — Plains" },
      [bolt.cardId]: { ...mkCardData(bolt.cardId), typeLine: "Instant" },
    };
    const scripts: Record<string, CardScript> = {
      [fetchCardId]: { triggers: [], activated: [ability] },
      ...extraScripts,
    };
    const ctx = { cards, scripts };
    const s = applyAction(g, "p1", { type: "moveCard", instanceId: fetchId, from: "hand", to: "battlefield" }, 0, ctx);
    return { s, ctx, fetchId, fetchCardId, plains, bolt };
  }

  function activate(setup: ReturnType<typeof fetchSetup>) {
    return applyAction(setup.s, "p1", { type: "activateAbility", instanceId: setup.fetchId, abilityIndex: 0 }, 0, setup.ctx);
  }

  it("activateAbility pays every cost atomically and opens pendingSearch", () => {
    const setup = fetchSetup();
    const s = activate(setup);
    const p1 = player(s, "p1");
    expect(p1.life).toBe(19); // paid 1 life
    expect(p1.zones.battlefield).toHaveLength(0); // sacrificed
    expect(p1.zones.graveyard.map((c) => c.instanceId)).toEqual([setup.fetchId]);
    expect(s.pendingSearch).toMatchObject({
      playerId: "p1",
      filter: { kind: "landSubtype", subtypes: ["Plains", "Island"] },
      destination: "battlefield",
      entersTapped: false,
      shuffle: true,
    });
    expect(s.log.map((e) => e.message).join("\n")).toMatch(/activated .*paying 1 life/);
  });

  it("the sacrifice routes through the normal departure machinery (dies triggers fire)", () => {
    const setup = fetchSetup();
    // Give the fetch land itself a dies trigger.
    setup.ctx.scripts[setup.fetchCardId] = {
      triggers: [{ event: "dies", optional: false, description: "dies", effect: { kind: "loseLife", amount: 1 } }],
      activated: [fetchAbility()],
    };
    const s = activate(setup);
    expect(s.stack).toHaveLength(1);
    expect(s.stack[0]!.isTrigger).toBe(true);
    expect(s.stack[0]!.triggerText).toBe("dies");
  });

  it("validates the ability, tap state, ownership, and single pending search", () => {
    const setup = fetchSetup();
    // No such ability index.
    expect(() =>
      applyAction(setup.s, "p1", { type: "activateAbility", instanceId: setup.fetchId, abilityIndex: 3 }, 0, setup.ctx)
    ).toThrow(/no activated ability/);
    // No scripts context at all.
    expect(() =>
      applyAction(setup.s, "p1", { type: "activateAbility", instanceId: setup.fetchId, abilityIndex: 0 })
    ).toThrow(/no activated ability/);
    // Not on your battlefield (opponent's attempt).
    expect(() =>
      applyAction(setup.s, "p2", { type: "activateAbility", instanceId: setup.fetchId, abilityIndex: 0 }, 0, setup.ctx)
    ).toThrow(EngineError);
    // Tapped source rejected when the ability costs {T}.
    const tapped = applyAction(setup.s, "p1", { type: "tapCard", instanceId: setup.fetchId, tapped: true }, 0, setup.ctx);
    expect(() =>
      applyAction(tapped, "p1", { type: "activateAbility", instanceId: setup.fetchId, abilityIndex: 0 }, 0, setup.ctx)
    ).toThrow(/already tapped/);
    // Only one search at a time (even by the opponent).
    const searching = activate(setup);
    const theirLand = handCard(searching, "p2");
    const theirCardId = player(searching, "p2").zones.hand[0]!.cardId;
    const ctx2 = {
      ...setup.ctx,
      scripts: { ...setup.ctx.scripts, [theirCardId]: { triggers: [], activated: [fetchAbility()] } },
    };
    const s2 = applyAction(searching, "p2", { type: "moveCard", instanceId: theirLand, from: "hand", to: "battlefield" }, 0, ctx2);
    expect(() =>
      applyAction(s2, "p2", { type: "activateAbility", instanceId: theirLand, abilityIndex: 0 }, 0, ctx2)
    ).toThrow(/already in progress/);
  });

  it("locks the searcher to completeSearch/concede while the opponent plays on", () => {
    const setup = fetchSetup();
    const s = activate(setup);
    expect(() => applyAction(s, "p1", { type: "drawCard", override: true }, 0, setup.ctx)).toThrow(/searching your library/);
    expect(() => applyAction(s, "p1", { type: "nextStep" }, 0, setup.ctx)).toThrow(/searching your library/);
    expect(() => applyAction(s, "p1", { type: "restartGame", seed: "x" }, 0, setup.ctx)).toThrow(/searching your library/);
    const theirCard = handCard(s, "p2");
    // The opponent is unaffected.
    const opp = applyAction(s, "p2", { type: "moveCard", instanceId: theirCard, from: "hand", to: "battlefield" }, 0, setup.ctx);
    expect(player(opp, "p2").zones.battlefield).toHaveLength(1);
    // Conceding mid-search is allowed.
    const conceded = applyAction(s, "p1", { type: "concede" }, 0, setup.ctx);
    expect(conceded.finished).toBe(true);
    expect(conceded.winnerId).toBe("p2");
  });

  it("completeSearch puts a matching card onto the battlefield, shuffles, clears the search", () => {
    const setup = fetchSetup();
    const s = activate(setup);
    const before = player(s, "p1").zones.library.map((c) => c.instanceId);
    const next = applyAction(s, "p1", { type: "completeSearch", instanceId: setup.plains.instanceId }, 0, setup.ctx);
    const p1 = player(next, "p1");
    expect(p1.zones.battlefield.map((c) => c.instanceId)).toEqual([setup.plains.instanceId]);
    expect(p1.zones.battlefield[0]!.tapped).toBe(false); // entersTapped: false
    expect(next.pendingSearch).toBeNull();
    // Shuffled: same cards minus the fetched one, different order.
    const after = p1.zones.library.map((c) => c.instanceId);
    expect(after.slice().sort()).toEqual(before.filter((id) => id !== setup.plains.instanceId).sort());
    expect(after).not.toEqual(before.filter((id) => id !== setup.plains.instanceId));
    expect(next.log.map((e) => e.message).join("\n")).toMatch(/shuffled their library/);
  });

  it("completeSearch is deterministic (seeded shuffle)", () => {
    const setup = fetchSetup();
    const s = activate(setup);
    const a = applyAction(s, "p1", { type: "completeSearch", instanceId: setup.plains.instanceId }, 0, setup.ctx);
    const b = applyAction(s, "p1", { type: "completeSearch", instanceId: setup.plains.instanceId }, 0, setup.ctx);
    expect(a).toEqual(b);
  });

  it("entersTapped applies to fetched battlefield arrivals", () => {
    const setup = fetchSetup(fetchAbility({ entersTapped: true, filter: { kind: "basicLand" }, costLife: 0 }));
    const s = activate(setup);
    expect(player(s, "p1").life).toBe(20); // no life cost
    const next = applyAction(s, "p1", { type: "completeSearch", instanceId: setup.plains.instanceId }, 0, setup.ctx);
    expect(player(next, "p1").zones.battlefield[0]!.tapped).toBe(true);
    expect(next.log.map((e) => e.message).join("\n")).toMatch(/onto the battlefield tapped/);
  });

  it("hand-destination searches put the card into the hand (no ETB)", () => {
    const setup = fetchSetup(fetchAbility({ destination: "hand" }), {});
    const s = activate(setup);
    const handBefore = player(s, "p1").zones.hand.length;
    const next = applyAction(s, "p1", { type: "completeSearch", instanceId: setup.plains.instanceId }, 0, setup.ctx);
    expect(player(next, "p1").zones.hand).toHaveLength(handBefore + 1);
    expect(player(next, "p1").zones.battlefield).toHaveLength(0);
    expect(next.stack).toHaveLength(0);
  });

  it("rejects wrong-filter picks, cards not in the library, and non-searchers", () => {
    const setup = fetchSetup();
    const s = activate(setup);
    // The Instant does not match Plains-or-Island.
    expect(() =>
      applyAction(s, "p1", { type: "completeSearch", instanceId: setup.bolt.instanceId }, 0, setup.ctx)
    ).toThrow(/does not match the search/);
    // A library card with NO card data cannot be validated -> rejected.
    const unknown = player(s, "p1").zones.library.find(
      (c) => c.instanceId !== setup.plains.instanceId && c.instanceId !== setup.bolt.instanceId
    )!;
    expect(() =>
      applyAction(s, "p1", { type: "completeSearch", instanceId: unknown.instanceId }, 0, setup.ctx)
    ).toThrow(/does not match the search/);
    // Not in the library at all.
    expect(() => applyAction(s, "p1", { type: "completeSearch", instanceId: "ghost" }, 0, setup.ctx)).toThrow(
      /not in your library/
    );
    // Only the searching player may complete.
    expect(() => applyAction(s, "p2", { type: "completeSearch", instanceId: null }, 0, setup.ctx)).toThrow(
      /searching player/
    );
    // No search in progress at all.
    expect(() => applyAction(setup.s, "p1", { type: "completeSearch", instanceId: null }, 0, setup.ctx)).toThrow(
      /No library search/
    );
  });

  it("completeSearch null = fail to find (logged, still shuffles, clears)", () => {
    const setup = fetchSetup();
    const s = activate(setup);
    const before = player(s, "p1").zones.library.map((c) => c.instanceId);
    const next = applyAction(s, "p1", { type: "completeSearch", instanceId: null }, 0, setup.ctx);
    expect(next.pendingSearch).toBeNull();
    const after = player(next, "p1").zones.library.map((c) => c.instanceId);
    expect(after.slice().sort()).toEqual(before.slice().sort());
    expect(after).not.toEqual(before);
    expect(next.log.map((e) => e.message).join("\n")).toMatch(/failed to find/);
  });

  it("ETB triggers fire for a fetched land with a script", () => {
    const setup = fetchSetup();
    setup.ctx.scripts[setup.plains.cardId] = {
      triggers: [{ event: "etb", optional: false, description: "land etb", effect: { kind: "gainLife", amount: 1 } }],
    };
    const s = activate(setup);
    const next = applyAction(s, "p1", { type: "completeSearch", instanceId: setup.plains.instanceId }, 0, setup.ctx);
    expect(next.stack).toHaveLength(1);
    expect(next.stack[0]!.isTrigger).toBe(true);
    expect(next.stack[0]!.triggerText).toBe("land etb");
  });

  it("restartGame and endMatch clear pendingSearch (opponent-initiated)", () => {
    const setup = fetchSetup();
    const s = activate(setup);
    const restarted = applyAction(s, "p2", { type: "restartGame", seed: "again" }, 0, setup.ctx);
    expect(restarted.pendingSearch).toBeNull();
    const ended = applyAction(s, "p2", { type: "endMatch" }, 0, setup.ctx);
    expect(ended.pendingSearch).toBeNull();
    expect(ended.finished).toBe(true);
  });

  it("a searcher who conceded can still restart the finished game", () => {
    const setup = fetchSetup();
    const s = activate(setup);
    const conceded = applyAction(s, "p1", { type: "concede" }, 0, setup.ctx);
    const restarted = applyAction(conceded, "p1", { type: "restartGame", seed: "rematch" }, 0, setup.ctx);
    expect(restarted.finished).toBe(false);
    expect(restarted.pendingSearch).toBeNull();
  });
});

describe("mana pools empty on every step transition", () => {
  it("nextStep clears both players' pools", () => {
    const g = newGame();
    const active = g.activePlayerId;
    const inactive = other(g, active);
    let s = applyAction(g, active, { type: "addMana", color: "R", amount: 2 });
    s = applyAction(s, inactive, { type: "addMana", color: "U", amount: 1 });
    s = applyAction(s, active, { type: "nextStep" });
    expect(player(s, active).manaPool).toEqual({});
    expect(player(s, inactive).manaPool).toEqual({});
  });

  it("nextTurn clears pools too", () => {
    const g = newGame();
    const active = g.activePlayerId;
    let s = applyAction(g, active, { type: "addMana", color: "G", amount: 3 });
    s = applyAction(s, active, { type: "nextTurn" });
    expect(player(s, active).manaPool).toEqual({});
  });
});
