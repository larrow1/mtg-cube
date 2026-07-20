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
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { BASIC_LAND_NAMES, type CardData, type DraftCard } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { useCardData } from "../lib/cardCache";
import {
  COLOR_BUCKET_ORDER,
  cmcBucket,
  colorBucket,
  compareByCmcName,
  manaPipClasses,
  primaryType,
  type ColorBucket,
} from "../lib/cards";
import { sideboardedInstanceIds } from "../lib/draftLanes";
import { Card } from "../components/Card";
import { CardGrid } from "../components/CardGrid";
import { CurveChart } from "../components/CurveChart";
import { ColorSplit } from "../components/PicksRail";
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

const FILTER_PIPS: ColorBucket[] = ["W", "U", "B", "R", "G", "C", "M"];
const TYPE_CHIPS = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Battle", "Land"];

/** Deck-strip mana columns, matching the draft tray's clean 0-1..6+ lanes. */
const DECK_BUCKETS = ["0-1", "2", "3", "4", "5", "6+"] as const;
type DeckBucket = (typeof DECK_BUCKETS)[number];

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
// Deck strip column (Arena-like stack: only name bands visible)
// ---------------------------------------------------------------------------

function StackColumn({
  entries,
  cards,
  width,
  accent = false,
  header,
  isOver,
  onHoverChange,
  onDropCard,
  onEntryClick,
  clickTitle,
  emptyLabel,
  footer,
}: {
  entries: StackEntry[];
  cards: Record<string, CardData>;
  width: number;
  accent?: boolean;
  header?: ReactNode;
  isOver: boolean;
  onHoverChange: (over: boolean) => void;
  onDropCard: (instanceId: string) => void;
  onEntryClick: (instanceId: string) => void;
  clickTitle: string;
  emptyLabel: string;
  footer?: ReactNode;
}): JSX.Element {
  // Same trick as the draft tray: top-margin percentages resolve against the
  // column width, so "-119%" hides all but the card's name band (aspect 5/7).
  const overlap = "-119%";

  return (
    <div
      className={`flex h-full shrink-0 flex-col rounded-lg px-1 pt-0.5 transition-colors duration-150 ${
        accent
          ? `border border-dashed ${isOver ? "border-amber-300/80 bg-amber-400/10" : "border-amber-400/40 bg-amber-400/[0.04]"}`
          : isOver
            ? "bg-brass-400/10 ring-1 ring-brass-400/50"
            : "bg-white/[0.02]"
      }`}
      style={{ width: width + 10 }}
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
      <div className="flex h-4 shrink-0 items-center gap-1 px-0.5">{header}</div>
      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-1 pt-1">
        {entries.length === 0 && !footer ? (
          <div
            className={`flex h-14 items-center justify-center rounded-md border border-dashed text-[9px] uppercase tracking-wider ${
              accent ? "border-amber-400/30 text-amber-400/60" : "border-amber-100/10 text-zinc-600"
            }`}
          >
            {emptyLabel}
          </div>
        ) : (
          entries.map((entry, i) => {
            const top = entry.instances[entry.instances.length - 1];
            return (
              <div
                key={entry.cardId}
                className="relative transition-transform duration-150 hover:z-30 hover:-translate-y-1"
                style={{ marginTop: i === 0 ? 0 : overlap }}
              >
                <Card
                  data={cards[entry.cardId]}
                  size="md"
                  className="!w-full"
                  draggable
                  onDragStart={(e) => {
                    if (top) e.dataTransfer.setData(DRAG_MIME, top.instanceId);
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
          })
        )}
        {footer}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deckbuild screen
// ---------------------------------------------------------------------------

export function Deckbuild(): JSX.Element {
  const { state, pushToast, dispatch } = useApp();
  const room = state.room;
  const me = state.session;
  const picks = state.draft?.picks ?? [];

  const [assignment, setAssignment] = useState<Record<string, DeckZone>>({});
  const [basics, setBasics] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [pairA, setPairA] = useState("");
  const [pairB, setPairB] = useState("");

  // Pool filters (they apply to the pool only).
  const [query, setQuery] = useState("");
  const [colorPips, setColorPips] = useState<ReadonlySet<ColorBucket>>(new Set());
  const [typeChips, setTypeChips] = useState<ReadonlySet<string>>(new Set());

  // Deck-strip drag highlight, keyed per column.
  const [dragCol, setDragCol] = useState<string | null>(null);

  const cards = useCardData(useMemo(() => picks.map((p) => p.cardId), [picks]));

  // Seed cards the player parked in the draft's Sideboard lane into "side".
  // Defensive: bad/absent stored data leaves everything in "pool" as before,
  // and explicit moves made here are never overwritten.
  const draftId = state.draft?.draftId;
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!draftId || seededFor.current === draftId) return;
    seededFor.current = draftId;
    const side = sideboardedInstanceIds(draftId);
    if (side.size === 0) return;
    setAssignment((cur) => {
      const next = { ...cur };
      for (const id of side) {
        if (!(id in next)) next[id] = "side";
      }
      return next;
    });
  }, [draftId]);

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
    if (colorPips.size > 0 && !colorPips.has(colorBucket(data))) return false;
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

  const bucketEntries = new Map<DeckBucket, StackEntry[]>();
  for (const bucket of DECK_BUCKETS) bucketEntries.set(bucket, []);
  {
    const byBucket = new Map<DeckBucket, DraftCard[]>();
    for (const dc of mainSpells) {
      const bucket = deckBucket(cards[dc.cardId]?.cmc);
      const arr = byBucket.get(bucket);
      if (arr) arr.push(dc);
      else byBucket.set(bucket, [dc]);
    }
    for (const [bucket, arr] of byBucket) bucketEntries.set(bucket, stackEntries(arr, cards));
  }
  const landEntries = stackEntries(mainLands, cards);
  const sideEntries = stackEntries(side, cards);

  const landsCount = mainLands.length + basicsTotal;

  const submitDeck = async (): Promise<void> => {
    setSubmitting(true);
    // Anything left in the pool is submitted as sideboard alongside the
    // explicit sideboard (the contract has no "pool" concept at submit time).
    const r = await call("submitDeck", { main, sideboard: [...side, ...pool], basics });
    setSubmitting(false);
    if (r.ok) pushToast("Deck submitted", "success");
    else pushToast(r.error ?? "Deck rejected");
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

  const myLiveMatch = room.matches.find((m) => !m.finished && m.playerIds.includes(me.playerId));

  const allowDrag = (e: DragEvent<HTMLElement>): void => e.preventDefault();

  const basicsFooter = (
    <div className="mt-1.5 space-y-1">
      {BASIC_LAND_NAMES.map((name) => {
        const n = basics[name] ?? 0;
        const sym = BASIC_COLORS[name] ?? "C";
        return (
          <div
            key={name}
            className={`flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-150 ${
              n > 0 ? "bg-white/[0.06]" : "bg-white/[0.02]"
            }`}
            title={name}
          >
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black shadow-card ${manaPipClasses(sym)}`}>
              {sym}
            </span>
            <span className={`min-w-6 text-center text-xs font-bold tabular-nums ${n > 0 ? "text-zinc-100" : "text-zinc-600"}`}>
              x{n}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded bg-white/[0.06] text-xs font-bold text-zinc-300 transition-colors duration-150 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-30"
              disabled={n === 0}
              onClick={() => setBasics((b) => ({ ...b, [name]: Math.max(0, (b[name] ?? 0) - 1) }))}
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

  return (
    <div className="mx-auto flex h-full max-w-[110rem] animate-fade-in flex-col gap-2.5 p-3">
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

      <div className="flex min-h-0 flex-1 gap-2.5">
        {/* Pool on top + deck strip along the bottom */}
        <main className="flex min-w-0 flex-1 flex-col gap-2.5">
          {/* Pool */}
          <section
            className="panel flex min-h-0 flex-1 flex-col"
            onDragOver={allowDrag}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) moveTo(id, "pool");
            }}
          >
            {/* Arena-style filter bar */}
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-amber-100/[0.08] px-3 py-2">
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
                  const pipClass =
                    b === "M" ? "bg-gradient-to-br from-yellow-200 to-amber-500 text-amber-950" : manaPipClasses(b);
                  return (
                    <button
                      key={b}
                      type="button"
                      onClick={() => togglePip(b)}
                      className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-black transition-all duration-150 ${pipClass} ${
                        active ? "scale-110 shadow-glow-soft ring-1 ring-amber-300/80" : "opacity-35 saturate-50 hover:opacity-70"
                      }`}
                      title={b === "M" ? "Multicolor" : b === "C" ? "Colorless" : b}
                      aria-pressed={active}
                    >
                      {b}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {TYPE_CHIPS.map((t) => {
                  const active = typeChips.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleType(t)}
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors duration-150 ${
                        active
                          ? "border-brass-400/70 bg-brass-400/15 text-brass-300"
                          : "border-amber-100/15 bg-white/[0.03] text-zinc-400 hover:border-amber-200/30 hover:text-zinc-200"
                      }`}
                      aria-pressed={active}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              {hasFilters && (
                <button
                  type="button"
                  className="flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.07] text-[11px] font-bold text-zinc-300 transition-colors duration-150 hover:bg-red-500/25 hover:text-red-200"
                  onClick={clearFilters}
                  title="Clear all filters"
                  aria-label="Clear all filters"
                >
                  ✕
                </button>
              )}
              <div className="flex-1" />
              <span className="text-[10px] tabular-nums text-zinc-500">
                {shownPool.length} shown / {pool.length} pool
              </span>
            </div>
            {/* Pool grid */}
            <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-3">
              {pool.length === 0 ? (
                <div className="rounded-xl border border-dashed border-amber-100/15 py-10 text-center text-xs text-zinc-400">
                  Your deck starts fully built from the draft — click or drag cards out of it and your cuts land here.
                </div>
              ) : shownPool.length === 0 ? (
                <div className="rounded-xl border border-dashed border-amber-100/15 py-10 text-center text-xs text-zinc-400">
                  No cards match these filters.
                </div>
              ) : (
                <CardGrid min={140}>
                  {shownPool.map((dc) => (
                    <Card
                      key={dc.instanceId}
                      data={cards[dc.cardId]}
                      size="md"
                      className="!w-full max-w-[160px]"
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, dc.instanceId)}
                      onClick={() => moveTo(dc.instanceId, "main")}
                      title="Click to add to your deck"
                    />
                  ))}
                </CardGrid>
              )}
            </div>
          </section>

          {/* Deck strip */}
          <section
            className="panel flex h-[34vh] min-h-[13rem] shrink-0 flex-col"
            onDragOver={allowDrag}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) moveTo(id, "main");
            }}
          >
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pb-1 pt-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Deck</span>
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-bold tabular-nums ${
                  deckCount < 40 ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"
                }`}
                title="Main deck count including lands"
              >
                {mainSpells.length} + {landsCount} lands / 40{deckCount < 40 ? " — add more cards" : ""}
              </span>
              <span className="hidden text-[10px] text-zinc-600 md:inline">
                click a card to return it to the pool · drag between deck, lands and sideboard
              </span>
            </div>
            <div className="scrollbar-slim flex min-h-0 flex-1 gap-1.5 overflow-x-auto px-3 pb-2">
              {DECK_BUCKETS.map((bucket) => (
                <StackColumn
                  key={bucket}
                  entries={bucketEntries.get(bucket) ?? []}
                  cards={cards}
                  width={104}
                  isOver={dragCol === `cmc-${bucket}`}
                  onHoverChange={(over) => setDragCol(over ? `cmc-${bucket}` : null)}
                  onDropCard={(id) => moveTo(id, "main")}
                  onEntryClick={(id) => moveTo(id, "pool")}
                  clickTitle="Click to return to the pool"
                  emptyLabel="empty"
                />
              ))}
              <div className="w-1 shrink-0" />
              <StackColumn
                entries={landEntries}
                cards={cards}
                width={128}
                header={
                  <>
                    <span className="truncate text-[10px] font-bold uppercase tracking-wider text-zinc-400">Lands</span>
                    <span className="text-[10px] font-semibold tabular-nums text-zinc-500">{landsCount}</span>
                  </>
                }
                isOver={dragCol === "lands"}
                onHoverChange={(over) => setDragCol(over ? "lands" : null)}
                onDropCard={(id) => moveTo(id, "main")}
                onEntryClick={(id) => moveTo(id, "pool")}
                clickTitle="Click to return to the pool"
                emptyLabel="lands"
                footer={basicsFooter}
              />
              <StackColumn
                entries={sideEntries}
                cards={cards}
                width={104}
                accent
                header={
                  <>
                    <span className="truncate text-[10px] font-bold uppercase tracking-wider text-amber-300">Sideboard</span>
                    <span className="text-[10px] font-semibold tabular-nums text-zinc-500">{side.length}</span>
                  </>
                }
                isOver={dragCol === "side"}
                onHoverChange={(over) => setDragCol(over ? "side" : null)}
                onDropCard={(id) => moveTo(id, "side")}
                onEntryClick={(id) => moveTo(id, "pool")}
                clickTitle="Click to return to the pool"
                emptyLabel="side"
              />
            </div>
          </section>
        </main>

        {/* Right rail */}
        <aside className="scrollbar-slim flex w-64 shrink-0 flex-col gap-2.5 overflow-y-auto min-[1500px]:w-72">
          {/* Submit */}
          <div className="panel shrink-0 p-3">
            <div className="mb-2 flex items-center gap-2">
              <h1 className="text-sm font-black text-zinc-50">Deck building</h1>
              {ranked && <span className="chip border-brass-400/60 font-black tracking-widest text-brass-300">RANKED</span>}
            </div>
            <button
              type="button"
              className="btn-gold w-full"
              disabled={submitting || main.length === 0}
              onClick={() => void submitDeck()}
            >
              {submitting ? "Submitting…" : submitted ? "Resubmit deck" : "Submit deck"}
            </button>
            <div className="mt-3 border-t border-amber-100/[0.08] pt-2.5">
              <h2 className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Decks submitted</h2>
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
          </div>

          <CurveChart counts={curveCounts} />
          <ColorSplit main={main} cards={cards} label="Colors (deck)" />

          {/* Host: pair matches (ranked rooms auto-pair on the server) */}
          {isHost && !ranked && (
            <div className="panel shrink-0 border-brass-400/30 p-3">
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
            <div className="panel shrink-0 p-3">
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

          <ChatPanel className="h-64 shrink-0" />
        </aside>
      </div>
    </div>
  );
}
