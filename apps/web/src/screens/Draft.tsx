/**
 * Draft: pack grid with select/confirm (double-click to snap-pick), pick
 * timer, seat strip, and a picks tray grouped by color.
 */
import { useEffect, useMemo, useState } from "react";
import type { DraftView } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { useCardData } from "../lib/cardCache";
import { COLOR_BUCKET_LABELS, COLOR_BUCKET_ORDER, colorBucket, compareByCmcName, formatSeconds, type ColorBucket } from "../lib/cards";
import { Card } from "../components/Card";
import { CardGrid } from "../components/CardGrid";

function useCountdown(deadline: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (deadline === null) {
      setRemaining(null);
      return;
    }
    const tick = (): void => setRemaining(deadline - Date.now());
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadline]);
  return remaining;
}

function SeatStrip({ draft }: { draft: DraftView }): JSX.Element {
  return (
    <div className="scrollbar-slim flex gap-1.5 overflow-x-auto pb-1">
      {draft.seats.map((seat) => {
        const isMe = seat.seatIndex === draft.seatIndex;
        return (
          <div
            key={seat.seatIndex}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors duration-150 ${
              isMe ? "border-emerald-500/40 bg-emerald-500/10" : "border-white/[0.06] bg-white/[0.03]"
            }`}
          >
            <span className={`font-semibold ${isMe ? "text-emerald-300" : "text-zinc-300"}`}>
              {seat.playerName ?? `Bot ${seat.seatIndex + 1}`}
            </span>
            {seat.isBot && <span className="chip border-purple-400/30 text-purple-300">bot</span>}
            <span className="text-[10px] tabular-nums text-zinc-500" title="Cards picked">
              {seat.pickCount}
            </span>
            {seat.queuedPacks > 0 && (
              <span className="flex items-center gap-0.5" title={`${seat.queuedPacks} pack${seat.queuedPacks === 1 ? "" : "s"} waiting`}>
                {Array.from({ length: Math.min(seat.queuedPacks, 4) }).map((_, i) => (
                  <span key={i} className="h-1.5 w-1.5 rounded-full bg-brass-400" />
                ))}
                {seat.queuedPacks > 4 && <span className="text-[9px] text-brass-300">+{seat.queuedPacks - 4}</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Draft(): JSX.Element {
  const { state, pushToast } = useApp();
  const draft = state.draft;
  const [selected, setSelected] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const packKey = draft?.currentPack?.id ?? "none";
  const pickCount = draft?.picks.length ?? 0;

  // Re-enable picking + clear selection whenever a new pack/pick state arrives.
  useEffect(() => {
    setPicking(false);
    setSelected(null);
  }, [packKey, pickCount]);

  const allIds = useMemo(() => {
    if (!draft) return [];
    return [...(draft.currentPack?.cards ?? []), ...draft.picks].map((c) => c.cardId);
  }, [draft]);
  const cards = useCardData(allIds);

  const remaining = useCountdown(draft?.pickDeadline ?? null);

  if (!draft) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="panel animate-fade-in px-6 py-4 text-sm text-zinc-400">Waiting for the draft to begin…</div>
      </div>
    );
  }

  const pickNumber = (draft.picks.length % draft.cardsPerPack) + 1;

  const makePick = async (instanceId: string): Promise<void> => {
    if (picking) return;
    setPicking(true);
    const r = await call("makePick", { instanceId });
    if (!r.ok) {
      setPicking(false);
      pushToast(r.error ?? "Pick rejected");
    }
  };

  // Picks tray grouped by color bucket.
  const groups = new Map<ColorBucket, typeof draft.picks>();
  for (const pick of draft.picks) {
    const bucket = colorBucket(cards[pick.cardId]);
    const arr = groups.get(bucket);
    if (arr) arr.push(pick);
    else groups.set(bucket, [pick]);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => compareByCmcName(cards[a.cardId], cards[b.cardId]));
  }

  const timerDanger = remaining !== null && remaining < 10_000;

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-3 p-4">
      {/* Header */}
      <header className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-black text-zinc-50">
            Pack <span className="text-emerald-300">{draft.packNumber}</span>
            <span className="text-zinc-500">/{draft.packsPerPlayer}</span>
          </span>
          <span className="text-sm font-semibold text-zinc-400">
            Pick <span className="text-zinc-100">{Math.min(pickNumber, draft.cardsPerPack)}</span>
          </span>
        </div>
        {remaining !== null && draft.currentPack && (
          <span
            className={`rounded-md px-2.5 py-1 font-mono text-sm font-bold tabular-nums ${
              timerDanger ? "animate-pulse bg-red-500/20 text-red-300" : "bg-white/[0.05] text-zinc-200"
            }`}
            title="Time left to pick"
          >
            {formatSeconds(remaining)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <SeatStrip draft={draft} />
        </div>
      </header>

      {/* Pack */}
      <main className="panel flex-1 p-4">
        {draft.complete ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
            <svg viewBox="0 0 24 24" className="h-10 w-10 fill-emerald-400"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" /></svg>
            <div className="text-lg font-bold text-zinc-100">Draft complete</div>
            <div className="text-sm text-zinc-500">Moving to deck building…</div>
          </div>
        ) : draft.currentPack ? (
          <>
            <CardGrid min={150}>
              {draft.currentPack.cards.map((dc) => (
                <Card
                  key={dc.instanceId}
                  data={cards[dc.cardId]}
                  size="md"
                  selected={selected === dc.instanceId}
                  dimmed={picking}
                  className="!w-full max-w-[160px]"
                  onClick={() => setSelected((cur) => (cur === dc.instanceId ? null : dc.instanceId))}
                  onDoubleClick={() => void makePick(dc.instanceId)}
                />
              ))}
            </CardGrid>
            <div className="sticky bottom-2 mt-4 flex justify-center">
              <button
                type="button"
                className="btn-gold !px-8 !py-2.5 shadow-card-lg"
                disabled={!selected || picking}
                onClick={() => {
                  if (selected) void makePick(selected);
                }}
              >
                {picking ? "Picking…" : selected ? "Confirm pick" : "Select a card"}
              </button>
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500/60" style={{ animationDelay: `${i * 200}ms` }} />
              ))}
            </div>
            <div className="text-sm font-semibold text-zinc-300">Waiting for the next pack…</div>
            <div className="text-xs text-zinc-600">Your neighbor is still deliberating.</div>
          </div>
        )}
      </main>

      {/* Picks tray */}
      <footer className="panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Your picks</span>
          <span className="chip">{draft.picks.length}</span>
        </div>
        {draft.picks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/10 py-4 text-center text-xs text-zinc-600">
            Cards you pick will collect here, grouped by color.
          </div>
        ) : (
          <div className="scrollbar-slim flex gap-4 overflow-x-auto pb-1">
            {COLOR_BUCKET_ORDER.filter((b) => groups.has(b)).map((bucket) => {
              const picks = groups.get(bucket) ?? [];
              return (
                <div key={bucket} className="shrink-0">
                  <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">
                    {COLOR_BUCKET_LABELS[bucket]} · {picks.length}
                  </div>
                  <div className="flex gap-1">
                    {picks.map((pick) => (
                      <Card key={pick.instanceId} data={cards[pick.cardId]} size="xs" />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </footer>
    </div>
  );
}
