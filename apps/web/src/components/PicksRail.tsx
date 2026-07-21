/**
 * Right rail on the Draft screen: live stats for the current main picks
 * (type counts with creature-subtype breakdown, mana curve, color split) and,
 * in "List" view, a compact names-only picks list grouped by lane with
 * hover-anchored card previews plus click/drag movement between the main deck
 * and sideboard.
 */
import { useMemo, useState, type DragEvent } from "react";
import type { CardData, Color, DraftCard } from "@mtg-cube/shared";
import { CurveChart } from "./CurveChart";
import { useCardPreview } from "./Card";
import { AUTO_LANE, ViewToggle, type PackPickDrop } from "./PicksTray";
import { getPackPickInstanceId } from "../lib/dnd";
import {
  cmcBucket,
  colorBucket,
  compareByCmcName,
  parseManaCost,
  primaryType,
  type ColorBucket,
} from "../lib/cards";
import { ManaSymbol } from "./ManaSymbol";
import { SIDEBOARD_LANE_ID, defaultLaneId, type DraftLanes } from "../lib/draftLanes";

const DRAG_MIME = "text/plain";

const TYPE_ORDER = ["Creature", "Planeswalker", "Instant", "Sorcery", "Artifact", "Enchantment", "Battle", "Land", "Other"];
const TYPE_PLURALS: Record<string, string> = {
  Creature: "Creatures",
  Planeswalker: "Planeswalkers",
  Instant: "Instants",
  Sorcery: "Sorceries",
  Artifact: "Artifacts",
  Enchantment: "Enchantments",
  Battle: "Battles",
  Land: "Lands",
  Other: "Other",
};

const LIST_ROW_COLOR: Record<ColorBucket, string> = {
  W: "border-[#b99a26]",
  U: "border-[#147fbd]",
  B: "border-[#5f5268]",
  R: "border-[#df482f]",
  G: "border-[#168552]",
  M: "border-[#a77d12]",
  C: "border-[#68727a]",
  L: "border-[#775032]",
};

const LIST_FILL_COLOR: Record<ColorBucket, string> = {
  W: "#eee6bd",
  U: "#82bedf",
  B: "#a9a0ae",
  R: "#eba18b",
  G: "#a5d0ba",
  M: "#d9c06b",
  C: "#c8cbcd",
  L: "#bda185",
};

const LIST_BORDER_FILL_COLOR: Record<ColorBucket, string> = {
  W: "#b99a26",
  U: "#147fbd",
  B: "#5f5268",
  R: "#df482f",
  G: "#168552",
  M: "#a77d12",
  C: "#68727a",
  L: "#775032",
};

const LAND_TYPE_COLORS: ReadonlyArray<readonly [string, Color]> = [
  ["Plains", "W"],
  ["Island", "U"],
  ["Swamp", "B"],
  ["Mountain", "R"],
  ["Forest", "G"],
];

/** Colors a list row should communicate, including lands' usable/fetchable mana. */
function listRowColors(data: CardData | undefined): Color[] {
  if (!data) return [];
  const printed = data.colors.length > 0 ? data.colors : data.colorIdentity;
  if (!data.typeLine.toLowerCase().includes("land")) return printed;

  const oracle = [data.oracleText, ...(data.faces?.map((face) => face.oracleText) ?? [])]
    .filter((text): text is string => Boolean(text))
    .join(" ");

  // Fetch lands have no rules color identity, so use the basic land types
  // named in their search instruction (Misty Rainforest => Island + Forest).
  if (/search your library/i.test(oracle)) {
    const fetchColors = LAND_TYPE_COLORS
      .filter(([landType]) => new RegExp(`\\b${landType}\\b`, "i").test(oracle))
      .map(([, color]) => color);
    if (fetchColors.length > 0) return fetchColors;
  }

  const produced = LAND_TYPE_COLORS
    .map(([, color]) => color)
    .filter((color) => data.producedMana?.includes(color));
  return produced.length > 0 ? produced : printed;
}

