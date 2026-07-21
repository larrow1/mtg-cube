/**
 * Right rail on the Draft screen: live stats for the current main picks
 * (type counts with creature-subtype breakdown, mana curve, color split) and,
 * in "List" view, a compact names-only picks list grouped by lane with
 * hover-anchored card previews and drag-to-move between lanes.
 */
import { useMemo, useState, type DragEvent } from "react";
import type { CardData, DraftCard } from "@mtg-cube/shared";
import { CurveChart } from "./CurveChart";
import { useCardPreview } from "./Card";
import { ViewToggle, type PackPickDrop } from "./PicksTray";
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
import { SIDEBOARD_LANE_ID, isUnnamedDefaultLane, type DraftLanes, type Lane } from "../lib/draftLanes";

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

const NAME_COLOR: Record<ColorBucket, string> = {
  W: "text-yellow-100",
  U: "text-sky-300",
  B: "text-purple-300",
  R: "text-red-300",
  G: "text-green-300",
  M: "text-amber-300",
  C: "text-zinc-300",
  L: "text-orange-300",
};

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
}: {
  pick: DraftCard;
  data: CardData | undefined;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
}): JSX.Element {
  const { showPreview, clearPreview } = useCardPreview();
  const bucket = colorBucket(data);
  const pips = parseManaCost(data?.manaCost);
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
      className="flex min-h-8 cursor-grab items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors duration-100 hover:bg-white/[0.07] active:cursor-grabbing"
      title={data?.name ?? pick.cardId}
    >
      <span className="flex shrink-0 items-center gap-[1px]">
        {pips.slice(0, 6).map((s, i) => (
          <ManaSymbol key={`${s}-${i}`} symbol={s} className="h-4 w-4" />
        ))}
      </span>
      <span className={`truncate text-sm font-medium ${NAME_COLOR[bucket]}`}>{data?.name ?? "…"}</span>
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
  const sideboardLane: Lane = { id: SIDEBOARD_LANE_ID, name: "Sideboard" };
  const laneList: Lane[] = [...lanesApi.lanes, sideboardLane];
  const total = [...lanesApi.grouped.values()].reduce((a, arr) => a + arr.length, 0);

  return (
    <div className="panel draft-list-zone flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Your picks</span>
        <span className="chip">{total}</span>
        <div className="flex-1" />
        <ViewToggle view={view} onView={onView} />
      </div>
      <div className="scrollbar-slim min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {total === 0 && (
          <div className="rounded-lg border border-dashed border-amber-100/15 py-4 text-center text-[11px] text-zinc-500">
            No picks yet.
          </div>
        )}
        {laneList.map((lane) => {
          const picks = [...(lanesApi.grouped.get(lane.id) ?? [])].sort((a, b) =>
            compareByCmcName(cards[a.cardId], cards[b.cardId])
          );
          const isSide = lane.id === SIDEBOARD_LANE_ID;
          if (picks.length === 0 && !isSide) return null;
          return (
            <div
              key={lane.id}
              className={`rounded-lg p-1 transition-colors duration-100 ${
                isSide
                  ? `border border-dashed ${dragOver === lane.id ? "border-amber-300/80 bg-amber-400/10" : "border-amber-400/35"}`
                  : dragOver === lane.id
                    ? "bg-brass-400/10 ring-1 ring-brass-400/50"
                    : ""
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(lane.id);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const packId = getPackPickInstanceId(e.dataTransfer);
                if (packId) {
                  onPackPick?.(packId, lane.id);
                  return;
                }
                const id = e.dataTransfer.getData(DRAG_MIME);
                if (id) lanesApi.moveCard(id, lane.id);
              }}
            >
              {!isSide && isUnnamedDefaultLane(lane) ? (
                // Unnamed default lanes: thin divider instead of a numeric header.
                <div className="mx-1 mb-1 border-t border-amber-100/10" />
              ) : (
                <div className={`flex items-center gap-1.5 px-1 pb-0.5 text-[9px] font-bold uppercase tracking-wider ${isSide ? "text-amber-300" : "text-zinc-500"}`}>
                  {lane.name} <span className="tabular-nums">· {picks.length}</span>
                </div>
              )}
              {picks.map((pick) => (
                <ListRow
                  key={pick.instanceId}
                  pick={pick}
                  data={cards[pick.cardId]}
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, pick.instanceId)}
                />
              ))}
              {picks.length === 0 && isSide && (
                <div className="px-1 pb-1 text-[10px] text-amber-400/50">Drop cards here to sideboard them.</div>
              )}
            </div>
          );
        })}
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
