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
 *
 * v4 additions:
 *  - `onResolve` (instants/sorceries only): every oracle line must parse into
 *    a supported effect or the whole script omits onResolve — partial
 *    automation of a spell is worse than none (all-or-nothing). Targeted
 *    lines, library manipulation, and modal/compound text all fail parsing
 *    naturally and stay manual.
 *  - `activated` fetch searches: template regexes for the Evolving
 *    Wilds/Terramorphic wording, the ten true fetches ("Pay 1 life,
 *    Sacrifice ...: Search ... for a X or Y card"), Prismatic Vista, and
 *    reveal-to-hand variants; cards the templates miss (Fabled Passage's
 *    conditional untap rider) live in CARD_OVERRIDES.
 *
 * v9 additions (declarative trigger conditions):
 *  - Templates may attach `when: TriggerCondition` to the produced trigger.
 *    When `when` is present it IS the condition and the legacy `event` field
 *    is INERT — it is still set to the closest legacy value purely for
 *    readability ("upkeep" is the conventional placeholder for conditions
 *    with no legacy analogue: step, draw-you, discard, becameTapped).
 *  - Newly expressible: "~ or another <type> you control enters" (selfOrOther),
 *    "another creature you control enters"/"dies", landfall, begin-of-combat /
 *    each-opponent's-upkeep / first-main / draw-step steps, "whenever you
 *    attack" (team), "becomes tapped", "you draw/discard a card", plain
 *    "an opponent draws a card" (the Bowmasters except-rider keeps the legacy
 *    opponentDraws event with its built-in exemption).
 *
 * v10 additions (replacement rules):
 *  - `parseReplacement` infers self-arrival modifiers: "~ enters the
 *    battlefield tapped." and "~ enters with N <word> counters on it."
 *    Anchored, so conditional taps ("... unless ...") and X counts stay
 *    manual/unmodeled.
 */
import type {
  ActivatedSearchAbility,
  CardData,
  CardScript,
  CardTrigger,
  EventCardFilter,
  ReplacementRule,
  SearchFilter,
  SpellResolutionScript,
  TriggerCondition,
  TriggerEffect,
  TriggerEvent,
} from "./types.js";

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

/** "creature" -> "Creature", "lhurgoyf" -> "Lhurgoyf". */
function capitalize(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

const EVENT_CARD_TYPES: Record<string, string> = {
  creature: "Creature",
  artifact: "Artifact",
  land: "Land",
  enchantment: "Enchantment",
};

/**
 * v9: build an EventCardFilter from a captured type/subtype word of an
 * "…or another <word> you control enters" clause. A plain card type maps to a
 * types filter; "permanent" means no filter at all; anything else is treated
 * as a subtype word ("Lhurgoyf", optionally "Lhurgoyf creature").
 */
function eventCardFilter(word: string): EventCardFilter | undefined {
  const w = word.toLowerCase();
  if (w === "permanent") return undefined;
  const type = EVENT_CARD_TYPES[w];
  if (type !== undefined) return { types: [type] };
  const subtype = capitalize(word.replace(/\s+creature$/i, ""));
  return /\bcreature$/i.test(word) ? { types: ["Creature"], subtype } : { subtype };
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

  // "~ deals 2 damage to each opponent" — mechanical in 1v1.
  if (
    (m = text.match(
      new RegExp(`^(?:${self}|it|he|she|they) deals? (\\w+) damage to each opponent$`, "i")
    ))
  ) {
    const amount = parseCount(m[1]!);
    return amount === null ? null : { kind: "damageOpponent", amount };
  }

  // "~ deals 2 damage to any target" — v6: a REAL targeted effect (CR 115.4).
  // The trigger's controller picks the target when it resolves.
  if (
    (m = text.match(
      new RegExp(`^(?:${self}|it|he|she|they) deals? (\\w+) damage to any target$`, "i")
    ))
  ) {
    const amount = parseCount(m[1]!);
    return amount === null ? null : { kind: "damageAnyTarget", amount };
  }

  // "amass Orcs 1" / "amass Zombies 2" (CR 701.47a).
  if ((m = text.match(/^amass (\w+?)s? (\w+)$/i))) {
    const count = parseCount(m[2]!);
    if (count === null) return null;
    const subtype = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase();
    return { kind: "amass", subtype, count };
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
// Spell resolution parsing (instants/sorceries, v4)
// ---------------------------------------------------------------------------

/**
 * Parse ONE oracle line of an instant/sorcery into automated resolution
 * effects. Returns null when the line cannot be fully automated — the caller
 * then omits `onResolve` entirely (all-or-nothing).
 *
 * Differences from trigger-effect parsing:
 *  - Any line mentioning "target" is rejected outright (Lightning Bolt): a
 *    resolving spell has no targeting UI, and the trigger template's
 *    "any target -> opponent" shorthand is NOT safe for real targeted spells.
 *  - "You draw N cards and you lose N life" is a dedicated compound template
 *    because the pattern is a cube staple (Night's Whisper; Sign in Blood
 *    says "Target player draws", so it correctly fails on the target rule).
 *    It expands to two effects, matching how compound overrides are split.
 *  - Keyword lines, modal text, library manipulation (Brainstorm, Ponder,
 *    Stock Up), and anything else unparseable fail naturally.
 */
function parseSpellLine(line: string, self: string): TriggerEffect[] | null {
  const text = line.trim().replace(/\.+$/, "");
  if (!text) return null;

  // Compound draw-and-lose (Night's Whisper: "You draw two cards and you
  // lose 2 life.").
  const compound = text.match(/^you draw (\w+) cards? and you lose (\w+) life$/i);
  if (compound) {
    const count = parseCount(compound[1]!);
    const amount = parseCount(compound[2]!);
    if (count === null || amount === null) return null;
    return [
      { kind: "draw", count },
      { kind: "loseLife", amount },
    ];
  }

  // The two targeted patterns the engine can actually resolve (v11: the
  // effect applies directly at resolution — cast-time targeting, or the
  // resolution-time picker as a fallback — no separate effect entry).
  if (/^counter target spell$/i.test(text)) {
    return [{ kind: "counterTarget" }];
  }
  const anyTarget = text.match(
    new RegExp(`^(?:${self}|it) deals? (\\w+) damage to any target$`, "i")
  );
  if (anyTarget) {
    const amount = parseCount(anyTarget[1]!);
    return amount === null ? null : [{ kind: "damageAnyTarget", amount }];
  }

  // All other targeted text is never automated for spells.
  if (/\btargets?\b/i.test(text)) return null;

  const effect = parseEffect(text, self);
  return effect === null ? null : [effect];
}

// ---------------------------------------------------------------------------
// Activated fetch-search abilities (v4)
// ---------------------------------------------------------------------------

const BASIC_LAND_TYPES = "Plains|Island|Swamp|Mountain|Forest";

/**
 * Parse one oracle line as a fetch-style activated search ability. Covers:
 *  - Evolving Wilds / Terramorphic Expanse:
 *    "{T}, Sacrifice this land: Search your library for a basic land card,
 *     put it onto the battlefield tapped, then shuffle."
 *  - the ten true fetches (Flooded Strand, ...):
 *    "{T}, Pay 1 life, Sacrifice this land: Search your library for a
 *     Plains or Island card, put it onto the battlefield, then shuffle."
 *  - Prismatic Vista (basic land + 1 life), and reveal-to-hand variants
 *    ("..., reveal it, put it into your hand, then shuffle.").
 * Older printings say "Sacrifice CARDNAME" — the self alternation covers both.
 * Lines with extra riders (Fabled Passage) fail the anchors and belong in
 * CARD_OVERRIDES.
 */
function parseActivatedSearch(line: string, self: string): ActivatedSearchAbility | null {
  const m = line.match(
    new RegExp(
      `^(\\{T\\}, )?(?:Pay (\\d+) life, )?Sacrifice (?:${self}): ` +
        `Search your library for a (basic land|(?:${BASIC_LAND_TYPES}) or (?:${BASIC_LAND_TYPES})) card, ` +
        `(?:reveal it, )?put it (onto the battlefield( tapped)?|into your hand), then shuffle(?: your library)?\\.?$`,
      "i"
    )
  );
  if (!m) return null;

  let filter: SearchFilter;
  const what = m[3]!;
  if (/^basic land$/i.test(what)) {
    filter = { kind: "basicLand" };
  } else {
    const subtypes = what
      .split(/\s+or\s+/i)
      .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
    filter = { kind: "landSubtype", subtypes };
  }

  return {
    costTap: m[1] !== undefined,
    costSacrifice: true,
    costLife: m[2] !== undefined ? Number(m[2]) : 0,
    description: line,
    filter,
    destination: /into your hand/i.test(m[4]!) ? "hand" : "battlefield",
    entersTapped: m[5] !== undefined,
    shuffle: true,
  };
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
    /**
     * v9: declarative condition attached to the produced trigger. When set it
     * IS the condition (the engine ignores `event`); the legacy event value
     * is kept purely for readability — "upkeep" is the conventional inert
     * placeholder for conditions with no legacy analogue.
     */
    when?: TriggerCondition | ((m: RegExpMatchArray) => TriggerCondition);
    /** Extra sentence appended to the stack description (engine deviations). */
    descriptionNote?: string;
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
      // ("each opponent's upkeep" is the v9 stepEntered/opponents template
      // further down — it intentionally does NOT match here.)
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

    // -----------------------------------------------------------------------
    // v9 declarative conditions. Every entry below sets `when`, which the
    // engine matches against the GameEvent stream; the legacy `event` value
    // is INERT and chosen only for readability ("upkeep" = conventional
    // placeholder where no legacy value fits).
    // -----------------------------------------------------------------------
    {
      // "Whenever ~ or another <type/subtype> you control enters," (Kappa
      // Cannoneer, Pyrogoyf). Riders like "with power 4 or greater" (Vaultborn
      // Tyrant) deliberately do NOT match — those keep curated overrides.
      events: ["etb"],
      re: new RegExp(
        `^whenever (?:${self}) or another ` +
          `(creature|artifact|land|enchantment|permanent|[A-Z][a-z]+(?: creature)?) ` +
          `you control enters(?: the battlefield)?, (.+)$`,
        "i"
      ),
      when: (m) => {
        const card = eventCardFilter(m[1]!);
        return {
          on: "zoneChange",
          which: "selfOrOther",
          move: "entersBattlefield",
          controller: "you",
          ...(card !== undefined ? { card } : {}),
        };
      },
    },
    {
      // "Whenever another [nontoken] creature/artifact/... you control
      // enters," (Guide of Souls, Ultron) — plus the older "enters the
      // battlefield under your control" templating of the same condition.
      events: ["etb"],
      re: /^whenever another (nontoken )?(creature|artifact|land|enchantment) (?:you control enters(?: the battlefield)?|enters the battlefield under your control), (.+)$/i,
      when: (m) => ({
        on: "zoneChange",
        which: "other",
        move: "entersBattlefield",
        controller: "you",
        card: {
          types: [EVENT_CARD_TYPES[m[2]!.toLowerCase()]!],
          ...(m[1] !== undefined ? { nontoken: true } : {}),
        },
      }),
    },
    {
      // Landfall: "Whenever a land you control enters," (the "Landfall — "
      // ability word is stripped before matching).
      events: ["etb"],
      re: /^whenever a land you control enters(?: the battlefield)?, (.+)$/i,
      when: {
        on: "zoneChange",
        which: "other",
        move: "entersBattlefield",
        controller: "you",
        card: { types: ["Land"] },
      },
    },
    {
      // "Whenever an artifact you control enters," (Tezzeret, Cruel Captain).
      // "a/an" without "another" includes the source itself whenever it fits
      // the filter, so selfOrOther. Lands are the landfall template above.
      events: ["etb"],
      re: /^whenever an? (creature|artifact|enchantment) you control enters(?: the battlefield)?, (.+)$/i,
      when: (m) => ({
        on: "zoneChange",
        which: "selfOrOther",
        move: "entersBattlefield",
        controller: "you",
        card: { types: [EVENT_CARD_TYPES[m[1]!.toLowerCase()]!] },
      }),
    },
    {
      // "Whenever another [nontoken] creature [you control] dies," (Grim
      // Haruspex, Reaper of the Wilds).
      events: ["dies"],
      re: /^whenever another (nontoken )?creature( you control)? dies, (.+)$/i,
      when: (m) => ({
        on: "zoneChange",
        which: "other",
        move: "dies",
        controller: m[2] !== undefined ? "you" : "any",
        card: { types: ["Creature"], ...(m[1] !== undefined ? { nontoken: true } : {}) },
      }),
    },
    {
      // "Whenever a nontoken creature you control dies," (Gutter Grime
      // templating — "a" instead of "another").
      events: ["dies"],
      re: /^whenever a nontoken creature you control dies, (.+)$/i,
      when: {
        on: "zoneChange",
        which: "other",
        move: "dies",
        controller: "you",
        card: { types: ["Creature"], nontoken: true },
      },
    },
    {
      // "At the beginning of combat on your turn," (Luminarch Aspirant,
      // Goblin Rabblemaster, ...).
      events: ["upkeep"], // placeholder — inert, `when` is the condition
      re: /^at the beginning of combat on your turn, (.+)$/i,
      when: { on: "stepEntered", step: "beginCombat", whose: "yours" },
    },
    {
      // "At the beginning of each opponent's upkeep," (Abhorrent Oculus).
      events: ["upkeep"], // placeholder — inert
      re: /^at the beginning of each opponent's upkeep, (.+)$/i,
      when: { on: "stepEntered", step: "upkeep", whose: "opponents" },
    },
    {
      // "At the beginning of your first/precombat main phase," (Coalition
      // Relic — both wordings have been printed).
      events: ["upkeep"], // placeholder — inert
      re: /^at the beginning of your (?:first|precombat) main phase, (.+)$/i,
      when: { on: "stepEntered", step: "main1", whose: "yours" },
    },
    {
      // "At the beginning of your draw step," (Mana Vault).
      events: ["upkeep"], // placeholder — inert
      re: /^at the beginning of your draw step, (.+)$/i,
      when: { on: "stepEntered", step: "draw", whose: "yours" },
    },
    {
      // "Whenever you attack," (Adeline, Raffine, Gut, Inti, Guide of Souls).
      // Team condition: the engine fires it when the FIRST attacker of a
      // combat is declared (SPEC v9 documented deviation from a formal
      // declare-attackers commit) — the description says so.
      events: ["attack"],
      re: /^whenever you attack(?: with one or more creatures)?, (.+)$/i,
      when: { on: "attackDeclared", which: "team" },
      descriptionNote: "(Fires when your first attacker is declared each combat.)",
    },
    {
      // "Whenever ~ becomes tapped," (Hawkeye, Master Marksman).
      events: ["upkeep"], // placeholder — inert
      re: new RegExp(`^whenever (?:${self}) becomes tapped, (.+)$`, "i"),
      when: { on: "becameTapped", which: "self" },
    },
    {
      // "Whenever you draw a card," (Sheoldred's first half).
      events: ["upkeep"], // placeholder — inert
      re: /^whenever you draw a card, (.+)$/i,
      when: { on: "draw", who: "you" },
    },
    {
      // "Whenever an opponent draws a card," — the PLAIN form only. The
      // Bowmasters "except the first one they draw in each of their draw
      // steps" rider breaks the anchor and keeps the legacy opponentDraws
      // event (whose exemption is built in); this `when` has no exemption.
      events: ["opponentDraws"],
      re: /^whenever an opponent draws a card, (.+)$/i,
      when: { on: "draw", who: "opponent" },
    },
    {
      // "Whenever you discard a card," (Currency Converter, Ivora).
      events: ["upkeep"], // placeholder — inert
      re: /^whenever you discard a card, (.+)$/i,
      when: { on: "discard", who: "you" },
    },
  ];

  const body = line.replace(ABILITY_WORD_PREFIX, "");
  for (const { events, re, castFilter, when, descriptionNote } of conditions) {
    const m = body.match(re);
    if (!m) continue;
    // The effect clause is always the LAST capture group (v9 templates also
    // capture type/subtype words before it).
    let clause = m[m.length - 1]!.trim();
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
    const whenValue = typeof when === "function" ? when(m) : when;
    return events.map((event) => ({
      event,
      ...(whenValue !== undefined ? { when: whenValue } : {}),
      optional,
      description: descriptionNote !== undefined ? `${line} ${descriptionNote}` : line,
      effect,
      ...(event === "castSpell" && castFilter !== undefined ? { castFilter } : {}),
    }));
  }
  return [];
}

/**
 * v10: parse one oracle line as a self-arrival replacement rule.
 *  - "~ enters the battlefield tapped." / "This land enters tapped."
 *    Anchored: "… tapped unless …" and other riders never match (conditional
 *    taps stay manual).
 *  - "~ enters the battlefield with N <word> counters on it." — number words
 *    only ("with X charge counters" fails parseCount and stays unmodeled).
 */
function parseReplacement(line: string, self: string): ReplacementRule | null {
  if (new RegExp(`^(?:${self}) enters(?: the battlefield)? tapped\\.?$`, "i").test(line)) {
    return { kind: "entersTapped" };
  }
  const m = line.match(
    new RegExp(
      `^(?:${self}) enters(?: the battlefield)? with (\\w+) (\\+1\\/\\+1|[a-z]+) counters? on it\\.?$`,
      "i"
    )
  );
  if (m) {
    const count = parseCount(m[1]!);
    if (count !== null) return { kind: "entersWithCounters", counterType: m[2]!, count };
  }
  return null;
}

/**
 * Infer a CardScript from oracle text. Front face only for multi-faced cards
 * (the back face is reached in play via flipCard and stays manual). Returns
 * null when nothing at all is detected (no triggers, no activated searches,
 * no spell-resolution script).
 */
export function inferScript(card: CardData): CardScript | null {
  const face = card.faces?.[0];
  const name = face?.name ?? card.name;
  const oracle = face ? face.oracleText ?? "" : card.oracleText ?? "";
  const typeLine = face?.typeLine ?? card.typeLine;
  if (!oracle) return null;

  // Strip reminder text (parenthesized), then examine each line on its own.
  const stripped = oracle.replace(/\s*\([^)]*\)/g, "");
  const self = selfAlternation(name);
  const lines = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const triggers: CardTrigger[] = [];
  const activated: ActivatedSearchAbility[] = [];
  const replacements: ReplacementRule[] = [];
  for (const line of lines) {
    triggers.push(...parseLine(line, self));
    const search = parseActivatedSearch(line, self);
    if (search) activated.push(search);
    const replacement = parseReplacement(line, self);
    if (replacement) replacements.push(replacement);
  }

  // onResolve: instants/sorceries only, and ALL-OR-NOTHING — one unparseable
  // line means the whole spell resolves manually (partial automation of a
  // spell is worse than none).
  let onResolve: SpellResolutionScript | undefined;
  if (/\b(?:Instant|Sorcery)\b/i.test(typeLine)) {
    const effects: TriggerEffect[] = [];
    let allParsed = lines.length > 0;
    for (const line of lines) {
      const parsed = parseSpellLine(line, self);
      if (parsed === null) {
        allParsed = false;
        break;
      }
      effects.push(...parsed);
    }
    if (allParsed && effects.length > 0) onResolve = { effects };
  }

  if (
    triggers.length === 0 &&
    activated.length === 0 &&
    onResolve === undefined &&
    replacements.length === 0
  ) {
    return null;
  }
  return {
    triggers,
    ...(activated.length > 0 ? { activated } : {}),
    ...(onResolve !== undefined ? { onResolve } : {}),
    ...(replacements.length > 0 ? { replacements } : {}),
  };
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

  // v9: the whole condition is declarative now — fires for itself AND every
  // other artifact you control (the compound effect stays a manual note).
  "Kappa Cannoneer": {
    triggers: [
      {
        event: "etb", // inert — `when` is the condition
        when: {
          on: "zoneChange",
          which: "selfOrOther",
          move: "entersBattlefield",
          controller: "you",
          card: { types: ["Artifact"] },
        },
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
  // v6: fully scripted — ETB and the opponent-draw watcher both deal 1 to a
  // chosen target then amass Orcs 1 (opponentDraws has the "except their
  // draw-step first draw" exemption built into the event).
  "Orcish Bowmasters": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When this creature enters, it deals 1 damage to any target. Then amass Orcs 1.",
        effect: {
          kind: "seq",
          effects: [
            { kind: "damageAnyTarget", amount: 1 },
            { kind: "amass", subtype: "Orc", count: 1 },
          ],
        },
      },
      {
        event: "opponentDraws",
        optional: false,
        description:
          "Whenever an opponent draws a card except the first one they draw in each of their draw steps, this creature deals 1 damage to any target. Then amass Orcs 1.",
        effect: {
          kind: "seq",
          effects: [
            { kind: "damageAnyTarget", amount: 1 },
            { kind: "amass", subtype: "Orc", count: 1 },
          ],
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
  // v9: fires for itself and every other Lhurgoyf you control (the dynamic
  // power-based damage stays a manual note).
  Pyrogoyf: {
    triggers: [
      {
        event: "etb", // inert — `when` is the condition
        when: {
          on: "zoneChange",
          which: "selfOrOther",
          move: "entersBattlefield",
          controller: "you",
          card: { types: ["Creature"], subtype: "Lhurgoyf" },
        },
        optional: false,
        description:
          "Whenever this creature or another Lhurgoyf creature you control enters, that creature deals damage equal to its power to any target.",
        effect: {
          kind: "manual",
          note: "the entering creature deals damage equal to its power to any target",
        },
      },
    ],
  },
  // v9: the land-death token trigger is declarative (a land is any card whose
  // type line says Land; sacrifices and destructions both "die"). The ETB
  // land recursion is targeted, so manual.
  "Titania, Protector of Argoth": {
    triggers: [
      {
        event: "etb",
        optional: false,
        description: "When Titania enters, return target land card from your graveyard to the battlefield.",
        effect: {
          kind: "manual",
          note: "return target land card from your graveyard to the battlefield",
        },
      },
      {
        event: "dies", // inert — `when` is the condition
        when: {
          on: "zoneChange",
          which: "other",
          move: "dies",
          controller: "you",
          card: { types: ["Land"] },
        },
        optional: false,
        description:
          "Whenever a land you control is put into a graveyard from the battlefield, create a 5/3 green Elemental creature token.",
        effect: {
          kind: "createToken",
          name: "Elemental",
          typeLine: "Token Creature — Elemental",
          power: "5",
          toughness: "3",
          count: 1,
        },
      },
    ],
  },
  // v9 DEVIATION (documented): there is no "play a land" event — the closest
  // condition is "a land you control enters", which ALSO fires for lands put
  // onto the battlefield without being played (fetches). The effect is a
  // manual note either way, so the player applies the real rider by hand.
  Fastbond: {
    triggers: [
      {
        event: "etb", // inert — `when` is the condition
        when: {
          on: "zoneChange",
          which: "other",
          move: "entersBattlefield",
          controller: "you",
          card: { types: ["Land"] },
        },
        optional: false,
        description:
          "Whenever you play a land, if it wasn't the first land you played this turn, this enchantment deals 1 damage to you.",
        effect: {
          kind: "manual",
          note: "if it wasn't the first land you played this turn, this enchantment deals 1 damage to you (fires for ANY land arrival — decline it for lands that weren't played)",
        },
      },
    ],
  },
  // Same "play a land" -> "land enters" approximation as Fastbond.
  "City of Traitors": {
    triggers: [
      {
        event: "etb", // inert — `when` is the condition
        when: {
          on: "zoneChange",
          which: "other",
          move: "entersBattlefield",
          controller: "you",
          card: { types: ["Land"] },
        },
        optional: false,
        description: "When you play another land, sacrifice this land.",
        effect: {
          kind: "manual",
          note: "sacrifice this land (fires for ANY other land arrival — decline it for lands that weren't played)",
        },
      },
    ],
  },
  // v9: fully automated. The opponent half uses the draw/opponent condition
  // WITHOUT the Bowmasters draw-step exemption (Sheoldred hits every draw);
  // "they lose 2 life" is the drawer, which in 1v1 is exactly "each opponent".
  "Sheoldred, the Apocalypse": {
    triggers: [
      {
        event: "upkeep", // inert placeholder — `when` is the condition
        when: { on: "draw", who: "you" },
        optional: false,
        description: "Whenever you draw a card, you gain 2 life.",
        effect: { kind: "gainLife", amount: 2 },
      },
      {
        event: "opponentDraws", // inert — `when` wins (no draw-step exemption)
        when: { on: "draw", who: "opponent" },
        optional: false,
        description: "Whenever an opponent draws a card, they lose 2 life.",
        effect: { kind: "eachOpponentLosesLife", amount: 2 },
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
  // v4 fetch search the template misses: the trailing "Then if you control
  // four or more lands, untap that land." rider defeats the anchored regex.
  // The fetched land enters tapped; with four or more lands, untap it by hand
  // (the description keeps the full wording for the players).
  "Fabled Passage": {
    triggers: [],
    activated: [
      {
        costTap: true,
        costSacrifice: true,
        costLife: 0,
        description:
          "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land.",
        filter: { kind: "basicLand" },
        destination: "battlefield",
        entersTapped: true,
        shuffle: true,
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
  // v9 migrated OUT of this list (now scripted via declarative `when`
  // conditions — inference templates or CARD_OVERRIDES): Guide of Souls,
  // Kappa Cannoneer, Pyrogoyf, Ultron, Tezzeret Cruel Captain, Titania, the
  // landfall block (Bristly Bill, Lotus Cobra, Scythecat Cub, Springheart
  // Nantuko, Icetill Explorer, Omnath), Fastbond + City of Traitors
  // (land-enters approximation), the begin-of-combat block (Luminarch
  // Aspirant, Agent Bishop, Leader, Goblin Rabblemaster, Reckless
  // Stormseeker, Ursine Monstrosity, Ouroboroid, Okoye, Mister Fantastic),
  // Coalition Relic, Mana Vault, the team-attack block (Adeline, Gut,
  // Raffine), Abhorrent Oculus, Sheoldred, Hawkeye, Currency Converter,
  // Ivora.

  // --- other-permanent events the condition vocabulary still can't say -----
  "Enduring Innocence":
    "the 'one or more other creatures with power 2 or less enter' batch needs a power filter and a once-each-turn limit EventCardFilter lacks (the dies return is scripted)",
  "Vaultborn Tyrant":
    "the 'or another creature with power 4 or greater enters' half needs a power filter EventCardFilter lacks (self ETB + dies are scripted)",
  "Super Shredder":
    "another-permanent-leaves is expressible in v9 but this card is deliberately unmigrated (exact wording unverified — needs a curated override)",
  "The Ooze": "counter-carrying-creature-leaves needs a counters filter EventCardFilter lacks",
  "Sword of the Meek":
    "the '1/1 creature you control enters' trigger needs a P/T filter, and it watches from the graveyard (trigger matching only sees battlefield permanents)",
  "Ajani, Nacatl Pariah":
    "the 'one or more other Cats you control die' batch transform stays manual (batch-once semantics are not expressible; the front-face ETB token is inferred)",
  "Skullclamp": "equipped-creature-dies has no condition (equipment watches another permanent)",
  "Tireless Tracker": "sacrifice-a-Clue has no condition (the landfall investigate is now inferred)",
  // --- begin-of-combat leftovers -------------------------------------------
  "Emperor of Bones":
    "counters-are-placed has no condition (the begin-of-combat exile is now inferred)",
  "Does Machines":
    "Class level-up has no condition, and its combat/cast lines are level-gated (Class levels are invisible to inference); the ETB is scripted",
  // --- team-attack leftovers -----------------------------------------------
  "Inti, Seneschal of the Sun":
    "the 'discard one or more cards' batch trigger is not expressible (the whenever-you-attack half is now inferred)",
  "Glimmer Lens": "equipped-creature-plus-another-attacker condition is not expressible",
  "Coveted Jewel": "opponent-attackers-unblocked trigger is not expressible",
  "Emberwilde Captain": "opponent-attacks-you-while-monarch trigger is not expressible",
  // --- casting-count / on-cast-of-this-spell -------------------------------
  "Cosmogrand Zenith": "Nth-spell-each-turn trigger needs per-turn spell counting (not tracked)",
  "Emeritus of Conflict": "Nth-spell-each-turn trigger needs per-turn spell counting",
  "Cori-Steel Cutter": "Nth-spell-each-turn trigger needs per-turn spell counting",
  "The Fantasticar": "Nth-noncreature-spell-each-turn trigger needs per-turn spell counting",
  "Sage of the Skies": "when-you-cast-this-spell (on-stack) trigger has no condition",
  "Sowing Mycospawn": "when-you-cast-this-spell (kicker) triggers have no condition",
  "Emrakul, the Aeons Torn": "when-you-cast-this-spell extra turn has no condition; the graveyard shuffle is scripted for death only (not mill/discard)",
  "Worldspine Wurm": "put-into-graveyard-from-anywhere is scripted for death only (not mill/discard)",
  "Ugin, Eye of the Storms": "when-you-cast-this-spell trigger and colorless-spell cast filter have no support",
  // --- Nth-draw counts / other hidden-zone events --------------------------
  "Faerie Mastermind":
    "opponent's-SECOND-draw needs per-turn draw counting (the plain draw condition would over-fire)",
  "King T'Challa": "any-player's-second-draw needs per-turn draw counting",
  "Tamiyo, Inquisitive Student": "your-third-draw needs per-turn draw counting",
  "Wan Shi Tong, All-Knowing": "cards-put-into-a-library trigger has no condition",
  "Moonshadow": "permanent-cards-into-your-graveyard trigger has no condition",
  "Laelia, the Blade Reforged": "cards-exiled-from-library/graveyard trigger has no condition (the attack trigger is scripted)",
  "Staff of the Storyteller": "token-creation trigger has no condition",
  // --- taps, targeting, damage-received, misc ------------------------------
  "Magda, Brazen Outlaw":
    "becameTapped only matches the source itself — the other-Dwarf-becomes-tapped condition is not expressible",
  "Badgermole Cub": "tap-a-creature-for-mana trigger has no condition",
  "Nissa, Who Shakes the World": "tap-a-Forest-for-mana trigger has no condition",
  "Surrak, Elusive Hunter": "becomes-the-target trigger has no condition",
  "Leovold, Emissary of Trest": "becomes-the-target trigger has no condition",
  "Screaming Nemesis": "is-dealt-damage trigger has no condition",
  "Umezawa's Jitte": "equipped-creature-deals-combat-damage trigger has no condition",
  "Baloth Prime":
    "sacrifice-a-land is only approximable by land-dies (it would over-fire on destroyed lands) — stays manual",
  "Alpha Deathclaw": "the 'or becomes monstrous' half has no condition (ETB is scripted)",
  "Smuggler's Copter": "the 'or blocks' half has no condition (the attack half is scripted)",
  "Stormchaser's Talent": "Class level-up trigger has no condition (the ETB token is scripted)",
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
