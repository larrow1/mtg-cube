import { describe, expect, it } from "vitest";
import type { CardData, GameCard, GameState } from "../src/types.js";
import { applyAction, createGame } from "../src/game/engine.js";
import { buildGameView } from "../src/game/view.js";

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

function cardData(id: string): CardData {
  return {
    id,
    name: `Name of ${id}`,
    cmc: 1,
    typeLine: "Creature — Test",
    colors: [],
    colorIdentity: [],
    layout: "normal",
  };
}

function setup(): { state: GameState; cards: Record<string, CardData> } {
  const deckA = Array.from({ length: 40 }, (_, i) => mkCard("p1", i));
  const deckB = Array.from({ length: 40 }, (_, i) => mkCard("p2", i));
  const cards: Record<string, CardData> = {};
  for (const c of [...deckA, ...deckB]) cards[c.cardId] = cardData(c.cardId);
  const state = createGame("g1", [
    { playerId: "p1", deck: deckA },
    { playerId: "p2", deck: deckB },
  ], "view-seed");
  return { state, cards };
}

function viewPlayer(v: ReturnType<typeof buildGameView>, id: string) {
  return v.state.players.find((p) => p.playerId === id)!;
}

describe("buildGameView", () => {
  it("keeps the viewer's own hand visible", () => {
    const { state, cards } = setup();
    const view = buildGameView(state, "p1", cards);
    const mine = viewPlayer(view, "p1");
    const realHand = state.players.find((p) => p.playerId === "p1")!.zones.hand;
    expect(mine.zones.hand).toEqual(realHand);
    for (const c of mine.zones.hand) expect(c.cardId).not.toBe("hidden");
  });

  it("hides the opponent's hand but preserves count and instanceIds", () => {
    const { state, cards } = setup();
    const view = buildGameView(state, "p1", cards);
    const theirs = viewPlayer(view, "p2");
    const realHand = state.players.find((p) => p.playerId === "p2")!.zones.hand;
    expect(theirs.zones.hand).toHaveLength(realHand.length);
    theirs.zones.hand.forEach((c, i) => {
      expect(c.cardId).toBe("hidden");
      expect(c.instanceId).toBe(realHand[i]!.instanceId);
      expect(c.counters).toEqual({});
    });
  });

  it("hides BOTH libraries as ordered placeholders", () => {
    const { state, cards } = setup();
    const view = buildGameView(state, "p1", cards);
    for (const id of ["p1", "p2"] as const) {
      const real = state.players.find((p) => p.playerId === id)!.zones.library;
      const shown = viewPlayer(view, id).zones.library;
      expect(shown).toHaveLength(real.length);
      shown.forEach((c, i) => {
        expect(c.cardId).toBe("hidden");
        expect(c.instanceId).toBe(real[i]!.instanceId); // order preserved: index 0 = top
      });
    }
  });

  it("filters the cards record to what the viewer may see", () => {
    const { state, cards } = setup();
    // Put one card of each player on the battlefield and one in p2's graveyard.
    let s = state;
    const p1Hand = s.players.find((p) => p.playerId === "p1")!.zones.hand;
    const p2Hand = s.players.find((p) => p.playerId === "p2")!.zones.hand;
    const p1Bf = p1Hand[0]!.instanceId;
    const p2Gy = p2Hand[0]!.instanceId;
    s = applyAction(s, "p1", { type: "moveCard", instanceId: p1Bf, from: "hand", to: "battlefield" });
    s = applyAction(s, "p2", { type: "moveCard", instanceId: p2Gy, from: "hand", to: "graveyard" });

    const view = buildGameView(s, "p1", cards);
    const visible = new Set(Object.keys(view.cards));

    // Own hand + public zones are present.
    for (const c of s.players.find((p) => p.playerId === "p1")!.zones.hand) {
      expect(visible.has(c.cardId)).toBe(true);
    }
    expect(visible.has(p1Hand[0]!.cardId)).toBe(true); // p1 battlefield
    expect(visible.has(p2Hand[0]!.cardId)).toBe(true); // p2 graveyard

    // Opponent hand and both libraries are NOT in the record.
    for (const c of s.players.find((p) => p.playerId === "p2")!.zones.hand) {
      expect(visible.has(c.cardId)).toBe(false);
    }
    for (const p of s.players) {
      for (const c of p.zones.library) expect(visible.has(c.cardId)).toBe(false);
    }
  });

  it("hides both hands from spectators", () => {
    const { state, cards } = setup();
    const view = buildGameView(state, "spectator", cards);
    for (const p of view.state.players) {
      for (const c of p.zones.hand) expect(c.cardId).toBe("hidden");
      for (const c of p.zones.library) expect(c.cardId).toBe("hidden");
    }
  });

  it("does not mutate the input state", () => {
    const { state, cards } = setup();
    const before = structuredClone(state);
    buildGameView(state, "p1", cards);
    buildGameView(state, "p2", cards);
    expect(state).toEqual(before);
  });

  it("reveals the searcher's OWN library during their pendingSearch (v4)", () => {
    const { state, cards } = setup();
    state.pendingSearch = {
      playerId: "p1",
      filter: { kind: "basicLand" },
      destination: "battlefield",
      entersTapped: true,
      shuffle: true,
      sourceName: "Evolving Wilds",
    };

    // Searcher's view: own library revealed (real cardIds, order preserved)
    // and its card data included.
    const mine = buildGameView(state, "p1", cards);
    const realLib = state.players.find((p) => p.playerId === "p1")!.zones.library;
    const shownLib = viewPlayer(mine, "p1").zones.library;
    expect(shownLib).toHaveLength(realLib.length);
    shownLib.forEach((c, i) => {
      expect(c.cardId).toBe(realLib[i]!.cardId);
      expect(c.instanceId).toBe(realLib[i]!.instanceId);
    });
    for (const c of realLib) expect(mine.cards[c.cardId]).toBeDefined();
    // The opponent's library stays hidden even in the searcher's view.
    for (const c of viewPlayer(mine, "p2").zones.library) expect(c.cardId).toBe("hidden");
    expect(mine.state.pendingSearch?.playerId).toBe("p1");

    // Opponent's view: metadata passes through, but the searcher's library
    // (and card data) stays hidden.
    const theirs = buildGameView(state, "p2", cards);
    expect(theirs.state.pendingSearch?.playerId).toBe("p1");
    expect(theirs.state.pendingSearch?.sourceName).toBe("Evolving Wilds");
    for (const c of viewPlayer(theirs, "p1").zones.library) expect(c.cardId).toBe("hidden");
    for (const c of realLib) expect(theirs.cards[c.cardId]).toBeUndefined();

    // Spectators see nothing extra either.
    const spec = buildGameView(state, "spectator", cards);
    for (const p of spec.state.players) {
      for (const c of p.zones.library) expect(c.cardId).toBe("hidden");
    }
  });

  it("hides libraries again once pendingSearch is cleared", () => {
    const { state, cards } = setup();
    state.pendingSearch = null;
    const view = buildGameView(state, "p1", cards);
    for (const p of view.state.players) {
      for (const c of p.zones.library) expect(c.cardId).toBe("hidden");
    }
  });

  it("keeps stack and battlefield cards visible to both players", () => {
    const { state, cards } = setup();
    let s = state;
    const spell = s.players.find((p) => p.playerId === "p1")!.zones.hand[0]!;
    s = applyAction(s, "p1", { type: "moveCard", instanceId: spell.instanceId, from: "hand", to: "stack" });
    const view = buildGameView(s, "p2", cards);
    expect(view.state.stack[0]!.cardId).toBe(spell.cardId);
    expect(view.cards[spell.cardId]).toBeDefined();
  });
});
