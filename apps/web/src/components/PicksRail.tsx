/**
 * Right rail on the Draft screen: live stats for the current main picks
 * (type counts with creature-subtype breakdown, mana curve, color split) and,
 * in "List" view, a compact names-only picks list grouped by lane with
 * hover-anchored card previews plus click/drag movement between the main deck
 * and sideboard.
 */
import { useMemo, useState, type DragEvent } from "react";
import type { CardData, Color, DraftCard } from "@mtg-cube/shared";
import "mana-font/css/mana.css";
import { CurveChart } from "./CurveChart";
import { useCardPreview } from "./Card";
import { AUTO_LANE, type PackPickDrop } from "./PicksTray";
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
  W: "border-[#77766e]",
  U: "border-[#087aad]",
  B: "border-[#4c4d52]",
  R: "border-[#a63428]",
  G: "border-[#087149]",
  M: "border-[#8a711d]",
  C: "border-[#5c6468]",
  L: "border-[#876d27]",
};

const LIST_FILL_COLOR: Record<ColorBucket, string> = {
  W: "#ecece6",
  U: "#79c1e3",
  B: "#a7a8a6",
  R: "#e69079",
  G: "#91c8aa",
  M: "#d8c36e",
  C: "#c4c8c8",
  L: "#d4bd72",
};

const LIST_BORDER_FILL_COLOR: Record<ColorBucket, string> = {
  W: "#77766e",
  U: "#087aad",
  B: "#4c4d52",
  R: "#a63428",
  G: "#087149",
  M: "#8a711d",
  C: "#5c6468",
  L: "#876d27",
};

/** Keep every two-color row's blend locked to the center of the card. */
function centeredListGradient(colors: Record<ColorBucket, string>, first: ColorBucket, second: ColorBucket): string {
  return `linear-gradient(90deg, ${colors[first]} 0%, ${colors[first]} 45%, ${colors[second]} 55%, ${colors[second]} 100%)`;
}

const LAND_TYPE_COLORS: ReadonlyArray<readonly [string, Color]> = [
  ["Plains", "W"],
  ["Island", "U"],
  ["Swamp", "B"],
  ["Mountain", "R"],
  ["Forest", "G"],
];

/** Use Scryfall's landscape artwork asset instead of cropping the full card frame. */
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

