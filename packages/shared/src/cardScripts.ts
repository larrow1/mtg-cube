/**
 * Card scripts — structured triggered-ability logic for the game engine.
 *
 * `scriptFor(card)` is the single entry point: a curated per-card override
 * registry (`CARD_OVERRIDES`) wins, otherwise `inferScript` parses the card's
 * oracle text with a fixed set of template regexes. Everything here is pure
 * and deterministic: same CardData in, same CardScript out.
 *
 * This file is the project's sustainable card registry. To teach the app a
 * new card, either:
 *  1. do nothing — if its oracle text matches one of the inference templates
 *     below it is picked up automatically; or
 *  2. add an entry to CARD_OVERRIDES keyed by the card's exact name.
 *
 * Design rules (see SPEC "Card scripts, triggers & mana (v3)"):
 *  - Only three trigger events exist: "etb", "dies", "upkeep".
 *  - A DETECTED trigger clause whose effect cannot be parsed becomes
 *    `{kind:"manual", note}` so nothing is silently dropped — resolving it
 *    just logs a reminder to do it by hand.
 *  - Trigger clauses we cannot even detect (cast triggers, attack triggers,
 *    "whenever another creature ..." etc.) are ignored entirely; a card with
 *    no detected triggers yields `null`.
 *  - Targeted effects are never automated (there is no targeting UI), so
 *    cards like Flametongue Kavu are curated as `manual`.
 */
