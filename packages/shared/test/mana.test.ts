import { describe, expect, it } from "vitest";
import type { CardData, GameCard, PlayerGameState, ZoneName } from "../src/types.js";
import {
  canPayFor,
  hasInstantSpeed,
  manaSourcesOf,
  parseManaCost,
  parsedCostSize,
  planManaPayment,
  type ManaSource,
} from "../src/game/mana.js";

function src(instanceId: string, colors: string[], isLand = true): ManaSource {
  return { instanceId, colors: colors as ManaSource["colors"], isLand };
}

describe("parseManaCost", () => {
  it("parses generic + colored pips", () => {
    expect(parseManaCost("{2}{U}{U}")).toEqual({ generic: 2, pips: { U: 2 }, hybrids: [], x: 0 });
    expect(parseManaCost("{W}")).toEqual({ generic: 0, pips: { W: 1 }, hybrids: [], x: 0 });
    expect(parseManaCost("{10}")).toEqual({ generic: 10, pips: {}, hybrids: [], x: 0 });
    expect(parseManaCost("{C}{C}")).toEqual({ generic: 0, pips: { C: 2 }, hybrids: [], x: 0 });
  });

  it("parses {0} and {X}", () => {
    const zero = parseManaCost("{0}")!;
    expect(parsedCostSize(zero)).toBe(0);
    const x = parseManaCost("{X}{R}")!;
    expect(x.x).toBe(1);
    expect(parsedCostSize(x)).toBe(1); // only the fixed {R}
  });

  it("parses two-option hybrids", () => {
    expect(parseManaCost("{W/U}")).toEqual({ generic: 0, pips: {}, hybrids: [["W", "U"]], x: 0 });
    expect(parseManaCost("{2/G}")!.hybrids).toEqual([["2", "G"]]);
  });

  it("rejects unenforceable symbols and garbage", () => {
    expect(parseManaCost("{W/P}")).toBeNull(); // phyrexian
    expect(parseManaCost("{S}")).toBeNull(); // snow
    expect(parseManaCost("{HW}")).toBeNull();
    expect(parseManaCost("")).toBeNull();
    expect(parseManaCost(undefined)).toBeNull();
    expect(parseManaCost("2UU")).toBeNull(); // not braces
  });
});

describe("planManaPayment", () => {
  it("prefers floating mana over tapping (CR 106.4)", () => {
    const plan = planManaPayment(parseManaCost("{U}")!, { U: 1 }, [src("island", ["U"])])!;
    expect(plan.fromPool).toEqual({ U: 1 });
    expect(plan.taps).toEqual([]);
  });

  it("auto-taps sources for colored pips and generic", () => {
    const plan = planManaPayment(
      parseManaCost("{1}{G}")!,
      {},
      [src("forest", ["G"]), src("mountain", ["R"])]
    )!;
    expect(plan.taps).toHaveLength(2);
    expect(plan.taps.find((t) => t.instanceId === "forest")!.color).toBe("G");
  });

  it("never strands a dual land on the wrong pip (backtracking/ordering)", () => {
    // {W}{U} with one dual (W/U) and one plains: the dual MUST cover U.
    const plan = planManaPayment(
      parseManaCost("{W}{U}")!,
      {},
      [src("dual", ["W", "U"]), src("plains", ["W"])]
    )!;
    expect(plan.taps.find((t) => t.instanceId === "dual")!.color).toBe("U");
    expect(plan.taps.find((t) => t.instanceId === "plains")!.color).toBe("W");
  });

  it("spends colorless-only sources on generic before flexible ones", () => {
    const plan = planManaPayment(
      parseManaCost("{1}{U}")!,
      {},
      [src("wastes", ["C"], true), src("island", ["U"])]
    )!;
    expect(plan.taps.find((t) => t.instanceId === "island")!.color).toBe("U");
    expect(plan.taps.find((t) => t.instanceId === "wastes")!.color).toBe("C");
  });

  it("pays hybrids with either option", () => {
    const onlyU = planManaPayment(parseManaCost("{W/U}")!, {}, [src("island", ["U"])]);
    expect(onlyU).not.toBeNull();
    const monocolorHybrid = planManaPayment(
      parseManaCost("{2/W}")!,
      {},
      [src("swamp", ["B"]), src("mountain", ["R"])]
    );
    expect(monocolorHybrid).not.toBeNull(); // paid as generic 2
    expect(monocolorHybrid!.taps).toHaveLength(2);
  });

  it("returns null when the cost cannot be paid", () => {
    expect(planManaPayment(parseManaCost("{U}")!, {}, [src("forest", ["G"])])).toBeNull();
    expect(planManaPayment(parseManaCost("{3}")!, { R: 1 }, [src("m", ["R"])])).toBeNull();
  });

  it("mixes pool and taps", () => {
    const plan = planManaPayment(
      parseManaCost("{2}{B}")!,
      { B: 1, C: 1 },
      [src("swamp", ["B"])]
    )!;
    expect(plan.fromPool.B).toBe(1);
    expect(plan.fromPool.C).toBe(1);
    expect(plan.taps).toHaveLength(1);
  });
});