/** Colors a list row should communicate, including lands' usable/fetchable mana. */
function listRowColors(data: CardData | undefined): Color[] {
  if (!data) return [];
  const printed = data.colors.length > 0 ? data.colors : data.colorIdentity;
  if (!data.typeLine.toLowerCase().includes("land")) {
    // Scryfall's `colors` array uses canonical WUBRG order, which does not
    // necessarily match the mana symbols printed on the card. Build the row
    // gradient from the mana cost first so {2}{R}{G} reads red → green, then
    // append any indicator-only colors that were not represented in the cost.
    const ordered: Color[] = [];
    const add = (color: Color): void => {
      if (!ordered.includes(color)) ordered.push(color);
    };
    for (const symbol of parseManaCost(data.manaCost)) {
      for (const character of symbol.toUpperCase()) {
        if (character === "W" || character === "U" || character === "B" || character === "R" || character === "G") {
          add(character);
        }
      }
    }
    for (const color of printed) add(color);
    return ordered;
  }

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

/** Colorless nonland artifacts stay neutral unless their printed casting cost contains a colored pip. */
function isColorlessArtifact(data: CardData | undefined): boolean {
  if (!data || data.colors.length > 0) return false;
  const typeLine = data.typeLine.toLowerCase();
  if (!typeLine.includes("artifact") || typeLine.includes("land")) return false;
  return !parseManaCost(data.manaCost).some((symbol) => /[WUBRG]/i.test(symbol));
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
  showEmpty = false,
}: {
  main: DraftCard[];
  cards: Record<string, CardData>;
  label?: string;
  showEmpty?: boolean;
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
  if (shown.length === 0 && !showEmpty) return null;

  return (
    <div className="panel-inset p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">{label}</div>
      {shown.length === 0 ? (
        <div className="text-[11px] text-zinc-500">No colors yet.</div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {shown.map((b) => (
            <span key={b} className="flex items-center gap-1">
              {b === "W" || b === "U" || b === "B" || b === "R" || b === "G" || b === "C" ? (
                <ManaSymbol symbol={b} className="h-5 w-5" />
              ) : (
                <i
                  className="ms ms-land ms-fw text-[1.2rem] text-orange-200 drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]"
                  aria-label="Land"
                  title="Land"
                />
              )}
              <span className="text-xs font-bold tabular-nums text-zinc-200">{counts.get(b) ?? 0}</span>
            </span>
          ))}
        </div>
      )}
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
  const bucket = isColorlessArtifact(data) ? "C" : colorBucket(data);
  const pips = parseManaCost(data?.manaCost);
  const cardColors = listRowColors(data);
  const normalizedName = data?.name.trim().toLowerCase();
  const neutralLand = normalizedName === "gemstone mine" || normalizedName === "gemstone caverns";
  // Lands inherit their actual mana role: colorless lands match artifacts,
  // one-color lands use that color, and 3+ color lands use the gold treatment.
  const rowBucket: ColorBucket = neutralLand ? "C" : bucket === "L"
    ? cardColors.length === 0 ? "C" : cardColors.length === 1 ? cardColors[0]! : cardColors.length > 2 ? "M" : "L"
    : bucket;
  const twoColor = !neutralLand && (bucket === "M" || bucket === "L") && cardColors.length === 2;
  const firstColor = cardColors[0] as ColorBucket | undefined;
  const secondColor = cardColors[1] as ColorBucket | undefined;
  const manaFill = twoColor
    ? `linear-gradient(${LIST_FILL_COLOR.M}, ${LIST_FILL_COLOR.M})`
    : LIST_FILL_COLOR[rowBucket];
  const gloss = "linear-gradient(180deg, rgba(255,255,255,0.48) 0%, rgba(255,255,255,0.14) 34%, rgba(255,255,255,0.02) 48%, rgba(0,0,0,0.08) 70%, rgba(0,0,0,0.2) 100%)";
  const borderFill = twoColor
    ? centeredListGradient(LIST_BORDER_FILL_COLOR, firstColor ?? "M", secondColor ?? "M")
    : null;
  const rowFill = borderFill
    ? `${gloss} padding-box, ${manaFill} padding-box, ${borderFill} border-box`
    : `${gloss}, ${manaFill}`;
  return (
    <div
      data-draft-pick-instance={pick.instanceId}
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
      className="draft-list-card-shell group relative my-[2px] ml-7 flex min-h-[27px] cursor-pointer items-center pl-2.5 pr-1.5 text-zinc-950 transition-transform duration-150 hover:-translate-y-px active:cursor-grabbing"
      title={`${data?.name ?? pick.cardId} — ${moveLabel}`}
    >
      <span
        aria-hidden="true"
        className={`draft-list-card-row absolute inset-0 rounded-[10px] border-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.52),inset_0_-2px_1px_rgba(0,0,0,0.24),0_2px_4px_rgba(0,0,0,0.82)] ring-2 ring-black/90 transition-[box-shadow,filter] duration-150 group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.62),inset_0_-2px_1px_rgba(0,0,0,0.26),0_4px_7px_rgba(0,0,0,0.9)] ${LIST_ROW_COLOR[rowBucket]}`}
        style={{ background: rowFill, borderColor: borderFill ? "transparent" : undefined }}
      />
      <span className="absolute -left-[26px] top-1/2 z-10 flex h-[22px] w-[22px] -translate-y-1/2 items-center justify-center rounded-full border-2 border-[#b9bbb7] bg-gradient-to-br from-[#3b3e43] via-[#17191d] to-black text-[8px] font-black tabular-nums text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.28),0_1px_4px_rgba(0,0,0,0.95),0_0_0_1px_rgba(0,0,0,0.9)]">
        1×
      </span>
      <span className="draft-list-card-name min-w-0 flex-1 truncate text-[12px] font-bold leading-none tracking-[-0.018em] text-black">{data?.name ?? "…"}</span>
      <span className="relative z-[3] ml-1 flex shrink-0 items-center gap-px">
        {pips.slice(0, 6).map((s, i) => (
          <span
            key={`${s}-${i}`}
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-full border-[0.5px] border-black"
          >
            <ManaSymbol symbol={s} className="h-[15px] w-[15px] max-w-none drop-shadow-none" />
          </span>
        ))}
      </span>
    </div>
  );
}

function PicksList({
  cards,
  lanesApi,
  onPackPick,
}: {
  cards: Record<string, CardData>;
  lanesApi: DraftLanes;
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
  const compactCurve = new Array<number>(8).fill(0);
  for (const pick of mainPicks) {
    const data = cards[pick.cardId];
    if (!data || data.typeLine.toLowerCase().includes("land")) continue;
    const bucket = cmcBucket(data.cmc);
    compactCurve[bucket] = (compactCurve[bucket] ?? 0) + 1;
  }
  const compactCurveMax = Math.max(1, ...compactCurve);
  const deckCover = mainPicks
    .map((pick) => cards[pick.cardId])
    .find((data) => data?.imageSmall || data?.imageNormal);
  const deckCoverUrl = artCropUrl(deckCover?.imageSmall ?? deckCover?.imageNormal);

  const dropOnMain = (instanceId: string): void => {
    const pick = allPicks.find((candidate) => candidate.instanceId === instanceId);
    if (pick) lanesApi.moveCard(instanceId, defaultLaneId(cards[pick.cardId]?.cmc));
  };

  return (
    <div className="panel draft-list-zone flex min-h-0 flex-1 flex-col">
      <div className={`draft-deck-banner relative flex h-[66px] shrink-0 items-center gap-2 overflow-hidden px-2.5 py-1.5 ${mainPicks.length >= 40 ? "is-complete" : ""}`}>
        <div className="draft-deck-banner-art relative h-11 w-[58px] shrink-0" aria-hidden="true">
          <span className="draft-deck-banner-card draft-deck-banner-card-front">
            {deckCoverUrl ? (
              <img src={deckCoverUrl} alt="" className="draft-deck-banner-art-image" />
            ) : (
              <img
                src="/ui/empty-deck-vault.jpg"
                alt=""
                className="draft-deck-banner-art-image"
              />
            )}
            <span className="draft-deck-banner-card-glass" />
          </span>
        </div>
        <div className="min-w-0 flex-1 leading-none">
          <div className="draft-deck-banner-title">Deck</div>
          <div className="draft-deck-banner-count mt-1 flex items-baseline gap-1 tabular-nums">
            <span>{mainPicks.length}</span>
            <span className="draft-deck-banner-count-target">/ 40</span>
            <span className="draft-deck-banner-count-label">Cards</span>
          </div>
        </div>
        <div
          className="draft-deck-mini-curve flex h-11 w-[70px] shrink-0 items-end justify-center gap-[2px] px-1.5 pb-1.5 pt-2"
          role="img"
          aria-label={`Mana curve for ${mainPicks.length} mainboard cards`}
          title="Mainboard mana curve"
        >
          {compactCurve.map((count, index) => (
            <span
              key={index}
              className={count > 0 ? "is-filled" : "is-empty"}
              style={{ height: `${Math.max(8, (count / compactCurveMax) * 100)}%` }}
              title={`${count} card${count === 1 ? "" : "s"} at mana value ${index === 7 ? "7+" : index}`}
            />
          ))}
        </div>
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
  open: boolean;
  onToggleOpen: () => void;
  onPackPick?: PackPickDrop;
}

export function PicksRail(props: PicksRailProps): JSX.Element {
  const { picks, cards, lanesApi, view, open, onToggleOpen, onPackPick } = props;

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
  const sideboardCount = picks.length - main.length;

  return (
    <aside className="draft-sidebar relative flex w-60 shrink-0 flex-col pl-2.5 min-[1400px]:w-72">
      {view === "list" && (
        <PicksList cards={cards} lanesApi={lanesApi} onPackPick={onPackPick} />
      )}

      {open && (
        <div
          id="draft-deck-stats-panel"
          className="panel draft-deck-stats-panel scrollbar-slim absolute inset-0 z-30 space-y-2 overflow-y-auto p-2"
        >
          <div className="flex items-center gap-2 px-1 py-0.5">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-amber-200">Deck Stats</span>
            <div className="flex-1" />
          <button
            type="button"
            className="rounded-md p-1 text-zinc-400 transition-colors duration-150 hover:bg-white/5 hover:text-amber-200"
            onClick={onToggleOpen}
            aria-label="Close Deck Stats"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true"><path d="m6.4 5 12.6 12.6-1.4 1.4L5 6.4 6.4 5Zm11.2 0L19 6.4 6.4 19 5 17.6 17.6 5Z" /></svg>
          </button>
        </div>
          <div className="panel-inset p-3">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Draft stats</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div><span className="block text-sm font-black tabular-nums text-amber-200">{picks.length}</span><span className="text-[9px] uppercase tracking-wide text-zinc-500">Picked</span></div>
              <div><span className="block text-sm font-black tabular-nums text-zinc-100">{main.length}</span><span className="text-[9px] uppercase tracking-wide text-zinc-500">Main</span></div>
              <div><span className="block text-sm font-black tabular-nums text-zinc-100">{sideboardCount}</span><span className="text-[9px] uppercase tracking-wide text-zinc-500">Sideboard</span></div>
            </div>
          </div>
          <TypeCounts main={main} cards={cards} />
          <CurveChart counts={curveCounts} />
          <ColorSplit main={main} cards={cards} showEmpty />
        </div>
      )}
    </aside>
  );
}
