import { describe, expect, it } from "vitest";
import type { CardData, Color, Cube, DraftConfig, DraftState } from "../src/types.js";
import { applyPick, createDraft, getDraftView, runBotPicks } from "../src/draft/engine.js";
import { createRng } from "../src/rng.js";

const COLOR_CYCLE: Color[][] = [["W"], ["U"], ["B"], ["R"], ["G"], []];

function makeCube(size: number): Cube {
  const cardIds: string[] = [];
  const cards: Record<string, CardData> = {};
  for (let i = 0; i < size; i++) {
    const id = `c${i}`;
    cardIds.push(id);
    const colors = COLOR_CYCLE[i % COLOR_CYCLE.length]!;
    cards[id] = {
      id,
      name: `Card ${i}`,
      cmc: i % 8,
      typeLine: "Creature — Test",
      colors,
      colorIdentity: colors,
      layout: "normal",
    };
  }
  return { id: "cube1", name: "Test Cube", cardIds, cards, unresolved: [] };
}

function config(overrides: Partial<DraftConfig> = {}): DraftConfig {
  return {
    seatCount: 8,
    packsPerPlayer: 3,
    cardsPerPack: 15,
    pickTimerSeconds: null,
    seed: "draft-seed",
    ...overrides,
  };
}

describe("createDraft", () => {
  it("deals round 1 into packQueues and later rounds into unopened", () => {
    const state = createDraft(makeCube(400), config());
    expect(state.packNumber).toBe(1);
    expect(state.complete).toBe(false);
    expect(state.seats).toHaveLength(8);
    for (const seat of state.seats) {
      expect(seat.packQueue).toHaveLength(1);
      expect(seat.packQueue[0]!.cards).toHaveLength(15);
      expect(seat.picks).toHaveLength(0);
      expect(seat.playerId).toBeNull();
      expect(seat.isBot).toBe(true);
      expect(state.unopened[seat.seatIndex]).toHaveLength(2);
    }
  });

  it("assigns unique instanceIds across all dealt cards", () => {
    const state = createDraft(makeCube(400), config());
    const ids = new Set<string>();
    for (const seat of state.seats) {
      for (const pack of seat.packQueue) for (const c of pack.cards) ids.add(c.instanceId);
    }
    for (const packs of state.unopened) {
      for (const pack of packs) for (const c of pack.cards) ids.add(c.instanceId);
    }
    expect(ids.size).toBe(8 * 3 * 15);
  });

  it("is deterministic for the same seed and does not mutate the cube", () => {
    const cube = makeCube(400);
    const before = structuredClone(cube);
    const a = createDraft(cube, config());
    const b = createDraft(cube, config());
    expect(a).toEqual(b);
    expect(cube).toEqual(before);
  });

  it("throws a descriptive error when the cube is too small", () => {
    expect(() => createDraft(makeCube(100), config())).toThrow(/360/);
  });
});

describe("applyPick", () => {
  function threeSeatDraft(): DraftState {
    // 3 seats x 2 packs x 2 cards = 12 cards needed.
    return createDraft(
      makeCube(12),
      config({ seatCount: 3, packsPerPlayer: 2, cardsPerPack: 2 })
    );
  }

  it("moves the card to picks and passes the rest left on odd pack rounds", () => {
    const state = threeSeatDraft();
    const packId = state.seats[0]!.packQueue[0]!.id;
    const pickId = state.seats[0]!.packQueue[0]!.cards[0]!.instanceId;
    const next = applyPick(state, 0, pickId);

    expect(next.seats[0]!.picks.map((c) => c.instanceId)).toEqual([pickId]);
    expect(next.seats[0]!.packQueue).toHaveLength(0);
    // Seat 1 now has its own pack plus the passed one (left = +1).
    expect(next.seats[1]!.packQueue).toHaveLength(2);
    expect(next.seats[1]!.packQueue[1]!.id).toBe(packId);
    expect(next.seats[1]!.packQueue[1]!.cards).toHaveLength(1);
    // Input state untouched.
    expect(state.seats[0]!.picks).toHaveLength(0);
  });

  it("discards empty packs, advances rounds, and passes right on even rounds", () => {
    let state = threeSeatDraft();
    // Round 1: every card gets picked (2 cards per pack, 3 seats = 6 picks).
    while (state.packNumber === 1 && !state.complete) {
      const seat = state.seats.find((s) => s.packQueue.length > 0)!;
      state = applyPick(state, seat.seatIndex, seat.packQueue[0]!.cards[0]!.instanceId);
    }
    expect(state.packNumber).toBe(2);
    expect(state.complete).toBe(false);
    for (const seat of state.seats) {
      expect(seat.picks).toHaveLength(2);
      expect(seat.packQueue).toHaveLength(1);
    }

    // Round 2 passes right: seat 0's leftover pack goes to seat 2.
    const packId = state.seats[0]!.packQueue[0]!.id;
    const next = applyPick(state, 0, state.seats[0]!.packQueue[0]!.cards[0]!.instanceId);
    expect(next.seats[2]!.packQueue).toHaveLength(2);
    expect(next.seats[2]!.packQueue[1]!.id).toBe(packId);
  });

  it("marks the draft complete after the final round", () => {
    let state = threeSeatDraft();
    while (!state.complete) {
      const seat = state.seats.find((s) => s.packQueue.length > 0)!;
      state = applyPick(state, seat.seatIndex, seat.packQueue[0]!.cards[0]!.instanceId);
    }
    expect(state.complete).toBe(true);
    for (const seat of state.seats) {
      expect(seat.picks).toHaveLength(4);
      expect(seat.packQueue).toHaveLength(0);
    }
  });

  it("rejects picks of cards not in the head pack", () => {
    const state = threeSeatDraft();
    expect(() => applyPick(state, 0, "nope")).toThrow(/not in seat 0/);
  });

  it("rejects picks from a seat with no waiting pack", () => {
    const state = threeSeatDraft();
    const afterPick = applyPick(state, 0, state.seats[0]!.packQueue[0]!.cards[0]!.instanceId);
    expect(() =>
      applyPick(afterPick, 0, "anything")
    ).toThrow(/no pack waiting/);
  });

  it("rejects invalid seat indexes", () => {
    const state = threeSeatDraft();
    expect(() => applyPick(state, 99, "x")).toThrow(/No seat/);
  });
});

