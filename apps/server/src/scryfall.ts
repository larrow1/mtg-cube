/**
 * Scryfall integration: resolve cube lists to CardData via POST /cards/collection
 * (batches of 75, 100ms between batches) and provide the five basic lands.
 */
import type { CardData, CardFace, Color } from "@mtg-cube/shared";
import { BASIC_LAND_NAMES } from "@mtg-cube/shared";

const API = "https://api.scryfall.com";
const BATCH_SIZE = 75;
const BATCH_DELAY_MS = 100;

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "mtg-cube-draft/0.1",
};

// ---------------------------------------------------------------------------
// Scryfall response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

interface ScryfallImageUris {
  small?: string;
  normal?: string;
}

interface ScryfallFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors?: string[];
  image_uris?: ScryfallImageUris;
}

interface ScryfallCard {
  id: string;
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  power?: string;
  toughness?: string;
  loyalty?: string;
  image_uris?: ScryfallImageUris;
  layout?: string;
  card_faces?: ScryfallFace[];
  produced_mana?: string[];
}

// ---------------------------------------------------------------------------
// Mapping to CardData
// ---------------------------------------------------------------------------

const COLOR_SET = new Set(["W", "U", "B", "R", "G"]);

function toColors(raw: string[] | undefined): Color[] {
  return [...new Set(raw ?? [])].filter((c): c is Color => COLOR_SET.has(c));
}

function toFace(face: ScryfallFace): CardFace {
  const out: CardFace = { name: face.name, typeLine: face.type_line ?? "" };
  if (face.mana_cost) out.manaCost = face.mana_cost;
  if (face.oracle_text) out.oracleText = face.oracle_text;
  if (face.power !== undefined) out.power = face.power;
  if (face.toughness !== undefined) out.toughness = face.toughness;
  if (face.loyalty !== undefined) out.loyalty = face.loyalty;
  if (face.image_uris?.normal) out.imageNormal = face.image_uris.normal;
  if (face.image_uris?.small) out.imageSmall = face.image_uris.small;
  return out;
}

