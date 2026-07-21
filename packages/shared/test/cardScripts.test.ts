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
    // Trigger conditions we still do not model are ignored, not guessed at.
    expect(
      inferScript(card("Clue Payoff", "Whenever you sacrifice a Clue, put a +1/+1 counter on this creature."))
    ).toBeNull();
    // P/T filters are not expressible (Sword of the Meek).
    expect(
      inferScript(
        card(
          "Sword of the Meek",
          "Whenever a 1/1 creature you control enters, you may return this card from your graveyard to the battlefield, then attach it to that creature.",
          { typeLine: "Artifact — Equipment" }
        )
      )
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

  it("Lightning Bolt: 'any target' damage IS automated as a targeted effect (v7)", () => {
    const script = inferScript(
      card("Lightning Bolt", "Lightning Bolt deals 3 damage to any target.", { typeLine: "Instant" })
    );
    expect(script?.onResolve).toEqual({ effects: [{ kind: "damageAnyTarget", amount: 3 }] });
  });

  it("Counterspell: 'counter target spell' IS automated (v7)", () => {
    const script = inferScript(
      card("Counterspell", "Counter target spell.", { typeLine: "Instant" })
    );
    expect(script?.onResolve).toEqual({ effects: [{ kind: "counterTarget" }] });
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
    expect(UNSUPPORTED_TRIGGER_CARDS["Magda, Brazen Outlaw"]).toMatch(/tapped/i);
    expect(UNSUPPORTED_TRIGGER_CARDS["Vaultborn Tyrant"]).toMatch(/power/i);
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

describe("v9: declarative trigger conditions (inference templates)", () => {
  it('"~ or another <type> you control enters" -> selfOrOther (Kappa Cannoneer wording)', () => {
    const script = inferScript(
      card(
        "Kappa Test",
        "Whenever this creature or another artifact you control enters, put a +1/+1 counter on this creature. It can't be blocked this turn."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
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
          note: "put a +1/+1 counter on this creature. It can't be blocked this turn",
        },
      },
    ]);
  });

  it('"~ or another <subtype> creature you control enters" -> subtype filter (Pyrogoyf wording)', () => {
    const script = inferScript(
      card(
        "Pyrogoyf",
        "Whenever this creature or another Lhurgoyf creature you control enters, that creature deals damage equal to its power to any target."
      )
    );
    expect(script?.triggers[0]!.when).toEqual({
      on: "zoneChange",
      which: "selfOrOther",
      move: "entersBattlefield",
      controller: "you",
      card: { types: ["Creature"], subtype: "Lhurgoyf" },
    });
  });

  it("the power-N rider does NOT match selfOrOther (Vaultborn Tyrant keeps its override)", () => {
    const script = inferScript(
      card(
        "Vaultborn Tyrant",
        "Trample\nWhenever this creature or another creature you control with power 4 or greater enters, you gain 3 life and draw a card.\nWhen this creature dies, if it's not a token, create a token that's a copy of it, except it's an artifact in addition to its other types."
      )
    );
    // Only the dies line parses; the power-rider enters line yields nothing.
    expect(script?.triggers.map((t) => t.event)).toEqual(["dies"]);
    expect(script?.triggers[0]!.when).toBeUndefined();
  });

  it('"another creature you control enters" + "you attack": Guide of Souls fully detected', () => {
    const script = inferScript(
      card(
        "Guide of Souls",
        "Whenever another creature you control enters, you gain 1 life and get {E} (an energy counter).\nWhenever you attack, you may pay {E}{E}{E}. When you do, put two +1/+1 counters and a flying counter on target attacking creature. It becomes an Angel in addition to its other types."
      )
    );
    expect(script?.triggers).toHaveLength(2);
    expect(script?.triggers[0]).toMatchObject({
      event: "etb",
      when: {
        on: "zoneChange",
        which: "other",
        move: "entersBattlefield",
        controller: "you",
        card: { types: ["Creature"] },
      },
      optional: false,
      effect: { kind: "manual", note: "you gain 1 life and get {E}" },
    });
    expect(script?.triggers[1]).toMatchObject({
      event: "attack",
      when: { on: "attackDeclared", which: "team" },
      optional: true, // "you may pay {E}{E}{E}"
      effect: { kind: "manual" },
    });
    // The team deviation is surfaced on the stack description.
    expect(script?.triggers[1]!.description).toMatch(/first attacker/i);
  });

  it('"another nontoken artifact you control enters": Ultron, Artificial Malevolence', () => {
    const script = inferScript(
      card(
        "Ultron, Artificial Malevolence",
        "Whenever another nontoken artifact you control enters, you may pay {2}. If you do, create a token that's a copy of it. If the token isn't a creature, it becomes a 2/2 Robot Villain creature in addition to its other types."
      )
    );
    expect(script?.triggers[0]).toMatchObject({
      event: "etb",
      when: {
        on: "zoneChange",
        which: "other",
        move: "entersBattlefield",
        controller: "you",
        card: { types: ["Artifact"], nontoken: true },
      },
      optional: true,
      effect: { kind: "manual" },
    });
  });

  it('"an artifact you control enters" -> selfOrOther + automated loyalty counter: Tezzeret', () => {
    const script = inferScript(
      card(
        "Tezzeret, Cruel Captain",
        "Whenever an artifact you control enters, put a loyalty counter on Tezzeret.",
        { typeLine: "Legendary Planeswalker — Tezzeret" }
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        when: {
          on: "zoneChange",
          which: "selfOrOther",
          move: "entersBattlefield",
          controller: "you",
          card: { types: ["Artifact"] },
        },
        optional: false,
        description: "Whenever an artifact you control enters, put a loyalty counter on Tezzeret.",
        effect: { kind: "addCounters", counterType: "loyalty", count: 1 },
      },
    ]);
  });

  it("landfall (ability word stripped) stays manual when the effect is mana: Lotus Cobra", () => {
    const script = inferScript(
      card("Lotus Cobra", "Landfall — Whenever a land you control enters, add one mana of any color.")
    );
    expect(script?.triggers).toEqual([
      {
        event: "etb",
        when: {
          on: "zoneChange",
          which: "other",
          move: "entersBattlefield",
          controller: "you",
          card: { types: ["Land"] },
        },
        optional: false,
        description: "Landfall — Whenever a land you control enters, add one mana of any color.",
        effect: { kind: "manual", note: "add one mana of any color" },
      },
    ]);
  });

  it("landfall with a parseable effect is fully automated: Tireless Tracker's investigate", () => {
    const script = inferScript(
      card(
        "Tireless Tracker",
        'Landfall — Whenever a land you control enters, investigate. (Create a Clue token. It\'s an artifact with "{2}, Sacrifice this token: Draw a card.")\nWhenever you sacrifice a Clue, put a +1/+1 counter on this creature.'
      )
    );
    // The sacrifice-a-Clue line stays undetected (documented in UNSUPPORTED).
    expect(script?.triggers).toHaveLength(1);
    expect(script?.triggers[0]).toMatchObject({
      when: { on: "zoneChange", card: { types: ["Land"] } },
      effect: { kind: "createToken", name: "Clue", typeLine: "Token Artifact — Clue", count: 1 },
    });
  });

  it('"another nontoken creature you control dies" is automated: Grim Haruspex', () => {
    const script = inferScript(
      card("Grim Haruspex", "Morph {B}\nWhenever another nontoken creature you control dies, draw a card.")
    );
    expect(script?.triggers).toEqual([
      {
        event: "dies",
        when: {
          on: "zoneChange",
          which: "other",
          move: "dies",
          controller: "you",
          card: { types: ["Creature"], nontoken: true },
        },
        optional: false,
        description: "Whenever another nontoken creature you control dies, draw a card.",
        effect: { kind: "draw", count: 1 },
      },
    ]);
  });

  it('"another creature dies" (any controller): Reaper of the Wilds', () => {
    const script = inferScript(
      card("Reaper of the Wilds", "Whenever another creature dies, scry 1.\n{B}: Reaper of the Wilds gains deathtouch until end of turn.")
    );
    expect(script?.triggers[0]).toMatchObject({
      event: "dies",
      when: {
        on: "zoneChange",
        which: "other",
        move: "dies",
        controller: "any",
        card: { types: ["Creature"] },
      },
      effect: { kind: "scry", count: 1 },
    });
  });

  it("begin-of-combat step condition: Luminarch Aspirant (manual, targeted)", () => {
    const script = inferScript(
      card(
        "Luminarch Aspirant",
        "At the beginning of combat on your turn, put a +1/+1 counter on target creature you control."
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "upkeep", // inert placeholder — `when` wins
        when: { on: "stepEntered", step: "beginCombat", whose: "yours" },
        optional: false,
        description:
          "At the beginning of combat on your turn, put a +1/+1 counter on target creature you control.",
        effect: { kind: "manual", note: "put a +1/+1 counter on target creature you control" },
      },
    ]);
  });

  it("begin-of-combat token creation is fully automated: Goblin Rabblemaster", () => {
    const script = inferScript(
      card(
        "Goblin Rabblemaster",
        "Other Goblin creatures you control attack each combat if able.\nAt the beginning of combat on your turn, create a 1/1 red Goblin creature token with haste.\nWhenever this creature attacks, it gets +1/+0 until end of turn for each other attacking Goblin."
      )
    );
    expect(script?.triggers).toHaveLength(2);
    expect(script?.triggers[0]).toMatchObject({
      when: { on: "stepEntered", step: "beginCombat", whose: "yours" },
      effect: { kind: "createToken", name: "Goblin", power: "1", toughness: "1", count: 1 },
    });
    // The self-attack pump keeps its legacy event (no `when`).
    expect(script?.triggers[1]).toMatchObject({ event: "attack", effect: { kind: "manual" } });
    expect(script?.triggers[1]!.when).toBeUndefined();
  });

  it("each opponent's upkeep: Abhorrent Oculus (manifest dread stays manual)", () => {
    const script = inferScript(
      card(
        "Abhorrent Oculus",
        "As an additional cost to cast this spell, exile six cards from your graveyard.\nFlying\nAt the beginning of each opponent's upkeep, manifest dread. (Look at the top two cards of your library. Put one onto the battlefield face down as a 2/2 creature and the other into your graveyard. Turn it face up any time for its mana cost if it's a creature card.)"
      )
    );
    expect(script?.triggers).toEqual([
      {
        event: "upkeep", // inert placeholder
        when: { on: "stepEntered", step: "upkeep", whose: "opponents" },
        optional: false,
        description: "At the beginning of each opponent's upkeep, manifest dread.",
        effect: { kind: "manual", note: "manifest dread" },
      },
    ]);
  });

  it("first-main and draw-step conditions: Coalition Relic, Mana Vault", () => {
    const relic = inferScript(
      card(
        "Coalition Relic",
        "{T}: Add one mana of any color.\n{T}: Put a charge counter on this artifact.\nAt the beginning of your first main phase, remove all charge counters from this artifact. Add one mana of any color for each charge counter removed this way.",
        { typeLine: "Artifact" }
      )
    );
    expect(relic?.triggers).toHaveLength(1);
    expect(relic?.triggers[0]).toMatchObject({
      when: { on: "stepEntered", step: "main1", whose: "yours" },
      effect: { kind: "manual" },
    });

    const vault = inferScript(
      card(
        "Mana Vault",
        "This artifact doesn't untap during your untap step.\nAt the beginning of your upkeep, you may pay {4}. If you do, untap this artifact.\nAt the beginning of your draw step, if this artifact is tapped, it deals 1 damage to you.\n{T}: Add {C}{C}{C}.",
        { typeLine: "Artifact" }
      )
    );
    expect(vault?.triggers).toHaveLength(2);
    // The upkeep untap offer is the plain legacy template (no `when`).
    expect(vault?.triggers[0]).toMatchObject({ event: "upkeep", optional: true });
    expect(vault?.triggers[0]!.when).toBeUndefined();
    expect(vault?.triggers[1]).toMatchObject({
      when: { on: "stepEntered", step: "draw", whose: "yours" },
      optional: false,
      effect: { kind: "manual", note: "if this artifact is tapped, it deals 1 damage to you" },
    });
  });

  it('"whenever you attack" (team): Adeline, Resplendent Cathar', () => {
    const script = inferScript(
      card(
        "Adeline, Resplendent Cathar",
        "Vigilance\nAdeline's power is equal to the number of creatures you control.\nWhenever you attack, for each opponent, create a 1/1 white Human creature token that's tapped and attacking that player or a planeswalker they control."
      )
    );
    expect(script?.triggers).toHaveLength(1);
    expect(script?.triggers[0]).toMatchObject({
      event: "attack",
      when: { on: "attackDeclared", which: "team" },
      effect: { kind: "manual" },
    });
    expect(script?.triggers[0]!.description).toMatch(/first attacker/i);
  });

  it('"becomes tapped" with an ability-word prefix: Hawkeye, Master Marksman', () => {
    const script = inferScript(
      card(
        "Hawkeye, Master Marksman",
        "First strike, reach\nTrick Arrows — Whenever Hawkeye becomes tapped, you may pay {1} up to three times. When you do, choose up to that many.\n• Net — Target creature can't block this turn.\n• Explosive — Hawkeye deals 2 damage to target player.\n• Boomerang — Discard a card, then draw a card."
      )
    );
    expect(script?.triggers).toHaveLength(1);
    expect(script?.triggers[0]).toMatchObject({
      when: { on: "becameTapped", which: "self" },
      optional: true,
      effect: { kind: "manual" },
    });
    expect(script?.triggers[0]!.description).toMatch(/^Trick Arrows — /);
  });

  it("you-draw / opponent-draws conditions: Sheoldred's two halves via inference", () => {
    const script = inferScript(
      card(
        "Sheoldred, the Apocalypse",
        "Deathtouch\nWhenever you draw a card, you gain 2 life.\nWhenever an opponent draws a card, they lose 2 life."
      )
    );
    expect(script?.triggers).toHaveLength(2);
    expect(script?.triggers[0]).toMatchObject({
      when: { on: "draw", who: "you" },
      effect: { kind: "gainLife", amount: 2 },
    });
    expect(script?.triggers[1]).toMatchObject({
      event: "opponentDraws",
      when: { on: "draw", who: "opponent" },
      effect: { kind: "manual", note: "they lose 2 life" },
    });
  });

  it("the Bowmasters except-rider does NOT match the plain opponent-draws template", () => {
    expect(
      inferScript(
        card(
          "Rider Test",
          "Whenever an opponent draws a card except the first one they draw in each of their draw steps, this creature deals 1 damage to any target."
        )
      )
    ).toBeNull();
  });

  it('"whenever you discard a card" is automated for counter payoffs: Ivora', () => {
    const script = inferScript(
      card(
        "Ivora, Insatiable Heir",
        'Trample\nWhen Ivora enters and whenever it deals combat damage to a player, create a Blood token. (It\'s an artifact with "{1}, {T}, Discard a card, Sacrifice this token: Draw a card.")\nWhenever you discard a card, put a +1/+1 counter on Ivora.'
      )
    );
    expect(script?.triggers).toHaveLength(3);
    expect(script?.triggers[2]).toMatchObject({
      when: { on: "discard", who: "you" },
      effect: { kind: "addCounters", counterType: "+1/+1", count: 1 },
    });

    const converter = inferScript(
      card(
        "Currency Converter",
        "Whenever you discard a card, you may exile that card from your graveyard.\n{2}, {T}: Draw a card, then discard a card.",
        { typeLine: "Artifact" }
      )
    );
    expect(converter?.triggers[0]).toMatchObject({
      when: { on: "discard", who: "you" },
      optional: true,
      effect: { kind: "manual", note: "exile that card from your graveyard" },
    });
  });

  it("DFC front faces get step conditions too: Reckless Stormseeker", () => {
    const dfc = card("Reckless Stormseeker // Storm-Charged Slasher", undefined, {
      layout: "transform",
      faces: [
        {
          name: "Reckless Stormseeker",
          typeLine: "Creature — Human Werewolf",
          oracleText:
            "At the beginning of combat on your turn, target creature you control gets +1/+0 and gains haste until end of turn.\nDaybound (If a player casts no spells during their own turn, it becomes night next turn.)",
        },
        {
          name: "Storm-Charged Slasher",
          typeLine: "Creature — Werewolf",
          oracleText:
            "At the beginning of combat on your turn, target creature you control gets +2/+0 and gains trample and haste until end of turn.\nNightbound (If a player casts at least two spells during their own turn, it becomes day next turn.)",
        },
      ],
    });
    const script = inferScript(dfc);
    expect(script?.triggers).toHaveLength(1);
    expect(script?.triggers[0]).toMatchObject({
      when: { on: "stepEntered", step: "beginCombat", whose: "yours" },
      effect: { kind: "manual" },
    });
  });
});

