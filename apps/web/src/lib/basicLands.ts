/**
 * Client-side basic-land card data (Plains/Island/Swamp/Mountain/Forest) for
 * the deck builder's lands column. Fetched from Scryfall once per browser and
 * cached in localStorage; consumers get whatever is available immediately and
 * re-render when the fetch lands. Failures degrade to the pip fallback UI.
 */
import { useEffect, useState } from "react";
import type { CardData } from "@mtg-cube/shared";
import { BASIC_LAND_NAMES } from "@mtg-cube/shared";

const LS_KEY = "mtg-cube-basic-lands-v1";

type BasicMap = Partial<Record<string, CardData>>;

let memory: BasicMap | null = null;
let inflight: Promise<BasicMap> | null = null;

function loadStored(): BasicMap | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BasicMap;
    if (typeof parsed !== "object" || parsed === null) return null;
    // All five present with images = usable cache.
    const complete = BASIC_LAND_NAMES.every((n) => parsed[n]?.imageSmall);
    return complete ? parsed : null;
  } catch {
    return null;
  }
}

interface ScryfallBasic {
  id: string;
  name: string;
  type_line?: string;
  image_uris?: { small?: string; normal?: string };
}

async function fetchBasics(): Promise<BasicMap> {
  const res = await fetch("https://api.scryfall.com/cards/collection", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ identifiers: BASIC_LAND_NAMES.map((name) => ({ name })) }),
  });
  if (!res.ok) throw new Error(`Scryfall ${res.status}`);
  const body = (await res.json()) as { data?: ScryfallBasic[] };
  const out: BasicMap = {};
  for (const c of body.data ?? []) {
    const card: CardData = {
      id: c.id,
      name: c.name,
      cmc: 0,
      typeLine: c.type_line ?? `Basic Land — ${c.name}`,
      colors: [],
      colorIdentity: [],
      layout: "normal",
    };
    if (c.image_uris?.small) card.imageSmall = c.image_uris.small;
    if (c.image_uris?.normal) card.imageNormal = c.image_uris.normal;
    out[c.name] = card;
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(out));
  } catch {
    // Cache miss next load — harmless.
  }
  return out;
}

/** The five basics' CardData, or undefined per-name until the fetch lands. */
export function useBasicLandCards(): BasicMap {
  const [basics, setBasics] = useState<BasicMap>(() => {
    if (!memory) memory = loadStored();
    return memory ?? {};
  });

  useEffect(() => {
    if (memory && BASIC_LAND_NAMES.every((n) => memory?.[n])) return;
    inflight ??= fetchBasics()
      .then((m) => {
        memory = m;
        return m;
      })
      .catch(() => {
        inflight = null; // allow a retry on next mount
        return {} as BasicMap;
      });
    let alive = true;
    void inflight.then((m) => {
      if (alive && Object.keys(m).length > 0) setBasics(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  return basics;
}
