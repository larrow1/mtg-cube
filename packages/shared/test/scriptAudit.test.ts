/**
 * Blast-radius audit (SPEC v9) — golden snapshot of every fixture card's
 * script, the "Ninja's Kunai lesson": regenerated card logic can silently
 * change cards you did not mean to touch. Any edit to the inference templates
 * or CARD_OVERRIDES that alters ANY fixture card's script fails this test
 * with a readable per-card diff of old vs new.
 *
 * REGENERATION WORKFLOW (intentional template/override changes):
 *
 *     cd packages/shared
 *     UPDATE_SCRIPT_AUDIT=1 npx vitest run test/scriptAudit.test.ts
 *     # PowerShell: $env:UPDATE_SCRIPT_AUDIT = "1"; npx vitest run test/scriptAudit.test.ts
 *
 * That rewrites test/fixtures/scriptAudit.snapshot.json from the current
 * scriptFor output and the run passes. The snapshot is CHECKED IN: its git
 * diff is the card-behavior changelog for the change, and it MUST be reviewed
 * card-by-card in code review — every card whose script moved is either an
 * intended improvement or exactly the regression this audit exists to catch.
 * Never regenerate to "make the test green" without reading the diff.
 *
 * Determinism: scriptFor is pure, the snapshot is pretty-printed with 2-space
 * indent and recursively sorted keys, so regeneration with no behavior change
 * is byte-identical.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scriptFor } from "../src/cardScripts.js";
import { AUDIT_CARDS } from "./fixtures/auditCards.js";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("./fixtures/scriptAudit.snapshot.json", import.meta.url)
);
const UPDATE = process.env.UPDATE_SCRIPT_AUDIT !== undefined && process.env.UPDATE_SCRIPT_AUDIT !== "";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Recursively sort object keys so serialization is deterministic. */
function canonicalize(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value as Json;
}

/** Current scriptFor output for every fixture, keyed by card name, sorted. */
function currentScripts(): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const card of [...AUDIT_CARDS].sort((a, b) => a.name.localeCompare(b.name))) {
    out[card.name] = canonicalize(scriptFor(card));
  }
  return out;
}

const actual = currentScripts();

if (UPDATE) {
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(actual, null, 2) + "\n", "utf8");
}

function loadSnapshot(): Record<string, Json> {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `Missing golden snapshot ${SNAPSHOT_PATH}.\n` +
        `Generate it with: UPDATE_SCRIPT_AUDIT=1 npx vitest run test/scriptAudit.test.ts\n` +
        `(then check the file in and review it card-by-card).`
    );
  }
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Record<string, Json>;
}

describe("script audit — golden snapshot of scriptFor over the fixture cube", () => {
  it("no card's script changed vs the checked-in snapshot (per-card diff on failure)", () => {
    const snapshot = loadSnapshot();
    const changed: string[] = [];
    for (const card of AUDIT_CARDS) {
      const name = card.name;
      const oldScript = name in snapshot ? snapshot[name]! : undefined;
      const newScript = actual[name]!;
      if (JSON.stringify(oldScript) === JSON.stringify(newScript)) continue;
      changed.push(
        [
          `■ ${name}`,
          `  --- snapshot (old) ---`,
          `  ${oldScript === undefined ? "<no entry in snapshot>" : JSON.stringify(oldScript, null, 2).replace(/\n/g, "\n  ")}`,
          `  +++ current (new) +++`,
          `  ${JSON.stringify(newScript, null, 2).replace(/\n/g, "\n  ")}`,
        ].join("\n")
      );
    }
    if (changed.length > 0) {
      expect.fail(
        `${changed.length} card script(s) differ from test/fixtures/scriptAudit.snapshot.json ` +
          `(the Ninja's Kunai audit).\n\n` +
          changed.join("\n\n") +
          `\n\nIf every change above is INTENDED, regenerate the snapshot:\n` +
          `  UPDATE_SCRIPT_AUDIT=1 npx vitest run test/scriptAudit.test.ts\n` +
          `and have the snapshot diff reviewed card-by-card in code review.\n` +
          `If any change is NOT intended, your template edit has a wider blast radius than planned.`
      );
    }
  });

  it("snapshot covers every fixture exactly (no silent additions or stale entries)", () => {
    // Fixture names must be unique — the snapshot is keyed by name.
    const names = AUDIT_CARDS.map((c) => c.name);
    expect(new Set(names).size, "duplicate fixture card names").toBe(names.length);

    const snapshot = loadSnapshot();
    const missing = names.filter((n) => !(n in snapshot));
    expect(
      missing,
      `fixture cards missing from the snapshot — regenerate with UPDATE_SCRIPT_AUDIT=1`
    ).toEqual([]);

    const stale = Object.keys(snapshot).filter((n) => !names.includes(n));
    expect(
      stale,
      `snapshot entries with no matching fixture — regenerate with UPDATE_SCRIPT_AUDIT=1`
    ).toEqual([]);
  });
});