export function toCardData(c: ScryfallCard): CardData {
  const rawFaces = c.card_faces && c.card_faces.length > 0 ? c.card_faces : undefined;
  const faces = rawFaces?.map(toFace);
  const front = rawFaces?.[0];

  const card: CardData = {
    id: c.id,
    name: c.name,
    cmc: typeof c.cmc === "number" ? c.cmc : 0,
    typeLine: c.type_line ?? front?.type_line ?? "",
    colors: toColors(c.colors ?? rawFaces?.flatMap((f) => f.colors ?? [])),
    colorIdentity: toColors(c.color_identity),
    layout: c.layout ?? "normal",
  };

  const manaCost = c.mana_cost ?? front?.mana_cost;
  if (manaCost) card.manaCost = manaCost;

  const oracleText =
    c.oracle_text ??
    (faces && faces.length > 0
      ? faces
          .map((f) => f.oracleText)
          .filter((t): t is string => Boolean(t))
          .join("\n//\n")
      : undefined);
  if (oracleText) card.oracleText = oracleText;

  const power = c.power ?? front?.power;
  if (power !== undefined) card.power = power;
  const toughness = c.toughness ?? front?.toughness;
  if (toughness !== undefined) card.toughness = toughness;
  const loyalty = c.loyalty ?? front?.loyalty;
  if (loyalty !== undefined) card.loyalty = loyalty;

  // DFCs have per-face image_uris and no top-level ones; fall back to the front face.
  const imageSmall = c.image_uris?.small ?? front?.image_uris?.small;
  if (imageSmall) card.imageSmall = imageSmall;
  const imageNormal = c.image_uris?.normal ?? front?.image_uris?.normal;
  if (imageNormal) card.imageNormal = imageNormal;

  if (faces && faces.length > 1) card.faces = faces;
  if (c.produced_mana && c.produced_mana.length > 0) card.producedMana = c.produced_mana;

  return card;
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Every name a returned card can be matched by: full name, split halves, face names. */
function nameKeys(c: ScryfallCard): string[] {
  const keys = new Set<string>();
  keys.add(normalizeName(c.name));
  for (const part of c.name.split("//")) {
    const key = normalizeName(part);
    if (key) keys.add(key);
  }
  for (const face of c.card_faces ?? []) keys.add(normalizeName(face.name));
  return [...keys];
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ResolvedCards {
  /** Keyed by the exact requested name string. */
  byName: Map<string, CardData>;
  /** Requested names Scryfall could not resolve. */
  unresolved: string[];
}

/**
 * Resolve a list of card names via POST /cards/collection in batches of 75
 * with a 100ms pause between batches. Names that come back in `not_found`
 * (i.e. that no returned card matches) are collected into `unresolved`.
 */
export async function resolveCardNames(names: string[]): Promise<ResolvedCards> {
  const requested = [...new Set(names)];
  const foundRaw: ScryfallCard[] = [];

  for (let i = 0; i < requested.length; i += BATCH_SIZE) {
    if (i > 0) await delay(BATCH_DELAY_MS);
    const batch = requested.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${API}/cards/collection`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
    });
    if (!res.ok) throw new Error(`Scryfall request failed (HTTP ${res.status})`);
    const body = (await res.json()) as { data?: ScryfallCard[] };
    foundRaw.push(...(body.data ?? []));
  }

  const byKey = new Map<string, CardData>();
  for (const raw of foundRaw) {
    const card = toCardData(raw);
    for (const key of nameKeys(raw)) {
      if (!byKey.has(key)) byKey.set(key, card);
    }
  }

  const byName = new Map<string, CardData>();
  const unresolved: string[] = [];
  for (const name of requested) {
    const card = byKey.get(normalizeName(name));
    if (card) byName.set(name, card);
    else unresolved.push(name);
  }
  return { byName, unresolved };
}

// ---------------------------------------------------------------------------
// Basic lands
// ---------------------------------------------------------------------------

type BasicLandName = (typeof BASIC_LAND_NAMES)[number];

const BASIC_COLORS: Record<BasicLandName, Color> = {
  Plains: "W",
  Island: "U",
  Swamp: "B",
  Mountain: "R",
  Forest: "G",
};

/** Minimal offline CardData; no image, so the client renders its text fallback. */
function fallbackBasic(name: BasicLandName): CardData {
  const color = BASIC_COLORS[name];
  return {
    id: `basic-${name.toLowerCase()}`,
    name,
    cmc: 0,
    typeLine: `Basic Land — ${name}`,
    oracleText: `({T}: Add {${color}}.)`,
    colors: [],
    colorIdentity: [color],
    layout: "normal",
    producedMana: [color],
  };
}

let basicsCache: CardData[] | null = null;
let basicsLoading: Promise<CardData[]> | null = null;

/**
 * Fetch the five basics from Scryfall once (GET /cards/named?exact=...) and
 * cache them. Any per-card failure falls back to hardcoded minimal CardData.
 */
export function preloadBasicLands(): Promise<CardData[]> {
  if (basicsCache) return Promise.resolve(basicsCache);
  basicsLoading ??= (async () => {
    const cards: CardData[] = [];
    for (const name of BASIC_LAND_NAMES) {
      try {
        const res = await fetch(`${API}/cards/named?exact=${encodeURIComponent(name)}`, {
          headers: { Accept: HEADERS.Accept, "User-Agent": HEADERS["User-Agent"] },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        cards.push(toCardData((await res.json()) as ScryfallCard));
      } catch {
        console.warn(`Scryfall fetch for basic "${name}" failed; using hardcoded fallback`);
        cards.push(fallbackBasic(name));
      }
      await delay(BATCH_DELAY_MS);
    }
    basicsCache = cards;
    return cards;
  })();
  return basicsLoading;
}

/** The five basics, from cache if preloaded, otherwise the hardcoded fallbacks. */
export function getBasicLandCards(): CardData[] {
  return basicsCache ?? BASIC_LAND_NAMES.map(fallbackBasic);
}
