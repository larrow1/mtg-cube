/**
 * Blast-radius audit fixtures (SPEC v9 — "the Ninja's Kunai lesson").
 *
 * A curated list of real cube card oracle texts (plus a handful of synthetic
 * cards already used by cardScripts.test.ts, marked below) covering every
 * inference-template family and the curated CARD_OVERRIDES entries. The audit
 * test (test/scriptAudit.test.ts) runs `scriptFor` over every card here and
 * compares the result against the checked-in golden snapshot
 * (fixtures/scriptAudit.snapshot.json) — so ANY template or override change
 * that alters ANY card's script fails loudly with a per-card diff.
 *
 * Oracle texts are harvested from the repo itself (cardScripts.test.ts, the
 * CARD_OVERRIDES descriptions, and Scryfall texts cached during the v9
 * session). Do NOT paraphrase texts: the exact wording IS the input under
 * audit. Card names must be unique — the snapshot is keyed by name.
 */
import type { CardData } from "../../src/types.js";

/** Minimal CardData with a real name + oracle text; the rest is boilerplate. */
function card(
  name: string,
  oracleText: string | undefined,
  extra: Partial<CardData> = {}
): CardData {
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

export const AUDIT_CARDS: CardData[] = [
  // -------------------------------------------------------------------------
  // ETB triggers (draw / gainLife / tokens / counters / scry / manual)
  // -------------------------------------------------------------------------
  card("Wall of Omens", "Defender\nWhen Wall of Omens enters the battlefield, draw a card."),
  card(
    "Mulldrifter",
    "Flying\nWhen Mulldrifter enters the battlefield, draw two cards.\nEvoke {2}{U} (You may cast this spell for its evoke cost. If you do, it's sacrificed when it enters the battlefield.)"
  ),
  card(
    "Radiant Fountain",
    "When Radiant Fountain enters the battlefield, you gain 2 life.\n{T}: Add {C}.",
    { typeLine: "Land" }
  ),
  card(
    "Siege-Gang Commander",
    "When Siege-Gang Commander enters the battlefield, create three 1/1 red Goblin creature tokens.\n{1}{R}, Sacrifice a Goblin: Siege-Gang Commander deals 2 damage to any target."
  ),
  card(
    "Priest of the Blood Rite",
    "When Priest of the Blood Rite enters the battlefield, create a 5/5 black Demon creature token with flying.\nAt the beginning of your upkeep, you lose 2 life."
  ),
  card("Barrier of Bones", "Defender\nWhen Barrier of Bones enters the battlefield, scry 1."),
  card("Scale Keeper", "When Scale Keeper enters the battlefield, put two +1/+1 counters on it."),
  card("Thraben Inspector", "When this creature enters, investigate."),
  card(
    "Prideful Parent",
    "Vigilance\nWhen this creature enters, create a 1/1 white Cat creature token."
  ),
  card(
    "Aviary Mechanic",
    "When Aviary Mechanic enters the battlefield, you may return a permanent you control to its owner's hand."
  ),
  card(
    "Ghalta, Stampede Tyrant",
    "Trample\nWhen Ghalta enters the battlefield, put any number of creature cards from your hand onto the battlefield."
  ),
  card(
    "Loran of the Third Path",
    "When Loran enters, destroy up to one target artifact or enchantment."
  ),
  // Synthetic (from cardScripts.test.ts): standalone each-opponent-loses ETB.
  card(
    "Vault Emissary",
    "When Vault Emissary enters the battlefield, each opponent loses 2 life."
  ),

  // -------------------------------------------------------------------------
  // Dies / leaves / compound-event triggers
  // -------------------------------------------------------------------------
  card(
    "Filigree Familiar",
    "When Filigree Familiar enters the battlefield, you gain 2 life.\nWhen Filigree Familiar dies, draw a card."
  ),
  card("Perilous Myr", "When Perilous Myr dies, it deals 2 damage to any target."),
  card(
    "Kokusho, the Evening Star",
    "Flying\nWhen Kokusho, the Evening Star dies, each opponent loses 5 life and you gain life equal to the life lost this way."
  ),
  card(
    "Skyclave Apparition",
    "When this creature enters, exile up to one target nonland, nontoken permanent you don't control with mana value 4 or less.\nWhen this creature leaves the battlefield, the exiled card's owner creates an X/X blue Illusion creature token, where X is the exiled card's mana value."
  ),
  card(
    "Cryogen Relic",
    "When this artifact enters or leaves the battlefield, draw a card.",
    { typeLine: "Artifact" }
  ),
  card(
    "Sanguine Evangelist",
    "Battle cry\nWhen this creature enters or dies, create a 1/1 black Bat creature token with flying."
  ),
  card(
    "Sentinel of the Nameless City",
    "Vigilance\nWhenever this creature enters or attacks, create a Map token."
  ),

  // -------------------------------------------------------------------------
  // Upkeep / eachUpkeep / endStep
  // -------------------------------------------------------------------------
  card(
    "As Foretold",
    "At the beginning of your upkeep, put a time counter on As Foretold.\nOnce each turn, you may pay {0} rather than pay the mana cost for a spell you cast with mana value X or less, where X is the number of time counters on As Foretold.",
    { typeLine: "Enchantment" }
  ),
  card(
    "Oath of Druids",
    "At the beginning of each player's upkeep, that player chooses target player who controls more creatures than they do and is their opponent. The first player may reveal cards from the top of their library until they reveal a creature card. If they do, that player puts that card onto the battlefield and all other cards revealed this way into their graveyard.",
    { typeLine: "Enchantment" }
  ),
  // Synthetic (from cardScripts.test.ts): end-step compound stays manual.
  card("Doombringer", "At the beginning of your end step, you draw a card and lose 1 life."),

  // -------------------------------------------------------------------------
  // Attack / combat damage
  // -------------------------------------------------------------------------
  card(
    "Goblin Rabblemaster",
    "Other Goblin creatures you control attack each combat if able.\nAt the beginning of combat on your turn, create a 1/1 red Goblin creature token with haste.\nWhenever this creature attacks, it gets +1/+0 until end of turn for each other attacking Goblin."
  ),
  card(
    "Psychic Frog",
    "Whenever this creature deals combat damage to a player or planeswalker, draw a card.\nDiscard a card: Put a +1/+1 counter on this creature."
  ),

  // -------------------------------------------------------------------------
  // castSpell filters
  // -------------------------------------------------------------------------
  card(
    "Guttersnipe",
    "Whenever you cast an instant or sorcery spell, Guttersnipe deals 2 damage to each opponent."
  ),
  card(
    "Monastery Mentor",
    "Prowess\nWhenever you cast a noncreature spell, create a 1/1 white Monk creature token with prowess."
  ),
  card(
    "Ravenous Robots",
    "Whenever you cast an artifact spell, create a 1/1 colorless Robot artifact creature token."
  ),

  // -------------------------------------------------------------------------
  // v9 conditions — selfOrOther / other-enters / landfall
  // -------------------------------------------------------------------------
  card(
    "Guide of Souls",
    "Whenever another creature you control enters, you gain 1 life and get {E} (an energy counter).\nWhenever you attack, you may pay {E}{E}{E}. When you do, put two +1/+1 counters and a flying counter on target attacking creature. It becomes an Angel in addition to its other types."
  ),
  card(
    "Ultron, Artificial Malevolence",
    "Whenever another nontoken artifact you control enters, you may pay {2}. If you do, create a token that's a copy of it. If the token isn't a creature, it becomes a 2/2 Robot Villain creature in addition to its other types.",
    { typeLine: "Legendary Artifact Creature — Robot Villain" }
  ),
  card(
    "Tezzeret, Cruel Captain",
    "Whenever an artifact you control enters, put a loyalty counter on Tezzeret.\n0: Untap target artifact or creature. If it's an artifact creature, put a +1/+1 counter on it.\n−3: Search your library for an artifact card with mana value 1 or less, reveal it, put it into your hand, then shuffle.\n−7: You get an emblem with \"At the beginning of combat on your turn, put three +1/+1 counters on target artifact you control. If it's not a creature, it becomes a 0/0 Robot artifact creature.\"",
    { typeLine: "Legendary Planeswalker — Tezzeret" }
  ),
  card(
    "Lotus Cobra",
    "Landfall — Whenever a land you control enters, add one mana of any color."
  ),
  card(
    "Bristly Bill, Spine Sower",
    "Landfall — Whenever a land you control enters, put a +1/+1 counter on target creature.\n{3}{G}{G}: Double the number of +1/+1 counters on each creature you control."
  ),
  card(
    "Tireless Tracker",
    'Landfall — Whenever a land you control enters, investigate. (Create a Clue token. It\'s an artifact with "{2}, Sacrifice this token: Draw a card.")\nWhenever you sacrifice a Clue, put a +1/+1 counter on this creature.'
  ),
  card(
    "Icetill Explorer",
    "You may play an additional land on each of your turns.\nYou may play lands from your graveyard.\nLandfall — Whenever a land you control enters, mill a card."
  ),
  card(
    "Scythecat Cub",
    "Trample\nLandfall — Whenever a land you control enters, put a +1/+1 counter on target creature you control. If this is the second time this ability has resolved this turn, double the number of +1/+1 counters on that creature instead."
  ),

  // -------------------------------------------------------------------------
  // v9 conditions — other-creature-dies
  // -------------------------------------------------------------------------
  card(
    "Grim Haruspex",
    "Morph {B}\nWhenever another nontoken creature you control dies, draw a card."
  ),
  card(
    "Reaper of the Wilds",
    "Whenever another creature dies, scry 1.\n{B}: Reaper of the Wilds gains deathtouch until end of turn."
  ),

  // -------------------------------------------------------------------------
  // v9 conditions — steps (begin-of-combat, opponents' upkeep, main1, draw)
  // -------------------------------------------------------------------------
  card(
    "Luminarch Aspirant",
    "At the beginning of combat on your turn, put a +1/+1 counter on target creature you control."
  ),
  card(
    "Agent Bishop, Man in Black",
    "At the beginning of combat on your turn, put a +1/+1 counter on each of up to two target creatures."
  ),
  card(
    "Ouroboroid",
    "At the beginning of combat on your turn, put X +1/+1 counters on each creature you control, where X is this creature's power."
  ),
  card(
    "Abhorrent Oculus",
    "As an additional cost to cast this spell, exile six cards from your graveyard.\nFlying\nAt the beginning of each opponent's upkeep, manifest dread. (Look at the top two cards of your library. Put one onto the battlefield face down as a 2/2 creature and the other into your graveyard. Turn it face up any time for its mana cost if it's a creature card.)"
  ),
  card(
    "Coalition Relic",
    "{T}: Add one mana of any color.\n{T}: Put a charge counter on this artifact.\nAt the beginning of your first main phase, remove all charge counters from this artifact. Add one mana of any color for each charge counter removed this way.",
    { typeLine: "Artifact" }
  ),
  card(
    "Mana Vault",
    "This artifact doesn't untap during your untap step.\nAt the beginning of your upkeep, you may pay {4}. If you do, untap this artifact.\nAt the beginning of your draw step, if this artifact is tapped, it deals 1 damage to you.\n{T}: Add {C}{C}{C}.",
    { typeLine: "Artifact" }
  ),

  // -------------------------------------------------------------------------
  // v9 conditions — team attack, becameTapped, draw/discard watchers
  // -------------------------------------------------------------------------
  card(
    "Adeline, Resplendent Cathar",
    "Vigilance\nAdeline's power is equal to the number of creatures you control.\nWhenever you attack, for each opponent, create a 1/1 white Human creature token that's tapped and attacking that player or a planeswalker they control."
  ),
  card(
    "Raffine, Scheming Seer",
    "Flying, ward {1}\nWhenever you attack, target attacking creature connives X, where X is the number of attacking creatures. (Draw X cards, then discard X cards. Put a +1/+1 counter on that creature for each nonland card discarded this way.)"
  ),
  card(
    "Gut, True Soul Zealot",
    "Whenever you attack, you may sacrifice another creature or an artifact. If you do, create a 4/1 black Skeleton creature token with menace that's tapped and attacking. (It can't be blocked except by two or more creatures.)\nChoose a Background (You can have a Background as a second commander.)"
  ),
  card(
    "Hawkeye, Master Marksman",
    "First strike, reach\nTrick Arrows — Whenever Hawkeye becomes tapped, you may pay {1} up to three times. When you do, choose up to that many.\n• Net — Target creature can't block this turn.\n• Explosive — Hawkeye deals 2 damage to target player.\n• Boomerang — Discard a card, then draw a card."
  ),
  card(
    "Currency Converter",
    "Whenever you discard a card, you may exile that card from your graveyard.\n{2}, {T}: Draw a card, then discard a card.\n{T}: Put a card exiled with this artifact into its owner's graveyard. If it's a land card, create a Treasure token. If it's a nonland card, create a 2/2 black Rogue creature token.",
    { typeLine: "Artifact" }
  ),
  card(
    "Ivora, Insatiable Heir",
    'Trample\nWhen Ivora enters and whenever it deals combat damage to a player, create a Blood token. (It\'s an artifact with "{1}, {T}, Discard a card, Sacrifice this token: Draw a card.")\nWhenever you discard a card, put a +1/+1 counter on Ivora.'
  ),
  // Synthetic (from cardScripts.test.ts): the Bowmasters except-rider must
  // NOT match the plain opponent-draws template.
  card(
    "Rider Test",
    "Whenever an opponent draws a card except the first one they draw in each of their draw steps, this creature deals 1 damage to any target."
  ),

  // -------------------------------------------------------------------------
  // onResolve spells (positive and all-or-nothing negative cases)
  // -------------------------------------------------------------------------
  card("Night's Whisper", "You draw two cards and you lose 2 life.", { typeLine: "Sorcery" }),
  card("Divination", "Draw two cards.", { typeLine: "Sorcery" }),
  card("Revitalize", "You gain 3 life.\nDraw a card.", { typeLine: "Instant" }),
  card("Lightning Bolt", "Lightning Bolt deals 3 damage to any target.", { typeLine: "Instant" }),
  card("Counterspell", "Counter target spell.", { typeLine: "Instant" }),
  card("Sign in Blood", "Target player draws two cards and loses 2 life.", {
    typeLine: "Sorcery",
  }),
  card(
    "Brainstorm",
    "Draw three cards, then put two cards from your hand on top of your library in any order.",
    { typeLine: "Instant" }
  ),
  card("Wheel of Fortune", "Each player discards their hand, then draws seven cards.", {
    typeLine: "Sorcery",
  }),
  card(
    "Treasure Cruise",
    "Delve (Each card you exile from your graveyard while casting this spell pays for {1}.)\nDraw three cards.",
    { typeLine: "Sorcery" }
  ),

  // -------------------------------------------------------------------------
  // Fetch lands (activated searches)
  // -------------------------------------------------------------------------
  card(
    "Evolving Wilds",
    "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.",
    { typeLine: "Land" }
  ),
  card(
    "Flooded Strand",
    "{T}, Pay 1 life, Sacrifice this land: Search your library for a Plains or Island card, put it onto the battlefield, then shuffle.",
    { typeLine: "Land" }
  ),
  card(
    "Bloodstained Mire",
    "{T}, Pay 1 life, Sacrifice this land: Search your library for a Swamp or Mountain card, put it onto the battlefield, then shuffle.",
    { typeLine: "Land" }
  ),
  card(
    "Prismatic Vista",
    "{T}, Pay 1 life, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield, then shuffle.",
    { typeLine: "Land" }
  ),
  card(
    "Fabled Passage",
    "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land.",
    { typeLine: "Land" }
  ),

  // -------------------------------------------------------------------------
  // Replacement rules — entersTapped / entersWithCounters (v10)
  // -------------------------------------------------------------------------
  card(
    "Bojuka Bog",
    "Bojuka Bog enters the battlefield tapped.\nWhen Bojuka Bog enters the battlefield, exile target player's graveyard.\n{T}: Add {B}.",
    { typeLine: "Land" }
  ),
  card(
    "Bloodfell Caves",
    "This land enters tapped.\nWhen this land enters, you gain 1 life.\n{T}: Add {B} or {R}.",
    { typeLine: "Land" }
  ),
  card("Guildless Commons", "This land enters tapped.\n{T}: Add {C}.", { typeLine: "Land" }),
  card(
    "Glacial Fortress",
    "Glacial Fortress enters the battlefield tapped unless you control a Plains or an Island.\n{T}: Add {W} or {U}.",
    { typeLine: "Land" }
  ),
  card(
    "Serrated Arrows",
    "Serrated Arrows enters the battlefield with three arrowhead counters on it.\nAt the beginning of your upkeep, if there are no arrowhead counters on Serrated Arrows, sacrifice it.\n{T}, Remove an arrowhead counter from Serrated Arrows: Put a -1/-1 counter on target creature.",
    { typeLine: "Artifact" }
  ),
  card(
    "Spike Feeder",
    "Spike Feeder enters the battlefield with two +1/+1 counters on it.\n{2}, Remove a +1/+1 counter from Spike Feeder: Put a +1/+1 counter on target creature.\nRemove a +1/+1 counter from Spike Feeder: You gain 2 life."
  ),
  card(
    "Chalice of the Void",
    "Chalice of the Void enters the battlefield with X charge counters on it.\nWhenever a player casts a spell with mana value equal to the number of charge counters on Chalice of the Void, counter that spell.",
    { typeLine: "Artifact" }
  ),

  // -------------------------------------------------------------------------
  // Double-faced cards (front face only)
  // -------------------------------------------------------------------------
  card("Skyclave Cleric // Skyclave Basilica", undefined, {
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
  }),
  card("Reckless Stormseeker // Storm-Charged Slasher", undefined, {
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
  }),

  // -------------------------------------------------------------------------
  // CARD_OVERRIDES-backed cards (overrides win over inference — the snapshot
  // pins the override contents too). Oracle texts from the override
  // descriptions / cached Scryfall texts.
  // -------------------------------------------------------------------------
  card(
    "Flametongue Kavu",
    "When Flametongue Kavu enters the battlefield, it deals 4 damage to target creature."
  ),
  card(
    "Shriekmaw",
    "Fear\nWhen Shriekmaw enters the battlefield, destroy target nonartifact, nonblack creature.\nEvoke {1}{B}"
  ),
  card(
    "Ravenous Chupacabra",
    "When Ravenous Chupacabra enters the battlefield, destroy target creature an opponent controls."
  ),
  card(
    "Solemn Simulacrum",
    "When Solemn Simulacrum enters the battlefield, you may search your library for a basic land card, put it onto the battlefield tapped, then shuffle.\nWhen Solemn Simulacrum dies, you may draw a card.",
    { typeLine: "Artifact Creature — Golem" }
  ),
  card("Kitchen Finks", "When Kitchen Finks enters the battlefield, you gain 2 life.\nPersist"),
  card(
    "Thragtusk",
    "When Thragtusk enters the battlefield, you gain 5 life.\nWhen Thragtusk leaves the battlefield, create a 3/3 green Beast creature token."
  ),
  card(
    "Grave Titan",
    "Deathtouch\nWhenever Grave Titan enters the battlefield or attacks, create two 2/2 black Zombie creature tokens."
  ),
  card(
    "Sun Titan",
    "Vigilance\nWhenever Sun Titan enters the battlefield or attacks, you may return target permanent card with mana value 3 or less from your graveyard to the battlefield."
  ),
  card(
    "Bitterblossom",
    "At the beginning of your upkeep, you lose 1 life and create a 1/1 black Faerie Rogue creature token with flying.",
    { typeLine: "Kindred Enchantment — Faerie" }
  ),
  card(
    "Phyrexian Arena",
    "At the beginning of your upkeep, you draw a card and you lose 1 life.",
    { typeLine: "Enchantment" }
  ),
  card(
    "Kappa Cannoneer",
    "Improvise (Your artifacts can help cast this spell. Each artifact you tap after you're done activating mana abilities pays for {1}.)\nWard {4}\nWhenever this creature or another artifact you control enters, put a +1/+1 counter on this creature. It can't be blocked this turn.",
    { typeLine: "Artifact Creature — Turtle Warrior" }
  ),
  card(
    "Pyrogoyf",
    "Pyrogoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.\nWhenever this creature or another Lhurgoyf creature you control enters, that creature deals damage equal to its power to any target."
  ),
  card(
    "Vaultborn Tyrant",
    "Trample\nWhenever this creature or another creature you control with power 4 or greater enters, you gain 3 life and draw a card.\nWhen this creature dies, if it's not a token, create a token that's a copy of it, except it's an artifact in addition to its other types."
  ),
  card(
    "Titania, Protector of Argoth",
    "When Titania enters, return target land card from your graveyard to the battlefield.\nWhenever a land you control is put into a graveyard from the battlefield, create a 5/3 green Elemental creature token."
  ),
  card(
    "Fastbond",
    "You may play any number of lands on each of your turns.\nWhenever you play a land, if it wasn't the first land you played this turn, this enchantment deals 1 damage to you.",
    { typeLine: "Enchantment" }
  ),
  card(
    "City of Traitors",
    "When you play another land, sacrifice this land.\n{T}: Add {C}{C}.",
    { typeLine: "Land" }
  ),
  card(
    "Sheoldred, the Apocalypse",
    "Deathtouch\nWhenever you draw a card, you gain 2 life.\nWhenever an opponent draws a card, they lose 2 life."
  ),
  card(
    "Orcish Bowmasters",
    "Flash\nWhen this creature enters, it deals 1 damage to any target. Then amass Orcs 1.\nWhenever an opponent draws a card except the first one they draw in each of their draw steps, this creature deals 1 damage to any target. Then amass Orcs 1."
  ),
  card(
    "Underworld Breach",
    "Each nonland permanent card in your graveyard gains escape until end of turn. The escape cost is equal to the card's mana cost plus exile three other cards from your graveyard.\nAt the beginning of the end step, sacrifice this enchantment.",
    { typeLine: "Enchantment" }
  ),
  card(
    "Questing Beast",
    "Vigilance, deathtouch, haste\nWhenever Questing Beast deals combat damage to an opponent, it deals that much damage to target planeswalker that player controls."
  ),
  card(
    "Worldspine Wurm",
    "Trample\nWhen this creature dies, create three 5/5 green Wurm creature tokens with trample.\nWhen Worldspine Wurm is put into a graveyard from anywhere, shuffle it into its owner's library."
  ),
  card(
    "Smuggler's Copter",
    "Flying\nWhenever this Vehicle attacks or blocks, you may draw a card. If you do, discard a card.\nCrew 1",
    { typeLine: "Artifact — Vehicle" }
  ),
  card(
    "Stormchaser's Talent",
    "When this Class enters, create a 1/1 blue and red Otter creature token with prowess.",
    { typeLine: "Enchantment — Class" }
  ),
  card(
    "Sedgemoor Witch",
    'Menace\nWard—Pay 3 life.\nMagecraft — Whenever you cast or copy an instant or sorcery spell, create a 1/1 black and green Pest creature token with "When this token dies, you gain 1 life."'
  ),
  card(
    "Vivi Ornitier",
    "{0}: Add X mana in any combination of {U} and/or {R}, where X is Vivi Ornitier's power. Activate only during your turn and only once each turn.\nWhenever you cast a noncreature spell, put a +1/+1 counter on Vivi Ornitier and it deals 1 damage to each opponent."
  ),
  card(
    "Witherbloom Apprentice",
    "Magecraft — Whenever you cast or copy an instant or sorcery spell, each opponent loses 1 life and you gain 1 life."
  ),
  card(
    "Minsc & Boo, Timeless Heroes",
    "When Minsc & Boo enters and at the beginning of your upkeep, you may create Boo, a legendary 1/1 red Hamster creature token with trample and haste.",
    { typeLine: "Legendary Planeswalker — Minsc" }
  ),

  // -------------------------------------------------------------------------
  // Negative anchors — cards that must produce NO script (null)
  // -------------------------------------------------------------------------
  card("Grizzly Bears", undefined),
  card("Wind Drake", "Flying"),
  card("Island", undefined, { typeLine: "Basic Land — Island" }),
  card("Command Tower", "{T}: Add one mana of any color in your commander's color identity.", {
    typeLine: "Land",
  }),
  card(
    "Clue Payoff",
    "Whenever you sacrifice a Clue, put a +1/+1 counter on this creature."
  ),
  card(
    "Sword of the Meek",
    "Equipped creature gets +1/+2.\nWhenever a 1/1 creature you control enters, you may return this card from your graveyard to the battlefield, then attach it to that creature.\nEquip {2}",
    { typeLine: "Artifact — Equipment" }
  ),
];
