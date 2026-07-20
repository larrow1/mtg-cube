/**
 * Draft: pack grid with select/confirm (double-click to snap-pick), pick
 * timer, seat strip, a resizable bottom picks tray with drag-organizable
 * lanes + pinned sideboard, and a right stats rail (type counts, live curve,
 * color split) with an alternate compact list view of picks.
 */
import { useEffect, useMemo, useState } from "react";
import type { DraftView } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { useCardData } from "../lib/cardCache";
import { formatSeconds } from "../lib/cards";
import { useDraftLanes } from "../lib/draftLanes";
import { Card } from "../components/Card";
import { CardGrid } from "../components/CardGrid";
import { PicksTray, clampTrayH } from "../components/PicksTray";
import { PicksRail } from "../components/PicksRail";

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
              isMe ? "border-brass-400/50 bg-amber-400/10" : "border-amber-100/[0.08] bg-white/[0.04]"
            }`}
          >
            <span className={`font-semibold ${isMe ? "text-brass-300" : "text-zinc-300"}`}>
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

// ---------------------------------------------------------------------------
// Tray / rail preference persistence (global, not per draft)
// ---------------------------------------------------------------------------

const TRAY_PREFS_KEY = "mtg-cube-picks-tray";

interface TrayPrefs {
  h: number;
  min: boolean;
  view: "cards" | "list";
  rail: boolean;
}

const DEFAULT_PREFS: TrayPrefs = { h: 232, min: false, view: "cards", rail: true };

function loadTrayPrefs(): TrayPrefs {
  try {
    const raw = localStorage.getItem(TRAY_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<TrayPrefs> | null;
    if (!p || typeof p !== "object") return DEFAULT_PREFS;
    return {
      h: typeof p.h === "number" && Number.isFinite(p.h) ? clampTrayH(p.h) : DEFAULT_PREFS.h,
      min: p.min === true,
      view: p.view === "list" ? "list" : "cards",
      rail: p.rail !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function Draft(): JSX.Element {
  const { state, pushToast } = useApp();
  const draft = state.draft;
  const ranked = state.room?.ranked ?? false;
  const [selected, setSelected] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const [prefs, setPrefs] = useState<TrayPrefs>(loadTrayPrefs);
  useEffect(() => {
    try {
      localStorage.setItem(TRAY_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // localStorage unavailable — prefs just won't survive reloads.
    }
  }, [prefs]);

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

  const picks = useMemo(() => draft?.picks ?? [], [draft]);
  const lanesApi = useDraftLanes(draft?.draftId, picks, cards);

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

  const timerDanger = remaining !== null && remaining < 10_000;

  return (
    <div className="mx-auto flex h-full max-w-[110rem] flex-col gap-2.5 p-3">
      {/* Header */}
      <header className="panel flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-black text-zinc-50">
            Pack <span className="text-brass-300">{draft.packNumber}</span>
            <span className="text-zinc-500">/{draft.packsPerPlayer}</span>
          </span>
          <span className="text-sm font-semibold text-zinc-400">
            Pick <span className="text-zinc-100">{Math.min(pickNumber, draft.cardsPerPack)}</span>
          </span>
        </div>
        {ranked && <span className="chip border-brass-400/60 font-black tracking-widest text-brass-300">RANKED</span>}
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

      {/* Pack + stats rail */}
      <div className="flex min-h-0 flex-1 gap-2.5">
        <main className="panel scrollbar-slim min-h-0 flex-1 overflow-y-auto p-4">
          {draft.complete ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <svg viewBox="0 0 24 24" className="h-10 w-10 fill-brass-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.45)]"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" /></svg>
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
                  <span key={i} className="h-2.5 w-2.5 animate-pulse rounded-full bg-brass-400/70" style={{ animationDelay: `${i * 200}ms` }} />
                ))}
              </div>
              <div className="text-sm font-semibold text-zinc-300">Waiting for the next pack…</div>
              <div className="text-xs text-zinc-500">Your neighbor is still deliberating.</div>
            </div>
          )}
        </main>

        <PicksRail
          picks={picks}
          cards={cards}
          lanesApi={lanesApi}
          view={prefs.view}
          onView={(view) => setPrefs((p) => ({ ...p, view }))}
          open={prefs.rail}
          onToggleOpen={() => setPrefs((p) => ({ ...p, rail: !p.rail }))}
        />
      </div>

      {/* Picks tray (cards view only — list view lives in the right rail) */}
      {prefs.view === "cards" && (
        <PicksTray
          picks={picks}
          cards={cards}
          lanesApi={lanesApi}
          trayH={prefs.h}
          minimized={prefs.min}
          onResize={(h) => setPrefs((p) => ({ ...p, h, min: false }))}
          onToggleMinimized={() => setPrefs((p) => ({ ...p, min: !p.min }))}
          view={prefs.view}
          onView={(view) => setPrefs((p) => ({ ...p, view }))}
        />
      )}
    </div>
  );
}
