import { describe, expect, it } from "vitest";
import { normalizeCubeLines, parseCubeList } from "../src/cubeParser.js";

describe("parseCubeList", () => {
  it("parses bare names, counts, and Nx counts", () => {
    const lines = parseCubeList(
      ["Lightning Bolt", "1 Counterspell", "4x Llanowar Elves", "2X Shock"].join("\n")
    );
    expect(lines).toEqual([
      { count: 1, name: "Lightning Bolt" },
      { count: 1, name: "Counterspell" },
      { count: 4, name: "Llanowar Elves" },
      { count: 2, name: "Shock" },
    ]);
  });

  it("ignores blank lines and comments", () => {
    const lines = parseCubeList("# my cube\n\n// section\n  \nLightning Bolt\n");
    expect(lines).toEqual([{ count: 1, name: "Lightning Bolt" }]);
  });

  it("strips set/collector suffixes", () => {
    const lines = parseCubeList(
      ["Lightning Bolt (M10) 146", "Counterspell [7ED]", "1 Shock (M21)"].join("\n")
    );
    expect(lines.map((l) => l.name)).toEqual(["Lightning Bolt", "Counterspell", "Shock"]);
  });

  it("passes split card names through", () => {
    const lines = parseCubeList("1 Fire // Ice\nWear // Tear");
    expect(lines.map((l) => l.name)).toEqual(["Fire // Ice", "Wear // Tear"]);
  });

  it("drops lines with out-of-range counts", () => {
    const lines = parseCubeList("0 Nothing\n100 TooMany\n3 Fine");
    expect(lines).toEqual([{ count: 3, name: "Fine" }]);
  });

  it("handles \\r\\n line endings", () => {
    const lines = parseCubeList("Lightning Bolt\r\n2 Shock\r\n");
    expect(lines).toEqual([
      { count: 1, name: "Lightning Bolt" },
      { count: 2, name: "Shock" },
    ]);
  });
});

describe("normalizeCubeLines", () => {
  it("collapses duplicates case-insensitively, summing counts", () => {
    const out = normalizeCubeLines([
      { count: 1, name: "Lightning Bolt" },
      { count: 2, name: "Shock" },
      { count: 3, name: "lightning bolt" },
    ]);
    expect(out).toEqual([
      { count: 4, name: "Lightning Bolt" },
      { count: 2, name: "Shock" },
    ]);
  });

  it("preserves first-seen order and does not mutate input", () => {
    const input = [
      { count: 1, name: "B" },
      { count: 1, name: "A" },
      { count: 1, name: "b" },
    ];
    const copy = structuredClone(input);
    const out = normalizeCubeLines(input);
    expect(out.map((l) => l.name)).toEqual(["B", "A"]);
    expect(input).toEqual(copy);
  });
});