describe("runBotPicks", () => {
  it("runs a full 8-seat 3x15 all-bot draft to completion", () => {
    const cube = makeCube(400);
    const state = createDraft(cube, config());
    const done = runBotPicks(state, createRng("bots"), cube.cards);

    expect(done.complete).toBe(true);
    const all = new Set<string>();
    for (const seat of done.seats) {
      expect(seat.picks).toHaveLength(45);
      expect(seat.packQueue).toHaveLength(0);
      for (const c of seat.picks) all.add(c.instanceId);
    }
    expect(all.size).toBe(360); // every dealt card ended up in exactly one pool
    // Input untouched.
    expect(state.complete).toBe(false);
  });

  it("is deterministic for the same rng seed", () => {
    const cube = makeCube(400);
    const state = createDraft(cube, config());
    const a = runBotPicks(state, createRng("bots"), cube.cards);
    const b = runBotPicks(state, createRng("bots"), cube.cards);
    expect(a).toEqual(b);
  });

  it("stops at human seats with waiting packs", () => {
    const cube = makeCube(400);
    const state = createDraft(cube, config());
    state.seats[0]!.isBot = false;
    state.seats[0]!.playerId = "p1";
    const after = runBotPicks(state, createRng("bots"), cube.cards);
    expect(after.complete).toBe(false);
    // The human still has (at least) their own round-1 pack waiting.
    expect(after.seats[0]!.packQueue.length).toBeGreaterThan(0);
    expect(after.seats[0]!.picks).toHaveLength(0);
  });

  it("prefers cards in the colors it has drafted", () => {
    const cube = makeCube(24);
    const state = createDraft(
      makeCube(24),
      config({ seatCount: 2, packsPerPlayer: 1, cardsPerPack: 3 })
    );
    // Give the bot a strong white commitment and a known pack.
    state.seats[0]!.picks = [
      { instanceId: "x1", cardId: "c0" }, // W
      { instanceId: "x2", cardId: "c6" }, // W
      { instanceId: "x3", cardId: "c12" }, // W
    ];
    state.seats[0]!.packQueue = [
      {
        id: "test-pack",
        cards: [
          { instanceId: "y1", cardId: "c1" }, // U
          { instanceId: "y2", cardId: "c18" }, // W
          { instanceId: "y3", cardId: "c2" }, // B
        ],
      },
    ];
    state.seats[1]!.isBot = false; // keep the other seat out of the loop
    const after = runBotPicks(state, createRng("any-seed"), cube.cards);
    const picked = after.seats[0]!.picks.map((c) => c.instanceId);
    expect(picked).toContain("y2");
  });
});

describe("getDraftView", () => {
  it("shows only your own current pack and public seat info", () => {
    const state = createDraft(makeCube(400), config());
    const names: (string | null)[] = ["Alice", null, null, null, null, null, null, null];
    const view = getDraftView(state, 0, names, 12345);

    expect(view.draftId).toBe(state.id);
    expect(view.seatIndex).toBe(0);
    expect(view.packNumber).toBe(1);
    expect(view.packsPerPlayer).toBe(3);
    expect(view.cardsPerPack).toBe(15);
    expect(view.currentPack!.id).toBe(state.seats[0]!.packQueue[0]!.id);
    expect(view.currentPack!.cards).toHaveLength(15);
    expect(view.queuedPacks).toBe(0);
    expect(view.pickDeadline).toBe(12345);
    expect(view.complete).toBe(false);
    expect(view.seats).toHaveLength(8);
    expect(view.seats[0]).toEqual({
      seatIndex: 0,
      playerName: "Alice",
      isBot: true,
      pickCount: 0,
      queuedPacks: 1,
    });
    // Public seat info exposes no card contents.
    for (const seat of view.seats) {
      expect(Object.keys(seat).sort()).toEqual([
        "isBot",
        "pickCount",
        "playerName",
        "queuedPacks",
        "seatIndex",
      ]);
    }
  });

  it("returns null currentPack while waiting", () => {
    const state = createDraft(makeCube(400), config());
    const after = applyPick(state, 0, state.seats[0]!.packQueue[0]!.cards[0]!.instanceId);
    const view = getDraftView(after, 0, [], null);
    expect(view.currentPack).toBeNull();
    expect(view.picks).toHaveLength(1);
  });
});
