/**
 * Draft: pack grid with select/confirm (double-click to snap-pick), pick
 * timer, seat strip, a resizable bottom picks tray with drag-organizable
 * lanes + pinned sideboard, and a right stats rail (type counts, live curve,
 * color split) with an alternate compact list view of picks.
 */
import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { DraftView, Pack } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { useCardData } from "../lib/cardCache";
import { formatSeconds } from "../lib/cards";
import { setPackPickData } from "../lib/dnd";
import { useDraftLanes } from "../lib/draftLanes";
import { Card } from "../components/Card";
import { CardGrid } from "../components/CardGrid";
import { AUTO_LANE, PicksTray, ViewToggle, clampTrayH } from "../components/PicksTray";
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

type DraftSeatSummary = DraftView["seats"][number];

function DraftSeatChip({ seat, isMe, position }: { seat: DraftSeatSummary; isMe: boolean; position: "left" | "right" | "center" }): JSX.Element {
  return (
    <div
      className={`draft-seat-chip flex h-11 w-36 min-w-0 shrink-0 items-center gap-2 rounded-xl border px-2.5 text-xs ${isMe ? "is-me" : ""}`}
      title={isMe ? "Your seat" : `${position === "left" ? "Left" : "Right"} neighbor`}
    >
      {seat.isBot ? (
        <img
          src={`/avatars/draft-bot-${botAvatarColor(seat.seatIndex)}.webp`}
          alt="Bot"
          title="Bot-controlled seat"
          className="h-7 w-7 shrink-0 rounded-full border border-brass-300/60 object-cover shadow-[0_0_8px_rgba(242,182,75,0.22)]"
        />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-200/35 bg-sky-400/15 text-[9px] font-black text-sky-100 shadow-[0_0_8px_rgba(56,189,248,0.16)]">
          {(seat.playerName ?? "P").slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-semibold leading-tight ${isMe ? "text-brass-200" : "text-zinc-200"}`}>
          {seat.playerName ?? `Bot ${seat.seatIndex + 1}`}
          {isMe && <span className="text-zinc-500"> (you)</span>}
        </span>
        <span className="mt-0.5 flex h-2.5 items-center gap-1 text-[9px] leading-none tabular-nums text-zinc-500">
          <span title="Cards picked">{seat.pickCount} picked</span>
          {seat.queuedPacks > 0 && (
            <span className="flex items-center gap-0.5" title={`${seat.queuedPacks} pack${seat.queuedPacks === 1 ? "" : "s"} waiting`}>
              {Array.from({ length: Math.min(seat.queuedPacks, 3) }).map((_, i) => (
                <span key={i} className="h-1.5 w-1.5 rounded-full bg-brass-400" />
              ))}
              {seat.queuedPacks > 3 && <span className="text-brass-300">+{seat.queuedPacks - 3}</span>}
            </span>
          )}
        </span>
      </span>
    </div>
  );
}

function PackPassArrow({ direction }: { direction: "left" | "right" }): JSX.Element {
  return (
    <span
      className="flex shrink-0 items-center justify-center text-orange-300 drop-shadow-[0_0_6px_rgba(251,146,60,0.55)]"
      title={`Packs pass ${direction}`}
      aria-label={`Packs pass ${direction}`}
    >
      <svg viewBox="0 0 28 16" className={`h-4 w-7 fill-current ${direction === "left" ? "rotate-180" : ""}`} aria-hidden="true">
        <path d="M2 6.5h17.2l-4-4L17.7 0 26 8l-8.3 8-2.5-2.5 4-4H2v-3Z" />
      </svg>
    </span>
  );
}

function SeatStrip({ draft }: { draft: DraftView }): JSX.Element {
  const seatCount = draft.seats.length;
  const me = draft.seats.find((seat) => seat.seatIndex === draft.seatIndex);
  const left = draft.seats.find((seat) => seat.seatIndex === (draft.seatIndex + 1) % seatCount);
  const right = draft.seats.find((seat) => seat.seatIndex === (draft.seatIndex - 1 + seatCount) % seatCount);
  const direction = draft.packNumber % 2 === 1 ? "left" : "right";

  if (!me || !left || !right) return <div />;

  if (seatCount === 2) {
    return (
      <div className="flex min-w-0 items-center justify-center gap-2">
        {direction === "left" ? (
          <>
            <DraftSeatChip seat={left} isMe={false} position="left" />
            <PackPassArrow direction="left" />
            <DraftSeatChip seat={me} isMe position="center" />
          </>
        ) : (
          <>
            <DraftSeatChip seat={me} isMe position="center" />
            <PackPassArrow direction="right" />
            <DraftSeatChip seat={right} isMe={false} position="right" />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center justify-center gap-2">
      <DraftSeatChip seat={left} isMe={false} position="left" />
      <PackPassArrow direction={direction} />
      <DraftSeatChip seat={me} isMe position="center" />
      <PackPassArrow direction={direction} />
      <DraftSeatChip seat={right} isMe={false} position="right" />
    </div>
  );
}

function DraftTableOverview({ draft, onClose }: { draft: DraftView; onClose: () => void }): JSX.Element {
  const seatCount = draft.seats.length;
  const passLeft = draft.packNumber % 2 === 1;
  const direction = passLeft ? "left" : "right";
  const step = 360 / Math.max(1, seatCount);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const relativeIndex = (seatIndex: number): number => (seatIndex - draft.seatIndex + seatCount) % seatCount;
  const pointOnTable = (angle: number, radiusX: number, radiusY: number): { left: string; top: string } => {
    const radians = angle * Math.PI / 180;
    return {
      left: `${50 + Math.cos(radians) * radiusX}%`,
      top: `${50 + Math.sin(radians) * radiusY}%`,
    };
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-[3px]"
      role="dialog"
      aria-modal="true"
      aria-label="Draft table overview"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="draft-table-overview flex max-h-[92vh] w-full max-w-4xl animate-pop-in flex-col overflow-hidden rounded-2xl border">
        <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3 sm:px-5">
          <div>
            <h2 className="text-sm font-black uppercase tracking-[0.16em] text-zinc-100">Draft table</h2>
            <p className="mt-0.5 text-[11px] text-zinc-400">
              Pack {draft.packNumber} · Passing {direction}
            </p>
          </div>
          <button type="button" className="btn-ghost !rounded-full !p-2" onClick={onClose} aria-label="Close table overview">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3 1.4 1.4Z" /></svg>
          </button>
        </header>

        <div className="scrollbar-slim overflow-auto p-3 sm:p-5">
          <div className="draft-table-stage relative mx-auto aspect-[16/10] min-w-[34rem] overflow-hidden rounded-2xl border border-white/[0.08]">
            <div className="draft-table-felt absolute left-1/2 top-1/2 h-[54%] w-[62%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border">
              <div className="absolute inset-[7%] rounded-[50%] border border-emerald-200/10" />
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-emerald-100/45">Current round</span>
                <span className="mt-1 text-xl font-black text-amber-200">Pack {draft.packNumber}</span>
                <span className="mt-1 text-xs font-bold uppercase tracking-wider text-orange-300">Passing {direction}</span>
              </div>
            </div>

            {draft.seats.map((seat) => {
              const angle = 90 + relativeIndex(seat.seatIndex) * step;
              const position = pointOnTable(angle, 42, 39);
              const isMe = seat.seatIndex === draft.seatIndex;
              return (
                <div
                  key={seat.seatIndex}
                  className={`draft-table-seat absolute flex w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-xl border px-2 py-1.5 text-center sm:w-28 ${isMe ? "is-me" : ""}`}
                  style={position}
                >
                  {seat.isBot ? (
                    <img
                      src={`/avatars/draft-bot-${botAvatarColor(seat.seatIndex)}.webp`}
                      alt="Bot"
                      className="h-8 w-8 rounded-full border border-brass-300/60 object-cover shadow-[0_0_10px_rgba(242,182,75,0.28)]"
                    />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-full border border-sky-200/30 bg-sky-400/15 text-xs font-black text-sky-100">
                      {(seat.playerName ?? "P").slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className={`mt-1 w-full truncate text-[11px] font-bold ${isMe ? "text-amber-200" : "text-zinc-200"}`}>
                    {seat.playerName ?? `Bot ${seat.seatIndex + 1}`}{isMe ? " (you)" : ""}
                  </span>
                  <span className="text-[9px] tabular-nums text-zinc-500">{seat.pickCount} picked</span>
                  {seat.queuedPacks > 0 && (
                    <span className="mt-1 flex items-center" title={`${seat.queuedPacks} pack${seat.queuedPacks === 1 ? "" : "s"} at this seat`}>
                      {Array.from({ length: Math.min(3, seat.queuedPacks) }).map((_, index) => (
                        <span
                          key={index}
                          className={`h-4 w-3 rounded-[2px] border border-amber-200/55 bg-gradient-to-br from-amber-700 via-orange-900 to-zinc-950 shadow-sm ${index > 0 ? "-ml-1" : ""}`}
                        />
                      ))}
                      <span className="ml-1 text-[9px] font-black text-amber-200">×{seat.queuedPacks}</span>
                    </span>
                  )}
                </div>
              );
            })}

            {draft.seats.map((seat) => {
              const travel = passLeft ? 1 : -1;
              const middleAngle = 90 + (relativeIndex(seat.seatIndex) + travel * 0.5) * step;
              const position = pointOnTable(middleAngle, 31, 28);
              const rotation = middleAngle + travel * 90;
              return (
                <span
                  key={`arrow-${seat.seatIndex}`}
                  className="draft-table-pass-arrow absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
                  style={{ ...position, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M3 10.5h12.2L11 6.3 13.3 4 21 12l-7.7 8-2.3-2.3 4.2-4.2H3v-3Z" /></svg>
                </span>
              );
            })}
          </div>
          <p className="mt-3 text-center text-[10px] text-zinc-500">Pack icons show how many packs are currently waiting at each seat.</p>
        </div>
      </div>
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
}

interface AnimatedPack {
  pack: Pack | null;
  round: number;
}

interface PickFlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PickFlight {
  instanceId: string;
  cardId: string;
  source: PickFlightRect;
  target: PickFlightRect | null;
  view: "cards" | "list";
}

function rectValues(rect: DOMRect): PickFlightRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function PickFlightOverlay({
  flight,
  data,
  onDone,
}: {
  flight: PickFlight;
  data: ReturnType<typeof useCardData>[string] | undefined;
  onDone: () => void;
}) {
  const target = flight.target;
  const sourceCenterX = flight.source.left + flight.source.width / 2;
  const sourceCenterY = flight.source.top + flight.source.height / 2;
  const targetCenterX = target ? target.left + target.width / 2 : sourceCenterX;
  const targetCenterY = target ? target.top + target.height / 2 : sourceCenterY;
  const deltaX = targetCenterX - sourceCenterX;
  const deltaY = targetCenterY - sourceCenterY;
  const targetScale = target
    ? Math.min(1, target.width / flight.source.width, target.height / flight.source.height)
    : 1;
  const midpointX = deltaX * 0.56;
  const midpointY = deltaY * 0.38 - Math.min(72, Math.max(28, Math.abs(deltaX) * 0.08));
  const style = {
    left: flight.source.left,
    top: flight.source.top,
    width: flight.source.width,
    height: flight.source.height,
    "--pick-flight-x": `${deltaX}px`,
    "--pick-flight-y": `${deltaY}px`,
    "--pick-flight-mid-x": `${midpointX}px`,
    "--pick-flight-mid-y": `${midpointY}px`,
    "--pick-flight-scale": targetScale,
    "--pick-flight-scale-overshoot": targetScale * 1.16,
  } as CSSProperties;

  return createPortal(
    <div
      className={`draft-pick-flight ${target ? "is-flying" : "is-waiting"} ${flight.view === "list" ? "to-list" : "to-cards"}`}
      style={style}
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && target) onDone();
      }}
    >
      <Card data={data} size="md" className="!h-full !w-full" disablePreview />
      <span className="draft-pick-flight-glow" />
    </div>,
    document.body
  );
}

const DEFAULT_PREFS: TrayPrefs = { h: 232, view: "list" };

function loadTrayPrefs(): TrayPrefs {
  try {
    const raw = localStorage.getItem(TRAY_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<TrayPrefs> | null;
    if (!p || typeof p !== "object") return DEFAULT_PREFS;
    return {
      h: typeof p.h === "number" && Number.isFinite(p.h) ? clampTrayH(p.h) : DEFAULT_PREFS.h,
      view: "list",
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
  const [tableOverviewOpen, setTableOverviewOpen] = useState(false);
  const [deckStatsOpen, setDeckStatsOpen] = useState(false);
  const [visiblePack, setVisiblePack] = useState<AnimatedPack>(() => ({
    pack: state.draft?.currentPack ?? null,
    round: state.draft?.packNumber ?? 1,
  }));
  const [outgoingPack, setOutgoingPack] = useState<AnimatedPack | null>(null);
  const [pickFlight, setPickFlight] = useState<PickFlight | null>(null);

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

  useEffect(() => {
    const nextPack = draft?.currentPack ?? null;
    const nextRound = draft?.packNumber ?? visiblePack.round;
    if ((visiblePack.pack?.id ?? null) === (nextPack?.id ?? null) && visiblePack.round === nextRound) return;
    if (visiblePack.pack) setOutgoingPack(visiblePack);
    setVisiblePack({ pack: nextPack, round: nextRound });
  }, [draft?.currentPack, draft?.packNumber, visiblePack]);

  useEffect(() => {
    if (!outgoingPack) return;
    const timeout = window.setTimeout(() => setOutgoingPack(null), 1320);
    return () => window.clearTimeout(timeout);
  }, [outgoingPack]);

  // Re-enable picking + clear selection whenever a new pack/pick state arrives.
  useEffect(() => {
    setPicking(false);
    setSelected(null);
  }, [packKey, pickCount]);

  const allIds = useMemo(() => {
    if (!draft) return [];
    return [
      ...(draft.currentPack?.cards ?? []),
      ...(visiblePack.pack?.cards ?? []),
      ...(outgoingPack?.pack?.cards ?? []),
      ...draft.picks,
    ].map((c) => c.cardId);
  }, [draft, outgoingPack, visiblePack]);
  const cards = useCardData(allIds);

  const remaining = useCountdown(draft?.pickDeadline ?? null);

  const picks = useMemo(() => draft?.picks ?? [], [draft]);
  const lanesApi = useDraftLanes(draft?.draftId, picks, cards);

  useLayoutEffect(() => {
    if (!draft || !pickFlight || pickFlight.target) return;
    if (!draft.picks.some((pick) => pick.instanceId === pickFlight.instanceId)) return;

    let measureFrame = 0;
    const revealFrame = window.requestAnimationFrame(() => {
      const destination = document.querySelector<HTMLElement>(
        `[data-draft-pick-instance="${pickFlight.instanceId}"]`
      );
      if (!destination) return;
      destination.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
      measureFrame = window.requestAnimationFrame(() => {
        const rect = destination.getBoundingClientRect();
        destination.classList.add("draft-pick-arrival");
        setPickFlight((current) =>
          current?.instanceId === pickFlight.instanceId
            ? { ...current, target: rectValues(rect) }
            : current
        );
      });
    });

    return () => {
      window.cancelAnimationFrame(revealFrame);
      if (measureFrame) window.cancelAnimationFrame(measureFrame);
    };
  }, [draft, pickFlight]);

  if (!draft) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="panel animate-fade-in px-6 py-4 text-sm text-zinc-400">Waiting for the draft to begin…</div>
      </div>
    );
  }

  const pickNumber = (draft.picks.length % draft.cardsPerPack) + 1;

  const beginPickFlight = (instanceId: string): void => {
    const source = document.querySelector<HTMLElement>(
      `[data-pack-card-instance="${instanceId}"]`
    );
    const packCard = draft.currentPack?.cards.find((card) => card.instanceId === instanceId);
    if (!source || !packCard) return;
    setPickFlight({
      instanceId,
      cardId: packCard.cardId,
      source: rectValues(source.getBoundingClientRect()),
      target: null,
      view: prefs.view,
    });
  };

  const finishPickFlight = (): void => {
    if (pickFlight) {
      document
        .querySelector<HTMLElement>(`[data-draft-pick-instance="${pickFlight.instanceId}"]`)
        ?.classList.remove("draft-pick-arrival");
    }
    setPickFlight(null);
  };

  const makePick = async (instanceId: string): Promise<void> => {
    if (picking) return;
    beginPickFlight(instanceId);
    setPicking(true);
    const r = await call("makePick", { instanceId });
    if (!r.ok) {
      setPickFlight(null);
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
  const packDirection = (round: number): "left" | "right" => round % 2 === 1 ? "left" : "right";
  const outgoingDirection = outgoingPack ? packDirection(outgoingPack.round) : null;
  const incomingDirection = packDirection(visiblePack.round) === "left" ? "right" : "left";
  const visiblePackIsLive = (visiblePack.pack?.id ?? null) === (draft.currentPack?.id ?? null);

  const renderPackGrid = (pack: Pack, interactive: boolean): JSX.Element => (
    <CardGrid
      columns={5}
      min={prefs.view === "list" ? 132 : 160}
      className={`draft-pack-grid ${prefs.view === "list" ? "is-list-view" : ""}`}
    >
      {pack.cards.map((dc) => (
        <div
          key={dc.instanceId}
          data-pack-card-instance={dc.instanceId}
          className={`draft-pack-card-slot w-full ${pickFlight?.instanceId === dc.instanceId ? "is-pick-flight-source" : ""}`}
        >
          <Card
            data={cards[dc.cardId]}
            size="md"
            selected={interactive && selected === dc.instanceId}
            highlight={interactive && autoPickId === dc.instanceId ? "autopick" : null}
            dimmed={interactive && picking}
            className="!w-full"
            disablePreview={!interactive}
            draggable={interactive && !picking}
            onDragStart={interactive ? (event) => {
              setSelected(dc.instanceId);
              setPackPickData(event.dataTransfer, dc.instanceId);
            } : undefined}
            onClick={interactive ? () => setSelected((cur) => (cur === dc.instanceId ? null : dc.instanceId)) : undefined}
            onDoubleClick={interactive ? () => void makePick(dc.instanceId) : undefined}
          />
        </div>
      ))}
    </CardGrid>
  );

  return (
    <div className="draft-scene h-full overflow-hidden">
    <div className="relative z-10 mx-auto flex h-full max-w-[110rem] flex-col gap-2.5 p-3">
      {/* Header */}
      <header className="panel draft-header flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="draft-round-status flex shrink-0 items-baseline gap-3">
          <span className="draft-round-label text-lg font-black">
            Pack <span>{draft.packNumber}</span>
            <span>/{draft.packsPerPlayer}</span>
          </span>
          <span className="draft-round-label text-sm font-bold">
            Pick <span>{Math.min(pickNumber, draft.cardsPerPack)}</span>
          </span>
        </div>
        {ranked && <span className="chip border-brass-400/60 font-black tracking-widest text-brass-300">RANKED</span>}
        <div className="relative min-w-0 flex-1">
          <SeatStrip draft={draft} />
          <button
            type="button"
            className="absolute inset-0 z-10 cursor-pointer rounded-xl bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/80"
            onClick={() => setTableOverviewOpen(true)}
            aria-label="View the full draft table"
            title="View the full draft table"
          />
        </div>
        <div className="draft-header-view-bar flex shrink-0 items-center gap-1.5 px-2 py-1">
          <button
            type="button"
            className={`draft-deck-stats-toggle flex min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] transition-colors duration-150 ${deckStatsOpen ? "is-open text-amber-100" : "text-zinc-300 hover:text-amber-200"}`}
            onClick={() => setDeckStatsOpen((current) => !current)}
            aria-expanded={deckStatsOpen}
            aria-controls="draft-deck-stats-panel"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 fill-current" aria-hidden="true"><path d="M4 19h16v2H4v-2Zm1-8h3v6H5v-6Zm5-4h3v10h-3V7Zm5-4h3v14h-3V3Z" /></svg>
            <span>Deck Stats</span>
            <svg viewBox="0 0 24 24" className={`h-3 w-3 shrink-0 fill-current transition-transform duration-200 ${deckStatsOpen ? "rotate-180" : ""}`} aria-hidden="true"><path d="m7 10 5 5 5-5H7Z" /></svg>
          </button>
          <ViewToggle view={prefs.view} onView={(view) => setPrefs((p) => ({ ...p, view }))} />
        </div>
      </header>

      {/* Pack + stats rail */}
      <div className="flex min-h-0 flex-1 gap-2.5">
        <main className="panel draft-pack-zone relative min-h-0 flex-1 overflow-hidden p-4">
          {draft.complete && !visiblePack.pack ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <svg viewBox="0 0 24 24" className="h-10 w-10 fill-brass-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.45)]"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" /></svg>
              <div className="text-lg font-bold text-zinc-100">Draft complete</div>
              <div className="text-sm text-zinc-500">Moving to deck building…</div>
            </div>
          ) : !visiblePack.pack ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="h-2.5 w-2.5 animate-pulse rounded-full bg-brass-400/70" style={{ animationDelay: `${i * 200}ms` }} />
                ))}
              </div>
              <div className="text-sm font-semibold text-zinc-300">Waiting for the next pack…</div>
              <div className="text-xs text-zinc-500">Your neighbor is still deliberating.</div>
            </div>
          ) : null}

          {visiblePack.pack && (
            <div
              key={`${visiblePack.round}-${visiblePack.pack.id}`}
              className={`pack-sweep-layer pack-sweep-enter-${incomingDirection} ${outgoingPack ? "wait-for-pack-exit" : ""} absolute bottom-[6.25rem] left-4 right-4 top-4 z-10`}
            >
              {renderPackGrid(visiblePack.pack, visiblePackIsLive)}
            </div>
          )}

          {outgoingPack?.pack && outgoingDirection && (
            <div className={`pack-sweep-layer pack-sweep-exit-${outgoingDirection} pointer-events-none absolute bottom-[6.25rem] left-4 right-4 top-4 z-20`}>
              {renderPackGrid(outgoingPack.pack, false)}
            </div>
          )}

          <div className="draft-bottom-pick-bar absolute bottom-2.5 left-4 right-4 z-40 flex items-center justify-center">
            <div className="draft-bottom-pick-controls flex items-center gap-3 px-3 py-1.5">
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
                    <div className="draft-timer-fill" style={{ width: `${timerPercent}%` }} />
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
          </div>
        </main>

        <PicksRail
          picks={picks}
          cards={cards}
          lanesApi={lanesApi}
          view={prefs.view}
          open={deckStatsOpen}
          onToggleOpen={() => setDeckStatsOpen((current) => !current)}
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
          onPackPick={(id, laneId) => void pickToLane(id, laneId)}
        />
      )}
      {pickFlight && (
        <PickFlightOverlay
          flight={pickFlight}
          data={cards[pickFlight.cardId]}
          onDone={finishPickFlight}
        />
      )}
    </div>
    {tableOverviewOpen && <DraftTableOverview draft={draft} onClose={() => setTableOverviewOpen(false)} />}
    </div>
  );
}
