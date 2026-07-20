/**
 * Deckbuild: pool <-> main deck via click or drag-drop, sort controls, basic
 * land steppers, curve chart, sideboard, submit + waiting state. The host
 * additionally pairs players into matches.
 */
import { useMemo, useState, type DragEvent } from "react";
import { BASIC_LAND_NAMES, type DraftCard } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { useCardData } from "../lib/cardCache";
import {
  CMC_BUCKET_LABELS,
  COLOR_BUCKET_LABELS,
  COLOR_BUCKET_ORDER,
  cmcBucket,
  colorBucket,
  compareByCmcName,
  manaPipClasses,
  primaryType,
} from "../lib/cards";
import { Card } from "../components/Card";
import { CurveChart } from "../components/CurveChart";
import { ChatPanel } from "../components/ChatPanel";

type SortMode = "cmc" | "color" | "type";
type DeckZone = "pool" | "main" | "side";

const BASIC_COLORS: Record<string, string> = {
  Plains: "W",
  Island: "U",
  Swamp: "B",
  Mountain: "R",
  Forest: "G",
};

const TYPE_GROUP_ORDER = ["Creature", "Planeswalker", "Instant", "Sorcery", "Artifact", "Enchantment", "Battle", "Land", "Other"];

export function Deckbuild(): JSX.Element {
  const { state, pushToast, dispatch } = useApp();
  const room = state.room;
  const me = state.session;
  const picks = state.draft?.picks ?? [];

  const [assignment, setAssignment] = useState<Record<string, DeckZone>>({});
  const [basics, setBasics] = useState<Record<string, number>>({});
  const [sortMode, setSortMode] = useState<SortMode>("cmc");
  const [submitting, setSubmitting] = useState(false);
  const [pairA, setPairA] = useState("");
  const [pairB, setPairB] = useState("");

  const cards = useCardData(useMemo(() => picks.map((p) => p.cardId), [picks]));

  if (!room || !me) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="panel px-6 py-4 text-sm text-zinc-400">Loading…</div>
      </div>
    );
  }

  const zoneOf = (instanceId: string): DeckZone => assignment[instanceId] ?? "pool";
  const inZone = (zone: DeckZone): DraftCard[] => picks.filter((p) => zoneOf(p.instanceId) === zone);
  const pool = inZone("pool");
  const main = inZone("main");
  const side = inZone("side");

  const moveTo = (instanceId: string, zone: DeckZone): void => {
    setAssignment((cur) => ({ ...cur, [instanceId]: zone }));
  };

  const onDropTo = (zone: DeckZone) => (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    if (id) moveTo(id, zone);
  };

  const basicsTotal = Object.values(basics).reduce((a, b) => a + b, 0);
  const deckCount = main.length + basicsTotal;
  const submitted = room.decksSubmitted.includes(me.playerId);
  const isHost = room.hostId === me.playerId;

  const groupCards = (list: DraftCard[]): [string, DraftCard[]][] => {
    const map = new Map<string, DraftCard[]>();
    for (const dc of list) {
      const data = cards[dc.cardId];
      const key =
        sortMode === "cmc"
          ? (CMC_BUCKET_LABELS[cmcBucket(data?.cmc ?? 0)] ?? "0")
          : sortMode === "color"
            ? COLOR_BUCKET_LABELS[colorBucket(data)]
            : primaryType(data);
      const arr = map.get(key);
      if (arr) arr.push(dc);
      else map.set(key, [dc]);
    }
    for (const arr of map.values()) arr.sort((a, b) => compareByCmcName(cards[a.cardId], cards[b.cardId]));
    const order =
      sortMode === "cmc"
        ? CMC_BUCKET_LABELS
        : sortMode === "color"
          ? COLOR_BUCKET_ORDER.map((b) => COLOR_BUCKET_LABELS[b])
          : TYPE_GROUP_ORDER;
    return order.filter((k) => map.has(k)).map((k) => [k, map.get(k) ?? []]);
  };

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

  const curveCounts = useMemo(() => {
    const counts = new Array<number>(8).fill(0);
    for (const dc of main) {
      const data = cards[dc.cardId];
      if (!data || data.typeLine.toLowerCase().includes("land")) continue;
      const b = cmcBucket(data.cmc);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    return counts;
  }, [main, cards]);

  const renderGroups = (list: DraftCard[], from: DeckZone, to: DeckZone): JSX.Element => (
    <div className="space-y-3">
      {groupCards(list).map(([label, items]) => (
        <div key={label}>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">
            {label} · {items.length}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {items.map((dc) => (
              <Card
                key={dc.instanceId}
                data={cards[dc.cardId]}
                size="sm"
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", dc.instanceId)}
                onClick={() => moveTo(dc.instanceId, to)}
                title={`Click to move to ${to === "main" ? "deck" : to}`}
                className={from === "side" ? "opacity-80" : ""}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const myLiveMatch = room.matches.find(
    (m) => !m.finished && m.playerIds.includes(me.playerId)
  );

  return (
    <div className="mx-auto max-w-[110rem] animate-fade-in p-4">
      {myLiveMatch && (
        <div className="panel mb-3 flex flex-wrap items-center justify-between gap-3 border-brass-400/40 px-4 py-3">
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
      <header className="panel mb-3 flex flex-wrap items-center gap-3 px-4 py-2.5">
        <h1 className="text-lg font-black text-zinc-50">Deck building</h1>
        <div className="flex items-center gap-1.5">
          {(["cmc", "color", "type"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setSortMode(m)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold uppercase transition-colors duration-150 ${
                sortMode === m ? "bg-gradient-to-b from-brass-300 to-brass-500 text-amber-950 shadow-card" : "bg-white/[0.05] text-zinc-400 hover:bg-white/10"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span
          className={`rounded-md px-2.5 py-1 text-sm font-bold tabular-nums ${
            deckCount < 40 ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"
          }`}
          title="Main deck count including basics"
        >
          {deckCount} / 40{deckCount < 40 ? " — add more cards" : ""}
        </span>
        <button
          type="button"
          className="btn-gold"
          disabled={submitting || main.length === 0}
          onClick={() => void submitDeck()}
        >
          {submitting ? "Submitting…" : submitted ? "Resubmit deck" : "Submit deck"}
        </button>
      </header>

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr_19rem]">
        {/* Pool */}
        <section
          className="panel min-h-[24rem] p-3"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDropTo("pool")}
        >
          <h2 className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            Pool <span className="chip">{pool.length}</span>
            <span className="normal-case text-zinc-500">click a card to add it to your deck</span>
          </h2>
          {pool.length === 0 ? (
            <div className="rounded-xl border border-dashed border-amber-100/15 py-10 text-center text-xs text-zinc-400">
              Pool is empty — every last pick made the cut.
            </div>
          ) : (
            renderGroups(pool, "pool", "main")
          )}
        </section>

        {/* Main deck */}
        <section
          className="panel min-h-[24rem] p-3"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDropTo("main")}
        >
          <h2 className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            Main deck <span className="chip">{main.length} + {basicsTotal} basics</span>
          </h2>
          {main.length === 0 ? (
            <div className="rounded-xl border border-dashed border-brass-400/30 py-10 text-center text-xs text-zinc-400">
              Nothing here yet — drag or click cards from your pool and start brewing.
            </div>
          ) : (
            renderGroups(main, "main", "pool")
          )}

          {/* Sideboard */}
          <div
            className="mt-4 border-t border-amber-100/[0.08] pt-3"
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.stopPropagation();
              onDropTo("side")(e);
            }}
          >
            <h3 className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              Sideboard <span className="chip">{side.length}</span>
              <span className="normal-case text-zinc-500">drop cards here</span>
            </h3>
            {side.length === 0 ? (
              <div className="rounded-xl border border-dashed border-amber-100/15 py-4 text-center text-[11px] text-zinc-500">
                Unused pool cards are also submitted as sideboard.
              </div>
            ) : (
              renderGroups(side, "side", "pool")
            )}
          </div>
        </section>

        {/* Right rail */}
        <aside className="space-y-3">
          {/* Basics */}
          <div className="panel p-3">
            <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Basic lands</h2>
            <div className="space-y-1.5">
              {BASIC_LAND_NAMES.map((name) => {
                const n = basics[name] ?? 0;
                const sym = BASIC_COLORS[name] ?? "C";
                return (
                  <div key={name} className="flex items-center gap-2">
                    <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-black shadow-card ${manaPipClasses(sym)}`}>
                      {sym}
                    </span>
                    <span className="flex-1 text-xs font-semibold text-zinc-300">{name}</span>
                    <button
                      type="button"
                      className="btn-ghost !px-2 !py-0.5 !text-sm"
                      disabled={n === 0}
                      onClick={() => setBasics((b) => ({ ...b, [name]: Math.max(0, (b[name] ?? 0) - 1) }))}
                      aria-label={`Remove ${name}`}
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-sm font-bold tabular-nums text-zinc-100">{n}</span>
                    <button
                      type="button"
                      className="btn-ghost !px-2 !py-0.5 !text-sm"
                      onClick={() => setBasics((b) => ({ ...b, [name]: (b[name] ?? 0) + 1 }))}
                      aria-label={`Add ${name}`}
                    >
                      +
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <CurveChart counts={curveCounts} />

          {/* Submission status */}
          <div className="panel p-3">
            <h2 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Decks submitted</h2>
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

          {/* Host: pair matches */}
          {isHost && (
            <div className="panel border-brass-400/30 p-3">
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
            <div className="panel p-3">
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

          <ChatPanel className="h-72" />
        </aside>
      </div>
    </div>
  );
}
