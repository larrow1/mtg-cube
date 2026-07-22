/**
 * Resizable bottom picks tray for the Draft screen ("Cards" view):
 * Arena/CubeCobra-style vertical lanes where cards stack with only a name band
 * visible, drag-to-move between lanes, drag-to-create lanes, inline lane
 * rename, and a pinned Sideboard lane. Height is user-draggable via the grip.
 */
import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { CardData, DraftCard } from "@mtg-cube/shared";
import { Card } from "./Card";
import { getPackPickInstanceId } from "../lib/dnd";
import { SIDEBOARD_LANE_ID, isUnnamedLane, type DraftLanes, type Lane } from "../lib/draftLanes";

/**
 * Drop handler for dropping a card straight from the current pack onto a lane
 * (performs the pick, then lands the card in that lane). `laneId === null`
 * means "create a new lane for it".
 */
export type PackPickDrop = (instanceId: string, laneId: string | null) => void;

/**
 * Sentinel laneId for pack-pick drops with no explicit lane (the tray's empty
 * state): the pick happens, the card falls into its natural cmc lane.
 */
export const AUTO_LANE = "__auto__";

export const TRAY_MIN_H = 120;
export const trayMaxH = (): number => Math.round(window.innerHeight * 0.65);
export const clampTrayH = (h: number): number => Math.max(TRAY_MIN_H, Math.min(trayMaxH(), Math.round(h)));

const DRAG_MIME = "text/plain";

function LaneHeader({
  lane,
  count,
  renamable,
  onRename,
  accent,
}: {
  lane: Lane;
  count: number;
  renamable: boolean;
  onRename: (name: string) => void;
  accent?: boolean;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(lane.name);

  const commit = (): void => {
    setEditing(false);
    onRename(val);
  };

  // Default cmc lanes stay headerless until the user names them — only a
  // subtle hover-only "name" affordance occupies the header row.
  const unnamed = !accent && isUnnamedLane(lane);

  return (
    <div className="mb-1 flex h-4 items-center gap-1 px-0.5">
      {editing ? (
        <input
          autoFocus
          className="w-full rounded border border-brass-400/50 bg-felt-950/90 px-1 text-[10px] font-bold uppercase tracking-wider text-zinc-100 outline-none"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setVal(lane.name);
              setEditing(false);
            }
          }}
        />
      ) : unnamed ? (
        renamable && (
          <button
            type="button"
            className="truncate text-[9px] font-semibold uppercase tracking-wider text-zinc-500 opacity-0 transition-opacity duration-150 hover:text-brass-300 group-hover:opacity-100"
            title="Name this lane"
            onClick={() => {
              setVal("");
              setEditing(true);
            }}
          >
            + name
          </button>
        )
      ) : (
        <button
          type="button"
          className={`truncate text-[10px] font-bold uppercase tracking-wider ${
            accent ? "text-amber-300" : "text-zinc-400"
          } ${renamable ? "cursor-text hover:text-brass-300" : "cursor-default"}`}
          title={renamable ? "Click to rename" : undefined}
          onClick={() => {
            if (renamable) {
              setVal(lane.name);
              setEditing(true);
            }
          }}
        >
          {lane.name}
        </button>
      )}
      {!editing && !unnamed && (
        <span className="text-[10px] font-semibold tabular-nums text-zinc-500">{count}</span>
      )}
    </div>
  );
}

