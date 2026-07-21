import { describe, expect, it } from "vitest";
import type { CardData } from "../src/types.js";
import { CARD_OVERRIDES, inferScript, scriptFor } from "../src/cardScripts.js";

/** Minimal CardData with a real name + oracle text; the rest is boilerplate. */
function card(name: string, oracleText: string | undefined, extra: Partial<CardData> = {}): CardData {
  return {
    id: name.toLowerCase().replace(/[^a-z]+/g, "-"),
    name,
    cmc: 0,
    typeLine: "Creature",
    colors: [],
    colorIdentity: [],
    layout: "normal",
    ...(oracleText !== undefined ? { oracleText } : {}),
    ...extra,
  };
}

describe("inferScript — oracle-text templates (real card texts)", () => {
  it("ETB draw one: Wall of Omens", () => {
    const script = inferScript(
      card("Wall of Omens", "Defender\nWhen Wall of Omens enters the battlefield, draw a card.")
    );
    expect(script).toEqual({
      triggers: [
        {
          event: "etb",
          optional: false,
          description: "When Wall of Omens enters the battlefield, draw a card.",
          effect: { kind: "draw", count: 1 },
        },
      ],
    });
  });

  it("ETB draw two + reminder text stripped: Mulldrifter", () => {
    const script = inferScript(
      card(
        "Mulldrifter",
        "Flying\nWhen Mulldrifter enters the battlefield, draw two cards.\nEvoke {2}{U} (You may cast this spell for its evoke cost. If you do, it's sacrificed when it enters the battlefield.)"
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description: "When Mulldrifter enters the battlefield, draw two cards.",
        effect: { kind: "draw", count: 2 },
      },
    ]);
  });

  it("ETB gain life on a land: Radiant Fountain", () => {
    const script = inferScript(
      card("Radiant Fountain", "When Radiant Fountain enters the battlefield, you gain 2 life.\n{T}: Add {C}.")
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description: "When Radiant Fountain enters the battlefield, you gain 2 life.",
        effect: { kind: "gainLife", amount: 2 },
      },
    ]);
  });

  it("each opponent loses N life on ETB", () => {
    // Synthetic-but-standard templating: printed cards always pair this
    // clause with a lifegain rider (Drana's Emissary, Zulaport Cutthroat...),
    // which correctly falls back to manual — see the Kokusho case below.
    const script = inferScript(
      card("Vault Emissary", "When Vault Emissary enters the battlefield, each opponent loses 2 life.")
    );
    expect(script?.triggers[0]).toMatchObject({
      event: "etb",
      optional: false,
      effect: { kind: "eachOpponentLosesLife", amount: 2 },
    });
  });

  it("token creation with a count word + activated ability ignored: Siege-Gang Commander", () => {
    const script = inferScript(
      card(
        "Siege-Gang Commander",
        "When Siege-Gang Commander enters the battlefield, create three 1/1 red Goblin creature tokens.\n{1}{R}, Sacrifice a Goblin: Siege-Gang Commander deals 2 damage to any target."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description:
          "When Siege-Gang Commander enters the battlefield, create three 1/1 red Goblin creature tokens.",
        effect: {
          kind: "createToken",
          name: "Goblin",
          typeLine: "Token Creature — Goblin",
          power: "1",
          toughness: "1",
          count: 3,
        },
      },
    ]);
  });

  it("two triggers, token with keyword + upkeep life loss: Priest of the Blood Rite", () => {
    const script = inferScript(
      card(
        "Priest of the Blood Rite",
        "When Priest of the Blood Rite enters the battlefield, create a 5/5 black Demon creature token with flying.\nAt the beginning of your upkeep, you lose 2 life."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description:
          "When Priest of the Blood Rite enters the battlefield, create a 5/5 black Demon creature token with flying.",
        effect: {
          kind: "createToken",
          name: "Demon",
          typeLine: "Token Creature — Demon",
          power: "5",
          toughness: "5",
          count: 1,
        },
      },
      {
        event: "upkeep",
        optional: false,
        description: "At the beginning of your upkeep, you lose 2 life.",
        effect: { kind: "loseLife", amount: 2 },
      },
    ]);
  });

  it("ETB scry: Barrier of Bones", () => {
    const script = inferScript(
      card("Barrier of Bones", "Defender\nWhen Barrier of Bones enters the battlefield, scry 1.")
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description: "When Barrier of Bones enters the battlefield, scry 1.",
        effect: { kind: "scry", count: 1 },
      },
    ]);
  });

  it("upkeep counter-on-self (named counter type): As Foretold", () => {
    const script = inferScript(
      card(
        "As Foretold",
        "At the beginning of your upkeep, put a time counter on As Foretold.\nOnce each turn, you may pay {0} rather than pay the mana cost for a spell you cast with mana value X or less, where X is the number of time counters on As Foretold."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "upkeep",
        optional: false,
        description: "At the beginning of your upkeep, put a time counter on As Foretold.",
        effect: { kind: "addCounters", counterType: "time", count: 1 },
      },
    ]);
  });

  it("+1/+1 counters on itself parse with the dedicated counter type", () => {
    // Standard templating for a self-buff ETB trigger.
    const script = inferScript(
      card("Scale Keeper", "When Scale Keeper enters the battlefield, put two +1/+1 counters on it.")
    );
    expect(script?.triggers[0]!.effect).toEqual({ kind: "addCounters", counterType: "+1/+1", count: 2 });
  });

  it('"you may" makes the trigger optional (manual effect): Aviary Mechanic', () => {
    const script = inferScript(
      card(
        "Aviary Mechanic",
        "When Aviary Mechanic enters the battlefield, you may return a permanent you control to its owner's hand."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: true,
        description:
          "When Aviary Mechanic enters the battlefield, you may return a permanent you control to its owner's hand.",
        effect: { kind: "manual", note: "return a permanent you control to its owner's hand" },
      },
    ]);
  });

  it("ETB gain + dies draw as two triggers: Filigree Familiar", () => {
    const script = inferScript(
      card(
        "Filigree Familiar",
        "When Filigree Familiar enters the battlefield, you gain 2 life.\nWhen Filigree Familiar dies, draw a card."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description: "When Filigree Familiar enters the battlefield, you gain 2 life.",
        effect: { kind: "gainLife", amount: 2 },
      },
      {
        event: "dies",
        optional: false,
        description: "When Filigree Familiar dies, draw a card.",
        effect: { kind: "draw", count: 1 },
      },
    ]);
  });

  it("dies trigger with self-damage to any target: Perilous Myr", () => {
    const script = inferScript(
      card("Perilous Myr", "When Perilous Myr dies, it deals 2 damage to any target.")
    );
    expect(script?.triggers).toEqual([
      {
        event: "dies",
        optional: false,
        description: "When Perilous Myr dies, it deals 2 damage to any target.",
        effect: { kind: "damageOpponent", amount: 2 },
      },
    ]);
  });

  it("compound dies clause falls back to manual: Kokusho, the Evening Star", () => {
    const script = inferScript(
      card(
        "Kokusho, the Evening Star",
        "Flying\nWhen Kokusho, the Evening Star dies, each opponent loses 5 life and you gain life equal to the life lost this way."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "dies",
        optional: false,
        description:
          "When Kokusho, the Evening Star dies, each opponent loses 5 life and you gain life equal to the life lost this way.",
        effect: {
          kind: "manual",
          note: "each opponent loses 5 life and you gain life equal to the life lost this way",
        },
      },
    ]);
  });

  it("short-name self reference (legendary): Ghalta, Stampede Tyrant", () => {
    const script = inferScript(
      card(
        "Ghalta, Stampede Tyrant",
        "Trample\nWhen Ghalta enters the battlefield, put any number of creature cards from your hand onto the battlefield."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description:
          "When Ghalta enters the battlefield, put any number of creature cards from your hand onto the battlefield.",
        effect: {
          kind: "manual",
          note: "put any number of creature cards from your hand onto the battlefield",
        },
      },
    ]);
  });

  it('modern "this creature enters" templating (no "the battlefield"): Prideful Parent', () => {
    const script = inferScript(
      card(
        "Prideful Parent",
        "Vigilance\nWhen this creature enters, create a 1/1 white Cat creature token."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description: "When this creature enters, create a 1/1 white Cat creature token.",
        effect: {
          kind: "createToken",
          name: "Cat",
          typeLine: "Token Creature — Cat",
          power: "1",
          toughness: "1",
          count: 1,
        },
      },
    ]);
  });

  it("cards with no trigger clauses yield null", () => {
    expect(inferScript(card("Grizzly Bears", undefined))).toBeNull();
    expect(inferScript(card("Wind Drake", "Flying"))).toBeNull();
    // Trigger conditions we do not model are ignored, not guessed at.
    expect(
      inferScript(
        card("Guttersnipe", "Whenever you cast an instant or sorcery spell, Guttersnipe deals 2 damage to each opponent.")
      )
    ).toBeNull();
  });

  it("DFC: only the front face is parsed: Skyclave Cleric // Skyclave Basilica", () => {
    const dfc = card("Skyclave Cleric // Skyclave Basilica", undefined, {
      layout: "modal_dfc",
      faces: [
        {
          name: "Skyclave Cleric",
          typeLine: "Creature — Kor Cleric",
          oracleText: "When Skyclave Cleric enters the battlefield, you gain 2 life.",
        },
        {
          name: "Skyclave Basilica",
          typeLine: "Land",
          oracleText: "Skyclave Basilica enters the battlefield tapped.\n{T}: Add {W}.",
        },
      ],
    });
    const script = inferScript(dfc);
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description: "When Skyclave Cleric enters the battlefield, you gain 2 life.",
        effect: { kind: "gainLife", amount: 2 },
      },
    ]);
  });
});