import type { CardData, CardScript, CardTrigger, TriggerEffect, TriggerEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

/** Oracle-text number words ("draw two cards", "create three ... tokens"). */
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Parse "a"/"an"/"one".."ten" or a digit string into a positive count. */
function parseCount(word: string): number | null {
  const w = word.toLowerCase();
  const named = NUMBER_WORDS[w];
  if (named !== undefined) return named;
  if (/^\d+$/.test(w)) {
    const n = Number(w);
    return n >= 1 ? n : null;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex alternation for every way oracle text refers to the card itself:
 * the full name, the short name (part before the first comma — legendary
 * cards say "When Ghalta enters ..."), and the modern generic self-references
 * ("this creature" etc.). Longer alternatives first so the full name wins.
 */
function selfAlternation(name: string): string {
  const short = name.split(",")[0]!.trim();
  const names = short && short.toLowerCase() !== name.toLowerCase() ? [name, short] : [name];
  return [
    ...names.map(escapeRegExp),
    "this creature",
    "this artifact",
    "this enchantment",
    "this permanent",
    "this land",
  ].join("|");
}

// ---------------------------------------------------------------------------
// Effect templates
// ---------------------------------------------------------------------------

const COLOR_WORDS = "white|blue|black|red|green|colorless";

/**
 * Parse ONE effect clause (the text after the trigger condition's comma, with
 * any leading "you may" already stripped) into a structured TriggerEffect.
 * Each template is anchored `^...$`, so compound clauses ("draw a card, then
 * discard a card") match nothing and fall back to manual in the caller.
 */
function parseEffect(clause: string, self: string): TriggerEffect | null {
  // Drop the trailing period; templates below are period-free.
  const text = clause.trim().replace(/\.+$/, "");
  let m: RegExpMatchArray | null;

  // "draw a card" / "draw two cards" / "draw 3 cards"
  if ((m = text.match(/^draw (\w+) cards?$/i))) {
    const count = parseCount(m[1]!);
    return count === null ? null : { kind: "draw", count };
  }

  // "you gain 2 life"
  if ((m = text.match(/^you gain (\w+) life$/i))) {
    const amount = parseCount(m[1]!);
    return amount === null ? null : { kind: "gainLife", amount };
  }

  // "you lose 2 life"
  if ((m = text.match(/^you lose (\w+) life$/i))) {
    const amount = parseCount(m[1]!);
    return amount === null ? null : { kind: "loseLife", amount };
  }

  // "each opponent loses 1 life"
  if ((m = text.match(/^each opponent loses (\w+) life$/i))) {
    const amount = parseCount(m[1]!);
    return amount === null ? null : { kind: "eachOpponentLosesLife", amount };
  }

  // "~ deals 2 damage to each opponent" / "it deals 2 damage to any target".
  // "any target" is auto-resolved against the opponent (1v1) — cards where
  // that shorthand is wrong (true targeted removal) belong in CARD_OVERRIDES.
  if (
    (m = text.match(
      new RegExp(`^(?:${self}|it) deals (\\w+) damage to (?:each opponent|any target)$`, "i")
    ))
  ) {
    const amount = parseCount(m[1]!);
    return amount === null ? null : { kind: "damageOpponent", amount };
  }

  // "put a +1/+1 counter on ~" / "put two charge counters on this artifact".
  // Counter type is "+1/+1" or a single lowercase word (charge, time, ...).
  if (
    (m = text.match(
      new RegExp(`^put (\\w+) (\\+1\\/\\+1|[a-z]+) counters? on (?:${self}|it|itself)$`, "i")
    ))
  ) {
    const count = parseCount(m[1]!);
    return count === null ? null : { kind: "addCounters", counterType: m[2]!, count };
  }

  // "create a 5/5 black Demon creature token with flying" /
  // "create three 1/1 red Goblin creature tokens".
  // The token name is the subtype words; a single trailing "with <keyword>"
  // is accepted (kept in the description, not modeled — tokens have no
  // rules text in this engine). Anything fancier (no P/T, multi-ability,
  // "that's tapped and attacking", ...) falls through to manual.
  if (
    (m = text.match(
      new RegExp(
        `^create (\\w+) (\\d+)\\/(\\d+) ` +
          `((?:${COLOR_WORDS})(?: and (?:${COLOR_WORDS}))?) ` +
          `([A-Za-z' ]+?) ((?:artifact )?)creature tokens?( with [a-z]+)?$`,
        "i"
      )
    ))
  ) {
    const count = parseCount(m[1]!);
    if (count === null) return null;
    const name = m[5]!.trim();
    const artifact = m[6]!.trim().length > 0;
    return {
      kind: "createToken",
      name,
      typeLine: `Token ${artifact ? "Artifact " : ""}Creature — ${name}`,
      power: m[2]!,
      toughness: m[3]!,
      count,
    };
  }

  // "scry 2"
  if ((m = text.match(/^scry (\w+)$/i))) {
    const count = parseCount(m[1]!);
    return count === null ? null : { kind: "scry", count };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Trigger clause detection
// ---------------------------------------------------------------------------

/**
 * Try to read one oracle-text line as a trigger clause. Returns null when the
 * line is not a detectable trigger (keywords, activated abilities, trigger
 * conditions we do not model).
 */
function parseLine(line: string, self: string): CardTrigger | null {
  const conditions: { event: TriggerEvent; re: RegExp }[] = [
    {
      event: "etb",
      // "When ~ enters the battlefield," / modern "When this creature enters,"
      re: new RegExp(`^when(?:ever)? (?:${self}) enters(?: the battlefield)?, (.+)$`, "i"),
    },
    {
      event: "dies",
      // "When ~ dies," (plus the pre-2011 templating of the same event).
      re: new RegExp(
        `^when(?:ever)? (?:${self}) (?:dies|is put into a graveyard from the battlefield), (.+)$`,
        "i"
      ),
    },
    {
      event: "upkeep",
      re: /^at the beginning of your upkeep, (.+)$/i,
    },
  ];

  for (const { event, re } of conditions) {
    const m = line.match(re);
    if (!m) continue;
    let clause = m[1]!.trim();
    let optional = false;
    const may = clause.match(/^you may (.+)$/i);
    if (may) {
      optional = true;
      clause = may[1]!;
    }
    // A detected trigger ALWAYS yields a script entry: parsed effects run
    // mechanically, everything else becomes a manual reminder.
    const effect = parseEffect(clause, self) ?? {
      kind: "manual" as const,
      note: clause.trim().replace(/\.+$/, ""),
    };
    return { event, optional, description: line, effect };
  }
  return null;
}

/**
 * Infer a CardScript from oracle text. Front face only for multi-faced cards
 * (the back face is reached in play via flipCard and stays manual). Returns
 * null when no trigger clause is detected at all.
 */
export function inferScript(card: CardData): CardScript | null {
  const face = card.faces?.[0];
  const name = face?.name ?? card.name;
  const oracle = face ? face.oracleText ?? "" : card.oracleText ?? "";
  if (!oracle) return null;

  // Strip reminder text (parenthesized), then examine each line on its own.
  const stripped = oracle.replace(/\s*\([^)]*\)/g, "");
  const self = selfAlternation(name);

  const triggers: CardTrigger[] = [];
  for (const raw of stripped.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const trigger = parseLine(line, self);
    if (trigger) triggers.push(trigger);
  }
  return triggers.length > 0 ? { triggers } : null;
}

// ---------------------------------------------------------------------------
// Override registry — curated cube staples
// ---------------------------------------------------------------------------

/**
 * Hand-written scripts keyed by exact card name. These win over inference and
 * exist for two reasons:
 *  - cards whose parseable-looking text must stay manual (targeted effects:
 *    Flametongue Kavu, Shriekmaw, ...);
 *  - cards whose compound text inference would give up on, but whose useful
 *    half CAN be automated safely (Bitterblossom, Phyrexian Arena, ...),
 *    expressed as multiple single-effect triggers of the same event.
 * Descriptions carry the real oracle wording so the stack UI reads true.
 */
export const CARD_OVERRIDES: Record<string, CardScript> = {
  // Targeted ETB damage — never automated (no targeting system).
  "Flametongue Kavu": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When Flametongue Kavu enters the battlefield, it deals 4 damage to target creature.",
        effect: { kind: "manual", note: "it deals 4 damage to target creature" },
      },
    ],
  },
  // Targeted ETB removal (evoke handled by normal play, not scripted).
  Shriekmaw: {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "When Shriekmaw enters the battlefield, destroy target nonartifact, nonblack creature.",
        effect: { kind: "manual", note: "destroy target nonartifact, nonblack creature" },
      },
    ],
  },
  "Ravenous Chupacabra": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "When Ravenous Chupacabra enters the battlefield, destroy target creature an opponent controls.",
        effect: { kind: "manual", note: "destroy target creature an opponent controls" },
      },
    ],
  },
  // Inference would get this one right too; curated as ground truth.
  Mulldrifter: {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When Mulldrifter enters the battlefield, draw two cards.",
        effect: { kind: "draw", count: 2 },
      },
    ],
  },
  // ETB tutor is manual; the dies draw is fully automated.
  "Solemn Simulacrum": {
    triggers: [
      {
        event: "etb",
        optional: true,
        description:
          "When Solemn Simulacrum enters the battlefield, you may search your library for a basic land card, put it onto the battlefield tapped, then shuffle.",
        effect: {
          kind: "manual",
          note: "search your library for a basic land card, put it onto the battlefield tapped, then shuffle",
        },
      },
      {
        event: "dies",
        optional: true,
        description: "When Solemn Simulacrum dies, you may draw a card.",
        effect: { kind: "draw", count: 1 },
      },
    ],
  },
  "Kitchen Finks": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When Kitchen Finks enters the battlefield, you gain 2 life.",
        effect: { kind: "gainLife", amount: 2 },
      },
    ],
  },
  // The token trigger is really "leaves the battlefield"; "dies" is the
  // closest event this engine has and covers the common case. The real
  // wording stays in the description so players can correct edge cases.
  Thragtusk: {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When Thragtusk enters the battlefield, you gain 5 life.",
        effect: { kind: "gainLife", amount: 5 },
      },
      {
        event: "dies",
        optional: false,
        description:
          "When Thragtusk leaves the battlefield, create a 3/3 green Beast creature token.",
        effect: {
          kind: "createToken",
          name: "Beast",
          typeLine: "Token Creature — Beast",
          power: "3",
          toughness: "3",
          count: 1,
        },
      },
    ],
  },
  // Attack half of the trigger is not modeled; the ETB half is automated.
  "Grave Titan": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "Whenever Grave Titan enters the battlefield or attacks, create two 2/2 black Zombie creature tokens.",
        effect: {
          kind: "createToken",
          name: "Zombie",
          typeLine: "Token Creature — Zombie",
          power: "2",
          toughness: "2",
          count: 2,
        },
      },
    ],
  },
  // Targeted recursion — manual, optional ("you may").
  "Sun Titan": {
    triggers: [
      {
        event: "etb",
        optional: true,
        description:
          "Whenever Sun Titan enters the battlefield or attacks, you may return target permanent card with mana value 3 or less from your graveyard to the battlefield.",
        effect: {
          kind: "manual",
          note: "return target permanent card with mana value 3 or less from your graveyard to the battlefield",
        },
      },
    ],
  },
  // Compound upkeep clause split into two single-effect triggers.
  Bitterblossom: {
    triggers: [
      {
        event: "upkeep",
        optional: false,
        description:
          "At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature token with flying.",
        effect: { kind: "loseLife", amount: 1 },
      },
      {
        event: "upkeep",
        optional: false,
        description:
          "At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature token with flying.",
        effect: {
          kind: "createToken",
          name: "Faerie Rogue",
          typeLine: "Token Creature — Faerie Rogue",
          power: "1",
          toughness: "1",
          count: 1,
        },
      },
    ],
  },
  // Compound upkeep clause split into two single-effect triggers.
  "Phyrexian Arena": {
    triggers: [
      {
        event: "upkeep",
        optional: false,
        description: "At the beginning of your upkeep, you draw a card and you lose 1 life.",
        effect: { kind: "draw", count: 1 },
      },
      {
        event: "upkeep",
        optional: false,
        description: "At the beginning of your upkeep, you draw a card and you lose 1 life.",
        effect: { kind: "loseLife", amount: 1 },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Overrides win; otherwise infer from oracle text; null = no known triggers. */
export function scriptFor(card: CardData): CardScript | null {
  return CARD_OVERRIDES[card.name] ?? inferScript(card);
}