function LaneColumn({
  lane,
  picks,
  cards,
  cardW,
  sideboard,
  lanesApi,
  dragOver,
  setDragOver,
  onPackPick,
  onMoveCard,
  arrivingInstanceId,
  className = "",
}: {
  lane: Lane;
  picks: DraftCard[];
  cards: Record<string, CardData>;
  cardW: number;
  sideboard: boolean;
  lanesApi: DraftLanes;
  dragOver: string | null;
  setDragOver: (id: string | null) => void;
  onPackPick?: PackPickDrop;
  onMoveCard: (instanceId: string, laneId: string) => void;
  arrivingInstanceId?: string | null;
  className?: string;
}): JSX.Element {
  // Match Deck Builder Cards view: keep a fixed name-band overlap so resizing
  // the divider only changes the visible viewport. Cards never accordion or
  // redistribute themselves relative to one another while the tray moves.
  const overlap = "-119%";
  const isOver = dragOver === lane.id;

  return (
    <div
      className={`group flex h-full shrink-0 flex-col rounded-lg px-1 pt-0.5 transition-colors duration-100 ${
        sideboard
          ? isOver ? "bg-amber-400/10 ring-1 ring-amber-300/80" : ""
          : isOver
            ? "bg-brass-400/10 ring-1 ring-brass-400/50"
            : ""
      } ${className}`}
      style={{ width: cardW + 10 }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(lane.id);
      }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(null);
        // Pack drags pick the card *and* land it here; move drags just move.
        const packId = getPackPickInstanceId(e.dataTransfer);
        if (packId) {
          onPackPick?.(packId, lane.id);
          return;
        }
        const id = e.dataTransfer.getData(DRAG_MIME);
        if (id) onMoveCard(id, lane.id);
      }}
    >
      <LaneHeader
        lane={lane}
        count={picks.length}
        renamable={!sideboard}
        onRename={(name) => lanesApi.renameLane(lane.id, name)}
        accent={sideboard}
      />
      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-1 pt-1">
        {picks.length === 0 ? (
          <div className="h-16" aria-hidden="true" />
        ) : (
          picks.map((pick, i) => (
            <div
              key={pick.instanceId}
              data-draft-pick-instance={pick.instanceId}
              className={`relative transition-transform duration-100 hover:z-30 hover:-translate-y-1 ${
                arrivingInstanceId === pick.instanceId ? "deckbuilder-card-column-arrival" : ""
              }`}
              style={{ marginTop: i === 0 ? 0 : overlap }}
            >
              <Card
                data={cards[pick.cardId]}
                size="md"
                className="!w-full"
                previewPlacement="above"
                draggable
                onDragStart={(e) => e.dataTransfer.setData(DRAG_MIME, pick.instanceId)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export interface TrayViewToggleProps {
  view: "cards" | "list";
  onView: (v: "cards" | "list") => void;
}

export function ViewToggle({ view, onView }: TrayViewToggleProps): JSX.Element {
  return (
    <div className="flex items-center rounded-md bg-white/[0.05] p-0.5">
      {(["list", "cards"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onView(v)}
          className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors duration-150 ${
            view === v ? "bg-gradient-to-b from-brass-300 to-brass-500 text-amber-950" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

interface PicksTrayProps {
  picks: readonly DraftCard[];
  cards: Record<string, CardData>;
  lanesApi: DraftLanes;
  trayH: number;
  onResize: (h: number) => void;
  onPackPick?: PackPickDrop;
}

export function PicksTray(props: PicksTrayProps): JSX.Element {
  const { picks, cards, lanesApi, trayH, onResize, onPackPick } = props;
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [newLaneOver, setNewLaneOver] = useState(false);
  const mainboardScrollRef = useRef<HTMLDivElement>(null);
  const [pendingLaneGap, setPendingLaneGap] = useState<{ key: string; index: number } | null>(null);
  const laneGapTimer = useRef<number | null>(null);
  const [arrivingCardId, setArrivingCardId] = useState<string | null>(null);
  const arrivingCardTimer = useRef<number | null>(null);

  useEffect(() => {
    const resetPendingLane = (): void => {
      if (laneGapTimer.current !== null) window.clearTimeout(laneGapTimer.current);
      laneGapTimer.current = null;
      setPendingLaneGap(null);
    };
    document.addEventListener("dragend", resetPendingLane);
    return () => {
      document.removeEventListener("dragend", resetPendingLane);
      if (laneGapTimer.current !== null) window.clearTimeout(laneGapTimer.current);
      if (arrivingCardTimer.current !== null) window.clearTimeout(arrivingCardTimer.current);
    };
  }, []);

  useEffect(() => {
    const scroller = mainboardScrollRef.current;
    if (!scroller) return;
    const redirectWheel = (event: WheelEvent): void => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      scroller.scrollLeft += delta;
    };
    scroller.addEventListener("wheel", redirectWheel, { passive: false, capture: true });
    return () => scroller.removeEventListener("wheel", redirectWheel, { capture: true });
  }, []);

  const clearLaneGapTimer = (): void => {
    if (laneGapTimer.current !== null) window.clearTimeout(laneGapTimer.current);
    laneGapTimer.current = null;
  };

  const beginLaneGapHold = (key: string, index: number): void => {
    if (pendingLaneGap?.key === key || laneGapTimer.current !== null) return;
    laneGapTimer.current = window.setTimeout(() => {
      laneGapTimer.current = null;
      setPendingLaneGap({ key, index });
    }, 250);
  };

  const leaveLaneGap = (key: string): void => {
    clearLaneGapTimer();
    setPendingLaneGap((current) => current?.key === key ? null : current);
  };

  const markCardArrival = (instanceId: string): void => {
    if (arrivingCardTimer.current !== null) window.clearTimeout(arrivingCardTimer.current);
    setArrivingCardId(instanceId);
    arrivingCardTimer.current = window.setTimeout(() => {
      arrivingCardTimer.current = null;
      setArrivingCardId(null);
    }, 420);
  };

  const moveCardToLane = (instanceId: string, laneId: string): void => {
    lanesApi.moveCard(instanceId, laneId);
    markCardArrival(instanceId);
  };

  const dropIntoNewLane = (event: DragEvent<HTMLDivElement>, index: number): void => {
    event.preventDefault();
    event.stopPropagation();
    clearLaneGapTimer();
    const packId = getPackPickInstanceId(event.dataTransfer);
    if (packId) {
      const laneId = lanesApi.addLaneWithCard(packId, index);
      onPackPick?.(packId, laneId);
      setPendingLaneGap(null);
      return;
    }
    const instanceId = event.dataTransfer.getData(DRAG_MIME);
    if (instanceId) {
      lanesApi.addLaneWithCard(instanceId, index);
      markCardArrival(instanceId);
    }
    setPendingLaneGap(null);
  };

  const startResize = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = trayH;
    const onMove = (ev: MouseEvent): void => onResize(clampTrayH(startH + (startY - ev.clientY)));
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const cardW = 130;

  const sideboardLane: Lane = { id: SIDEBOARD_LANE_ID, name: "Sideboard" };

  const handle = (
    <div
      className="group flex h-3.5 w-full shrink-0 cursor-row-resize items-center justify-center"
      onMouseDown={startResize}
      title="Drag to resize"
    >
      <div className="h-1 w-20 rounded-full bg-white/15 transition-colors duration-150 group-hover:bg-brass-400/70" />
    </div>
  );

  return (
    <footer className="panel draft-tray flex shrink-0 flex-col overflow-hidden" style={{ height: trayH }}>
      {handle}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Your picks</span>
        <span className="chip">{picks.length}</span>
        <span className="hidden text-[10px] text-zinc-600 sm:inline">drag cards between lanes · click a lane name to rename</span>
      </div>
      <div className="flex min-h-0 flex-1 pl-3 pb-2">
          <div
            ref={mainboardScrollRef}
            className="deckbuilder-mainboard-scroll scrollbar-slim min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
            tabIndex={0}
            aria-label="Draft card columns"
            onDragOver={(event) => {
              const scroller = event.currentTarget;
              const bounds = scroller.getBoundingClientRect();
              const edgeSize = 72;
              if (event.clientX < bounds.left + edgeSize) scroller.scrollLeft -= 18;
              else if (event.clientX > bounds.right - edgeSize) scroller.scrollLeft += 18;
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              event.currentTarget.scrollBy({
                left: event.key === "ArrowLeft" ? -150 : 150,
                behavior: "smooth",
              });
            }}
          >
            <div className="flex h-full w-max min-w-full gap-0 pr-3">
              {lanesApi.lanes.map((lane, index) => {
                const previousLane = index > 0 ? lanesApi.lanes[index - 1] : null;
                const gapKey = previousLane ? `${previousLane.id}:${lane.id}` : null;
                const preparedGap = gapKey && pendingLaneGap?.key === gapKey;
                return (
                  <div key={lane.id} className="contents">
                    {gapKey && (
                      <div
                        className={`deckbuilder-column-gap flex h-full shrink-0 items-center justify-center overflow-hidden transition-[width,border-color,background-color] duration-200 ${
                          preparedGap
                            ? "is-prepared w-[140px] border border-amber-300/55 bg-amber-300/[0.06]"
                            : "w-2 border-x border-transparent hover:border-amber-300/30 hover:bg-amber-300/[0.03]"
                        }`}
                        onDragEnter={(event) => {
                          event.preventDefault();
                          beginLaneGapHold(gapKey, index);
                        }}
                        onDragOver={(event) => event.preventDefault()}
                        onDragLeave={() => leaveLaneGap(gapKey)}
                        onDrop={(event) => dropIntoNewLane(event, index)}
                        title="Hold a card here to create a lane"
                      >
                        {preparedGap && (
                          <span className="pointer-events-none text-3xl font-light text-amber-200/75">+</span>
                        )}
                      </div>
                    )}
                    <LaneColumn
                      lane={lane}
                      picks={lanesApi.grouped.get(lane.id) ?? []}
                      cards={cards}
                      cardW={cardW}
                      sideboard={false}
                      lanesApi={lanesApi}
                      dragOver={dragOver}
                      setDragOver={setDragOver}
                      onPackPick={onPackPick}
                      onMoveCard={moveCardToLane}
                      arrivingInstanceId={arrivingCardId}
                      className={lane.id.startsWith("lane-") ? "deckbuilder-column-created" : ""}
                    />
                  </div>
                );
              })}
              <div className="w-2 shrink-0" />
              {/* Invisible far-right target, matching Deck Builder Cards view. */}
              <div
                className="h-full w-[140px] shrink-0 bg-transparent"
                onDragEnter={(event) => {
                  event.preventDefault();
                  setNewLaneOver(true);
                }}
                onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
                onDragLeave={() => setNewLaneOver(false)}
                onDrop={(event) => {
                  setNewLaneOver(false);
                  dropIntoNewLane(event, lanesApi.lanes.length);
                }}
                title="Drop a card here to create a new lane"
                aria-label="Drop a card here to create a new lane"
                data-drag-over={newLaneOver || undefined}
              />
            </div>
          </div>
          <aside className="h-full w-60 shrink-0 border-l border-amber-200/25 bg-gradient-to-r from-amber-950/20 to-transparent pl-2.5 pr-2 min-[1400px]:w-72">
            <LaneColumn
              lane={sideboardLane}
              picks={lanesApi.grouped.get(SIDEBOARD_LANE_ID) ?? []}
              cards={cards}
              cardW={cardW}
              sideboard
              lanesApi={lanesApi}
              dragOver={dragOver}
              setDragOver={setDragOver}
              onPackPick={onPackPick}
              onMoveCard={moveCardToLane}
              arrivingInstanceId={arrivingCardId}
            />
          </aside>
        </div>
    </footer>
  );
}
