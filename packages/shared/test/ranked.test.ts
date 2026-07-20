import { describe, expect, it } from "vitest";
import { RANK_BANDS, STARTING_RATING, eloDelta, rankFor } from "../src/ranked.js";
import { RANK_TIERS } from "../src/types.js";

describe("eloDelta", () => {
  it("gives 0 for a draw between equal ratings", () => {
    expect(eloDelta(1200, 1200, 0.5)).toBe(0);
    expect(eloDelta(1500, 1500, 0.5)).toBe(0);
  });

  it("gives +16 for a win between equal ratings (K=32)", () => {
    expect(eloDelta(1200, 1200, 1)).toBe(16);
    expect(eloDelta(1200, 1200, 0)).toBe(-16);
  });

  it("is symmetric: A's delta for a result mirrors B's for the opposite result", () => {
    const deltaA = eloDelta(1300, 1180, 1);
    const deltaB = eloDelta(1180, 1300, 0);
    expect(deltaA).toBe(-deltaB);
  });

  it("rewards the underdog more for a win than the favorite", () => {
    const underdogWin = eloDelta(1100, 1400, 1);
    const favoriteWin = eloDelta(1400, 1100, 1);
    expect(underdogWin).toBeGreaterThan(favoriteWin);
    expect(underdogWin).toBeGreaterThan(16);
    expect(favoriteWin).toBeLessThan(16);
    expect(favoriteWin).toBeGreaterThanOrEqual(0);
  });

  it("win delta grows monotonically with the opponent's rating", () => {
    let prev = -Infinity;
    for (let opp = 800; opp <= 1600; opp += 50) {
      const d = eloDelta(1200, opp, 1);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it("respects a custom K factor", () => {
    expect(eloDelta(1200, 1200, 1, 16)).toBe(8);
  });
});

describe("rankFor", () => {
  it("maps band boundaries per the spec", () => {
    expect(rankFor(1099)).toBe("Bronze");
    expect(rankFor(1100)).toBe("Silver");
    expect(rankFor(1249)).toBe("Silver");
    expect(rankFor(1250)).toBe("Gold");
    expect(rankFor(1399)).toBe("Gold");
    expect(rankFor(1400)).toBe("Platinum");
    expect(rankFor(1549)).toBe("Platinum");
    expect(rankFor(1550)).toBe("Diamond");
    expect(rankFor(1699)).toBe("Diamond");
    expect(rankFor(1700)).toBe("Mythic");
    expect(rankFor(2400)).toBe("Mythic");
  });

  it("puts the starting rating in Silver", () => {
    expect(rankFor(STARTING_RATING)).toBe("Silver");
  });

  it("handles ratings below every band", () => {
    expect(rankFor(0)).toBe("Bronze");
    expect(rankFor(-50)).toBe("Bronze");
  });

  it("is monotonic: higher ratings never map to a lower tier", () => {
    let prevIdx = 0;
    for (let rating = 0; rating <= 2500; rating += 1) {
      const idx = RANK_TIERS.indexOf(rankFor(rating));
      expect(idx).toBeGreaterThanOrEqual(prevIdx);
      prevIdx = idx;
    }
  });
});

describe("RANK_BANDS", () => {
  it("lists every tier once, ascending by min", () => {
    expect(RANK_BANDS.map((b) => b.tier)).toEqual([...RANK_TIERS]);
    for (let i = 1; i < RANK_BANDS.length; i++) {
      expect(RANK_BANDS[i]!.min).toBeGreaterThan(RANK_BANDS[i - 1]!.min);
    }
  });

  it("agrees with rankFor at each band's min", () => {
    for (const band of RANK_BANDS) {
      expect(rankFor(band.min)).toBe(band.tier);
      if (band.min > 0) expect(rankFor(band.min - 1)).not.toBe(band.tier);
    }
  });
});
