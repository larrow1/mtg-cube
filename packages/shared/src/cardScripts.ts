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
 *  - Supported trigger events: "etb", "dies", "leaves", "upkeep",
 *    "eachUpkeep", "endStep", "attack", "castSpell" (with castFilter), and
 *    "combatDamageToPlayer". The engine owns their emission points.
 *  - A DETECTED trigger clause whose effect cannot be parsed becomes
 *    `{kind:"manual", note}` so nothing is silently dropped — resolving it
 *    just logs a reminder to do it by hand.
 *  - Trigger CONDITIONS outside the supported events ("whenever another
 *    creature enters", "whenever an opponent casts", saga chapters, ...) are
 *    ignored by inference; cube cards affected are documented in
 *    UNSUPPORTED_TRIGGER_CARDS below so the omission is explicit.
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
  const names = new Set([name]);
  // Part before the first comma ("When Ghalta enters ...").
  const short = name.split(",")[0]!.trim();
  if (short) names.add(short);
  // Comma-less legends shorten too: "Loran of the Third Path" says "When
  // Loran enters", "Batroc the Leaper" says "When Batroc enters". Safe in the
  // anchored trigger templates these alternations are used in.
  const lead = name.split(/\s+(?:of|the)\s+/)[0]!.trim();
  if (lead) names.add(lead);
  // Longest first so the full name wins over its own prefixes.
  const sorted = [...names].sort((a, b) => b.length - a.length);
  return [
    ...sorted.map(escapeRegExp),
    "this creature",
    "this artifact",
    "this enchantment",
    "this permanent",
    "this land",
    "this Class",
    "this Equipment",
    "this Aura",
    "this Vehicle",
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
      new RegExp(`^(?:${self}|it|he|she|they) deals? (\\w+) damage to (?:each opponent|any target)$`, "i")
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

  // "create a Treasure token" / "create two Blood tokens" — predefined
  // artifact tokens. Their rules text is not modeled (tokens carry no rules
  // in this engine); name + type line are enough to play with.
  if (
    (m = text.match(
      /^create (\w+) (Treasure|Blood|Clue|Food|Gold|Junk|Map|Powerstone) tokens?$/i
    ))
  ) {
    const count = parseCount(m[1]!);
    if (count === null) return null;
    const tokenName = m[2]![0]!.toUpperCase() + m[2]!.slice(1).toLowerCase();
    return {
      kind: "createToken",
      name: tokenName,
      typeLine: `Token Artifact — ${tokenName}`,
      count,
    };
  }

  // "investigate" = create a Clue token (its sacrifice ability is printed on
  // the stack description via the card; the token itself carries no rules).
  if (/^investigate$/i.test(text)) {
    return { kind: "createToken", name: "Clue", typeLine: "Token Artifact — Clue", count: 1 };
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
 * Ability-word prefixes ("Magecraft — Whenever ...", "Raid — When ...") are
 * flavor labels; strip them before matching trigger conditions. The original
 * line (prefix included) stays as the trigger description.
 */
const ABILITY_WORD_PREFIX = /^[A-Z][A-Za-z'’ -]{0,30} — /;

/**
 * Try to read one oracle-text line as one or more trigger clauses. Returns []
 * when the line is not a detectable trigger (keywords, activated abilities,
 * trigger conditions we do not model). Compound conditions covering two
 * supported events ("enters or attacks", "enters or dies") yield one trigger
 * per event with the shared effect.
 */
function parseLine(line: string, self: string): CardTrigger[] {
  const conditions: {
    events: TriggerEvent[];
    re: RegExp;
    castFilter?: CardTrigger["castFilter"];
  }[] = [
    {
      // "When ~ enters the battlefield or attacks," / "Whenever ~ attacks or
      // enters," — fires on both supported events.
      events: ["etb", "attack"],
      re: new RegExp(
        `^when(?:ever)? (?:${self}) (?:enters?(?: the battlefield)? or attacks|attacks or enters?(?: the battlefield)?), (.+)$`,
        "i"
      ),
    },
    {
      // "When ~ enters or dies,"
      events: ["etb", "dies"],
      re: new RegExp(`^when(?:ever)? (?:${self}) enters?(?: the battlefield)? or dies, (.+)$`, "i"),
    },
    {
      // "When ~ enters or leaves the battlefield," (charms like Cryogen Relic).
      events: ["etb", "leaves"],
      re: new RegExp(
        `^when(?:ever)? (?:${self}) enters?(?: the battlefield)? or leaves the battlefield, (.+)$`,
        "i"
      ),
    },
    {
      // "When ~ enters and whenever it deals combat damage to a player,"
      events: ["etb", "combatDamageToPlayer"],
      re: new RegExp(
        `^when(?:ever)? (?:${self}) enters?(?: the battlefield)? and whenever (?:it|he|she|they) deals? combat damage to a player, (.+)$`,
        "i"
      ),
    },
    {
      // "When ~ enters and at the beginning of your upkeep," (Minsc & Boo).
      events: ["etb", "upkeep"],
      re: new RegExp(
        `^when(?:ever)? (?:${self}) enters?(?: the battlefield)? and at the beginning of your upkeep, (.+)$`,
        "i"
      ),
    },
    {
      events: ["etb"],
      // "When ~ enters the battlefield," / modern "When this creature enters,"
      // ("enters?" also covers plural-named legends: "When Cloak and Dagger enter,").
      re: new RegExp(`^when(?:ever)? (?:${self}) enters?(?: the battlefield)?, (.+)$`, "i"),
    },
    {
      events: ["dies"],
      // "When ~ dies," (plus the pre-2011 templating of the same event).
      re: new RegExp(
        `^when(?:ever)? (?:${self}) (?:dies|is put into a graveyard from the battlefield), (.+)$`,
        "i"
      ),
    },
    {
      events: ["leaves"],
      re: new RegExp(`^when(?:ever)? (?:${self}) leaves the battlefield, (.+)$`, "i"),
    },
    {
      events: ["upkeep"],
      re: /^at the beginning of your upkeep, (.+)$/i,
    },
    {
      // "each upkeep" / "each player's upkeep" fires on both players' turns.
      // ("each opponent's upkeep" intentionally does NOT match — that
      // condition has no event and belongs in UNSUPPORTED_TRIGGER_CARDS.)
      events: ["eachUpkeep"],
      re: /^at the beginning of each (?:player's )?upkeep, (.+)$/i,
    },
    {
      events: ["endStep"],
      re: /^at the beginning of your end step, (.+)$/i,
    },
    {
      events: ["attack"],
      re: new RegExp(`^whenever (?:${self}) attacks, (.+)$`, "i"),
    },
    {
      // "or planeswalker": planeswalkers are ordinary battlefield cards here,
      // so the unblocked-attacker emission covers the main (player) case.
      events: ["combatDamageToPlayer"],
      re: new RegExp(
        `^whenever (?:${self}) deals combat damage to a player(?: or planeswalker)?, (.+)$`,
        "i"
      ),
    },
    {
      events: ["castSpell"],
      castFilter: "instantOrSorcery",
      // "cast or copy" (magecraft) maps to the cast event; copies are not a
      // thing in this engine, so the cast half is the whole story.
      re: /^whenever you cast (?:or copy )?an instant or sorcery spell, (.+)$/i,
    },
    {
      events: ["castSpell"],
      castFilter: "noncreature",
      re: /^whenever you cast a noncreature spell, (.+)$/i,
    },
    {
      events: ["castSpell"],
      castFilter: "creature",
      re: /^whenever you cast a creature spell, (.+)$/i,
    },
    {
      events: ["castSpell"],
      castFilter: "artifact",
      re: /^whenever you cast an artifact spell, (.+)$/i,
    },
    {
      events: ["castSpell"],
      castFilter: "any",
      re: /^whenever you cast a spell, (.+)$/i,
    },
  ];

  const body = line.replace(ABILITY_WORD_PREFIX, "");
  for (const { events, re, castFilter } of conditions) {
    const m = body.match(re);
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
    return events.map((event) => ({
      event,
      optional,
      description: line,
      effect,
      ...(event === "castSpell" && castFilter !== undefined ? { castFilter } : {}),
    }));
  }
  return [];
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
    triggers.push(...parseLine(line, self));
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
  // Targeted ETB damage — never automated (no targeting system). Description
  // uses the current oracle wording ("this creature enters").
  "Flametongue Kavu": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When this creature enters, it deals 4 damage to target creature.",
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
  // The token trigger fires on ANY departure ("leaves the battlefield").
  Thragtusk: {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When Thragtusk enters the battlefield, you gain 5 life.",
        effect: { kind: "gainLife", amount: 5 },
      },
      {
        event: "leaves",
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
  // "Enters or attacks" — one trigger per supported event, same effect.
  "Grave Titan": {
    triggers: (["etb", "attack"] as const).map((event) => ({
      event,
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
    })),
  },
  // Targeted recursion — manual, optional ("you may"), on both events.
  "Sun Titan": {
    triggers: (["etb", "attack"] as const).map((event) => ({
      event,
      optional: true,
      description:
        "Whenever Sun Titan enters the battlefield or attacks, you may return target permanent card with mana value 3 or less from your graveyard to the battlefield.",
      effect: {
        kind: "manual",
        note: "return target permanent card with mana value 3 or less from your graveyard to the battlefield",
      },
    })),
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

  // -------------------------------------------------------------------------
  // LSV cube curation. Cards whose trigger line combines a supported condition
  // with an unsupportable one keep the supported half here; the other half is
  // documented in UNSUPPORTED_TRIGGER_CARDS. Descriptions quote the current
  // oracle wording so the stack UI (and the audit tooling) read true.
  // -------------------------------------------------------------------------

  // Self-ETB half scripted; "or another artifact you control enters" is not
  // modelable (see UNSUPPORTED_TRIGGER_CARDS).
  "Kappa Cannoneer": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "Whenever this creature or another artifact you control enters, put a +1/+1 counter on this creature. It can't be blocked this turn.",
        effect: {
          kind: "manual",
          note: "put a +1/+1 counter on this creature; it can't be blocked this turn",
        },
      },
    ],
  },
  // The one oracle line packs an ETB reanimation and a leaves-clean-up
  // delayed trigger; both map to supported events.
  "Animate Dead": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "When this Aura enters, if it's on the battlefield, it loses \"enchant creature card in a graveyard\" and gains \"enchant creature put onto the battlefield with this Aura.\" Return enchanted creature card to the battlefield under your control and attach this Aura to it. When this Aura leaves the battlefield, that creature's controller sacrifices it.",
        effect: {
          kind: "manual",
          note: "return the enchanted creature card to the battlefield under your control and attach this Aura to it",
        },
      },
      {
        event: "leaves",
        optional: false,
        description:
          "When this Aura leaves the battlefield, that creature's controller sacrifices it.",
        effect: { kind: "manual", note: "the returned creature's controller sacrifices it" },
      },
    ],
  },
  // ETB half scripted; the "whenever an opponent draws" half is not modelable.
  "Orcish Bowmasters": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "When this creature enters and whenever an opponent draws a card except the first one they draw in each of their draw steps, this creature deals 1 damage to any target. Then amass Orcs 1.",
        effect: {
          kind: "manual",
          note: "this creature deals 1 damage to any target, then amass Orcs 1",
        },
      },
    ],
  },
  // The attack trigger fires on every declaration; its "first time each turn"
  // and delirium riders are printed in the description for the players to
  // apply (counter the trigger when the condition is not met).
  "Fear of Missing Out": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When this creature enters, discard a card, then draw a card.",
        effect: { kind: "manual", note: "discard a card, then draw a card" },
      },
      {
        event: "attack",
        optional: false,
        description:
          "Delirium — Whenever this creature attacks for the first time each turn, if there are four or more card types among cards in your graveyard, untap target creature. After this phase, there is an additional combat phase.",
        effect: {
          kind: "manual",
          note: "if delirium and this is its first attack this turn: untap target creature; add an extra combat phase",
        },
      },
    ],
  },
  // The normal case (cast from hand) is a plain ETB; the from-graveyard/exile
  // exception and the die-roll stay manual.
  '"Name Sticker" Goblin': {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          'When this creature enters from anywhere other than a graveyard or exile, if it\'s on the battlefield and you control 9 or fewer creatures named "Name Sticker" Goblin, roll a 20-sided die.',
        effect: {
          kind: "manual",
          note: "unless it entered from a graveyard or exile: roll a 20-sided die and apply the result",
        },
      },
    ],
  },
  // Self-ETB half scripted; "or another Lhurgoyf creature you control" is not.
  Pyrogoyf: {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "Whenever this creature or another Lhurgoyf creature you control enters, that creature deals damage equal to its power to any target.",
        effect: { kind: "manual", note: "this creature deals damage equal to its power to any target" },
      },
    ],
  },
  // "At the beginning of the end step" means EVERY end step; the endStep
  // event only fires on the controller's own turn (the overwhelmingly common
  // case — Breach is cast and used on your own turn). Cast on an opponent's
  // turn, sacrifice it by hand at their end step.
  "Underworld Breach": {
    triggers: [
      {
        event: "endStep",
        optional: false,
        description: "At the beginning of the end step, sacrifice this enchantment.",
        effect: { kind: "manual", note: "sacrifice this enchantment" },
      },
    ],
  },
  // "Combat damage to an opponent" is this engine's combatDamageToPlayer;
  // the planeswalker ping is a targeted follow-up, so manual.
  "Questing Beast": {
    triggers: [
      {
        event: "combatDamageToPlayer",
        optional: false,
        description:
          "Whenever Questing Beast deals combat damage to an opponent, it deals that much damage to target planeswalker that player controls.",
        effect: {
          kind: "manual",
          note: "it deals that much damage to target planeswalker that player controls",
        },
      },
    ],
  },
  // Self half of the enters trigger automated as two single-effect triggers;
  // the "another creature with power 4 or greater" half is not modelable.
  "Vaultborn Tyrant": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "Whenever this creature or another creature you control with power 4 or greater enters, you gain 3 life and draw a card.",
        effect: { kind: "gainLife", amount: 3 },
      },
      {
        event: "etb",
        optional: false,
        description:
          "Whenever this creature or another creature you control with power 4 or greater enters, you gain 3 life and draw a card.",
        effect: { kind: "draw", count: 1 },
      },
      {
        event: "dies",
        optional: false,
        description:
          "When this creature dies, if it's not a token, create a token that's a copy of it, except it's an artifact in addition to its other types.",
        effect: {
          kind: "manual",
          note: "if it's not a token, create a token copy of it (an artifact in addition to its other types)",
        },
      },
    ],
  },
  // Death fires both printed triggers; being milled/discarded into the
  // graveyard cannot be caught (see UNSUPPORTED_TRIGGER_CARDS).
  "Worldspine Wurm": {
    triggers: [
      {
        event: "dies",
        optional: false,
        description: "When this creature dies, create three 5/5 green Wurm creature tokens with trample.",
        effect: {
          kind: "createToken",
          name: "Wurm",
          typeLine: "Token Creature — Wurm",
          power: "5",
          toughness: "5",
          count: 3,
        },
      },
      {
        event: "dies",
        optional: false,
        description:
          "When Worldspine Wurm is put into a graveyard from anywhere, shuffle it into its owner's library.",
        effect: { kind: "manual", note: "shuffle it into its owner's library" },
      },
    ],
  },
  // The shuffle trigger is caught for the death case only; the on-cast extra
  // turn and non-battlefield graveyard arrivals are documented as unsupported.
  "Emrakul, the Aeons Torn": {
    triggers: [
      {
        event: "dies",
        optional: false,
        description:
          "When Emrakul is put into a graveyard from anywhere, its owner shuffles their graveyard into their library.",
        effect: { kind: "manual", note: "its owner shuffles their graveyard into their library" },
      },
    ],
  },
  // Attack half scripted (optional loot); the blocks half is not modelable.
  "Smuggler's Copter": {
    triggers: [
      {
        event: "attack",
        optional: true,
        description: "Whenever this Vehicle attacks or blocks, you may draw a card. If you do, discard a card.",
        effect: { kind: "manual", note: "draw a card. If you do, discard a card" },
      },
    ],
  },
  // Class card: the ETB token is unconditional, but the cast trigger is a
  // LEVEL 3 ability — inference cannot see class levels, so it stays a manual
  // reminder stating the level condition (decline/counter it below level 3).
  "Stormchaser's Talent": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When this Class enters, create a 1/1 blue and red Otter creature token with prowess.",
        effect: {
          kind: "createToken",
          name: "Otter",
          typeLine: "Token Creature — Otter",
          power: "1",
          toughness: "1",
          count: 1,
        },
      },
      {
        event: "castSpell",
        optional: false,
        castFilter: "instantOrSorcery",
        description:
          "Whenever you cast an instant or sorcery spell, create a 1/1 blue and red Otter creature token with prowess.",
        effect: {
          kind: "manual",
          note: "ONLY if this Class is level 3: create a 1/1 blue and red Otter creature token with prowess",
        },
      },
    ],
  },
  // ETB half scripted; "or becomes monstrous" is not modelable.
  "Alpha Deathclaw": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When this creature enters or becomes monstrous, destroy target permanent.",
        effect: { kind: "manual", note: "destroy target permanent" },
      },
    ],
  },
  // Compound cast trigger split into two single-effect triggers.
  "Vivi Ornitier": {
    triggers: [
      {
        event: "castSpell",
        optional: false,
        castFilter: "noncreature",
        description:
          "Whenever you cast a noncreature spell, put a +1/+1 counter on Vivi Ornitier and it deals 1 damage to each opponent.",
        effect: { kind: "addCounters", counterType: "+1/+1", count: 1 },
      },
      {
        event: "castSpell",
        optional: false,
        castFilter: "noncreature",
        description:
          "Whenever you cast a noncreature spell, put a +1/+1 counter on Vivi Ornitier and it deals 1 damage to each opponent.",
        effect: { kind: "damageOpponent", amount: 1 },
      },
    ],
  },
  // Magecraft compound split into two single-effect triggers.
  "Witherbloom Apprentice": {
    triggers: [
      {
        event: "castSpell",
        optional: false,
        castFilter: "instantOrSorcery",
        description:
          "Magecraft — Whenever you cast or copy an instant or sorcery spell, each opponent loses 1 life and you gain 1 life.",
        effect: { kind: "eachOpponentLosesLife", amount: 1 },
      },
      {
        event: "castSpell",
        optional: false,
        castFilter: "instantOrSorcery",
        description:
          "Magecraft — Whenever you cast or copy an instant or sorcery spell, each opponent loses 1 life and you gain 1 life.",
        effect: { kind: "gainLife", amount: 1 },
      },
    ],
  },
  // The Pest's quoted death trigger is not modeled on the token (tokens carry
  // no rules text in this engine); the description preserves it for players.
  "Sedgemoor Witch": {
    triggers: [
      {
        event: "castSpell",
        optional: false,
        castFilter: "instantOrSorcery",
        description:
          "Magecraft — Whenever you cast or copy an instant or sorcery spell, create a 1/1 black and green Pest creature token with \"When this token dies, you gain 1 life.\"",
        effect: {
          kind: "createToken",
          name: "Pest",
          typeLine: "Token Creature — Pest",
          power: "1",
          toughness: "1",
          count: 1,
        },
      },
    ],
  },
  // "named Doombot" breaks the token template; the end-step compound splits.
  "Doctor Doom": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description:
          "When Doctor Doom enters, create two 3/3 colorless Robot Villain artifact creature tokens named Doombot.",
        effect: {
          kind: "createToken",
          name: "Doombot",
          typeLine: "Token Artifact Creature — Robot Villain",
          power: "3",
          toughness: "3",
          count: 2,
        },
      },
      {
        event: "endStep",
        optional: false,
        description: "At the beginning of your end step, you draw a card and lose 1 life.",
        effect: { kind: "draw", count: 1 },
      },
      {
        event: "endStep",
        optional: false,
        description: "At the beginning of your end step, you draw a card and lose 1 life.",
        effect: { kind: "loseLife", amount: 1 },
      },
    ],
  },
  // "create Boo, a legendary ..." breaks the token template (named token).
  "Minsc & Boo, Timeless Heroes": {
    triggers: (["etb", "upkeep"] as const).map((event) => ({
      event,
      optional: true,
      description:
        "When Minsc & Boo enters and at the beginning of your upkeep, you may create Boo, a legendary 1/1 red Hamster creature token with trample and haste.",
      effect: {
        kind: "createToken",
        name: "Boo",
        typeLine: "Token Legendary Creature — Hamster",
        power: "1",
        toughness: "1",
        count: 1,
      },
    })),
  },
};

