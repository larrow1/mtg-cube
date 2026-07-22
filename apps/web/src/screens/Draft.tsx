/**
 * Draft: pack grid with select/confirm (double-click to snap-pick), pick
 * timer, seat strip, a resizable bottom picks tray with drag-organizable
 * lanes + pinned sideboard, and a right stats rail (type counts, live curve,
 * color split) with an alternate compact list view of picks.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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

const BOT_AVATAR_COLORS = ["white", "red", "green", "blue", "purple", "gold", "charcoal", "pink"] as const;
const DRAFT_TABLE_RUNES = ["ᚠ", "ᚢ", "ᚦ", "ᚨ", "ᚱ", "ᚲ", "ᚷ", "ᚹ", "ᚺ", "ᚾ", "ᛁ", "ᛃ", "ᛇ", "ᛈ", "ᛉ", "ᛋ"] as const;

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
          {seat.queuedPacks > 0 && (
            <span className="flex items-center gap-0.5" title={`${seat.queuedPacks} pack${seat.queuedPacks === 1 ? "" : "s"} waiting`}>
              {Array.from({ length: Math.min(seat.queuedPacks, 8) }).map((_, i) => (
                <span key={i} className="h-1.5 w-1.5 rounded-full bg-brass-400" />
              ))}
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
  const faceUpCardIds = useMemo(
    () => draft.seats.flatMap((seat) => seat.faceUpPicks.map((pick) => pick.cardId)),
    [draft.seats]
  );
  const faceUpCards = useCardData(faceUpCardIds);
  const passLeft = draft.packNumber % 2 === 1;
  const step = 360 / Math.max(1, seatCount);
  const playerStartAngle = 90;
  // The table content lives in a centered square canvas inside the full-width
  // backdrop, so equal radii keep every seat precisely on the circular rim.
  const seatRadiusX = 36;
  const seatRadiusY = 36;
  // The dark outer rim sits just beyond the felt edge; center the arrowheads
  // within that band rather than on the inner border line.
  const arrowRadiusX = seatRadiusX * 1.03;
  const arrowRadiusY = seatRadiusY * 1.03;

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
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 backdrop-blur-[3px]"
      role="dialog"
      aria-modal="true"
      aria-label="Draft table overview"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="draft-table-stage relative h-[min(72vh,36rem)] min-h-[24rem] w-full animate-pop-in overflow-hidden border-y border-white/[0.06]">
        <div className="draft-table-canvas relative mx-auto aspect-square h-full">
            <div className="draft-table-felt absolute left-1/2 top-1/2 aspect-square h-[72%] -translate-x-1/2 -translate-y-1/2 rounded-full border">
              <svg className="draft-table-rune-wheel absolute inset-0 h-full w-full" viewBox="0 0 400 400" aria-hidden="true">
                <circle cx="200" cy="200" r="184" />
                <circle cx="200" cy="200" r="158" />
                {DRAFT_TABLE_RUNES.map((rune, runeIndex) => (
                  <g key={rune} transform={`rotate(${runeIndex * 22.5} 200 200)`}>
                    <path d="M200 17v19" />
                    <path d="M191 43h18" />
                    <text x="200" y="61" textAnchor="middle">{rune}</text>
                  </g>
                ))}
                {Array.from({ length: 8 }).map((_, spokeIndex) => (
                  <path
                    key={spokeIndex}
                    d="M200 74v35l-9 13 18 18-9 13"
                    transform={`rotate(${spokeIndex * 45} 200 200)`}
                  />
                ))}
                <path className="draft-table-knot" d="M200 126l24 32-24 24-24-24 24-32Zm0 56 30 30-30 62-30-62 30-30Zm-42 18 42 12 42-12-12 42-30 32-30-32-12-42Z" />
              </svg>
              <div className="draft-table-ring absolute inset-[7%] rounded-full border" />
              <div className="draft-table-ring absolute inset-[21%] rounded-full border" />
              <div className="draft-table-ring absolute inset-[35%] rounded-full border" />
              <div className="draft-table-center-mark absolute left-1/2 top-1/2 h-[14%] w-[14%] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[18%] border" />
            </div>

            {draft.seats.map((seat) => {
              const angle = playerStartAngle + relativeIndex(seat.seatIndex) * step;
              const position = pointOnTable(angle, seatRadiusX, seatRadiusY);
              // Keep face-up draft cards on the exact radial path from their
              // owner to the table center, about two-thirds of the way out.
              const faceUpPickPosition = pointOnTable(angle, seatRadiusX * 0.67, seatRadiusY * 0.67);
              const isMe = seat.seatIndex === draft.seatIndex;
              const faceUpPick = seat.faceUpPicks.length > 0 ? (
                <div
                  className="draft-table-face-up-pick"
                  style={faceUpPickPosition}
                  title={`${seat.faceUpPicks.length} face-up Cogwork Librarian${seat.faceUpPicks.length === 1 ? "" : "s"}`}
                >
                  {seat.faceUpPicks.map((pick) => (
                    <Card
                      key={pick.instanceId}
                      data={faceUpCards[pick.cardId]}
                      size="xs"
                      className="!w-8"
                      previewPlacement="above"
                      title="Cogwork Librarian — drafted face up"
                    />
                  ))}
                </div>
              ) : null;
              return (
                <Fragment key={seat.seatIndex}>
                  <div
                    className={`draft-table-seat absolute -translate-x-1/2 -translate-y-1/2 text-center ${isMe ? "is-me h-14 w-14 sm:h-16 sm:w-16" : "h-10 w-10 sm:h-12 sm:w-12"}`}
                    style={position}
                  >
                    <span
                      className="draft-table-player-icon relative z-10 flex h-full w-full rounded-full"
                      tabIndex={0}
                      aria-label={`${seat.playerName ?? `Bot ${seat.seatIndex + 1}`}${isMe ? " (you)" : ""}`}
                    >
                      {seat.isBot ? (
                        <img
                          src={`/avatars/draft-bot-${botAvatarColor(seat.seatIndex)}.webp`}
                          alt=""
                          className="h-full w-full rounded-full border border-brass-300/60 object-cover shadow-[0_0_12px_rgba(242,182,75,0.32)]"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center rounded-full border border-sky-200/55 bg-gradient-to-br from-sky-600 via-sky-800 to-slate-950 text-xs font-black text-white shadow-[0_0_12px_rgba(56,189,248,0.32)]">
                          {(seat.playerName ?? "P").slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <span className={`draft-table-player-name ${isMe ? "text-amber-200" : "text-zinc-100"}`}>
                        {seat.playerName ?? `Bot ${seat.seatIndex + 1}`}{isMe ? " (you)" : ""}
                      </span>
                    </span>
                    {seat.queuedPacks > 0 && (
                      <span
                        className="draft-table-pack-stack flex items-end justify-center gap-[2px]"
                        title={`${seat.queuedPacks} pack${seat.queuedPacks === 1 ? "" : "s"} at this seat`}
                      >
                        {Array.from({ length: Math.min(8, seat.queuedPacks) }).map((_, packIndex) => (
                          <span
                            key={packIndex}
                            className="draft-table-pack-card"
                            style={{ zIndex: packIndex + 1 }}
                          />
                        ))}
                      </span>
                    )}
                  </div>
                  {faceUpPick}
                </Fragment>
              );
            })}

            {seatCount > 1 && ([-0.5, 0.5] as const).map((relativeOffset) => {
              const travel = passLeft ? 1 : -1;
              const middleAngle = playerStartAngle + relativeOffset * step;
              // Only mark the two gaps immediately beside the current player.
              const position = pointOnTable(middleAngle, arrowRadiusX, arrowRadiusY);
              const rotation = middleAngle + travel * 90;
              return (
                <span
                  key={`arrow-${relativeOffset}`}
                  className="draft-table-pass-arrow absolute flex h-8 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                  style={{ ...position, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
                  aria-hidden="true"
                >
                  <svg viewBox="0 0 28 16" className="draft-table-arrow-glyph h-full w-full">
                    <path d="M1.5 1.5 13.5 8 1.5 14.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M14.5 1.5 26.5 8 14.5 14.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              );
            })}
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

export function Draft({ onFinalPickAnimationComplete }: { onFinalPickAnimationComplete?: () => void } = {}): JSX.Element {
  const { state, pushToast } = useApp();
  const draft = state.draft;
  const ranked = state.room?.ranked ?? false;
  const [selected, setSelected] = useState<string | null>(null);
  const [additionalSelected, setAdditionalSelected] = useState<string[]>([]);
  const [useCogwork, setUseCogwork] = useState(false);
  const [picking, setPicking] = useState(false);
  const [tableOverviewOpen, setTableOverviewOpen] = useState(false);
  const [deckStatsOpen, setDeckStatsOpen] = useState(false);
  const [visiblePack, setVisiblePack] = useState<AnimatedPack>(() => ({
    pack: state.draft?.currentPack ?? null,
    round: state.draft?.packNumber ?? 1,
  }));
  const [outgoingPack, setOutgoingPack] = useState<AnimatedPack | null>(null);
  const [pickFlight, setPickFlight] = useState<PickFlight | null>(null);
  const knownPickStateRef = useRef({
    draftId: state.draft?.draftId ?? null,
    ids: new Set(state.draft?.picks.map((pick) => pick.instanceId) ?? []),
  });

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
    setAdditionalSelected([]);
    setUseCogwork(false);
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
  const availableCogworks = picks.filter((pick) => pick.draftEffect === "cogwork-librarian").length;
  const lanesApi = useDraftLanes(draft?.draftId, picks, cards);

  // Manual picks capture their source before the request is sent. Timer
  // autopicks arrive only as a new server draft state, so detect the newly
  // added pick during layout while the old visible pack is still mounted and
  // route it through the same pick-flight animation.
  useLayoutEffect(() => {
    if (!draft) return;
    const known = knownPickStateRef.current;
    if (known.draftId !== draft.draftId) {
      knownPickStateRef.current = {
        draftId: draft.draftId,
        ids: new Set(draft.picks.map((pick) => pick.instanceId)),
      };
      return;
    }

    const addedPick = draft.picks.find((pick) => !known.ids.has(pick.instanceId));
    knownPickStateRef.current = {
      draftId: draft.draftId,
      ids: new Set(draft.picks.map((pick) => pick.instanceId)),
    };
    if (!addedPick || pickFlight) return;

    const source = document.querySelector<HTMLElement>(
      `[data-pack-card-instance="${addedPick.instanceId}"]`
    );
    if (!source) return;
    setPickFlight({
      instanceId: addedPick.instanceId,
      cardId: addedPick.cardId,
      source: rectValues(source.getBoundingClientRect()),
      target: null,
      view: prefs.view,
    });
  }, [draft, pickFlight, prefs.view]);

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
    const finishedDraft = draft.complete;
    if (pickFlight) {
      document
        .querySelector<HTMLElement>(`[data-draft-pick-instance="${pickFlight.instanceId}"]`)
        ?.classList.remove("draft-pick-arrival");
    }
    setPickFlight(null);
    if (finishedDraft) onFinalPickAnimationComplete?.();
  };

  const makePick = async (instanceId: string, additionalInstanceIds: string[] = []): Promise<void> => {
    if (picking) return;
    beginPickFlight(instanceId);
    setPicking(true);
    const r = await call("makePick", { instanceId, additionalInstanceIds });
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

  const togglePackSelection = (instanceId: string): void => {
    if (!useCogwork || !selected) {
      setSelected((current) => current === instanceId ? null : instanceId);
      setAdditionalSelected([]);
      return;
    }
    if (selected === instanceId) {
      setSelected(null);
      setAdditionalSelected([]);
      return;
    }
    setAdditionalSelected((current) => {
      if (current.includes(instanceId)) return current.filter((id) => id !== instanceId);
      if (current.length >= availableCogworks) return current;
      return [...current, instanceId];
    });
  };

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
            selected={interactive && (selected === dc.instanceId || additionalSelected.includes(dc.instanceId))}
            highlight={interactive && autoPickId === dc.instanceId ? "autopick" : null}
            dimmed={interactive && picking}
            className="!w-full"
            disablePreview={!interactive}
            draggable={interactive && !picking}
            onDragStart={interactive ? (event) => {
              setSelected(dc.instanceId);
              setPackPickData(event.dataTransfer, dc.instanceId);
            } : undefined}
            onClick={interactive ? () => togglePackSelection(dc.instanceId) : undefined}
            onDoubleClick={interactive && !useCogwork ? () => void makePick(dc.instanceId) : undefined}
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
              {availableCogworks > 0 && (draft.currentPack?.cards.length ?? 0) > 1 && (
                <button
                  type="button"
                  className={`draft-cogwork-button px-3 py-2 text-[10px] font-black uppercase tracking-[0.08em] ${useCogwork ? "is-active" : ""}`}
                  disabled={picking}
                  aria-pressed={useCogwork}
                  title="Draft one additional card for each Cogwork Librarian you return to this pack"
                  onClick={() => {
                    setUseCogwork((current) => !current);
                    setAdditionalSelected([]);
                  }}
                >
                  <span aria-hidden="true">⚙</span>
                  <span>{useCogwork ? "Cogwork active" : "Use Cogwork"}</span>
                  {availableCogworks > 1 && <span>×{availableCogworks}</span>}
                </button>
              )}
              <button
                type="button"
                className="draft-confirm-button min-w-[142px] px-6 py-2.5"
                disabled={!selected || picking || !draft.currentPack || (useCogwork && additionalSelected.length === 0)}
                onClick={() => {
                  if (selected) void makePick(selected, useCogwork ? additionalSelected : []);
                }}
              >
                {picking
                  ? "Picking…"
                  : selected
                    ? useCogwork && additionalSelected.length === 0
                      ? "Select extra card"
                      : additionalSelected.length > 0
                        ? `Confirm ${1 + additionalSelected.length} picks`
                        : "Confirm pick"
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