/** Creature subtypes: the words after the em-dash on the first face's type line. */
function creatureSubtypes(data: CardData): string[] {
  const first = data.typeLine.split(" // ")[0] ?? data.typeLine;
  const dash = first.indexOf("—");
  if (dash === -1) return [];
  return first
    .slice(dash + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function TypeCounts({ main, cards }: { main: DraftCard[]; cards: Record<string, CardData> }): JSX.Element {
  const { typeRows, subtypeRows, more } = useMemo(() => {
    const typeCounts = new Map<string, number>();
    const subCounts = new Map<string, number>();
    for (const pick of main) {
      const data = cards[pick.cardId];
      const t = primaryType(data);
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
      if (t === "Creature" && data) {
        for (const sub of creatureSubtypes(data)) {
          subCounts.set(sub, (subCounts.get(sub) ?? 0) + 1);
        }
      }
    }
    const typeRows = TYPE_ORDER.filter((t) => typeCounts.has(t)).map((t) => ({
      type: t,
      count: typeCounts.get(t) ?? 0,
    }));
    const sorted = [...subCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { typeRows, subtypeRows: sorted.slice(0, 8), more: sorted.length > 8 };
  }, [main, cards]);

  return (
    <div className="panel-inset p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Types (main)</div>
      {typeRows.length === 0 ? (
        <div className="text-[11px] text-zinc-500">No picks yet.</div>
      ) : (
        <ul className="space-y-0.5 text-xs">
          {typeRows.map(({ type, count }) => (
            <li key={type}>
              <div className="flex items-baseline justify-between">
                <span className="font-semibold text-zinc-200">{TYPE_PLURALS[type] ?? type}</span>
                <span className="font-bold tabular-nums text-brass-300">{count}</span>
              </div>
              {type === "Creature" && subtypeRows.length > 0 && (
                <div className="ml-3 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] leading-tight text-zinc-400">
                  {subtypeRows.map(([sub, n]) => (
                    <span key={sub}>
                      {sub} <span className="tabular-nums text-zinc-500">x{n}</span>
                    </span>
                  ))}
                  {more && <span className="text-zinc-600">…</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ColorSplit({
  main,
  cards,
  label = "Mana colors (main)",
}: {
  main: DraftCard[];
  cards: Record<string, CardData>;
  label?: string;
}): JSX.Element | null {
  const counts = useMemo(() => {
    const map = new Map<ColorBucket, number>();
    const manaColors: ColorBucket[] = ["W", "U", "B", "R", "G"];
    for (const pick of main) {
      const data = cards[pick.cardId];
      if (data?.typeLine.toLowerCase().includes("land")) {
        map.set("L", (map.get("L") ?? 0) + 1);
        continue;
      }

      // Count every distinct color that appears in the mana cost. A card with
      // {5}{G}{W}, repeated colored pips, or hybrid pips contributes once to
      // each represented color rather than being collapsed into Multicolor.
      const represented = new Set<ColorBucket>();
      for (const symbol of parseManaCost(data?.manaCost)) {
        for (const color of manaColors) {
          if (symbol.includes(color)) represented.add(color);
        }
      }

      if (represented.size === 0) represented.add("C");
      for (const color of represented) {
        map.set(color, (map.get(color) ?? 0) + 1);
      }
    }
    return map;
  }, [main, cards]);

  const order: ColorBucket[] = ["W", "U", "B", "R", "G", "C", "L"];
  const shown = order.filter((b) => (counts.get(b) ?? 0) > 0);
  if (shown.length === 0) return null;

  return (
    <div className="panel-inset p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">{label}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {shown.map((b) => (
          <span key={b} className="flex items-center gap-1">
            {b === "W" || b === "U" || b === "B" || b === "R" || b === "G" || b === "C" ? (
              <ManaSymbol symbol={b} className="h-5 w-5" />
            ) : (
              // "L" (lands) has no mana symbol — keep the orange letter pip.
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-orange-500/40 bg-orange-900 text-[10px] font-black text-orange-200 shadow-card">
                {b}
              </span>
            )}
            <span className="text-xs font-bold tabular-nums text-zinc-200">{counts.get(b) ?? 0}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ListRow({
  pick,
  data,
  onDragStart,
  onClick,
  moveLabel,
}: {
  pick: DraftCard;
  data: CardData | undefined;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onClick: () => void;
  moveLabel: string;
}): JSX.Element {
  const { showPreview, clearPreview } = useCardPreview();
  const bucket = colorBucket(data);
  const pips = parseManaCost(data?.manaCost);
  const cardColors = listRowColors(data);
  // Lands inherit their actual mana role: colorless lands match artifacts,
  // one-color lands use that color, and 3+ color lands use the gold treatment.
  const rowBucket: ColorBucket = bucket === "L"
    ? cardColors.length === 0 ? "C" : cardColors.length === 1 ? cardColors[0]! : cardColors.length > 2 ? "M" : "L"
    : bucket;
  const twoColor = (bucket === "M" || bucket === "L") && cardColors.length === 2;
  const firstColor = cardColors[0] as ColorBucket | undefined;
  const secondColor = cardColors[1] as ColorBucket | undefined;
  const manaFill = twoColor
    ? `linear-gradient(90deg, ${LIST_FILL_COLOR[cardColors[0] as ColorBucket] ?? LIST_FILL_COLOR.M} 0%, ${LIST_FILL_COLOR[cardColors[0] as ColorBucket] ?? LIST_FILL_COLOR.M} 38%, ${LIST_FILL_COLOR[cardColors[1] as ColorBucket] ?? LIST_FILL_COLOR.M} 62%, ${LIST_FILL_COLOR[cardColors[1] as ColorBucket] ?? LIST_FILL_COLOR.M} 100%)`
    : LIST_FILL_COLOR[rowBucket];
  const gloss = "linear-gradient(180deg, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0.04) 38%, rgba(0,0,0,0.12) 100%)";
  const borderFill = twoColor
    ? `linear-gradient(90deg, ${LIST_BORDER_FILL_COLOR[firstColor ?? "M"]} 0%, ${LIST_BORDER_FILL_COLOR[firstColor ?? "M"]} 38%, ${LIST_BORDER_FILL_COLOR[secondColor ?? "M"]} 62%, ${LIST_BORDER_FILL_COLOR[secondColor ?? "M"]} 100%)`
    : null;
  const rowFill = borderFill
    ? `${gloss} padding-box, ${manaFill} padding-box, ${borderFill} border-box`
    : `${gloss}, ${manaFill}`;
  return (
    <div
      draggable
      onDragStart={(e) => {
        clearPreview();
        onDragStart(e);
      }}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showPreview(data, { left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }}
      onMouseLeave={clearPreview}
      onClick={() => {
        clearPreview();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        clearPreview();
        onClick();
      }}
      role="button"
      tabIndex={0}
      aria-label={`${moveLabel}: ${data?.name ?? pick.cardId}`}
      className={`draft-list-card-row relative my-[3px] ml-2 flex min-h-[25px] cursor-pointer items-center rounded-[8px] border-[3px] pl-5 pr-1 text-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.28),inset_0_-1px_0_rgba(0,0,0,0.18),0_2px_3px_rgba(0,0,0,0.78)] ring-1 ring-black/90 transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.34),inset_0_-1px_0_rgba(0,0,0,0.2),0_3px_6px_rgba(0,0,0,0.88)] active:cursor-grabbing ${LIST_ROW_COLOR[rowBucket]}`}
      style={{ background: rowFill, borderColor: borderFill ? "transparent" : undefined }}
      title={`${data?.name ?? pick.cardId} — ${moveLabel}`}
    >
      <span className="absolute -left-[7px] top-1/2 z-10 flex h-[21px] w-[21px] -translate-y-1/2 items-center justify-center rounded-full border border-amber-100/55 bg-gradient-to-br from-zinc-600 via-zinc-800 to-zinc-950 text-[8px] font-black tabular-nums text-zinc-50 shadow-[inset_0_1px_1px_rgba(255,255,255,0.35),0_1px_3px_rgba(0,0,0,0.9),0_0_0_1px_rgba(0,0,0,0.75)]">
        1×
      </span>
      <span className="draft-list-card-name min-w-0 flex-1 truncate text-[12px] font-bold leading-none tracking-[-0.018em] text-black">{data?.name ?? "…"}</span>
      <span className="ml-1 flex shrink-0 items-center gap-px">
        {pips.slice(0, 6).map((s, i) => (
          <span
            key={`${s}-${i}`}
            className="inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full bg-black/12 shadow-[inset_0_1px_1px_rgba(0,0,0,0.42),inset_0_-1px_1px_rgba(255,255,255,0.2)] ring-1 ring-black/25"
          >
            <ManaSymbol symbol={s} className="h-3.5 w-3.5" />
          </span>
        ))}
      </span>
    </div>
  );
}

function PicksList({
  cards,
  lanesApi,
  view,
  onView,
  onPackPick,
}: {
  cards: Record<string, CardData>;
  lanesApi: DraftLanes;
  view: "cards" | "list";
  onView: (v: "cards" | "list") => void;
  onPackPick?: PackPickDrop;
}): JSX.Element {
  const [dragOver, setDragOver] = useState<string | null>(null);
  const allPicks = [...lanesApi.grouped.values()].flat();
  const sidePicks = [...(lanesApi.grouped.get(SIDEBOARD_LANE_ID) ?? [])].sort((a, b) =>
    compareByCmcName(cards[a.cardId], cards[b.cardId])
  );
  const mainPicks = allPicks
    .filter((pick) => lanesApi.laneOf(pick) !== SIDEBOARD_LANE_ID)
    .sort((a, b) => {
      const aData = cards[a.cardId];
      const bData = cards[b.cardId];
      const aLand = aData?.typeLine.toLowerCase().includes("land") ?? false;
      const bLand = bData?.typeLine.toLowerCase().includes("land") ?? false;
      if (aLand !== bLand) return aLand ? 1 : -1;
      const aX = parseManaCost(aData?.manaCost).some((symbol) => symbol.toUpperCase() === "X");
      const bX = parseManaCost(bData?.manaCost).some((symbol) => symbol.toUpperCase() === "X");
      if (aX !== bX) return aX ? 1 : -1;
      return compareByCmcName(aData, bData);
    });
  const total = allPicks.length;

  const dropOnMain = (instanceId: string): void => {
    const pick = allPicks.find((candidate) => candidate.instanceId === instanceId);
    if (pick) lanesApi.moveCard(instanceId, defaultLaneId(cards[pick.cardId]?.cmc));
  };

  return (
    <div className="panel draft-list-zone flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Your picks</span>
        <span className="chip">{total}</span>
        <div className="flex-1" />
        <ViewToggle view={view} onView={onView} />
      </div>
      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-2">
        {total === 0 && (
          <div className="rounded-lg border border-dashed border-amber-100/15 py-4 text-center text-[11px] text-zinc-500">
            No picks yet.
          </div>
        )}
        <div
          className={`rounded-lg transition-colors duration-100 ${dragOver === "main" ? "bg-brass-400/10 ring-1 ring-brass-400/50" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver("main");
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            const packId = getPackPickInstanceId(e.dataTransfer);
            if (packId) onPackPick?.(packId, AUTO_LANE);
            else {
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) dropOnMain(id);
            }
          }}
        >
          {mainPicks.map((pick) => (
            <ListRow
              key={pick.instanceId}
              pick={pick}
              data={cards[pick.cardId]}
              onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, pick.instanceId)}
              onClick={() => lanesApi.moveCard(pick.instanceId, SIDEBOARD_LANE_ID)}
              moveLabel="Move to sideboard"
            />
          ))}
        </div>
        <div
          className={`mt-2 rounded-lg border border-dashed p-1 transition-colors duration-100 ${
            dragOver === SIDEBOARD_LANE_ID ? "border-amber-300/80 bg-amber-400/10" : "border-amber-400/35"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(SIDEBOARD_LANE_ID);
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(null);
            const packId = getPackPickInstanceId(e.dataTransfer);
            if (packId) onPackPick?.(packId, SIDEBOARD_LANE_ID);
            else {
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) lanesApi.moveCard(id, SIDEBOARD_LANE_ID);
            }
          }}
        >
          <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300">
            Sideboard <span className="tabular-nums">· {sidePicks.length}</span>
          </div>
          {sidePicks.map((pick) => (
            <ListRow
              key={pick.instanceId}
              pick={pick}
              data={cards[pick.cardId]}
              onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, pick.instanceId)}
              onClick={() => dropOnMain(pick.instanceId)}
              moveLabel="Move to main deck"
            />
          ))}
          {sidePicks.length === 0 && (
            <div className="px-1 pb-1 text-[10px] text-amber-400/50">Drop cards here to sideboard them.</div>
          )}
        </div>
      </div>
    </div>
  );
}

interface PicksRailProps {
  picks: readonly DraftCard[];
  cards: Record<string, CardData>;
  lanesApi: DraftLanes;
  view: "cards" | "list";
  onView: (v: "cards" | "list") => void;
  open: boolean;
  onToggleOpen: () => void;
  onPackPick?: PackPickDrop;
}

export function PicksRail(props: PicksRailProps): JSX.Element {
  const { picks, cards, lanesApi, view, onView, open, onToggleOpen, onPackPick } = props;

  const main = useMemo(
    () => picks.filter((p) => lanesApi.laneOf(p) !== SIDEBOARD_LANE_ID),
    [picks, lanesApi]
  );

  const curveCounts = useMemo(() => {
    const counts = new Array<number>(8).fill(0);
    for (const pick of main) {
      const data = cards[pick.cardId];
      if (!data || data.typeLine.toLowerCase().includes("land")) continue;
      const b = cmcBucket(data.cmc);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    return counts;
  }, [main, cards]);

  if (!open) {
    return (
      <aside className="draft-sidebar flex w-8 shrink-0 flex-col items-center">
        <button
          type="button"
          className="panel flex flex-col items-center gap-2 px-1.5 py-3 text-zinc-400 transition-colors duration-150 hover:text-brass-300"
          onClick={onToggleOpen}
          title="Show draft stats"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12l4.6-4.6Z" /></svg>
          <span className="text-[9px] font-bold uppercase tracking-widest [writing-mode:vertical-rl]">Stats</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="draft-sidebar flex w-60 shrink-0 flex-col gap-2 pl-2.5 min-[1400px]:w-72">
      <div
        className={`panel draft-stats-zone scrollbar-slim min-h-0 space-y-2 overflow-y-auto p-2 ${view === "list" ? "max-h-[45%] shrink-0" : "flex-1"}`}
      >
        <div className="flex items-center gap-2 px-1 pt-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Draft stats</span>
          <span className="chip">{main.length} main</span>
          <div className="flex-1" />
          <button
            type="button"
            className="rounded p-0.5 text-zinc-500 transition-colors duration-150 hover:text-brass-300"
            onClick={onToggleOpen}
            title="Hide the stats rail"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="M8.6 7.4 10 6l6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6Z" /></svg>
          </button>
        </div>
        <TypeCounts main={main} cards={cards} />
        <CurveChart counts={curveCounts} />
        <ColorSplit main={main} cards={cards} />
      </div>
      {view === "list" && (
        <PicksList cards={cards} lanesApi={lanesApi} view={view} onView={onView} onPackPick={onPackPick} />
      )}
    </aside>
  );
}
