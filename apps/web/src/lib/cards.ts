/**
 * Pure helpers for rendering cards: names, type classification, colors, mana.
 */
import type { CardData, CardFace, GameCard } from "@mtg-cube/shared";

export type RowKind = "lands" | "creatures" | "other";

/** The face of a (possibly multi-faced) card currently showing. */
export function activeFace(data: CardData | undefined, faceIndex: number): CardFace | CardData | undefined {
  if (!data) return undefined;
  if (data.faces && data.faces.length > 0) {
    return data.faces[Math.max(0, faceIndex) % data.faces.length] ?? data;
  }
  return data;
}

export function typeLineOf(gc: GameCard, data: CardData | undefined): string {
  if (gc.isToken) return gc.tokenTypeLine ?? "Token";
  const face = activeFace(data, gc.faceIndex);
  return face?.typeLine ?? "";
}

export function nameOf(gc: GameCard, data: CardData | undefined): string {
  if (gc.isToken) return gc.tokenName ?? "Token";
  if (gc.cardId === "hidden") return "Face-down card";
  const face = activeFace(data, gc.faceIndex);
  return face?.name ?? data?.name ?? "Unknown card";
}

export function powerToughnessOf(gc: GameCard, data: CardData | undefined): string | null {
  if (gc.isToken) {
    if (gc.tokenPower !== undefined || gc.tokenToughness !== undefined) {
      return `${gc.tokenPower ?? "0"}/${gc.tokenToughness ?? "0"}`;
    }
    return null;
  }
  const face = activeFace(data, gc.faceIndex);
  const p = face?.power ?? data?.power;
  const t = face?.toughness ?? data?.toughness;
  if (p !== undefined && t !== undefined) return `${p}/${t}`;
  return null;
}

/** Battlefield row auto-classification. Face-down cards act like 2/2 creatures. */
export function classifyRow(gc: GameCard, data: CardData | undefined): RowKind {
  if (gc.faceDown) return "creatures";
  const tl = typeLineOf(gc, data).toLowerCase();
  if (tl.includes("creature")) return "creatures";
  if (tl.includes("land")) return "lands";
  return "other";
}

export type ColorBucket = "W" | "U" | "B" | "R" | "G" | "M" | "C" | "L";

export const COLOR_BUCKET_ORDER: ColorBucket[] = ["W", "U", "B", "R", "G", "M", "C", "L"];

export const COLOR_BUCKET_LABELS: Record<ColorBucket, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  M: "Multicolor",
  C: "Colorless",
  L: "Lands",
};

export function colorBucket(data: CardData | undefined): ColorBucket {
  if (!data) return "C";
  if (data.typeLine.toLowerCase().includes("land")) return "L";
  const colors = data.colors.length > 0 ? data.colors : data.colorIdentity;
  if (colors.length === 0) return "C";
  if (colors.length > 1) return "M";
  const only = colors[0];
  return only ?? "C";
}

/**
 * Evergreen keyword abilities we render as icon chips on battlefield art
 * tiles. Order here is canonical for display.
 */
export const KNOWN_KEYWORDS = [
  "flying",
  "first strike",
  "double strike",
  "deathtouch",
  "lifelink",
  "trample",
  "haste",
  "vigilance",
  "menace",
  "reach",
  "hexproof",
  "indestructible",
  "flash",
  "defender",
  "ward",
  "protection",
] as const;

const KNOWN_KEYWORD_SET = new Set<string>(KNOWN_KEYWORDS);

/**
 * Parse the FRONT face's oracle text for keyword abilities. Reminder text
 * (parenthesized) is stripped first; a line only counts when it consists
 * entirely of comma/semicolon-separated known keywords ("Flying, deathtouch"),
 * so ability sentences like "Flying, then draw a card" never false-positive.
 * "Ward {2}" / "Ward—pay 3 life" map to `ward`, "Protection from X" to
 * `protection`. Deduped, original order preserved.
 */
export function keywordAbilities(card: CardData): string[] {
  const front = card.faces && card.faces.length > 0 ? card.faces[0] : undefined;
  const oracle = front?.oracleText ?? card.oracleText;
  if (!oracle) return [];
  const stripped = oracle.replace(/\s*\([^)]*\)/g, "");
  const found: string[] = [];
  for (const line of stripped.split("\n")) {
    const parts = line
      .split(/[,;]/)
      .map((p) => p.trim().replace(/\.$/, ""))
      .filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    const lineKeywords: string[] = [];
    let allKnown = true;
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (KNOWN_KEYWORD_SET.has(lower)) {
        lineKeywords.push(lower);
      } else if (/^ward[\s{—-]/.test(lower)) {
        lineKeywords.push("ward");
      } else if (/^protection from /.test(lower)) {
        lineKeywords.push("protection");
      } else {
        // An unknown word disqualifies the whole line — it's a sentence, not
        // a keyword list.
        allKnown = false;
        break;
      }
    }
    if (allKnown) found.push(...lineKeywords);
  }
  return [...new Set(found)];
}

/** "{2}{W}{U}" -> ["2","W","U"]; bare costs pass through. */
export function parseManaCost(cost: string | undefined): string[] {
  if (!cost) return [];
  const out: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cost)) !== null) {
    const sym = m[1];
    if (sym !== undefined) out.push(sym);
  }
  return out;
}

/** Tailwind classes for a mana-symbol pip. */
export function manaPipClasses(symbol: string): string {
  switch (symbol) {
    case "W":
      return "bg-amber-200 text-amber-950";
    case "U":
      return "bg-sky-500 text-sky-50";
    case "B":
      return "bg-zinc-900 text-zinc-100 border border-zinc-500";
    case "R":
      return "bg-red-500 text-red-50";
    case "G":
      return "bg-green-500 text-green-950";
    case "C":
      return "bg-zinc-300 text-zinc-800";
    default:
      return "bg-zinc-500 text-zinc-100";
  }
}

/** Subtle frame tint per color bucket for the text-frame fallback. */
export function frameClasses(bucket: ColorBucket): string {
  switch (bucket) {
    case "W":
      return "from-amber-100/20 border-amber-200/30";
    case "U":
      return "from-sky-400/20 border-sky-400/30";
    case "B":
      return "from-purple-900/40 border-purple-500/25";
    case "R":
      return "from-red-500/20 border-red-400/30";
    case "G":
      return "from-green-600/25 border-green-500/30";
    case "M":
      return "from-yellow-400/20 border-yellow-400/35";
    case "L":
      return "from-orange-800/30 border-orange-400/25";
    default:
      return "from-zinc-400/15 border-zinc-400/25";
  }
}

export function cmcBucket(cmc: number): number {
  return Math.min(7, Math.max(0, Math.floor(cmc)));
}

export const CMC_BUCKET_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"];

const TYPE_ORDER = ["Creature", "Planeswalker", "Instant", "Sorcery", "Artifact", "Enchantment", "Battle", "Land"] as const;

export function primaryType(data: CardData | undefined): string {
  if (!data) return "Other";
  for (const t of TYPE_ORDER) {
    if (data.typeLine.includes(t)) return t;
  }
  return "Other";
}

export function compareByCmcName(a: CardData | undefined, b: CardData | undefined): number {
  const ac = a?.cmc ?? 99;
  const bc = b?.cmc ?? 99;
  if (ac !== bc) return ac - bc;
  return (a?.name ?? "").localeCompare(b?.name ?? "");
}

export function formatSeconds(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