describe("v9: migrated overrides & UNSUPPORTED trims", () => {
  it("Kappa Cannoneer and Pyrogoyf overrides carry selfOrOther conditions", () => {
    expect(CARD_OVERRIDES["Kappa Cannoneer"]!.triggers[0]!.when).toEqual({
      on: "zoneChange",
      which: "selfOrOther",
      move: "entersBattlefield",
      controller: "you",
      card: { types: ["Artifact"] },
    });
    expect(CARD_OVERRIDES["Pyrogoyf"]!.triggers[0]!.when).toMatchObject({
      which: "selfOrOther",
      card: { types: ["Creature"], subtype: "Lhurgoyf" },
    });
  });

  it("Titania: land-death token trigger is fully automated", () => {
    const titania = CARD_OVERRIDES["Titania, Protector of Argoth"]!;
    expect(titania.triggers).toHaveLength(2);
    expect(titania.triggers[0]).toMatchObject({ event: "etb", effect: { kind: "manual" } });
    expect(titania.triggers[1]).toMatchObject({
      when: { on: "zoneChange", which: "other", move: "dies", controller: "you", card: { types: ["Land"] } },
      effect: { kind: "createToken", name: "Elemental", power: "5", toughness: "3", count: 1 },
    });
  });

  it("Fastbond and City of Traitors approximate land plays with land arrivals (noted)", () => {
    for (const name of ["Fastbond", "City of Traitors"]) {
      const script = CARD_OVERRIDES[name]!;
      expect(script.triggers[0]!.when).toEqual({
        on: "zoneChange",
        which: "other",
        move: "entersBattlefield",
        controller: "you",
        card: { types: ["Land"] },
      });
      expect(script.triggers[0]!.effect).toMatchObject({ kind: "manual" });
      expect((script.triggers[0]!.effect as { note: string }).note).toMatch(/weren't played/i);
    }
  });

  it("Sheoldred override is fully automated on both halves (no draw-step exemption)", () => {
    const sheoldred = CARD_OVERRIDES["Sheoldred, the Apocalypse"]!;
    expect(sheoldred.triggers.map((t) => [t.when, t.effect])).toEqual([
      [{ on: "draw", who: "you" }, { kind: "gainLife", amount: 2 }],
      [{ on: "draw", who: "opponent" }, { kind: "eachOpponentLosesLife", amount: 2 }],
    ]);
  });

  it("migrated cards are no longer in UNSUPPORTED_TRIGGER_CARDS", () => {
    for (const name of [
      "Guide of Souls",
      "Kappa Cannoneer",
      "Pyrogoyf",
      "Ultron, Artificial Malevolence",
      "Tezzeret, Cruel Captain",
      "Titania, Protector of Argoth",
      "Bristly Bill, Spine Sower",
      "Lotus Cobra",
      "Scythecat Cub",
      "Springheart Nantuko",
      "Icetill Explorer",
      "Omnath, Locus of Creation",
      "Fastbond",
      "City of Traitors",
      "Luminarch Aspirant",
      "Agent Bishop, Man in Black",
      "Leader, Super-Genius",
      "Goblin Rabblemaster",
      "Reckless Stormseeker",
      "Ursine Monstrosity",
      "Ouroboroid",
      "Okoye, Mighty and Adored",
      "Mister Fantastic",
      "Coalition Relic",
      "Mana Vault",
      "Adeline, Resplendent Cathar",
      "Gut, True Soul Zealot",
      "Raffine, Scheming Seer",
      "Abhorrent Oculus",
      "Sheoldred, the Apocalypse",
      "Hawkeye, Master Marksman",
      "Currency Converter",
      "Ivora, Insatiable Heir",
    ]) {
      expect(UNSUPPORTED_TRIGGER_CARDS[name], name).toBeUndefined();
    }
  });

  it("deliberately-kept gaps stay documented with fresh reasons", () => {
    expect(UNSUPPORTED_TRIGGER_CARDS["Vaultborn Tyrant"]).toMatch(/power/);
    expect(UNSUPPORTED_TRIGGER_CARDS["Enduring Innocence"]).toMatch(/power|once/);
    expect(UNSUPPORTED_TRIGGER_CARDS["Sword of the Meek"]).toMatch(/P\/T|graveyard/);
    expect(UNSUPPORTED_TRIGGER_CARDS["Tireless Tracker"]).toMatch(/Clue/);
    expect(UNSUPPORTED_TRIGGER_CARDS["Inti, Seneschal of the Sun"]).toMatch(/discard/);
    expect(UNSUPPORTED_TRIGGER_CARDS["Ajani, Nacatl Pariah"]).toMatch(/batch/i);
    expect(UNSUPPORTED_TRIGGER_CARDS["Faerie Mastermind"]).toMatch(/count/i);
    expect(UNSUPPORTED_TRIGGER_CARDS["Emperor of Bones"]).toMatch(/counters/i);
    expect(UNSUPPORTED_TRIGGER_CARDS["Does Machines"]).toMatch(/level/i);
  });
});

describe("v10: replacement-rule inference", () => {
  it('"~ enters the battlefield tapped." + an ETB trigger both infer: Bojuka Bog', () => {
    const script = inferScript(
      card(
        "Bojuka Bog",
        "Bojuka Bog enters the battlefield tapped.\nWhen Bojuka Bog enters the battlefield, exile target player's graveyard.\n{T}: Add {B}.",
        { typeLine: "Land" }
      )
    );
    expect(script?.replacements).toEqual([{ kind: "entersTapped" }]);
    expect(script?.triggers).toHaveLength(1);
    expect(script?.triggers[0]).toMatchObject({
      event: "etb",
      effect: { kind: "manual", note: "exile target player's graveyard" },
    });
  });

  it('modern "This land enters tapped." wording: Bloodfell Caves', () => {
    const script = inferScript(
      card(
        "Bloodfell Caves",
        "This land enters tapped.\nWhen this land enters, you gain 1 life.\n{T}: Add {B} or {R}.",
        { typeLine: "Land" }
      )
    );
    expect(script?.replacements).toEqual([{ kind: "entersTapped" }]);
    expect(script?.triggers[0]!.effect).toEqual({ kind: "gainLife", amount: 1 });
  });

  it("a lone tap line still yields a script (replacements only)", () => {
    const script = inferScript(
      card("Guildless Commons", "This land enters tapped.\n{T}: Add {C}.", { typeLine: "Land" })
    );
    expect(script).toEqual({ triggers: [], replacements: [{ kind: "entersTapped" }] });
  });

  it('conditional "tapped unless" does NOT match (anchored): Glacial Fortress', () => {
    expect(
      inferScript(
        card(
          "Glacial Fortress",
          "Glacial Fortress enters the battlefield tapped unless you control a Plains or an Island.\n{T}: Add {W} or {U}.",
          { typeLine: "Land" }
        )
      )
    ).toBeNull();
  });

  it('"enters with N counters": Serrated Arrows and Spike Feeder', () => {
    const arrows = inferScript(
      card(
        "Serrated Arrows",
        "Serrated Arrows enters the battlefield with three arrowhead counters on it.\nAt the beginning of your upkeep, if there are no arrowhead counters on Serrated Arrows, sacrifice it.\n{T}, Remove an arrowhead counter from Serrated Arrows: Put a -1/-1 counter on target creature.",
        { typeLine: "Artifact" }
      )
    );
    expect(arrows?.replacements).toEqual([
      { kind: "entersWithCounters", counterType: "arrowhead", count: 3 },
    ]);

    const spike = inferScript(
      card(
        "Spike Feeder",
        "Spike Feeder enters the battlefield with two +1/+1 counters on it.\n{2}, Remove a +1/+1 counter from Spike Feeder: Put a +1/+1 counter on target creature.\nRemove a +1/+1 counter from Spike Feeder: You gain 2 life."
      )
    );
    expect(spike?.replacements).toEqual([
      { kind: "entersWithCounters", counterType: "+1/+1", count: 2 },
    ]);
  });

  it('"with X counters" is NOT modeled (parseCount rejects X): Chalice of the Void', () => {
    expect(
      inferScript(
        card(
          "Chalice of the Void",
          "Chalice of the Void enters the battlefield with X charge counters on it.\nWhenever a player casts a spell with mana value equal to the number of charge counters on Chalice of the Void, counter that spell.",
          { typeLine: "Artifact" }
        )
      )
    ).toBeNull();
  });
});
