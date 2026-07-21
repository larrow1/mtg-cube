/** A polished local match state for working on the game-table UI. */
import type { CardData, GameCard, GameView, PlayerGameState, RoomState, ZoneName } from "@mtg-cube/shared";
import type { Session } from "../store";

const me = "demo-player";
const opponent = "demo-opponent";

const imageFor = (name: string): string =>
  `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`;

function card(
  id: string,
  name: string,
  manaCost: string | undefined,
  cmc: number,
  typeLine: string,
  colors: CardData["colors"],
  extras: Partial<CardData> = {}
): CardData {
  return {
    id,
    name,
    manaCost,
    cmc,
    typeLine,
    colors,
    colorIdentity: colors,
    layout: "normal",
    imageNormal: imageFor(name),
    imageSmall: imageFor(name),
    ...extras,
  };
}

export const demoCards: Record<string, CardData> = {
  plains: card("plains", "Plains", undefined, 0, "Basic Land — Plains", ["W"], { producedMana: ["W"] }),
  island: card("island", "Island", undefined, 0, "Basic Land — Island", ["U"], { producedMana: ["U"] }),
  forest: card("forest", "Forest", undefined, 0, "Basic Land — Forest", ["G"], { producedMana: ["G"] }),
  "llanowar-elves": card("llanowar-elves", "Llanowar Elves", "{G}", 1, "Creature — Elf Druid", ["G"], { power: "1", toughness: "1", producedMana: ["G"] }),
  "serra-angel": card("serra-angel", "Serra Angel", "{3}{W}{W}", 5, "Creature — Angel", ["W"], { power: "4", toughness: "4" }),
  "shivan-dragon": card("shivan-dragon", "Shivan Dragon", "{4}{R}{R}", 6, "Creature — Dragon", ["R"], { power: "5", toughness: "5" }),
  "grizzly-bears": card("grizzly-bears", "Grizzly Bears", "{1}{G}", 2, "Creature — Bear", ["G"], { power: "2", toughness: "2" }),
  "lightning-bolt": card("lightning-bolt", "Lightning Bolt", "{R}", 1, "Instant", ["R"]),
  counterspell: card("counterspell", "Counterspell", "{U}{U}", 2, "Instant", ["U"]),
  opt: card("opt", "Opt", "{U}", 1, "Instant", ["U"]),
  murder: card("murder", "Murder", "{1}{B}{B}", 3, "Instant", ["B"]),
  "black-lotus": card("black-lotus", "Black Lotus", "{0}", 0, "Artifact", []),
};

function gameCard(cardId: string, ownerId: string, sortIndex: number, patch: Partial<GameCard> = {}): GameCard {
  return {
    instanceId: `${ownerId}-${cardId}-${sortIndex}`,
    cardId,
    ownerId,
    controllerId: ownerId,
    tapped: false,
    faceDown: false,
    faceIndex: 0,
    counters: {},
    attachedTo: null,
    isToken: false,
    damage: 0,
    attacking: false,
    blocking: null,
    sortIndex,
    ...patch,
  };
}

function emptyZones(): Record<ZoneName, GameCard[]> {
  return { library: [], hand: [], battlefield: [], graveyard: [], exile: [], stack: [], sideboard: [] };
}

function player(playerId: string, life: number): PlayerGameState {
  return { playerId, life, poison: 0, manaPool: {}, zones: emptyZones(), landsPlayedThisTurn: 0, hasLost: false };
}

const playerOne = player(me, 17);
playerOne.manaPool = { W: 1, U: 2, G: 1 };
playerOne.zones.battlefield = [
  gameCard("plains", me, 1), gameCard("island", me, 2), gameCard("forest", me, 3, { tapped: true }),
  gameCard("llanowar-elves", me, 4, { tapped: true }), gameCard("serra-angel", me, 5, { counters: { "+1/+1": 1 } }),
];
playerOne.zones.hand = ["lightning-bolt", "counterspell", "opt", "forest", "black-lotus", "murder"].map((id, i) => gameCard(id, me, i));
playerOne.zones.graveyard = [gameCard("opt", me, 31)];
playerOne.zones.exile = [gameCard("lightning-bolt", me, 32)];
playerOne.zones.library = Array.from({ length: 27 }, (_, i) => gameCard("hidden", me, 100 + i, { faceDown: true }));

const playerTwo = player(opponent, 13);
playerTwo.manaPool = { R: 2, G: 1 };
playerTwo.zones.battlefield = [
  gameCard("island", opponent, 1), gameCard("island", opponent, 2, { tapped: true }),
  gameCard("forest", opponent, 3), gameCard("shivan-dragon", opponent, 4),
  gameCard("grizzly-bears", opponent, 5, { attacking: true }),
];
playerTwo.zones.hand = Array.from({ length: 4 }, (_, i) => gameCard("hidden", opponent, i, { faceDown: true }));
playerTwo.zones.graveyard = [gameCard("counterspell", opponent, 31)];
playerTwo.zones.library = Array.from({ length: 22 }, (_, i) => gameCard("hidden", opponent, 100 + i, { faceDown: true }));

export const demoSession: Session = { roomId: "demo-room", playerId: me, token: "demo", name: "UI Explorer" };

export const demoRoom: RoomState = {
  id: "demo-room", hostId: me, phase: "playing",
  players: [{ id: me, name: "UI Explorer", connected: true }, { id: opponent, name: "Sparky", connected: true }],
  cube: { id: "demo-cube", name: "UI Testing Cube", cardCount: 360, unresolved: [] },
  draftConfig: { seatCount: 2, packsPerPlayer: 3, cardsPerPack: 15, pickTimerSeconds: null, seed: "ui-demo" },
  decksSubmitted: [me, opponent], matches: [{ id: "demo-game", playerIds: [me, opponent], finished: false }], ranked: false, sandbox: false,
};

export const demoGameView: GameView = {
  gameId: "demo-game",
  viewerId: me,
  state: {
    id: "demo-game", players: [playerOne, playerTwo], activePlayerId: me, priorityPlayerId: me,
    turnNumber: 6, step: "main1", stack: [], startingPlayerId: me, finished: false, winnerId: null, seq: 42,
    log: [
      { seq: 42, playerId: me, message: "UI Explorer entered their first main phase.", ts: Date.now() },
      { seq: 41, playerId: opponent, message: "Sparky attacked with Grizzly Bears.", ts: Date.now() - 20_000 },
      { seq: 40, playerId: me, message: "UI Explorer cast Serra Angel.", ts: Date.now() - 38_000 },
    ],
  },
  cards: demoCards,
};
