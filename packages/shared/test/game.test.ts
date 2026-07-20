import { describe, expect, it } from "vitest";
import type { GameCard, GameState } from "../src/types.js";
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
    const next = applyAction(g, "p1", { type: "drawCard" }, 777);
    expect(g).toEqual(before);
    expect(next.seq).toBe(1);
    const entry = next.log[next.log.length - 1]!;
    expect(entry.seq).toBe(1);
    expect(entry.playerId).toBe("p1");
    expect(entry.ts).toBe(777);
    expect(entry.message).toMatch(/drew 1 card/);
  });

  it("rejects unknown actors", () => {
    expect(() => applyAction(newGame(), "nobody", { type: "drawCard" })).toThrow(EngineError);
  });
});

describe("drawCard", () => {
  it("moves the top of the library to hand", () => {
    const g = newGame();
    const top = player(g, "p1").zones.library[0]!.instanceId;
    const next = applyAction(g, "p1", { type: "drawCard", count: 2 });
    const p = player(next, "p1");
    expect(p.zones.hand).toHaveLength(9);
    expect(p.zones.library).toHaveLength(31);
    expect(p.zones.hand[7]!.instanceId).toBe(top);
  });

  it("rejects non-positive counts", () => {
    expect(() => applyAction(newGame(), "p1", { type: "drawCard", count: 0 })).toThrow(EngineError);
    expect(() => applyAction(newGame(), "p1", { type: "drawCard", count: -3 })).toThrow(EngineError);
  });

  it("drawing from an empty library loses the game", () => {
    const g = newGame();
    const next = applyAction(g, "p1", { type: "drawCard", count: 999 });
    const p = player(next, "p1");
    expect(p.hasLost).toBe(true);
    expect(p.lossReason).toMatch(/empty library/);
    expect(next.finished).toBe(true);
    expect(next.winnerId).toBe("p2");
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

    // Walk to cleanup; mana + damage clear there.
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
