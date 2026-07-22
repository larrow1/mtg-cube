/**
 * Deckbuild, Arena-style: the pool as a dominant filterable grid of card
 * images on top (search + color-pip toggles + type chips), the deck as
 * compact stacked mana-value columns along the bottom (duplicates collapse
 * with an xN badge), with a lands column (drafted lands + basic-land
 * steppers) and an amber sideboard column at the right. A slim right rail
 * carries curve, color split, submit + checklist, host pair-match and chat.
 * Pool <-> deck <-> sideboard via click or drag-drop; submit semantics are
 * unchanged (leftover pool cards are submitted as sideboard).
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { BASIC_LAND_NAMES, type CardData, type Color, type DraftCard } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { useCardData } from "../lib/cardCache";
import {
  COLOR_BUCKET_ORDER,
  cmcBucket,
  colorBucket,
  compareByCmcName,
  listManaCostParts,
  parseManaCost,
  primaryType,
  type ColorBucket,
} from "../lib/cards";
import { ManaSymbol } from "../components/ManaSymbol";
import { sideboardedInstanceIds } from "../lib/draftLanes";
import { useBasicLandCards } from "../lib/basicLands";
import { Card, CardBack, useCardPreview } from "../components/Card";
import { CardGrid } from "../components/CardGrid";
import { CurveChart } from "../components/CurveChart";
import { ColorSplit, TypeCounts, draftListRowAppearance, listRowColors } from "../components/PicksRail";
import { ChatPanel } from "../components/ChatPanel";

type DeckZone = "pool" | "main" | "side";

const DRAG_MIME = "text/plain";

const BASIC_COLORS: Record<string, string> = {
  Plains: "W",
  Island: "U",
  Swamp: "B",
  Mountain: "R",
  Forest: "G",
};

const FILTER_PIPS: ColorBucket[] = ["W", "U", "B", "R", "G", "C"];
const TYPE_CHIPS = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Land"];
const BASIC_NAME_BY_COLOR: Record<Color, string> = {
  W: "Plains",
  U: "Island",
  B: "Swamp",
  R: "Mountain",
  G: "Forest",
};
const LAND_COLORS: Color[] = ["W", "U", "B", "R", "G"];
const BASIC_LAND_TYPE_NAMES = ["Plains", "Island", "Swamp", "Mountain", "Forest"] as const;
const IDEAL_LAND_COUNT = 17;

function basicNameFromInstanceId(instanceId: string): string | undefined {
  return BASIC_LAND_NAMES.find((name) => instanceId.startsWith(`basic-${name}-`));
}

/** Suggest basics at the limited 17 lands : 23 nonlands ratio. */
function suggestBasicLands(main: DraftCard[], cards: Record<string, CardData>): Record<string, number> {
  const lands = main.filter((card) => cards[card.cardId]?.typeLine.toLowerCase().includes("land"));
  const spells = main.filter((card) => !cards[card.cardId]?.typeLine.toLowerCase().includes("land"));
  const targetLandCount = Math.round(spells.length * IDEAL_LAND_COUNT / 23);

  const demand = new Map<Color, number>(LAND_COLORS.map((color) => [color, 0]));
  for (const spell of spells) {
    const data = cards[spell.cardId];
    const manaCost = data?.faces?.[0]?.manaCost ?? data?.manaCost;
    for (const symbol of parseManaCost(manaCost)) {
      const colors = [...new Set(
        [...symbol.toUpperCase()].filter((character): character is Color => LAND_COLORS.includes(character as Color))
      )];
      if (colors.length === 0) continue;
      for (const color of colors) demand.set(color, (demand.get(color) ?? 0) + 1 / colors.length);
    }
  }

  const totalDemand = LAND_COLORS.reduce((sum, color) => sum + (demand.get(color) ?? 0), 0);
  if (totalDemand === 0) return {};

  // A dual contributes half a land toward each of its colors; a triome
  // contributes one third. This keeps every existing land worth exactly one
  // slot while acknowledging every color it can produce or fetch.
  const existingCoverage = new Map<Color, number>(LAND_COLORS.map((color) => [color, 0]));
  for (const land of lands) {
    const colors = listRowColors(cards[land.cardId]);
    if (colors.length === 0) continue;
    for (const color of colors) {
      existingCoverage.set(color, (existingCoverage.get(color) ?? 0) + 1 / colors.length);
    }
  }

  const uncoveredColors = LAND_COLORS.filter(
    (color) => (demand.get(color) ?? 0) > 0 && (existingCoverage.get(color) ?? 0) === 0
  );
  // Even in a very small work-in-progress deck, give every otherwise
  // unsupported spell color at least one basic (one red and one blue spell
  // therefore receive both a Mountain and an Island).
  const basicsNeeded = Math.max(0, targetLandCount - lands.length, uncoveredColors.length);
  if (basicsNeeded === 0) return {};

  const scores = LAND_COLORS.map((color) => ({
    color,
    score: Math.max(0, targetLandCount * ((demand.get(color) ?? 0) / totalDemand) - (existingCoverage.get(color) ?? 0)),
  }));
  let scoreTotal = scores.reduce((sum, item) => sum + item.score, 0);
  if (scoreTotal === 0) {
    for (const item of scores) item.score = demand.get(item.color) ?? 0;
    scoreTotal = scores.reduce((sum, item) => sum + item.score, 0);
  }

  const guaranteed = new Set(uncoveredColors);
  const flexibleSlots = basicsNeeded - guaranteed.size;
  const allocations = scores.map((item) => {
    const exact = flexibleSlots * item.score / scoreTotal;
    return {
      ...item,
      count: (guaranteed.has(item.color) ? 1 : 0) + Math.floor(exact),
      fraction: exact - Math.floor(exact),
    };
  });
  let remaining = basicsNeeded - allocations.reduce((sum, item) => sum + item.count, 0);
  for (const item of [...allocations].sort((a, b) => b.fraction - a.fraction || LAND_COLORS.indexOf(a.color) - LAND_COLORS.indexOf(b.color))) {
    if (remaining <= 0) break;
    item.count += 1;
    remaining -= 1;
  }

  const result: Record<string, number> = {};
  for (const item of allocations) {
    if (item.count > 0) result[BASIC_NAME_BY_COLOR[item.color]] = item.count;
  }
  return result;
}

