import { describe, expect, it } from "vitest";
import { createRng, shuffle } from "../src/rng.js";

describe("createRng", () => {
  it("is deterministic for the same seed", () => {
    const a = createRng("seed-1");
    const b = createRng("seed-1");
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = createRng("seed-1");
    const b = createRng("seed-2");
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("yields numbers in [0, 1)", () => {
    const rng = createRng("bounds");
    for (let i = 0; i < 1000; i++) {
      const n = rng();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
});

describe("shuffle", () => {
  it("returns a permutation without mutating the input", () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const copy = input.slice();
    const out = shuffle(input, createRng("shuffle"));
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
    expect(out.slice().sort((a, b) => a - b)).toEqual(copy);
    expect(out).not.toEqual(copy); // astronomically unlikely to be identity
  });

  it("is deterministic for the same seed", () => {
    const input = Array.from({ length: 30 }, (_, i) => `card${i}`);
    expect(shuffle(input, createRng("s"))).toEqual(shuffle(input, createRng("s")));
  });
});
