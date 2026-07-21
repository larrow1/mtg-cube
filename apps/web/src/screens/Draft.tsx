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
import { setPackPickData } from "../lib/dnd";
import { useDraftLanes } from "../lib/draftLanes";
import { Card } from "../components/Card";
import { CardGrid } from "../components/CardGrid";
import { AUTO_LANE, PicksTray, clampTrayH } from "../components/PicksTray";
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

const BOT_AVATAR_COLORS = ["white", "red", "green", "blue", "purple", "gold", "charcoal"] as const;

function botAvatarColor(seatIndex: number): string {
  return BOT_AVATAR_COLORS[seatIndex % BOT_AVATAR_COLORS.length]!;
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
            {seat.isBot && (
              <img
                src={`/avatars/draft-bot-${botAvatarColor(seat.seatIndex)}.webp`}
                alt="Bot"
                title="Bot-controlled seat"
                className="h-6 w-6 shrink-0 rounded-full border border-brass-300/60 object-cover shadow-[0_0_8px_rgba(242,182,75,0.22)]"
              />
            )}
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
  view: "cards" | "list";
  rail: boolean;
}

const DEFAULT_PREFS: TrayPrefs = { h: 232, view: "list", rail: true };

function loadTrayPrefs(): TrayPrefs {
  try {
    const raw = localStorage.getItem(TRAY_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<TrayPrefs> | null;
    if (!p || typeof p !== "object") return DEFAULT_PREFS;
    return {
      h: typeof p.h === "number" && Number.isFinite(p.h) ? clampTrayH(p.h) : DEFAULT_PREFS.h,
      view: "list",
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

  /**
   * Drag-to-pick: a pack card dropped on a lane performs the pick through the
   * same call/ack path as double-click, and only on a successful ack records
   * the lane assignment so the card lands exactly where it was dropped
   * (`laneId === null` creates a new lane for it). The assignment is written
   * immediately on ack; the card renders in the lane once the server's pick
   * state lands.
   */
  const pickToLane = async (instanceId: string, laneId: string | null): Promise<void> => {
    if (picking) return;
    setPicking(true);
    const r = await call("makePick", { instanceId });
    if (!r.ok) {
      setPicking(false);
      pushToast(r.error ?? "Pick rejected");
      return; // Failed ack: nothing persists.
    }
    if (laneId === null) lanesApi.addLaneWithCard(instanceId);
    else if (laneId !== AUTO_LANE) lanesApi.moveCard(instanceId, laneId);
  };

  const timerDanger = remaining !== null && remaining > 0 && remaining < 10_000;
  const timerSetting = state.room?.draftConfig.pickTimerSeconds ?? null;
  const cardsRemaining = draft.currentPack?.cards.length ?? 0;
  const timerSeconds = timerSetting === "dynamic"
    ? cardsRemaining >= 13 ? 45 : cardsRemaining >= 10 ? 35 : cardsRemaining >= 7 ? 30 : cardsRemaining >= 4 ? 20 : cardsRemaining > 0 ? 10 : 0
    : (timerSetting ?? 0);
  const timerTotalMs = timerSeconds * 1000;
  const timerPercent = remaining === null || timerTotalMs <= 0
    ? 0
    : Math.max(0, Math.min(100, (remaining / timerTotalMs) * 100));
  // The server's timeout handler picks the first card in the waiting pack.
  // Mirror that ordering so this warning always identifies the exact card.
  const autoPickId = timerDanger && !selected && !picking
    ? (draft.currentPack?.cards[0]?.instanceId ?? null)
    : null;

  return (
    <div className="draft-scene h-full overflow-hidden">
    <div className="relative z-10 mx-auto flex h-full max-w-[110rem] flex-col gap-2.5 p-3">
      {/* Header */}
      <header className="panel draft-header flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex shrink-0 items-baseline gap-3">
          <span className="text-lg font-black text-orange-300 drop-shadow-[0_0_8px_rgba(251,146,60,0.45)]">
            Pack <span className="text-orange-400">{draft.packNumber}</span>
            <span className="text-orange-300/70">/{draft.packsPerPlayer}</span>
          </span>
          <span className="text-sm font-semibold text-orange-300 drop-shadow-[0_0_7px_rgba(251,146,60,0.32)]">
            Pick <span className="text-orange-400">{Math.min(pickNumber, draft.cardsPerPack)}</span>
          </span>
        </div>
        {ranked && <span className="chip border-brass-400/60 font-black tracking-widest text-brass-300">RANKED</span>}
        <div className="min-w-0 flex-1">
          <SeatStrip draft={draft} />
        </div>
        <div className="draft-pick-controls flex shrink-0 items-center gap-2.5">
          {remaining !== null && draft.currentPack && (
            <div className={`draft-timer-shell ${timerDanger ? "is-danger" : ""}`} title="Time left to pick">
              <div className="draft-timer-readout">
                <span className="draft-timer-clock">{formatSeconds(remaining)}</span>
              </div>
              <div
                className="draft-timer-track"
                role="progressbar"
                aria-label="Time left to pick"
                aria-valuemin={0}
                aria-valuemax={timerTotalMs}
                aria-valuenow={Math.max(0, remaining)}
              >
                <div
                  className="draft-timer-fill"
                  style={{ width: `${timerPercent}%` }}
                />
                <div className="draft-timer-gem" style={{ left: `${timerPercent}%` }} aria-hidden="true" />
              </div>
            </div>
          )}
          <button
            type="button"
            className="draft-confirm-button min-w-[142px] px-6 py-2.5"
            disabled={!selected || picking || !draft.currentPack}
            onClick={() => {
              if (selected) void makePick(selected);
            }}
          >
            {picking
              ? "Picking…"
              : selected
                ? "Confirm pick"
                : draft.currentPack
                  ? "Select a card"
                  : "Waiting…"}
          </button>
        </div>
      </header>

      {/* Pack + stats rail */}
      <div className="flex min-h-0 flex-1 gap-2.5">
        <main className="panel draft-pack-zone scrollbar-slim min-h-0 flex-1 overflow-y-auto p-4">
          {draft.complete ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <svg viewBox="0 0 24 24" className="h-10 w-10 fill-brass-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.45)]"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" /></svg>
              <div className="text-lg font-bold text-zinc-100">Draft complete</div>
              <div className="text-sm text-zinc-500">Moving to deck building…</div>
            </div>
          ) : draft.currentPack ? (
            <CardGrid min={prefs.view === "list" ? 172 : 150}>
                {draft.currentPack.cards.map((dc) => (
                  <Card
                    key={dc.instanceId}
                    data={cards[dc.cardId]}
                    size="md"
                    selected={selected === dc.instanceId}
                    highlight={autoPickId === dc.instanceId ? "autopick" : null}
                    dimmed={picking}
                    className={`!w-full ${prefs.view === "list" ? "max-w-[180px]" : "max-w-[160px]"}`}
                    draggable={!picking}
                    onDragStart={(e) => {
                      setSelected(dc.instanceId);
                      setPackPickData(e.dataTransfer, dc.instanceId);
                    }}
                    onClick={() => setSelected((cur) => (cur === dc.instanceId ? null : dc.instanceId))}
                    onDoubleClick={() => void makePick(dc.instanceId)}
                  />
                ))}
              </CardGrid>
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
          onPackPick={(id, laneId) => void pickToLane(id, laneId)}
        />
      </div>

      {/* Picks tray (cards view only — list view lives in the right rail) */}
      {prefs.view === "cards" && (
        <PicksTray
          picks={picks}
          cards={cards}
          lanesApi={lanesApi}
          trayH={prefs.h}
          onResize={(h) => setPrefs((p) => ({ ...p, h }))}
          view={prefs.view}
          onView={(view) => setPrefs((p) => ({ ...p, view }))}
          onPackPick={(id, laneId) => void pickToLane(id, laneId)}
        />
      )}
    </div>
    </div>
  );
}