// ---------------------------------------------------------------------------
// Documented gaps — trigger conditions this engine cannot express
// ---------------------------------------------------------------------------

/**
 * Cards whose oracle text contains a triggered ability whose CONDITION has no
 * supported TriggerEvent (so no script entry can honestly represent it).
 * Keyed by exact card name -> reason. This list exists so the omission is
 * documented in code instead of silent: the audit tooling treats these names
 * as reviewed-and-excused rather than gaps.
 *
 * A card may appear here AND still have scripted triggers for its supported
 * clauses (e.g. an ETB plus an unmodelable landfall line).
 */
export const UNSUPPORTED_TRIGGER_CARDS: Record<string, string> = {
  // --- other-permanent events (something ELSE entering/leaving/dying) ------
  "Guide of Souls": "another-creature-enters and whole-team attack triggers have no event",
  "Enduring Innocence": "other-creatures-enter trigger has no event",
  "Kappa Cannoneer": "the 'or another artifact you control enters' half has no event (self ETB is scripted)",
  "Pyrogoyf": "the 'or another Lhurgoyf creature you control enters' half has no event (self ETB is scripted)",
  "Vaultborn Tyrant": "the 'or another creature with power 4 or greater enters' half has no event (self ETB + dies are scripted)",
  "Super Shredder": "another-permanent-leaves trigger has no event",
  "The Ooze": "counter-carrying-creature-leaves trigger has no event",
  "Ultron, Artificial Malevolence": "another-artifact-enters trigger has no event",
  "Tezzeret, Cruel Captain": "artifact-you-control-enters trigger has no event",
  "Sword of the Meek": "1/1-creature-enters trigger has no event",
  "Titania, Protector of Argoth": "land-you-control-dies trigger has no event",
  "Ajani, Nacatl Pariah": "other-Cats-die trigger has no event",
  "Skullclamp": "equipped-creature-dies trigger has no event (equipment watches another permanent)",
  // --- landfall ------------------------------------------------------------
  "Bristly Bill, Spine Sower": "landfall (a land you control enters) has no event",
  "Lotus Cobra": "landfall has no event",
  "Scythecat Cub": "landfall has no event",
  "Springheart Nantuko": "landfall has no event",
  "Tireless Tracker": "landfall and sacrifice-a-Clue triggers have no event",
  "Icetill Explorer": "landfall has no event",
  "Omnath, Locus of Creation": "landfall has no event",
  // --- land plays ----------------------------------------------------------
  "Fastbond": "land-play trigger has no event (lands are not cast)",
  "City of Traitors": "land-play trigger has no event",
  // --- begin-of-combat / main-phase / draw-step steps ----------------------
  "Luminarch Aspirant": "begin-of-combat step trigger has no event",
  "Agent Bishop, Man in Black": "begin-of-combat step trigger has no event",
  "Leader, Super-Genius": "begin-of-combat step trigger has no event",
  "Goblin Rabblemaster": "begin-of-combat token trigger has no event (the attack pump is scripted)",
  "Reckless Stormseeker": "begin-of-combat step trigger has no event",
  "Ursine Monstrosity": "begin-of-combat step trigger has no event",
  "Ouroboroid": "begin-of-combat step trigger has no event",
  "Okoye, Mighty and Adored": "begin-of-combat step trigger has no event",
  "Mister Fantastic": "begin-of-combat step trigger has no event",
  "Emperor of Bones": "begin-of-combat and counters-placed triggers have no event",
  "Does Machines": "begin-of-combat and Class level-up triggers have no event (the ETB is scripted)",
  "Coalition Relic": "first-main-phase trigger has no event",
  "Mana Vault": "draw-step trigger has no event",
  // --- whole-team "whenever you attack" ------------------------------------
  "Adeline, Resplendent Cathar": "whole-team attack trigger has no event",
  "Inti, Seneschal of the Sun": "whole-team attack and discard triggers have no event",
  "Gut, True Soul Zealot": "whole-team attack trigger has no event",
  "Raffine, Scheming Seer": "whole-team attack trigger has no event",
  "Glimmer Lens": "equipped-creature-plus-another-attacker condition has no event",
  "Coveted Jewel": "opponent-attackers-unblocked trigger has no event",
  "Emberwilde Captain": "opponent-attacks-you-while-monarch trigger has no event",
  // --- casting-count / on-cast-of-this-spell -------------------------------
  "Cosmogrand Zenith": "Nth-spell-each-turn trigger has no event (spell counting is not tracked)",
  "Emeritus of Conflict": "Nth-spell-each-turn trigger has no event",
  "Cori-Steel Cutter": "Nth-spell-each-turn trigger has no event",
  "The Fantasticar": "Nth-noncreature-spell-each-turn trigger has no event",
  "Sage of the Skies": "when-you-cast-this-spell (on-stack) trigger has no event",
  "Sowing Mycospawn": "when-you-cast-this-spell (kicker) triggers have no event",
  "Emrakul, the Aeons Torn": "when-you-cast-this-spell extra turn has no event; the graveyard shuffle is scripted for death only (not mill/discard)",
  "Worldspine Wurm": "put-into-graveyard-from-anywhere is scripted for death only (not mill/discard)",
  "Ugin, Eye of the Storms": "when-you-cast-this-spell trigger and colorless-spell cast filter have no support",
  // --- draws / discards / other hidden-zone events -------------------------
  "Sheoldred, the Apocalypse": "draw triggers (yours and the opponent's) have no event",
  "Faerie Mastermind": "opponent's-second-draw trigger has no event",
  "King T'Challa": "any-player's-second-draw trigger has no event",
  "Tamiyo, Inquisitive Student": "your-third-draw trigger has no event",
  "Currency Converter": "discard trigger has no event",
  "Ivora, Insatiable Heir": "discard trigger has no event (the ETB/combat-damage Blood token is scripted)",
  "Wan Shi Tong, All-Knowing": "cards-put-into-a-library trigger has no event",
  "Moonshadow": "permanent-cards-into-your-graveyard trigger has no event",
  "Laelia, the Blade Reforged": "cards-exiled-from-library/graveyard trigger has no event (the attack trigger is scripted)",
  "Staff of the Storyteller": "token-creation trigger has no event",
  // --- taps, targeting, damage-received, misc ------------------------------
  "Hawkeye, Master Marksman": "becomes-tapped trigger has no event",
  "Magda, Brazen Outlaw": "Dwarf-becomes-tapped trigger has no event",
  "Badgermole Cub": "tap-a-creature-for-mana trigger has no event",
  "Nissa, Who Shakes the World": "tap-a-Forest-for-mana trigger has no event",
  "Surrak, Elusive Hunter": "becomes-the-target trigger has no event",
  "Leovold, Emissary of Trest": "becomes-the-target trigger has no event",
  "Screaming Nemesis": "is-dealt-damage trigger has no event",
  "Umezawa's Jitte": "equipped-creature-deals-combat-damage trigger has no event",
  "Abhorrent Oculus": "each-OPPONENT's-upkeep trigger has no event (upkeep/eachUpkeep don't fit)",
  "Baloth Prime": "sacrifice-a-land trigger has no event",
  "Alpha Deathclaw": "the 'or becomes monstrous' half has no event (ETB is scripted)",
  "Smuggler's Copter": "the 'or blocks' half has no event (the attack half is scripted)",
  "Orcish Bowmasters": "the 'whenever an opponent draws' half has no event (ETB is scripted)",
  "Stormchaser's Talent": "Class level-up trigger has no event (the ETB token is scripted)",
  // --- sagas (chapter abilities are not modeled at all) --------------------
  "Summon: Good King Mog XII": "saga (Summon) chapter abilities are not modeled",
  "Urza's Saga": "saga chapter abilities are not modeled",
  "Fable of the Mirror-Breaker": "saga chapter abilities are not modeled",
  "The Legend of Roku": "saga chapter abilities are not modeled",
  "The Super Hero Civil War": "saga chapter abilities are not modeled",
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Overrides win; otherwise infer from oracle text; null = no known triggers. */
export function scriptFor(card: CardData): CardScript | null {
  return CARD_OVERRIDES[card.name] ?? inferScript(card);
}