describe("scriptFor — override registry", () => {
  it("overrides win over inference (Flametongue Kavu stays manual)", () => {
    const ftk = card(
      "Flametongue Kavu",
      "When Flametongue Kavu enters the battlefield, it deals 4 damage to target creature."
    );
    const script = scriptFor(ftk);
    expect(script).toBe(CARD_OVERRIDES["Flametongue Kavu"]);
    expect(script?.triggers[0]!.effect.kind).toBe("manual");
  });

  it("Mulldrifter override matches its real semantics", () => {
    const script = scriptFor(card("Mulldrifter", "irrelevant — override wins"));
    expect(script?.triggers[0]!.effect).toEqual({ kind: "draw", count: 2 });
  });

  it("compound staples are curated as multiple single-effect triggers", () => {
    const arena = CARD_OVERRIDES["Phyrexian Arena"]!;
    expect(arena.triggers.map((t) => t.effect.kind)).toEqual(["draw", "loseLife"]);
    expect(arena.triggers.every((t) => t.event === "upkeep")).toBe(true);

    const blossom = CARD_OVERRIDES["Bitterblossom"]!;
    expect(blossom.triggers.map((t) => t.effect.kind)).toEqual(["loseLife", "createToken"]);
  });

  it("non-override cards fall through to inference, unknown cards to null", () => {
    const wall = scriptFor(
      card("Wall of Omens", "Defender\nWhen Wall of Omens enters the battlefield, draw a card.")
    );
    expect(wall?.triggers[0]!.effect).toEqual({ kind: "draw", count: 1 });
    expect(scriptFor(card("Island", undefined))).toBeNull();
  });
});