describe("manaSourcesOf / canPayFor / hasInstantSpeed", () => {
  const island: CardData = {
    id: "island",
    name: "Island",
    cmc: 0,
    typeLine: "Basic Land — Island",
    colors: [],
    colorIdentity: ["U"],
    layout: "normal",
    producedMana: ["U"],
  };
  const bolt: CardData = {
    id: "bolt",
    name: "Lightning Bolt",
    manaCost: "{R}",
    cmc: 1,
    typeLine: "Instant",
    colors: ["R"],
    colorIdentity: ["R"],
    layout: "normal",
  };
  const ambusher: CardData = {
    id: "ambusher",
    name: "Boreal Ambusher",
    manaCost: "{1}{U}",
    cmc: 2,
    typeLine: "Creature — Snake",
    oracleText: "Flash\nWhen this creature enters, tap target creature.",
    colors: ["U"],
    colorIdentity: ["U"],
    layout: "normal",
  };

  function mkPlayer(battlefield: GameCard[], pool: Record<string, number> = {}): PlayerGameState {
    const zones = {} as Record<ZoneName, GameCard[]>;
    for (const z of ["library", "hand", "battlefield", "graveyard", "exile", "stack", "sideboard"] as const) {
      zones[z] = [];
    }
    zones.battlefield = battlefield;
    return { playerId: "p1", life: 20, poison: 0, manaPool: pool, zones, landsPlayedThisTurn: 0, hasLost: false };
  }

  function bfCard(instanceId: string, cardId: string, tapped = false): GameCard {
    return {
      instanceId,
      cardId,
      ownerId: "p1",
      controllerId: "p1",
      tapped,
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

  it("collects only untapped face-up producers", () => {
    const player = mkPlayer([bfCard("a", "island"), bfCard("b", "island", true), bfCard("c", "bolt")]);
    const sources = manaSourcesOf(player, { island, bolt });
    expect(sources.map((s) => s.instanceId)).toEqual(["a"]);
    expect(sources[0]!.isLand).toBe(true);
  });

  it("canPayFor: payable, unpayable, and unparseable-permissive", () => {
    const oneIsland = mkPlayer([bfCard("a", "island")]);
    expect(canPayFor(bolt, oneIsland, { island, bolt })).toBe(false); // needs R
    expect(canPayFor(ambusher, oneIsland, { island, ambusher })).toBe(false); // {1}{U} > 1 source
    const twoIslands = mkPlayer([bfCard("a", "island"), bfCard("b", "island")]);
    expect(canPayFor(ambusher, twoIslands, { island, ambusher })).toBe(true);
    const phyrexian: CardData = { ...bolt, id: "px", manaCost: "{U/P}" };
    expect(canPayFor(phyrexian, mkPlayer([]), {})).toBe(true); // unenforceable -> castable
  });

  it("hasInstantSpeed: instants and Flash cards only", () => {
    expect(hasInstantSpeed(bolt)).toBe(true);
    expect(hasInstantSpeed(ambusher)).toBe(true);
    expect(hasInstantSpeed(island)).toBe(false);
    expect(hasInstantSpeed(undefined)).toBe(false);
  });
});