function ManaSources({
  main,
  cards,
  basics,
}: {
  main: DraftCard[];
  cards: Record<string, CardData>;
  basics: Record<string, number>;
}): JSX.Element {
  const sources = useMemo(() => {
    const byColor = new Map<Color, Map<string, number>>(
      LAND_COLORS.map((color) => [color, new Map<string, number>()])
    );
    const addSource = (color: Color, name: string, amount = 1): void => {
      const breakdown = byColor.get(color);
      if (breakdown) breakdown.set(name, (breakdown.get(name) ?? 0) + amount);
    };

    const oracleText = (data: CardData): string =>
      [data.oracleText, ...(data.faces?.map((face) => face.oracleText) ?? [])]
        .filter((text): text is string => Boolean(text))
        .join(" ");
    const fetchRule = (data: CardData): { types: string[]; basicOnly: boolean } | null => {
      const oracle = oracleText(data);
      if (!/search your library/i.test(oracle)) return null;
      const types = BASIC_LAND_TYPE_NAMES.filter((landType) =>
        new RegExp(`\\b${landType}\\b`, "i").test(oracle)
      );
      const basicOnly = /\bbasic land card\b/i.test(oracle);
      return types.length > 0 || basicOnly ? { types: [...types], basicOnly } : null;
    };

    const mainLands = main
      .map((card) => cards[card.cardId])
      .filter((data): data is CardData => Boolean(data?.typeLine.toLowerCase().includes("land")));
    const landTargets = mainLands.map((data) => ({
      data,
      typeLine: data.typeLine,
      isBasic: /\bbasic\b/i.test(data.typeLine),
    }));
    for (const basicName of BASIC_LAND_TYPE_NAMES) {
      if ((basics[basicName] ?? 0) <= 0) continue;
      const color = BASIC_COLORS[basicName] as Color;
      landTargets.push({
        data: {
          id: `basic-source-${basicName.toLowerCase()}`,
          name: basicName,
          cmc: 0,
          typeLine: `Basic Land — ${basicName}`,
          colors: [],
          colorIdentity: [color],
          layout: "normal",
          producedMana: [color],
        },
        typeLine: `Basic Land — ${basicName}`,
        isBasic: true,
      });
    }

    for (const card of main) {
      const data = cards[card.cardId];
      if (!data) continue;
      const typeLine = data.typeLine.toLowerCase();
      const isLandSource = typeLine.includes("land");
      const isZeroManaArtifactSource = typeLine.includes("artifact") && data.cmc === 0;
      if (!isLandSource && !isZeroManaArtifactSource) continue;
      const fetch = isLandSource ? fetchRule(data) : null;
      const colors = fetch
        ? [...new Set(landTargets.flatMap((target) => {
          const hasLegalLandType = fetch.types.some((landType) =>
            new RegExp(`\\b${landType}\\b`, "i").test(target.typeLine)
          );
          const isLegalTarget = fetch.basicOnly
            ? target.isBasic && (fetch.types.length === 0 || hasLegalLandType)
            : hasLegalLandType;
          return isLegalTarget ? listRowColors(target.data) : [];
        }))]
        : isLandSource
          ? listRowColors(data)
          : [...new Set((data.producedMana ?? []).filter((color): color is Color => LAND_COLORS.includes(color as Color)))];
      for (const color of colors) addSource(color, data.name);
    }
    for (const color of LAND_COLORS) {
      const basicName = BASIC_NAME_BY_COLOR[color];
      const count = basics[basicName] ?? 0;
      if (count > 0) addSource(color, basicName, count);
    }

    return LAND_COLORS.map((color) => {
      const breakdown = [...(byColor.get(color)?.entries() ?? [])]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return {
        color,
        count: breakdown.reduce((sum, [, amount]) => sum + amount, 0),
        breakdown,
      };
    });
  }, [basics, cards, main]);

  return (
    <div className="panel-inset p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Mana sources</div>
      <div className="space-y-2">
        {sources.map(({ color, count, breakdown }) => (
          <div key={color} className="flex items-start gap-2">
            <ManaSymbol symbol={color} className="h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-zinc-200">{count} source{count === 1 ? "" : "s"}</span>
                <span className="text-[9px] font-black text-zinc-500">{color}</span>
              </div>
              <div className="text-[10px] leading-snug text-zinc-500">
                {breakdown.length > 0
                  ? breakdown.map(([name, amount]) => `${amount} ${name}`).join(" · ")
                  : "No sources"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Deck-strip mana columns, matching the draft tray's clean 0-1..6+ lanes. */
const DECK_BUCKETS = ["0-1", "2", "3", "4", "5", "6+"] as const;
type DeckBucket = (typeof DECK_BUCKETS)[number];
type DeckColumn = string;
const DEFAULT_DECK_COLUMNS: DeckColumn[] = [...DECK_BUCKETS, "lands"];

function deckBucket(cmc: number | undefined): DeckBucket {
  const b = cmcBucket(cmc ?? 0);
  if (b <= 1) return "0-1";
  if (b >= 6) return "6+";
  return String(b) as DeckBucket;
}

/** One visual stack entry: duplicates of the same card collapse into it. */
interface StackEntry {
  cardId: string;
  instances: DraftCard[];
}

function stackEntries(list: DraftCard[], cards: Record<string, CardData>): StackEntry[] {
  const sorted = [...list].sort((a, b) => compareByCmcName(cards[a.cardId], cards[b.cardId]));
  const byCard = new Map<string, StackEntry>();
  const out: StackEntry[] = [];
  for (const dc of sorted) {
    let entry = byCard.get(dc.cardId);
    if (!entry) {
      entry = { cardId: dc.cardId, instances: [] };
      byCard.set(dc.cardId, entry);
      out.push(entry);
    }
    entry.instances.push(dc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deck-strip resize (mirrors the draft tray's PicksTray mechanics — the tray's
// clamp/min live in PicksTray.tsx with its own exports and a different min, so
// the tiny helpers are mirrored here rather than entangling the two screens)
// ---------------------------------------------------------------------------

const STRIP_PREFS_KEY = "mtg-cube-deckstrip";
const STRIP_MIN_H = 140;
const stripMaxH = (): number => Math.round(window.innerHeight * 0.82);
const clampStripH = (h: number): number => Math.max(STRIP_MIN_H, Math.min(stripMaxH(), Math.round(h)));

interface StripPrefs {
  h: number;
}

const DEFAULT_STRIP_PREFS: StripPrefs = { h: 300 };

function loadStripPrefs(): StripPrefs {
  try {
    const raw = localStorage.getItem(STRIP_PREFS_KEY);
    if (!raw) return DEFAULT_STRIP_PREFS;
    const p = JSON.parse(raw) as Partial<StripPrefs> | null;
    if (!p || typeof p !== "object") return DEFAULT_STRIP_PREFS;
    return {
      h: typeof p.h === "number" && Number.isFinite(p.h) ? clampStripH(p.h) : DEFAULT_STRIP_PREFS.h,
    };
  } catch {
    return DEFAULT_STRIP_PREFS;
  }
}

// ---------------------------------------------------------------------------
// Arena-style deck banner (deck-box art + count + inline mini curve)
// ---------------------------------------------------------------------------

/** Fanned trio of card backs (pure SVG) — the Arena sideboard chip icon. */
function FannedCardsIcon({ className = "" }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 22 16" className={className} aria-hidden="true">
      <rect x="2" y="3.5" width="8" height="11" rx="1.4" transform="rotate(-14 6 9)" className="fill-felt-800 stroke-amber-300/60" strokeWidth="0.8" />
      <rect x="7" y="2.5" width="8" height="11.5" rx="1.4" transform="rotate(-2 11 8)" className="fill-felt-700 stroke-amber-300/80" strokeWidth="0.8" />
      <rect x="12" y="2" width="8" height="12" rx="1.4" transform="rotate(10 16 8)" className="fill-felt-600 stroke-amber-300" strokeWidth="0.8" />
    </svg>
  );
}

/** 7 compact vertical bars (costs 0–6+), Arena banner style: no axes. */
function MiniCurve({ counts }: { counts: number[] }): JSX.Element {
  const max = Math.max(1, ...counts);
  return (
    <div className="flex h-8 shrink-0 items-end gap-[3px] px-1" aria-label="Mana curve">
      {counts.map((n, i) => {
        const label = i >= 6 ? "6+" : String(i);
        const h = n > 0 ? Math.max(5, Math.round((n / max) * 30)) : 2;
        return (
          <div
            key={label}
            className="flex h-full w-[7px] items-end"
            title={`${n} card${n === 1 ? "" : "s"} at cost ${label}`}
          >
            <div
              className={`w-full rounded-sm transition-all duration-300 ${
                n > 0
                  ? "bg-gradient-to-t from-amber-700 via-brass-400 to-amber-100 shadow-[0_0_5px_rgba(251,191,36,0.4)]"
                  : "bg-white/10"
              }`}
              style={{ height: h }}
            />
          </div>
        );
      })}
    </div>
  );
}

function artCropUrl(imageUrl: string | undefined): string | undefined {
  if (!imageUrl) return undefined;
  try {
    const url = new URL(imageUrl);
    if (url.hostname !== "cards.scryfall.io") return imageUrl;
    url.pathname = url.pathname.replace(/^\/(?:small|normal|large|png|border_crop)\//, "/art_crop/");
    return url.toString();
  } catch {
    return imageUrl;
  }
}

function DeckBanner({
  thumbSrc,
  thumbName,
  spellCount,
  landsCount,
  deckCount,
  curve,
  compact = false,
}: {
  thumbSrc: string | undefined;
  thumbName: string | undefined;
  spellCount: number;
  landsCount: number;
  deckCount: number;
  /** 7 buckets, costs 0..6+. */
  curve: number[];
  compact?: boolean;
}): JSX.Element {
  const under = deckCount < 40;
  return (
    <div
      className={`flex shrink-0 items-center rounded-xl border border-brass-400/30 bg-gradient-to-r from-brass-400/[0.16] via-amber-300/[0.06] to-transparent shadow-[inset_0_1px_0_rgba(255,221,150,0.14)] ${
        compact ? "gap-2 px-1.5 py-0.5" : "gap-2.5 px-2 py-1"
      }`}
    >
      <div
        className={`shrink-0 overflow-hidden rounded-md border border-brass-400/40 shadow-card transition-transform duration-200 hover:-rotate-3 hover:scale-110 ${
          compact ? "h-7 w-7" : "h-10 w-10"
        }`}
        title={thumbName}
      >
        {thumbSrc ? (
          <img src={thumbSrc} alt="" draggable={false} className="h-full w-full object-cover object-[center_18%]" />
        ) : (
          <CardBack />
        )}
      </div>
      <div className="min-w-0">
        <div className={`font-black uppercase leading-tight tracking-wider text-brass-300 ${compact ? "text-[9px]" : "text-[10px]"}`}>
          Deck
        </div>
        <div
          key={deckCount}
          className={`animate-count-pop whitespace-nowrap font-bold tabular-nums leading-tight ${
            compact ? "text-[11px]" : "text-xs"
          } ${under ? "text-red-300" : "text-emerald-300"}`}
          title={under ? "Main deck count including lands — add more cards" : "Main deck count including lands"}
        >
          {spellCount} + {landsCount} lands / 40
        </div>
      </div>
      {!compact && <MiniCurve counts={curve} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deck strip column (Arena-like stack: only name bands visible)
// ---------------------------------------------------------------------------

function StackColumn({
  entries,
  cards,
  width,
  isOver,
  onHoverChange,
  onDropCard,
  onEntryClick,
  clickTitle,
  draggableEntry = () => true,
  className = "",
  arrivingInstanceId,
}: {
  entries: StackEntry[];
  cards: Record<string, CardData>;
  width: number;
  isOver: boolean;
  onHoverChange: (over: boolean) => void;
  onDropCard: (instanceId: string) => void;
  onEntryClick: (instanceId: string) => void;
  clickTitle: string;
  draggableEntry?: (entry: StackEntry) => boolean;
  className?: string;
  arrivingInstanceId?: string | null;
}): JSX.Element {
  // Same trick as the draft tray: top-margin percentages resolve against the
  // column width, so "-119%" hides all but the card's name band (aspect 5/7).
  const overlap = "-119%";

  return (
    <div
      className={`flex h-full shrink-0 flex-col transition-colors duration-150 ${className} ${
        isOver ? "bg-brass-400/10 ring-1 ring-brass-400/50" : "bg-transparent"
      }`}
      style={{ width }}
      onDragOver={(e) => {
        e.preventDefault();
        onHoverChange(true);
      }}
      onDragLeave={() => onHoverChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onHoverChange(false);
        const id = e.dataTransfer.getData(DRAG_MIME);
        if (id) onDropCard(id);
      }}
    >
      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-1 pt-3">
        {entries.map((entry, i) => {
            const top = entry.instances[entry.instances.length - 1];
            const draggable = draggableEntry(entry);
            const isArriving = Boolean(
              arrivingInstanceId && entry.instances.some((instance) => instance.instanceId === arrivingInstanceId)
            );
            return (
              <div
                key={entry.cardId}
                className={`relative transition-transform duration-150 hover:z-30 hover:-translate-y-1 ${
                  isArriving ? "deckbuilder-card-column-arrival" : ""
                }`}
                style={{ marginTop: i === 0 ? 0 : overlap }}
              >
                <Card
                  data={cards[entry.cardId]}
                  size="md"
                  className="!w-full"
                  previewPlacement="above"
                  draggable={draggable}
                  onDragStart={(e) => {
                    if (draggable && top) e.dataTransfer.setData(DRAG_MIME, top.instanceId);
                  }}
                  onClick={() => {
                    if (top) onEntryClick(top.instanceId);
                  }}
                  title={clickTitle}
                />
                {entry.instances.length > 1 && (
                  <span className="pointer-events-none absolute -right-1 -top-1.5 z-20 rounded-full bg-gradient-to-b from-brass-300 to-brass-500 px-1.5 py-0.5 text-[10px] font-black leading-none text-amber-950 shadow-card">
                    x{entry.instances.length}
                  </span>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

function DeckRailRow({
  entry,
  data,
  onClick,
  clickTitle,
  draggable = true,
}: {
  entry: StackEntry;
  data: CardData | undefined;
  onClick: (instanceId: string) => void;
  clickTitle: string;
  draggable?: boolean;
}): JSX.Element {
  const { showPreview, clearPreview } = useCardPreview();
  const top = entry.instances[entry.instances.length - 1];
  const pips = listManaCostParts(data);
  const { borderClass, rowFill, borderFill } = draftListRowAppearance(data);
  return (
    <div
      className="draft-list-card-shell group relative my-[2px] ml-7 flex min-h-[27px] cursor-pointer items-center pl-2.5 pr-1.5 text-zinc-950 transition-transform duration-150 hover:-translate-y-px active:cursor-grabbing"
      draggable={draggable && Boolean(top)}
      onDragStart={(event) => {
        clearPreview();
        if (draggable && top) event.dataTransfer.setData(DRAG_MIME, top.instanceId);
      }}
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        showPreview(data, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }}
      onMouseLeave={clearPreview}
      onClick={() => {
        clearPreview();
        if (top) onClick(top.instanceId);
      }}
      title={clickTitle}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && top) {
          event.preventDefault();
          onClick(top.instanceId);
        }
      }}
    >
      <span
        aria-hidden="true"
        className={`draft-list-card-row absolute inset-0 rounded-[10px] border-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.52),inset_0_-2px_1px_rgba(0,0,0,0.24),0_2px_4px_rgba(0,0,0,0.82)] ring-2 ring-black/90 transition-[box-shadow,filter] duration-150 group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.62),inset_0_-2px_1px_rgba(0,0,0,0.26),0_4px_7px_rgba(0,0,0,0.9)] ${borderClass}`}
        style={{ background: rowFill, borderColor: borderFill ? "transparent" : undefined }}
      />
      <span className="absolute -left-[26px] top-1/2 z-10 flex h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-full border-2 border-[#b9bbb7] bg-gradient-to-br from-[#3b3e43] via-[#17191d] to-black text-[8px] font-black tabular-nums text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.28),0_1px_4px_rgba(0,0,0,0.95),0_0_0_1px_rgba(0,0,0,0.9)]">
        {entry.instances.length}×
      </span>
      <span className="draft-list-card-name min-w-0 flex-1 truncate text-[12px] font-bold leading-none tracking-[-0.018em] text-black">
        {data?.name ?? "Loading…"}
      </span>
      <span className="relative z-[3] ml-1 flex shrink-0 items-center gap-px">
        {pips.slice(0, 6).map((symbol, index) => symbol === "//" ? (
          <span key={`split-${index}`} className="mx-px text-[8px] font-black leading-none text-black">//</span>
        ) : (
          <span
            key={`${symbol}-${index}`}
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-full border-[0.5px] border-black"
          >
            <ManaSymbol symbol={symbol} className="h-[15px] w-[15px] max-w-none drop-shadow-none" />
          </span>
        ))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deckbuild screen
// ---------------------------------------------------------------------------

export function Deckbuild({ onDone }: { onDone?: () => void } = {}): JSX.Element {
  const { state, pushToast, dispatch } = useApp();
  const room = state.room;
  const me = state.session;
  const picks = state.draft?.picks ?? [];

  const [assignment, setAssignment] = useState<Record<string, DeckZone>>({});
  const [cardColumns, setCardColumns] = useState<Record<string, DeckColumn>>({});
  const [basics, setBasics] = useState<Record<string, number>>({});
  const basicCards = useBasicLandCards();
  const { showPreview, clearPreview } = useCardPreview();
  const [submitting, setSubmitting] = useState(false);
  const [deckStatsOpen, setDeckStatsOpen] = useState(false);
  const [pairA, setPairA] = useState("");
  const [pairB, setPairB] = useState("");

  // Pool filters (they apply to the pool only).
  const [query, setQuery] = useState("");
  const [colorPips, setColorPips] = useState<ReadonlySet<ColorBucket>>(new Set());
  const [typeChips, setTypeChips] = useState<ReadonlySet<string>>(new Set());
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const [deckView, setDeckView] = useState<"list" | "cards">("list");
  const deckWorkspaceRef = useRef<HTMLElement>(null);
  const sideboardGridHostRef = useRef<HTMLDivElement>(null);
  const mainboardScrollRef = useRef<HTMLDivElement>(null);
  const [columnOrder, setColumnOrder] = useState<DeckColumn[]>(DEFAULT_DECK_COLUMNS);
  const [pendingColumnGap, setPendingColumnGap] = useState<{
    key: string;
    index: number;
    columnId: DeckColumn;
  } | null>(null);
  const columnSequence = useRef(0);
  const columnGapTimer = useRef<number | null>(null);
  const [arrivingColumnCardId, setArrivingColumnCardId] = useState<string | null>(null);
  const arrivingColumnCardTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!typeMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!typeMenuRef.current?.contains(event.target as Node)) setTypeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [typeMenuOpen]);

  useEffect(() => {
    const resetPendingColumn = (): void => {
      if (columnGapTimer.current !== null) window.clearTimeout(columnGapTimer.current);
      columnGapTimer.current = null;
      setPendingColumnGap(null);
    };
    document.addEventListener("dragend", resetPendingColumn);
    return () => {
      document.removeEventListener("dragend", resetPendingColumn);
      if (columnGapTimer.current !== null) window.clearTimeout(columnGapTimer.current);
      if (arrivingColumnCardTimer.current !== null) window.clearTimeout(arrivingColumnCardTimer.current);
    };
  }, []);

  useEffect(() => {
    const scroller = mainboardScrollRef.current;
    if (!scroller) return;
    const redirectWheel = (event: WheelEvent): void => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      scroller.scrollLeft += delta;
    };
    scroller.addEventListener("wheel", redirectWheel, { passive: false, capture: true });
    return () => scroller.removeEventListener("wheel", redirectWheel, { capture: true });
  }, []);

  // Deck-strip drag highlight, keyed per column.
  const [dragCol, setDragCol] = useState<string | null>(null);

  // Deck-strip size prefs (drag-resizable like the draft picks tray).
  const [stripPrefs, setStripPrefs] = useState<StripPrefs>(loadStripPrefs);
  useEffect(() => {
    try {
      localStorage.setItem(STRIP_PREFS_KEY, JSON.stringify(stripPrefs));
    } catch {
      // localStorage unavailable — prefs just won't survive reloads.
    }
  }, [stripPrefs]);

  const measureStripMaxHeight = (): number => {
    const workspace = deckWorkspaceRef.current?.getBoundingClientRect();
    const grid = sideboardGridHostRef.current?.firstElementChild as HTMLElement | null;
    const firstCard = grid?.firstElementChild as HTMLElement | null;
    if (!workspace || !firstCard) return stripMaxH();
    const firstRowTop = firstCard.getBoundingClientRect().top;
    const dividerTopLimit = firstRowTop - 8;
    return Math.max(
      STRIP_MIN_H,
      Math.min(Math.round(workspace.height), Math.round(workspace.bottom - dividerTopLimit)),
    );
  };

  const startStripResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = stripPrefs.h;
    const maximumHeight = measureStripMaxHeight();
    const onMove = (ev: MouseEvent): void => {
      const desiredHeight = Math.round(startH + (startY - ev.clientY));
      const nextHeight = Math.max(STRIP_MIN_H, Math.min(maximumHeight, desiredHeight));
      setStripPrefs((current) => current.h === nextHeight ? current : { ...current, h: nextHeight });
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const selectDeckView = (view: "list" | "cards"): void => {
    const openingCards = view === "cards" && deckView !== "cards";
    setDeckView(view);
    if (!openingCards) return;

    window.requestAnimationFrame(() => {
      const workspace = deckWorkspaceRef.current?.getBoundingClientRect();
      const grid = sideboardGridHostRef.current?.firstElementChild as HTMLElement | null;
      const firstCard = grid?.firstElementChild as HTMLElement | null;
      if (!workspace || !firstCard) return;
      const firstCardBounds = firstCard.getBoundingClientRect();
      const firstRowBottom = firstCardBounds.bottom;
      const desiredDividerTop = firstRowBottom + 8;
      const maximumHeight = Math.max(
        STRIP_MIN_H,
        Math.min(Math.round(workspace.height), Math.round(workspace.bottom - (firstCardBounds.top - 8))),
      );
      setStripPrefs((current) => ({
        ...current,
        h: Math.max(STRIP_MIN_H, Math.min(maximumHeight, Math.round(workspace.bottom - desiredDividerTop))),
      }));
    });
  };

  const cards = useCardData(useMemo(() => picks.map((p) => p.cardId), [picks]));

  // Seed cards the player parked in the draft's Sideboard lane into the
  // visible pool area, which serves as the deckbuilder's sideboard.
  // Defensive: bad/absent stored data leaves everything in "pool" as before,
  // and explicit moves made here are never overwritten.
  const draftId = state.draft?.draftId;
  const seededFor = useRef<string | null>(null);
  const basicsSeededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draftId || seededFor.current === draftId) return;
    seededFor.current = draftId;
    const side = sideboardedInstanceIds(draftId);
    if (side.size === 0) return;
    setAssignment((cur) => {
      const next = { ...cur };
      for (const id of side) {
        if (!(id in next)) next[id] = "pool";
      }
      return next;
    });
  }, [draftId]);

  useEffect(() => {
    if (!draftId || basicsSeededFor.current === draftId || picks.length === 0) return;
    if (!picks.every((pick) => Boolean(cards[pick.cardId]))) return;
    const draftedSideboard = sideboardedInstanceIds(draftId);
    const initialMain = picks.filter((pick) => {
      const assigned = assignment[pick.instanceId];
      if (assigned) return assigned === "main";
      return !draftedSideboard.has(pick.instanceId);
    });
    basicsSeededFor.current = draftId;
    setBasics(suggestBasicLands(initialMain, cards));
  }, [assignment, cards, draftId, picks]);

  if (!room || !me) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="panel px-6 py-4 text-sm text-zinc-400">Loading…</div>
      </div>
    );
  }

  // Picks arrive pre-built: everything you drafted starts in the main deck
  // (sideboarded draft cards are seeded to "side" above) — the pool is where
  // cuts go.
  const zoneOf = (instanceId: string): DeckZone => assignment[instanceId] ?? "main";
  const inZone = (zone: DeckZone): DraftCard[] => picks.filter((p) => zoneOf(p.instanceId) === zone);
  const pool = inZone("pool");
  const main = inZone("main");
  const side = inZone("side");

  const moveTo = (instanceId: string, zone: DeckZone): void => {
    setAssignment((cur) => ({ ...cur, [instanceId]: zone }));
    if (zone !== "main") {
      setCardColumns((current) => {
        if (!(instanceId in current)) return current;
        const next = { ...current };
        delete next[instanceId];
        return next;
      });
    }
  };

  const moveToColumn = (instanceId: string, column: DeckColumn): void => {
    const basicName = basicNameFromInstanceId(instanceId);
    const pickedCard = picks.find((pick) => pick.instanceId === instanceId);
    const pickedData = pickedCard ? cards[pickedCard.cardId] : undefined;
    const defaultColumn = basicName || pickedData?.typeLine.toLowerCase().includes("land")
      ? "lands"
      : deckBucket(pickedData?.cmc);
    const previousColumn = cardColumns[instanceId] ?? defaultColumn;
    const changedColumns = zoneOf(instanceId) !== "main" || previousColumn !== column;

    if (!basicName) {
      setAssignment((current) => ({ ...current, [instanceId]: "main" }));
    }
    setCardColumns((current) => ({ ...current, [instanceId]: column }));
    if (!changedColumns) return;
    if (arrivingColumnCardTimer.current !== null) window.clearTimeout(arrivingColumnCardTimer.current);
    setArrivingColumnCardId(instanceId);
    arrivingColumnCardTimer.current = window.setTimeout(() => {
      arrivingColumnCardTimer.current = null;
      setArrivingColumnCardId(null);
    }, 420);
  };

  const nextColumnId = (): DeckColumn => {
    columnSequence.current += 1;
    return `custom-${columnSequence.current}`;
  };

  const clearColumnGapTimer = (): void => {
    if (columnGapTimer.current !== null) window.clearTimeout(columnGapTimer.current);
    columnGapTimer.current = null;
  };

  const beginColumnGapHold = (key: string, index: number): void => {
    if (pendingColumnGap?.key === key || columnGapTimer.current !== null) return;
    columnGapTimer.current = window.setTimeout(() => {
      columnGapTimer.current = null;
      setPendingColumnGap({ key, index, columnId: nextColumnId() });
    }, 250);
  };

  const leaveColumnGap = (key: string): void => {
    clearColumnGapTimer();
    setPendingColumnGap((current) => current?.key === key ? null : current);
  };

  const dropIntoNewColumn = (
    instanceId: string,
    index: number,
    preparedColumnId?: DeckColumn,
  ): void => {
    if (!instanceId) return;
    clearColumnGapTimer();
    const columnId = preparedColumnId ?? nextColumnId();
    setColumnOrder((current) => {
      const insertionIndex = Math.max(0, Math.min(index, current.length));
      return [
        ...current.slice(0, insertionIndex),
        columnId,
        ...current.slice(insertionIndex),
      ];
    });
    moveToColumn(instanceId, columnId);
    setPendingColumnGap(null);
  };

  const removeBasicCopy = (name: string, instanceId?: string): void => {
    const currentCount = basics[name] ?? 0;
    if (currentCount <= 0) return;
    const nextCount = currentCount - 1;
    const removedId = instanceId ?? `basic-${name}-${nextCount}`;
    setBasics((current) => ({ ...current, [name]: Math.max(0, (current[name] ?? 0) - 1) }));
    setCardColumns((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of Object.keys(next)) {
        if (!id.startsWith(`basic-${name}-`)) continue;
        const index = Number(id.slice(`basic-${name}-`.length));
        if (id === removedId || (Number.isFinite(index) && index >= nextCount)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  };

  const basicsTotal = Object.values(basics).reduce((a, b) => a + b, 0);
  const deckCount = main.length + basicsTotal;
  const submitted = room.decksSubmitted.includes(me.playerId);
  const isHost = room.hostId === me.playerId;
  const ranked = room.ranked;

  // -------------------------------------------------------------------------
  // Pool: Arena sort (color bucket, then mana value, then name) + filters
  // -------------------------------------------------------------------------

  const sortedPool = [...pool].sort((a, b) => {
    const da = cards[a.cardId];
    const db = cards[b.cardId];
    const ca = COLOR_BUCKET_ORDER.indexOf(colorBucket(da));
    const cb = COLOR_BUCKET_ORDER.indexOf(colorBucket(db));
    if (ca !== cb) return ca - cb;
    return compareByCmcName(da, db);
  });

  const trimmedQuery = query.trim().toLowerCase();
  const hasFilters = trimmedQuery !== "" || colorPips.size > 0 || typeChips.size > 0;

  const matchesFilters = (data: CardData | undefined): boolean => {
    if (!hasFilters) return true;
    if (!data) return false;
    if (trimmedQuery) {
      const hay = [
        data.name,
        data.typeLine,
        data.oracleText ?? "",
        ...(data.faces?.flatMap((f) => [f.name, f.typeLine, f.oracleText ?? ""]) ?? []),
      ]
        .join("\n")
        .toLowerCase();
      if (!hay.includes(trimmedQuery)) return false;
    }
    if (colorPips.size > 0) {
      const representedColors = listRowColors(data);
      const matchesColoredPip = representedColors.some((color) => colorPips.has(color));
      const matchesColorlessPip = representedColors.length === 0 && colorPips.has("C");
      if (!matchesColoredPip && !matchesColorlessPip) return false;
    }
    if (typeChips.size > 0 && !typeChips.has(primaryType(data))) return false;
    return true;
  };

  const shownPool = sortedPool.filter((dc) => matchesFilters(cards[dc.cardId]));

  const togglePip = (b: ColorBucket): void => {
    setColorPips((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  };
  const toggleType = (t: string): void => {
    setTypeChips((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };
  const clearFilters = (): void => {
    setQuery("");
    setColorPips(new Set());
    setTypeChips(new Set());
  };

  // -------------------------------------------------------------------------
  // Deck strip: mana columns + lands + sideboard
  // -------------------------------------------------------------------------

  const isLand = (dc: DraftCard): boolean =>
    (cards[dc.cardId]?.typeLine ?? "").toLowerCase().includes("land");
  const mainLands = main.filter(isLand);
  const mainSpells = main.filter((dc) => !isLand(dc));
  const creatureCount = mainSpells.filter((dc) =>
    (cards[dc.cardId]?.typeLine ?? "").toLowerCase().includes("creature")
  ).length;
  const nonCreatureCount = mainSpells.length - creatureCount;

  const landEntries = stackEntries(mainLands, cards);
  const sideEntries = stackEntries(side, cards);
  const mainEntries = [...stackEntries(mainSpells, cards), ...landEntries];
  const basicListEntries = BASIC_LAND_NAMES.flatMap((name) => {
    const count = basics[name] ?? 0;
    if (count <= 0) return [];
    const color = BASIC_COLORS[name] as Color;
    const resolved = basicCards[name];
    const data: CardData = {
      id: resolved?.id ?? `basic-${name.toLowerCase()}`,
      name,
      cmc: 0,
      typeLine: resolved?.typeLine ?? `Basic Land — ${name}`,
      colors: [],
      colorIdentity: [color],
      layout: resolved?.layout ?? "normal",
      imageSmall: resolved?.imageSmall,
      imageNormal: resolved?.imageNormal,
      producedMana: [color],
    };
    const entry: StackEntry = {
      cardId: data.id,
      instances: Array.from({ length: count }, (_, index) => ({
        instanceId: `basic-${name}-${index}`,
        cardId: data.id,
      })),
    };
    return [{ name, data, entry }];
  });
  const statsCards: Record<string, CardData> = { ...cards };
  for (const { data } of basicListEntries) statsCards[data.id] = data;
  const columnEntries = new Map<DeckColumn, StackEntry[]>();
  for (const column of columnOrder) columnEntries.set(column, []);
  {
    const byColumn = new Map<DeckColumn, DraftCard[]>();
    const placedCards = [
      ...main,
      ...basicListEntries.flatMap(({ entry }) => entry.instances),
    ];
    for (const dc of placedCards) {
      const isBasic = Boolean(basicNameFromInstanceId(dc.instanceId));
      const defaultColumn = isBasic || isLand(dc) ? "lands" : deckBucket(statsCards[dc.cardId]?.cmc);
      const requestedColumn = cardColumns[dc.instanceId]
        ?? (isBasic || isLand(dc) ? "lands" : deckBucket(statsCards[dc.cardId]?.cmc));
      const preferredColumn = columnEntries.has(requestedColumn) ? requestedColumn : defaultColumn;
      const arr = byColumn.get(preferredColumn);
      if (arr) arr.push(dc);
      else byColumn.set(preferredColumn, [dc]);
    }
    for (const [column, arr] of byColumn) columnEntries.set(column, stackEntries(arr, statsCards));
  }
  const statsMain: DraftCard[] = [
    ...main,
    ...basicListEntries.flatMap(({ entry }) => entry.instances),
  ];
  const landsCount = mainLands.length + basicsTotal;

  const submitDeck = async (): Promise<void> => {
    setSubmitting(true);
    // Anything left in the pool is submitted as sideboard alongside the
    // explicit sideboard (the contract has no "pool" concept at submit time).
    const r = await call("submitDeck", { main, sideboard: [...side, ...pool], basics });
    setSubmitting(false);
    if (r.ok) {
      pushToast("Deck submitted", "success");
      onDone?.();
    } else {
      pushToast(r.error ?? "Deck rejected");
    }
  };

  const startMatch = async (): Promise<void> => {
    if (!pairA || !pairB || pairA === pairB) return;
    const r = await call("startMatch", { playerA: pairA, playerB: pairB });
    if (!r.ok) pushToast(r.error ?? "Could not start match");
    else pushToast("Match started", "success");
  };

  const nameOfPlayer = (id: string): string => room.players.find((p) => p.id === id)?.name ?? "Unknown";

  const curveCounts = ((): number[] => {
    const counts = new Array<number>(8).fill(0);
    for (const dc of mainSpells) {
      const data = cards[dc.cardId];
      if (!data) continue;
      const b = cmcBucket(data.cmc);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    return counts;
  })();

  // Match the Draft list header: use artwork from the cheapest ordinary spell
  // in the main deck. X spells sort after fixed-cost spells, with lands used
  // only as an artwork fallback when the deck contains no illustrated spell.
  const curve7 = [...curveCounts.slice(0, 6), (curveCounts[6] ?? 0) + (curveCounts[7] ?? 0)];
  const thumbnailSpells = [...mainSpells].sort((a, b) => {
    const aData = cards[a.cardId];
    const bData = cards[b.cardId];
    const aX = parseManaCost(aData?.manaCost).some((symbol) => symbol.toUpperCase() === "X");
    const bX = parseManaCost(bData?.manaCost).some((symbol) => symbol.toUpperCase() === "X");
    if (aX !== bX) return aX ? 1 : -1;
    return compareByCmcName(aData, bData);
  });
  const thumbnailCandidates = [...thumbnailSpells, ...mainLands];
  const thumbData = thumbnailCandidates
    .map((dc) => cards[dc.cardId])
    .find((data) => Boolean(data?.imageSmall || data?.imageNormal));
  const deckCoverUrl = artCropUrl(thumbData?.imageSmall ?? thumbData?.imageNormal);
  const curveMax = Math.max(1, ...curveCounts);

  // The strip height remains draggable, but its cards stay locked to the
  // same dimensions as the Sideboard cards.
  const stripH = Math.max(STRIP_MIN_H, Math.round(stripPrefs.h));
  const cardW = 160;
  const landsW = cardW;

  const stripHandle = (
    <div
      className="group absolute inset-x-0 top-0 z-20 flex h-3.5 cursor-row-resize items-start justify-center"
      onMouseDown={startStripResize}
      title="Drag to resize"
    >
      <div className="h-0.5 w-20 rounded-full bg-white/10 transition-colors duration-150 group-hover:bg-brass-400/70" />
    </div>
  );

  const deckHeader = (): JSX.Element => (
    <button
      type="button"
      className={`draft-deck-banner deckbuilder-deck-header relative flex h-[66px] w-full max-w-[24rem] shrink-0 items-center gap-2 overflow-hidden px-2.5 py-1.5 text-left ${deckCount >= 40 ? "is-complete" : ""}`}
      onClick={() => setDeckStatsOpen(true)}
      aria-expanded={deckStatsOpen}
      aria-controls="deckbuilder-deck-stats"
      title="Open deck stats"
    >
      <div className="draft-deck-banner-art relative h-11 w-[58px] shrink-0" aria-hidden="true">
        <span className="draft-deck-banner-card draft-deck-banner-card-front">
          <img
            src={deckCoverUrl ?? "/ui/empty-deck-vault.jpg"}
            alt=""
            className="draft-deck-banner-art-image"
          />
          <span className="draft-deck-banner-card-glass" />
        </span>
      </div>
      <div className="min-w-0 flex-1 leading-none">
        <div className="flex items-center gap-2">
          <div className="draft-deck-banner-title">Deck</div>
          {ranked && <span className="chip border-brass-400/60 !px-1.5 !py-0 text-[8px] font-black tracking-widest text-brass-300">RANKED</span>}
        </div>
        <div className="draft-deck-banner-count mt-1 flex items-baseline gap-1 tabular-nums">
          <span>{deckCount}</span>
          <span className="draft-deck-banner-count-target">/ 40</span>
          <span className="draft-deck-banner-count-label">Cards</span>
        </div>
      </div>
      <div
        className="draft-deck-mini-curve flex h-11 w-[70px] shrink-0 items-end justify-center gap-[2px] px-1.5 pb-1.5 pt-2"
        role="img"
        aria-label={`Mana curve for ${deckCount} mainboard cards`}
        title="Mainboard mana curve"
      >
        {curveCounts.map((count, index) => (
          <span
            key={index}
            className={count > 0 ? "is-filled" : "is-empty"}
            style={{ height: `${Math.max(8, (count / curveMax) * 100)}%` }}
            title={`${count} card${count === 1 ? "" : "s"} at mana value ${index === 7 ? "7+" : index}`}
          />
        ))}
      </div>
    </button>
  );

  const myLiveMatch = room.matches.find((m) => !m.finished && m.playerIds.includes(me.playerId));

  const allowDrag = (e: DragEvent<HTMLElement>): void => e.preventDefault();

  const basicsFooter = (
    <div className="mt-1.5 space-y-1">
      {BASIC_LAND_NAMES.map((name) => {
        const n = basics[name] ?? 0;
        const sym = BASIC_COLORS[name] ?? "C";
        const landCard = basicCards[name];
        return (
          <div
            key={name}
            className={`flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-150 ${
              n > 0 ? "bg-white/[0.06]" : "bg-white/[0.02]"
            }`}
            title={name}
          >
            {landCard?.imageSmall ? (
              <img
                src={landCard.imageSmall}
                alt={name}
                loading="lazy"
                draggable={false}
                className={`h-9 w-[26px] shrink-0 cursor-zoom-in rounded-[3px] object-cover shadow-card transition-all duration-150 hover:-translate-y-0.5 ${
                  n > 0 ? "" : "opacity-45 saturate-50"
                }`}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  showPreview(landCard, { left: r.left, right: r.right, top: r.top, bottom: r.bottom });
                }}
                onMouseLeave={clearPreview}
              />
            ) : (
              <ManaSymbol symbol={sym} className="pointer-events-none h-5 w-5 shrink-0" />
            )}
            <span className={`min-w-6 text-center text-xs font-bold tabular-nums ${n > 0 ? "text-zinc-100" : "text-zinc-600"}`}>
              x{n}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded bg-white/[0.06] text-xs font-bold text-zinc-300 transition-colors duration-150 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-30"
              disabled={n === 0}
              onClick={() => removeBasicCopy(name)}
              aria-label={`Remove ${name}`}
            >
              −
            </button>
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded bg-white/[0.06] text-xs font-bold text-zinc-300 transition-colors duration-150 hover:bg-white/15"
              onClick={() => setBasics((b) => ({ ...b, [name]: (b[name] ?? 0) + 1 }))}
              aria-label={`Add ${name}`}
            >
              +
            </button>
          </div>
        );
      })}
    </div>
  );

  const deckStatsPanel = (): JSX.Element => (
    <div
      id="deckbuilder-deck-stats"
      className="deckbuilder-deck-stats-panel absolute inset-0 z-30 flex min-h-0 flex-col overflow-hidden p-3"
    >
      <div className="mb-2 flex shrink-0 items-center gap-2 px-1 py-0.5">
        <span className="text-[10px] font-black uppercase tracking-[0.12em] text-amber-200">Deck Stats</span>
        <div className="flex-1" />
        <button
          type="button"
          className="rounded-md p-1 text-zinc-400 transition-colors duration-150 hover:bg-white/5 hover:text-amber-200"
          onClick={() => setDeckStatsOpen(false)}
          aria-label="Close deck stats"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
            <path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
          </svg>
        </button>
      </div>
      <div className="deckbuilder-deck-stats-grid grid min-h-0 flex-1 grid-cols-2 gap-2">
        <div className="panel-inset p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Main deck</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-lg font-black tabular-nums text-amber-200">{deckCount}</div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Cards</div>
            </div>
            <div>
              <div className="text-lg font-black tabular-nums text-zinc-200">{mainSpells.length}</div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Nonlands</div>
            </div>
            <div>
              <div className="text-lg font-black tabular-nums text-zinc-200">{landsCount}</div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Lands</div>
            </div>
          </div>
        </div>
        <TypeCounts main={statsMain} cards={statsCards} label="Types" />
        <CurveChart counts={curveCounts} />
        <ColorSplit main={statsMain} cards={statsCards} label="Mana colors" showEmpty showLands={false} />
        <ManaSources main={main} cards={cards} basics={basics} />
        <div className="panel-inset p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Deck composition</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-lg font-black tabular-nums text-emerald-300">{creatureCount}</div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Creatures</div>
            </div>
            <div>
              <div className="text-lg font-black tabular-nums text-sky-300">{nonCreatureCount}</div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Non-creatures</div>
            </div>
            <div>
              <div className="text-lg font-black tabular-nums text-amber-200">{landsCount}</div>
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Lands</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="deckbuilder-scene flex h-full w-full animate-fade-in flex-col gap-2 p-2">
      {myLiveMatch && (
        <div className="panel flex shrink-0 flex-wrap items-center justify-between gap-3 border-brass-400/40 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-zinc-200">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Your match against{" "}
            <span className="font-bold">
              {room.players.find((p) => p.id === myLiveMatch.playerIds.find((id) => id !== me.playerId))?.name ?? "your opponent"}
            </span>{" "}
            is still in progress.
          </div>
          <button type="button" className="btn-primary !py-1.5 !text-xs" onClick={() => dispatch({ type: "rejoinGame" })}>
            Return to match
          </button>
        </div>
      )}
      {/* Ranked: decks lock on the server's 5-minute deadline (no live deadline in the contract). */}
      {ranked && !submitted && (
        <div className="panel flex shrink-0 flex-wrap items-center gap-3 border-brass-400/40 px-4 py-2">
          <span className="chip border-brass-400/60 font-black tracking-widest text-brass-300">RANKED</span>
          <span className="text-xs text-zinc-300">
            Decks auto-submit after 5 minutes — lock yours in before the clock does it for you.
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        {/* Pool on top + deck strip along the bottom */}
        <main ref={deckWorkspaceRef} className="flex min-w-0 flex-1 flex-col gap-0">
          {/* Pool */}
          <section
            className="deckbuilder-pool panel flex min-h-0 flex-1 flex-col"
            onDragOver={allowDrag}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) moveTo(id, "pool");
            }}
          >
            {/* Arena-style filter bar */}
            <div className="relative grid shrink-0 grid-cols-[max-content_minmax(9rem,1fr)_max-content] items-start gap-2 px-3 py-2">
              <div className="flex items-start gap-2">
                <input
                  className="input !w-48 !py-1.5 text-xs"
                  placeholder="Search name, type, text…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search the pool"
                />
                <div className="flex items-center gap-1">
                {FILTER_PIPS.map((b) => {
                  const active = colorPips.has(b);
                  return (
                    <button
                      key={b}
                      type="button"
                      onClick={() => togglePip(b)}
                      className={`flex h-6 w-6 items-center justify-center rounded-full transition-all duration-150 ${
                        active ? "shadow-glow-soft ring-1 ring-amber-300/80" : "opacity-100 saturate-100 hover:brightness-110"
                      }`}
                      title={b === "C" ? "Colorless" : b}
                      aria-pressed={active}
                    >
                      <ManaSymbol symbol={b} className="pointer-events-none h-6 w-6" />
                    </button>
                  );
                })}
              <div ref={typeMenuRef} className="relative flex h-6 w-6 items-center justify-center">
                <button
                  type="button"
                  className={`relative flex h-[22px] w-[22px] items-center justify-center rounded-full border-0 transition-all duration-150 ${
                    typeChips.size > 0
                      ? "bg-zinc-200 text-zinc-950 shadow-[0_0_9px_rgba(251,191,36,0.32)]"
                      : "bg-zinc-200 text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] hover:bg-white"
                  }`}
                  onClick={() => setTypeMenuOpen((open) => !open)}
                  aria-label="Filter by card type"
                  aria-expanded={typeMenuOpen}
                  title="Card type filters"
                >
                  <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" aria-hidden="true">
                    <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="15.5" cy="6" r="2.25" fill="currentColor" />
                    <circle cx="8.5" cy="12" r="2.25" fill="currentColor" />
                    <circle cx="14" cy="18" r="2.25" fill="currentColor" />
                  </svg>
                  {typeChips.size > 0 && (
                    <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-black/70 bg-amber-400 px-1 text-[8px] font-black tabular-nums text-black">
                      {typeChips.size}
                    </span>
                  )}
                </button>
                {typeMenuOpen && (
                  <div className="absolute left-0 top-[calc(100%+0.45rem)] z-50 w-48 rounded-xl border border-amber-200/35 bg-[linear-gradient(155deg,rgba(25,23,24,0.98),rgba(5,7,11,0.98))] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_28px_rgba(0,0,0,0.65)] backdrop-blur-xl">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[9px] font-black uppercase tracking-[0.12em] text-amber-200">Card Types</span>
                      {typeChips.size > 0 && (
                        <button
                          type="button"
                          className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 transition-colors hover:text-amber-200"
                          onClick={() => setTypeChips(new Set())}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {TYPE_CHIPS.map((type) => {
                        const active = typeChips.has(type);
                        return (
                          <button
                            key={type}
                            type="button"
                            onClick={() => toggleType(type)}
                            className={`rounded-md border px-2 py-1.5 text-left text-[10px] font-bold transition-all duration-150 ${
                              active
                                ? "border-amber-300/65 bg-amber-300/16 text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]"
                                : "border-white/10 bg-white/[0.025] text-zinc-400 hover:border-white/20 hover:text-zinc-100"
                            }`}
                            aria-pressed={active}
                          >
                            {type}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                </div>
                </div>
                {hasFilters && (
                  <button
                    type="button"
                    className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300/60 bg-zinc-600 text-[11px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] transition-colors duration-150 hover:border-red-300/70 hover:bg-red-700 hover:text-red-50"
                    onClick={clearFilters}
                    title="Clear all filters"
                    aria-label="Clear all filters"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="flex min-w-0 items-start justify-center">
                <button
                  type="button"
                  className={`deckbuilder-done-button deckbuilder-toolbar-done !min-h-0 w-36 shrink-0 !py-1 !text-base ${deckCount >= 40 ? "is-valid" : ""}`}
                  disabled={submitting || main.length === 0}
                  onClick={() => void submitDeck()}
                >
                  {submitting ? "Submitting…" : submitted ? "Resubmit Deck" : "Done"}
                </button>
              </div>
              <div className="flex shrink-0 items-start gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-full border border-amber-300/55 bg-gradient-to-b from-amber-300/20 to-orange-700/20 px-3 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_0_12px_rgba(249,115,22,0.16)] transition-all hover:border-amber-200 hover:brightness-110"
                    onClick={() => {
                      setBasics(suggestBasicLands(main, cards));
                      pushToast("Basic lands balanced", "success");
                    }}
                    title="Balance basic lands to the deck's colored mana needs"
                  >
                    Suggest Lands
                  </button>
                  <div className="flex items-center rounded-full border border-amber-200/25 bg-black/20 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" aria-label="Main deck view">
                    {(["list", "cards"] as const).map((view) => (
                      <button
                        key={view}
                        type="button"
                        className={`rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-[0.07em] transition-all duration-150 ${
                          deckView === view
                            ? "bg-gradient-to-b from-amber-200/25 to-orange-700/25 text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_0_8px_rgba(249,115,22,0.12)]"
                            : "text-zinc-500 hover:text-zinc-200"
                        }`}
                        onClick={() => selectDeckView(view)}
                        aria-pressed={deckView === view}
                      >
                        {view === "list" ? "List" : "Cards"}
                      </button>
                    ))}
                  </div>
                </div>
                <div
                  className={`deckbuilder-card-view-deck-header ${deckView === "cards" ? "is-open" : "is-closed"}`}
                  aria-hidden={deckView !== "cards"}
                >
                  <div className="deckbuilder-card-view-deck-header-inner">
                    {deckHeader()}
                  </div>
                </div>
              </div>
            </div>
            {/* Pool grid */}
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <div className="scrollbar-slim h-full overflow-y-auto p-3">
                {pool.length === 0 ? (
                  <div className="py-8 text-center text-xs text-zinc-400">
                    <FannedCardsIcon className="mx-auto mb-2 h-12 w-[4.125rem] opacity-60" />
                    <div className="font-bold uppercase tracking-[0.1em] text-amber-200/80">Sideboard</div>
                    <div className="mx-auto mt-1 max-w-md leading-relaxed text-zinc-400">
                      Cards placed in the sideboard during the draft start here. Any cards removed from your main deck will join them.
                    </div>
                  </div>
                ) : shownPool.length === 0 ? (
                  <div className="py-10 text-center text-xs text-zinc-400">
                    No cards match these filters.
                  </div>
                ) : (
                  <div ref={sideboardGridHostRef}>
                    <CardGrid min={160} columns={deckView === "cards" ? 8 : 6} className="!justify-start !justify-items-start">
                      {shownPool.map((dc) => (
                        <Card
                          key={dc.instanceId}
                          data={cards[dc.cardId]}
                          size="md"
                          className="!w-[160px]"
                          disableHoverMotion
                          previewPlacement={deckView === "cards" ? "above" : "side"}
                          draggable
                          onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, dc.instanceId)}
                          onClick={() => moveTo(dc.instanceId, "main")}
                          title="Click to add to your deck"
                        />
                      ))}
                    </CardGrid>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Main-deck card columns */}
          <section
            className={`deckbuilder-card-tray relative z-20 flex shrink-0 flex-col overflow-hidden ${
              deckView === "cards" ? "is-open" : "is-closed"
            }`}
            style={{ height: deckView === "cards" ? stripH : 0 }}
            aria-hidden={deckView !== "cards"}
            onDragOver={allowDrag}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) moveTo(id, "main");
            }}
            >
              {stripHandle}
              {mainEntries.length === 0 && basicListEntries.length === 0 && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-center text-xs font-semibold text-[#372a1d] drop-shadow-[0_1px_0_rgba(255,245,220,0.5)]">
                  Drag or click cards here to build your deck.
                </div>
              )}
              <div
                ref={mainboardScrollRef}
                className="deckbuilder-mainboard-scroll scrollbar-slim min-h-0 min-w-0 w-full max-w-full flex-1 overflow-x-auto overflow-y-hidden"
                tabIndex={0}
                aria-label="Mainboard card columns"
                onDragOver={(event) => {
                  const scroller = event.currentTarget;
                  const bounds = scroller.getBoundingClientRect();
                  const edgeSize = 72;
                  if (event.clientX < bounds.left + edgeSize) scroller.scrollLeft -= 18;
                  else if (event.clientX > bounds.right - edgeSize) scroller.scrollLeft += 18;
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  event.currentTarget.scrollBy({
                    left: event.key === "ArrowLeft" ? -172 : 172,
                    behavior: "smooth",
                  });
                }}
              >
                <div className="flex h-full w-max min-w-full gap-0 px-3 pb-3 pt-3">
                  {columnOrder.map((column, index) => {
                    const previousColumn = index > 0 ? columnOrder[index - 1] : null;
                    const gapKey = previousColumn ? `${previousColumn}:${column}` : null;
                    const preparedGap = gapKey && pendingColumnGap?.key === gapKey ? pendingColumnGap : null;
                    return (
                      <div key={column} className="contents">
                        {gapKey && (
                          <div
                            className={`deckbuilder-column-gap flex h-full shrink-0 items-center justify-center overflow-hidden transition-[width,border-color,background-color] duration-200 ${
                              preparedGap
                                ? "is-prepared w-[160px] border border-amber-300/55 bg-amber-300/[0.06]"
                                : "w-3 border-x border-transparent hover:border-amber-300/30 hover:bg-amber-300/[0.03]"
                            }`}
                            onDragEnter={(event) => {
                              event.preventDefault();
                              beginColumnGapHold(gapKey, index);
                            }}
                            onDragOver={(event) => event.preventDefault()}
                            onDragLeave={() => leaveColumnGap(gapKey)}
                            onDrop={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              dropIntoNewColumn(
                                event.dataTransfer.getData(DRAG_MIME),
                                index,
                                preparedGap?.columnId,
                              );
                            }}
                            title="Hold a card here to create a column"
                          >
                            {preparedGap && (
                              <span className="pointer-events-none text-3xl font-light text-amber-200/75">+</span>
                            )}
                          </div>
                        )}
                        <StackColumn
                          entries={columnEntries.get(column) ?? []}
                          cards={statsCards}
                          width={column === "lands" ? landsW : cardW}
                          className={column.startsWith("custom-") ? "deckbuilder-column-created" : ""}
                          arrivingInstanceId={arrivingColumnCardId}
                          isOver={dragCol === `column-${column}`}
                          onHoverChange={(over) => setDragCol(over ? `column-${column}` : null)}
                          onDropCard={(id) => moveToColumn(id, column)}
                          onEntryClick={(id) => {
                            const basicName = basicNameFromInstanceId(id);
                            if (basicName) removeBasicCopy(basicName, id);
                            else moveTo(id, "pool");
                          }}
                          clickTitle="Click to return to the pool"
                        />
                      </div>
                    );
                  })}
                  <div className="w-3 shrink-0" />
                  <div
                    className="h-full w-[160px] shrink-0 bg-transparent"
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setDragCol("new-column");
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setDragCol(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDragCol(null);
                      dropIntoNewColumn(event.dataTransfer.getData(DRAG_MIME), columnOrder.length);
                    }}
                    title="Drop a card here to create a new column"
                  />
                </div>
              </div>
          </section>
        </main>

        {/* Right rail */}
        <aside className={`deckbuilder-arena-rail flex shrink-0 flex-col overflow-hidden ${deckView === "list" ? "is-list-view w-[21rem] min-[1500px]:w-[24rem]" : "is-card-view w-0"}`}>
          <section
            className="panel draft-list-zone deckbuilder-main-list relative flex min-h-0 flex-1 flex-col overflow-hidden"
            onDragOver={allowDrag}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData(DRAG_MIME);
              if (id) moveTo(id, "main");
            }}
          >
            {deckHeader()}
            <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto py-2 pr-2 pl-0">
              <div className="rounded-lg">
              {mainEntries.length === 0 && basicListEntries.length === 0 ? (
                <div className="py-8 text-center text-xs font-semibold text-[#372a1d] drop-shadow-[0_1px_0_rgba(255,245,220,0.5)]">
                  Drag or click cards here to build your deck.
                </div>
              ) : (
                <>
                  {mainEntries.map((entry) => (
                    <DeckRailRow
                      key={entry.cardId}
                      entry={entry}
                      data={cards[entry.cardId]}
                      onClick={(id) => moveTo(id, "pool")}
                      clickTitle="Click to return one copy to the pool"
                    />
                  ))}
                  {basicListEntries.map(({ name, data, entry }) => (
                    <DeckRailRow
                      key={name}
                      entry={entry}
                      data={data}
                      draggable={false}
                      onClick={() => setBasics((current) => ({
                        ...current,
                        [name]: Math.max(0, (current[name] ?? 0) - 1),
                      }))}
                      clickTitle={`Click to remove one ${name}`}
                    />
                  ))}
                </>
              )}
              </div>
            </div>
          </section>

          <details className="hidden deckbuilder-rail-drawer shrink-0">
            <summary>Sideboard · {side.length}</summary>
            <div
              className="scrollbar-slim max-h-48 space-y-1 overflow-y-auto p-2"
              onDragOver={allowDrag}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData(DRAG_MIME);
                if (id) moveTo(id, "side");
              }}
            >
              {sideEntries.length === 0 ? (
                <div className="py-4 text-center text-[11px] text-zinc-500">Drop cards here for your sideboard.</div>
              ) : sideEntries.map((entry) => (
                <DeckRailRow
                  key={entry.cardId}
                  entry={entry}
                  data={cards[entry.cardId]}
                  onClick={(id) => moveTo(id, "pool")}
                  clickTitle="Click to return one copy to the pool"
                />
              ))}
            </div>
          </details>

          <details className="hidden deckbuilder-rail-drawer shrink-0">
            <summary>Basic lands · {basicsTotal}</summary>
            <div className="px-2 pb-2">{basicsFooter}</div>
          </details>

          <details className="hidden deckbuilder-rail-drawer shrink-0">
            <summary>Deck stats</summary>
            <div className="space-y-2 p-2">
              <CurveChart counts={curveCounts} />
              <ColorSplit main={main} cards={cards} label="Colors (deck)" />
            </div>
          </details>

          <details className="hidden deckbuilder-rail-drawer shrink-0">
            <summary>Players ready · {room.decksSubmitted.length}/{room.players.length}</summary>
            <div className="p-3">
              <ul className="space-y-1">
                {room.players.map((p) => {
                  const done = room.decksSubmitted.includes(p.id);
                  return (
                    <li key={p.id} className="flex items-center gap-2 text-xs">
                      {done ? (
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-emerald-400"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" /></svg>
                      ) : (
                        <span className="h-3.5 w-3.5 animate-pulse rounded-full border border-zinc-600" />
                      )}
                      <span className={done ? "text-zinc-200" : "text-zinc-500"}>
                        {p.name}
                        {p.id === me.playerId && " (you)"}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {submitted && room.decksSubmitted.length < room.players.length && (
                <p className="mt-2 text-[11px] text-zinc-500">Waiting for the others to finish…</p>
              )}
            </div>
          </details>

          {/* Host: pair matches (ranked rooms auto-pair on the server) */}
          {isHost && !ranked && (
            <div className="panel hidden shrink-0 border-brass-400/30 p-3">
              <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-brass-300">Pair a match</h2>
              <div className="mb-2 grid grid-cols-2 gap-2">
                <select className="input !py-1.5 text-xs" value={pairA} onChange={(e) => setPairA(e.target.value)}>
                  <option value="">Player A…</option>
                  {room.players.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {room.decksSubmitted.includes(p.id) ? "" : " (no deck)"}
                    </option>
                  ))}
                </select>
                <select className="input !py-1.5 text-xs" value={pairB} onChange={(e) => setPairB(e.target.value)}>
                  <option value="">Player B…</option>
                  {room.players.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {room.decksSubmitted.includes(p.id) ? "" : " (no deck)"}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="btn-primary w-full !text-xs"
                disabled={!pairA || !pairB || pairA === pairB}
                onClick={() => void startMatch()}
              >
                Start match
              </button>
            </div>
          )}

          {/* Match list */}
          {room.matches.length > 0 && (
            <div className="panel hidden shrink-0 p-3">
              <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Matches</h2>
              <ul className="space-y-1.5">
                {room.matches.map((m) => (
                  <li key={m.id} className="rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-zinc-200">
                        {nameOfPlayer(m.playerIds[0])} <span className="text-zinc-500">vs</span> {nameOfPlayer(m.playerIds[1])}
                      </span>
                      {m.finished ? (
                        <span className="chip border-brass-400/40 text-brass-300">
                          {m.winnerId ? `${nameOfPlayer(m.winnerId)} won` : "Draw"}
                        </span>
                      ) : (
                        <span className="chip border-emerald-400/40 text-emerald-300">live</span>
                      )}
                    </div>
                    {!m.finished && (
                      <button type="button" className="mt-1 text-[10px] text-zinc-600" disabled title="Spectating arrives in a future version">
                        Spectate (soon)
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ChatPanel className="hidden h-64 shrink-0" />

        </aside>
      </div>
      {deckStatsOpen && deckStatsPanel()}
    </div>
  );
}
