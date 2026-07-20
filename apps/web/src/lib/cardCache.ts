/**
 * Client-side CardData cache.
 *
 * Contract gap resolved here: DraftView / RoomState carry card *ids* only (no
 * CardData lookup table — GameView is the only view that ships one). The draft
 * and deckbuild screens therefore resolve ids straight from Scryfall's
 * `POST /cards/collection` (same endpoint the server uses), batched by 75 and
 * cached for the session. GameView.cards is primed into the same cache so game
 * screens never trigger a fetch.
 */
import { useEffect, useMemo, useReducer } from "react";
import type { CardData, Color } from "@mtg-cube/shared";

interface ScryfallImageUris {
  small?: string;
  normal?: string;
}

interface ScryfallFace {
  name?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  image_uris?: ScryfallImageUris;
}

interface ScryfallCard extends ScryfallFace {
  id?: string;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  layout?: string;
  card_faces?: ScryfallFace[];
  produced_mana?: string[];
}

interface ScryfallCollectionResponse {
  data?: ScryfallCard[];
  not_found?: unknown[];
}

const COLOR_SET = new Set(["W", "U", "B", "R", "G"]);

function toColors(raw: string[] | undefined): Color[] {
  if (!raw) return [];
  return raw.filter((c): c is Color => COLOR_SET.has(c));
}

function toCardData(sc: ScryfallCard): CardData | null {
  if (!sc.id || !sc.name) return null;
  const faces = sc.card_faces?.map((f) => ({
    name: f.name ?? sc.name ?? "",
    manaCost: f.mana_cost,
    typeLine: f.type_line ?? "",
    oracleText: f.oracle_text,
    power: f.power,
    toughness: f.toughness,
    loyalty: f.loyalty,
    imageNormal: f.image_uris?.normal,
    imageSmall: f.image_uris?.small,
  }));
  const firstFace = faces?.[0];
  return {
    id: sc.id,
    name: sc.name,
    manaCost: sc.mana_cost ?? firstFace?.manaCost,
    cmc: sc.cmc ?? 0,
    typeLine: sc.type_line ?? firstFace?.typeLine ?? "",
    oracleText: sc.oracle_text ?? firstFace?.oracleText,
    colors: toColors(sc.colors),
    colorIdentity: toColors(sc.color_identity),
    power: sc.power ?? firstFace?.power,
    toughness: sc.toughness ?? firstFace?.toughness,
    loyalty: sc.loyalty ?? firstFace?.loyalty,
    imageSmall: sc.image_uris?.small ?? firstFace?.imageSmall,
    imageNormal: sc.image_uris?.normal ?? firstFace?.imageNormal,
    layout: sc.layout ?? "normal",
    faces,
    producedMana: sc.produced_mana,
  };
}

/** id -> CardData, or null if Scryfall could not resolve it (avoid refetch loops). */
const cache = new Map<string, CardData | null>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Seed the cache from a server-provided lookup (e.g. GameView.cards). */
export function primeCards(cards: Record<string, CardData>): void {
  let changed = false;
  for (const [id, data] of Object.entries(cards)) {
    if (!cache.has(id)) {
      cache.set(id, data);
      changed = true;
    }
  }
  if (changed) notify();
}

export function getCachedCard(id: string): CardData | undefined {
  return cache.get(id) ?? undefined;
}

async function fetchBatch(ids: string[]): Promise<void> {
  try {
    const res = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers: ids.map((id) => ({ id })) }),
    });
    if (!res.ok) throw new Error(`Scryfall ${res.status}`);
    const json = (await res.json()) as ScryfallCollectionResponse;
    const found = new Set<string>();
    for (const sc of json.data ?? []) {
      const data = toCardData(sc);
      if (data) {
        cache.set(data.id, data);
        found.add(data.id);
      }
    }
    for (const id of ids) {
      if (!found.has(id)) cache.set(id, null);
    }
  } catch {
    // Leave ids unresolved; text fallbacks render and a later mount retries.
  } finally {
    for (const id of ids) inflight.delete(id);
    notify();
  }
}

function requestCards(ids: string[]): void {
  const missing = ids.filter((id) => id && id !== "hidden" && !cache.has(id) && !inflight.has(id));
  if (missing.length === 0) return;
  for (const id of missing) inflight.add(id);
  for (let i = 0; i < missing.length; i += 75) {
    void fetchBatch(missing.slice(i, i + 75));
  }
}

/**
 * Resolve CardData for a set of card ids, fetching missing ones from Scryfall.
 * Re-renders the component as batches arrive.
 */
export function useCardData(cardIds: readonly string[]): Record<string, CardData> {
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const key = useMemo(() => {
    const uniq = Array.from(new Set(cardIds.filter((id) => id && id !== "hidden")));
    uniq.sort();
    return uniq.join("|");
  }, [cardIds]);

  useEffect(() => {
    const listener = () => bump();
    listeners.add(listener);
    if (key.length > 0) requestCards(key.split("|"));
    return () => {
      listeners.delete(listener);
    };
  }, [key]);

  return useMemo(() => {
    const out: Record<string, CardData> = {};
    if (key.length === 0) return out;
    for (const id of key.split("|")) {
      const data = cache.get(id);
      if (data) out[id] = data;
    }
    return out;
  }, [key, cache.size]); // eslint-disable-line react-hooks/exhaustive-deps
}
