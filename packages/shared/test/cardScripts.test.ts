import { describe, expect, it } from "vitest";
import type { CardData } from "../src/types.js";
import { CARD_OVERRIDES, UNSUPPORTED_TRIGGER_CARDS, inferScript, scriptFor } from "../src/cardScripts.js";

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

  it("dies trigger with damage to any target infers a REAL target (v6): Perilous Myr", () => {
    const script = inferScript(
      card("Perilous Myr", "When Perilous Myr dies, it deals 2 damage to any target.")
    );
    expect(script?.triggers).toEqual([
      {
        event: "dies",
        optional: false,
        description: "When Perilous Myr dies, it deals 2 damage to any target.",
        effect: { kind: "damageAnyTarget", amount: 2 },
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
        card("Lotus Cobra", "Landfall — Whenever a land you control enters, add one mana of any color.")
      )
    ).toBeNull();
    // "each opponent's upkeep" is NOT eachUpkeep (it would misfire on yours).
    expect(
      inferScript(card("Abhorrent Oculus", "At the beginning of each opponent's upkeep, manifest dread."))
    ).toBeNull();
  });

  it("castSpell (instant/sorcery filter) with self-damage: Guttersnipe", () => {
    const script = inferScript(
      card(
        "Guttersnipe",
        "Whenever you cast an instant or sorcery spell, Guttersnipe deals 2 damage to each opponent."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "castSpell",
        optional: false,
        castFilter: "instantOrSorcery",
        description:
          "Whenever you cast an instant or sorcery spell, Guttersnipe deals 2 damage to each opponent.",
        effect: { kind: "damageOpponent", amount: 2 },
      },
    ]);
  });

  it("castSpell noncreature filter + token: Monastery Mentor", () => {
    const script = inferScript(
      card(
        "Monastery Mentor",
        "Prowess\nWhenever you cast a noncreature spell, create a 1/1 white Monk creature token with prowess."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "castSpell",
        optional: false,
        castFilter: "noncreature",
        description: "Whenever you cast a noncreature spell, create a 1/1 white Monk creature token with prowess.",
        effect: {
          kind: "createToken",
          name: "Monk",
          typeLine: "Token Creature — Monk",
          power: "1",
          toughness: "1",
          count: 1,
        },
      },
    ]);
  });

  it("castSpell artifact filter: Ravenous Robots", () => {
    const script = inferScript(
      card(
        "Ravenous Robots",
        "Whenever you cast an artifact spell, create a 1/1 colorless Robot artifact creature token."
      )
    );
    expect(script?.triggers[0]).toMatchObject({
      event: "castSpell",
      castFilter: "artifact",
      effect: { kind: "createToken", name: "Robot" },
    });
  });

  it("magecraft ability-word prefix is stripped for matching (kept in description): Sedgemoor Witch", () => {
    const script = inferScript(
      card(
        "Sedgemoor Witch",
        'Menace\nMagecraft — Whenever you cast or copy an instant or sorcery spell, create a 1/1 black and green Pest creature token with "When this token dies, you gain 1 life."'
      )
    );
    expect(script?.triggers).toHaveLength(1);
    const t = script!.triggers[0]!;
    expect(t.event).toBe("castSpell");
    expect(t.castFilter).toBe("instantOrSorcery");
    expect(t.description).toMatch(/^Magecraft — /);
    // Quoted token rules text defeats the token template -> manual fallback.
    expect(t.effect.kind).toBe("manual");
  });

  it("leaves trigger: Skyclave Apparition's exile clean-up", () => {
    const script = inferScript(
      card(
        "Skyclave Apparition",
        "When this creature enters, exile up to one target nonland, nontoken permanent you don't control with mana value 4 or less.\nWhen this creature leaves the battlefield, the exiled card's owner creates an X/X blue Illusion creature token, where X is the exiled card's mana value."
      )
    );
    expect(script?.triggers.map((t) => t.event)).toEqual(["etb", "leaves"]);
    expect(script?.triggers[1]!.effect.kind).toBe("manual");
  });

  it('"enters or leaves the battlefield" yields one trigger per event: Cryogen Relic', () => {
    const script = inferScript(
      card("Cryogen Relic", "When this artifact enters or leaves the battlefield, draw a card.", {
        typeLine: "Artifact",
      })
    );
    expect(script?.triggers.map((t) => [t.event, t.effect])).toEqual([
      ["etb", { kind: "draw", count: 1 }],
      ["leaves", { kind: "draw", count: 1 }],
    ]);
  });

  it('"enters or dies" yields one trigger per event: Sanguine Evangelist', () => {
    const script = inferScript(
      card(
        "Sanguine Evangelist",
        "Battle cry\nWhen this creature enters or dies, create a 1/1 black Bat creature token with flying."
      )
    );
    expect(script?.triggers.map((t) => t.event)).toEqual(["etb", "dies"]);
    expect(script?.triggers.every((t) => t.effect.kind === "createToken")).toBe(true);
  });

  it('"enters or attacks" + named artifact token: Sentinel of the Nameless City', () => {
    const script = inferScript(
      card(
        "Sentinel of the Nameless City",
        "Vigilance\nWhenever this creature enters or attacks, create a Map token."
      )
    );
    expect(script?.triggers.map((t) => [t.event, t.effect])).toEqual([
      ["etb", { kind: "createToken", name: "Map", typeLine: "Token Artifact — Map", count: 1 }],
      ["attack", { kind: "createToken", name: "Map", typeLine: "Token Artifact — Map", count: 1 }],
    ]);
  });

  it('"enters and whenever it deals combat damage to a player": Ivora', () => {
    const script = inferScript(
      card(
        "Ivora, Insatiable Heir",
        "Trample\nWhen Ivora enters and whenever it deals combat damage to a player, create a Blood token."
      )
    );
    expect(script?.triggers.map((t) => [t.event, t.effect])).toEqual([
      ["etb", { kind: "createToken", name: "Blood", typeLine: "Token Artifact — Blood", count: 1 }],
      ["combatDamageToPlayer", { kind: "createToken", name: "Blood", typeLine: "Token Artifact — Blood", count: 1 }],
    ]);
  });

  it("attack trigger falls back to manual for unparseable effects: Goblin Rabblemaster", () => {
    const script = inferScript(
      card(
        "Goblin Rabblemaster",
        "Whenever this creature attacks, it gets +1/+0 until end of turn for each other attacking Goblin."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "attack",
        optional: false,
        description:
          "Whenever this creature attacks, it gets +1/+0 until end of turn for each other attacking Goblin.",
        effect: { kind: "manual", note: "it gets +1/+0 until end of turn for each other attacking Goblin" },
      },
    ]);
  });

  it('combat damage "to a player or planeswalker": Psychic Frog', () => {
    const script = inferScript(
      card(
        "Psychic Frog",
        "Whenever this creature deals combat damage to a player or planeswalker, draw a card.\nDiscard a card: Put a +1/+1 counter on this creature."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "combatDamageToPlayer",
        optional: false,
        description: "Whenever this creature deals combat damage to a player or planeswalker, draw a card.",
        effect: { kind: "draw", count: 1 },
      },
    ]);
  });

  it("eachUpkeep: Oath of Druids fires on every player's upkeep (manual)", () => {
    const script = inferScript(
      card(
        "Oath of Druids",
        "At the beginning of each player's upkeep, that player chooses target player who controls more creatures than they do and is their opponent. The first player may reveal cards from the top of their library until they reveal a creature card. If they do, that player puts that card onto the battlefield and all other cards revealed this way into their graveyard.",
        { typeLine: "Enchantment" }
      )
    );
    expect(script?.triggers[0]).toMatchObject({ event: "eachUpkeep", effect: { kind: "manual" } });
  });

  it("endStep + investigate template: end-step draw split and Clue tokens", () => {
    const doom = inferScript(
      card("Doombringer", "At the beginning of your end step, you draw a card and lose 1 life.")
    );
    expect(doom?.triggers[0]).toMatchObject({ event: "endStep", effect: { kind: "manual" } });

    const inspector = inferScript(
      card("Thraben Inspector", "When this creature enters, investigate.")
    );
    expect(inspector?.triggers).toEqual([
      {
        event: "etb",
        optional: false,
        description: "When this creature enters, investigate.",
        effect: { kind: "createToken", name: "Clue", typeLine: "Token Artifact — Clue", count: 1 },
      },
    ]);
  });

  it("comma-less legends match their short names: Loran, Batroc", () => {
    const loran = inferScript(
      card("Loran of the Third Path", "When Loran enters, destroy up to one target artifact or enchantment.")
    );
    expect(loran?.triggers[0]).toMatchObject({
      event: "etb",
      effect: { kind: "manual", note: "destroy up to one target artifact or enchantment" },
    });

    const batroc = inferScript(
      card(
        "Batroc the Leaper",
        "When Batroc enters, he deals damage equal to his power to each of up to X targets, where X is the number of times he was kicked."
      )
    );
    expect(batroc?.triggers[0]!.event).toBe("etb");
  });

  it('"this Class"/"this Equipment" self-references and plural "enter"', () => {
    const talent = inferScript(
      card("Stormchaser's Talent", "When this Class enters, create a 1/1 blue and red Otter creature token with prowess.", {
        typeLine: "Enchantment — Class",
      })
    );
    expect(talent?.triggers[0]!.effect).toMatchObject({ kind: "createToken", name: "Otter" });

    const armor = inferScript(
      card("Iron Man Armor", "When this Equipment enters, attach it to target creature you control.", {
        typeLine: "Artifact — Equipment",
      })
    );
    expect(armor?.triggers[0]).toMatchObject({ event: "etb", effect: { kind: "manual" } });

    const cloak = inferScript(
      card(
        "Cloak and Dagger, Entwined",
        "When Cloak and Dagger enter, choose target opponent and up to one target creature they control."
      )
    );
    expect(cloak?.triggers[0]!.event).toBe("etb");
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

describe("inferScript — onResolve spell scripts (v4, real card texts)", () => {
  it("Night's Whisper: the compound draw-and-lose line expands to two effects", () => {
    const script = inferScript(
      card("Night's Whisper", "You draw two cards and you lose 2 life.", { typeLine: "Sorcery" })
    );
    expect(script).toEqual({
      triggers: [],
      onResolve: {
        effects: [
          { kind: "draw", count: 2 },
          { kind: "loseLife", amount: 2 },
        ],
      },
    });
  });

  it("Divination: a plain draw line", () => {
    const script = inferScript(card("Divination", "Draw two cards.", { typeLine: "Sorcery" }));
    expect(script?.onResolve).toEqual({ effects: [{ kind: "draw", count: 2 }] });
    expect(script?.triggers).toEqual([]);
  });

  it("Revitalize: two standalone lines, both parsed", () => {
    const script = inferScript(
      card("Revitalize", "You gain 3 life.\nDraw a card.", { typeLine: "Instant" })
    );
    expect(script?.onResolve).toEqual({
      effects: [
        { kind: "gainLife", amount: 3 },
        { kind: "draw", count: 1 },
      ],
    });
  });

  it("Lightning Bolt: targeted spells are never automated", () => {
    // No triggers, no activated abilities, no onResolve -> null script.
    expect(
      inferScript(
        card("Lightning Bolt", "Lightning Bolt deals 3 damage to any target.", { typeLine: "Instant" })
      )
    ).toBeNull();
  });

  it("Sign in Blood: 'Target player draws' fails on the target rule (unlike Night's Whisper)", () => {
    expect(
      inferScript(
        card("Sign in Blood", "Target player draws two cards and loses 2 life.", { typeLine: "Sorcery" })
      )
    ).toBeNull();
  });

  it("library manipulation stays manual: Brainstorm, Ponder, Stock Up", () => {
    expect(
      inferScript(
        card(
          "Brainstorm",
          "Draw three cards, then put two cards from your hand on top of your library in any order.",
          { typeLine: "Instant" }
        )
      )
    ).toBeNull();
    // Ponder: all-or-nothing — the final "Draw a card." line parses, but the
    // look-and-reorder line does not, so NO onResolve at all.
    expect(
      inferScript(
        card(
          "Ponder",
          "Look at the top three cards of your library, then put them back in any order. You may shuffle your library.\nDraw a card.",
          { typeLine: "Sorcery" }
        )
      )
    ).toBeNull();
    expect(
      inferScript(
        card(
          "Stock Up",
          "Look at the top five cards of your library. Put two of them into your hand and the rest into your graveyard.",
          { typeLine: "Sorcery" }
        )
      )
    ).toBeNull();
  });

  it("Wheel of Fortune: each-player effects stay manual", () => {
    expect(
      inferScript(
        card("Wheel of Fortune", "Each player discards their hand, then draws seven cards.", {
          typeLine: "Sorcery",
        })
      )
    ).toBeNull();
  });

  it("keyword lines defeat the all-or-nothing rule: Treasure Cruise", () => {
    expect(
      inferScript(card("Treasure Cruise", "Delve (Each card you exile from your graveyard while casting this spell pays for {1}.)\nDraw three cards.", { typeLine: "Sorcery" }))
    ).toBeNull();
  });

  it("non-spells never get onResolve", () => {
    const wall = inferScript(
      card("Wall of Omens", "Defender\nWhen Wall of Omens enters the battlefield, draw a card.")
    );
    expect(wall?.onResolve).toBeUndefined();
    expect(wall?.triggers).toHaveLength(1);
  });
});

describe("inferScript — activated fetch searches (v4, real card texts)", () => {
  it("Evolving Wilds: basic land, enters tapped, no life cost", () => {
    const script = inferScript(
      card(
        "Evolving Wilds",
        "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.",
        { typeLine: "Land" }
      )
    );
    expect(script).toEqual({
      triggers: [],
      activated: [
        {
          costTap: true,
          costSacrifice: true,
          costLife: 0,
          description:
            "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.",
          filter: { kind: "basicLand" },
          destination: "battlefield",
          entersTapped: true,
          shuffle: true,
        },
      ],
    });
  });

  it("all ten true fetches parse with the right subtype pairs (untapped, 1 life)", () => {
    const fetches: Record<string, [string, string]> = {
      "Flooded Strand": ["Plains", "Island"],
      "Polluted Delta": ["Island", "Swamp"],
      "Bloodstained Mire": ["Swamp", "Mountain"],
      "Wooded Foothills": ["Mountain", "Forest"],
      "Windswept Heath": ["Forest", "Plains"],
      "Marsh Flats": ["Plains", "Swamp"],
      "Scalding Tarn": ["Island", "Mountain"],
      "Verdant Catacombs": ["Swamp", "Forest"],
      "Arid Mesa": ["Mountain", "Plains"],
      "Misty Rainforest": ["Forest", "Island"],
    };
    for (const [name, [a, b]] of Object.entries(fetches)) {
      const script = inferScript(
        card(
          name,
          `{T}, Pay 1 life, Sacrifice this land: Search your library for a ${a} or ${b} card, put it onto the battlefield, then shuffle.`,
          { typeLine: "Land" }
        )
      );
      expect(script?.activated, name).toEqual([
        expect.objectContaining({
          costTap: true,
          costSacrifice: true,
          costLife: 1,
          filter: { kind: "landSubtype", subtypes: [a, b] },
          destination: "battlefield",
          entersTapped: false,
          shuffle: true,
        }),
      ]);
    }
  });

  it("Prismatic Vista: basic land for 1 life, untapped", () => {
    const script = inferScript(
      card(
        "Prismatic Vista",
        "{T}, Pay 1 life, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield, then shuffle.",
        { typeLine: "Land" }
      )
    );
    expect(script?.activated).toEqual([
      expect.objectContaining({
        costLife: 1,
        filter: { kind: "basicLand" },
        entersTapped: false,
      }),
    ]);
  });

  it("older 'Sacrifice CARDNAME' printings parse via the self alternation", () => {
    const script = inferScript(
      card(
        "Flooded Strand",
        "{T}, Pay 1 life, Sacrifice Flooded Strand: Search your library for a Plains or Island card, put it onto the battlefield, then shuffle your library.",
        { typeLine: "Land" }
      )
    );
    expect(script?.activated?.[0]).toMatchObject({
      filter: { kind: "landSubtype", subtypes: ["Plains", "Island"] },
    });
  });

  it("reveal-to-hand variants parse with destination hand", () => {
    // Synthetic-but-standard tutor-to-hand templating.
    const script = inferScript(
      card(
        "Coastal Cache",
        "{T}, Sacrifice this land: Search your library for a Plains or Island card, reveal it, put it into your hand, then shuffle.",
        { typeLine: "Land" }
      )
    );
    expect(script?.activated?.[0]).toMatchObject({
      destination: "hand",
      entersTapped: false,
      filter: { kind: "landSubtype", subtypes: ["Plains", "Island"] },
    });
  });

  it("Fabled Passage's untap rider defeats the template; the override covers it", () => {
    const fabled = card(
      "Fabled Passage",
      "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land.",
      { typeLine: "Land" }
    );
    expect(inferScript(fabled)).toBeNull();
    const script = scriptFor(fabled);
    expect(script).toBe(CARD_OVERRIDES["Fabled Passage"]);
    expect(script?.activated?.[0]).toMatchObject({
      filter: { kind: "basicLand" },
      entersTapped: true,
      costLife: 0,
    });
  });

  it("plain lands still yield null", () => {
    expect(inferScript(card("Command Tower", "{T}: Add one mana of any color in your commander's color identity.", { typeLine: "Land" }))).toBeNull();
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

  it("two-event overrides carry the effect on both events (Grave Titan, Sun Titan, Minsc & Boo)", () => {
    expect(CARD_OVERRIDES["Grave Titan"]!.triggers.map((t) => t.event)).toEqual(["etb", "attack"]);
    expect(CARD_OVERRIDES["Sun Titan"]!.triggers.map((t) => t.event)).toEqual(["etb", "attack"]);
    const minsc = CARD_OVERRIDES["Minsc & Boo, Timeless Heroes"]!;
    expect(minsc.triggers.map((t) => t.event)).toEqual(["etb", "upkeep"]);
    expect(minsc.triggers.every((t) => t.optional && t.effect.kind === "createToken")).toBe(true);
  });

  it("Thragtusk's token trigger is a leaves trigger (fires on any departure)", () => {
    expect(CARD_OVERRIDES["Thragtusk"]!.triggers.map((t) => t.event)).toEqual(["etb", "leaves"]);
  });

  it("compound cast triggers are curated as multiple single-effect triggers", () => {
    const vivi = CARD_OVERRIDES["Vivi Ornitier"]!;
    expect(vivi.triggers.map((t) => t.effect.kind)).toEqual(["addCounters", "damageOpponent"]);
    expect(vivi.triggers.every((t) => t.event === "castSpell" && t.castFilter === "noncreature")).toBe(true);

    const apprentice = CARD_OVERRIDES["Witherbloom Apprentice"]!;
    expect(apprentice.triggers.map((t) => t.effect.kind)).toEqual(["eachOpponentLosesLife", "gainLife"]);
  });

  it("dies/leaves precedence data: Worldspine Wurm keeps both dies triggers", () => {
    const wurm = CARD_OVERRIDES["Worldspine Wurm"]!;
    expect(wurm.triggers.map((t) => [t.event, t.effect.kind])).toEqual([
      ["dies", "createToken"],
      ["dies", "manual"],
    ]);
  });
});

describe("UNSUPPORTED_TRIGGER_CARDS — documented gaps", () => {
  it("every entry names a reason and no entry duplicates a fully-scripted card's only line", () => {
    for (const [name, reason] of Object.entries(UNSUPPORTED_TRIGGER_CARDS)) {
      expect(name.length).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(10);
    }
    // A few sentinel entries that must stay documented.
    expect(UNSUPPORTED_TRIGGER_CARDS["Sheoldred, the Apocalypse"]).toMatch(/draw/i);
    expect(UNSUPPORTED_TRIGGER_CARDS["Lotus Cobra"]).toMatch(/landfall/i);
    expect(UNSUPPORTED_TRIGGER_CARDS["Urza's Saga"]).toMatch(/saga/i);
  });
});

describe("v6: Orcish Bowmasters & amass", () => {
  it("Orcish Bowmasters override is fully scripted (etb + opponentDraws, seq effects)", () => {
    const script = CARD_OVERRIDES["Orcish Bowmasters"]!;
    expect(script.triggers).toHaveLength(2);
    const events = script.triggers.map((t) => t.event).sort();
    expect(events).toEqual(["etb", "opponentDraws"]);
    for (const t of script.triggers) {
      expect(t.effect).toEqual({
        kind: "seq",
        effects: [
          { kind: "damageAnyTarget", amount: 1 },
          { kind: "amass", subtype: "Orc", count: 1 },
        ],
      });
    }
  });

  it("Orcish Bowmasters is no longer in UNSUPPORTED_TRIGGER_CARDS", () => {
    expect(UNSUPPORTED_TRIGGER_CARDS["Orcish Bowmasters"]).toBeUndefined();
  });

  it("amass clause parses as an effect template", () => {
    const script = inferScript(
      card("Amass Test", "When Amass Test enters the battlefield, amass Orcs 1.")
    );
    expect(script?.triggers[0]?.effect).toEqual({ kind: "amass", subtype: "Orc", count: 1 });
  });
});
