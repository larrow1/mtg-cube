/**
 * Resizable bottom picks tray for the Draft screen ("Cards" view):
 * Arena/CubeCobra-style vertical lanes where cards stack with only a name band
 * visible, drag-to-move between lanes, drag-to-create lanes, inline lane
 * rename, and a pinned Sideboard lane. Height is user-draggable via the grip.
 */
import { useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
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
  laneH,
  sideboard,
  lanesApi,
  dragOver,
  setDragOver,
  onPackPick,
}: {
  lane: Lane;
  picks: DraftCard[];
  cards: Record<string, CardData>;
  cardW: number;
  laneH: number;
  sideboard: boolean;
  lanesApi: DraftLanes;
  dragOver: string | null;
  setDragOver: (id: string | null) => void;
  onPackPick?: PackPickDrop;
}): JSX.Element {
  const cardH = cardW * 7 / 5;
  const minimumStep = cardH * 0.15;
  const step = picks.length <= 1
    ? cardH
    : Math.min(cardH, Math.max(minimumStep, (laneH - cardH) / (picks.length - 1)));
  const overlap = step - cardH;
  const isOver = dragOver === lane.id;

  return (
    <div
      className={`group flex h-full shrink-0 flex-col rounded-lg px-1 pt-0.5 transition-colors duration-100 ${
        sideboard
          ? isOver ? "bg-amber-400/10 ring-1 ring-amber-300/80" : ""
          : isOver
            ? "bg-brass-400/10 ring-1 ring-brass-400/50"
            : ""
      }`}
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
        if (id) lanesApi.moveCard(id, lane.id);
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
              className="relative transition-transform duration-100 hover:z-30 hover:-translate-y-1"
              style={{ marginTop: i === 0 ? 0 : `${overlap}px` }}
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
  view: "cards" | "list";
  onView: (v: "cards" | "list") => void;
  onPackPick?: PackPickDrop;
}

export function PicksTray(props: PicksTrayProps): JSX.Element {
  const { picks, cards, lanesApi, trayH, onResize, view, onView, onPackPick } = props;
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [newLaneOver, setNewLaneOver] = useState(false);

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

  // Resizing reveals more of each stack rather than scaling the cards.
  const laneH = Math.max(40, trayH - 64);
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
        <div className="flex-1" />
        <ViewToggle view={view} onView={onView} />
      </div>
      <div className="flex min-h-0 flex-1 pl-3 pb-2">
          <div className="scrollbar-slim flex min-w-0 flex-1 gap-2 overflow-x-auto pr-3">
            {lanesApi.lanes.map((lane) => (
              <LaneColumn
                key={lane.id}
                lane={lane}
                picks={lanesApi.grouped.get(lane.id) ?? []}
                cards={cards}
                cardW={cardW}
                laneH={laneH}
                sideboard={false}
                lanesApi={lanesApi}
                dragOver={dragOver}
                setDragOver={setDragOver}
                onPackPick={onPackPick}
              />
            ))}
            {/* Drop target: create a new lane */}
            <div
              className={`h-full shrink-0 rounded-lg transition-colors duration-100 ${
                newLaneOver ? "bg-brass-400/10 ring-1 ring-brass-400/70" : ""
              }`}
              style={{ width: cardW + 10 }}
              onDragOver={(e: DragEvent<HTMLDivElement>) => {
                e.preventDefault();
                setNewLaneOver(true);
              }}
              onDragLeave={() => setNewLaneOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setNewLaneOver(false);
                const packId = getPackPickInstanceId(e.dataTransfer);
                if (packId) {
                  onPackPick?.(packId, null);
                  return;
                }
                const id = e.dataTransfer.getData(DRAG_MIME);
                if (id) lanesApi.addLaneWithCard(id);
              }}
              title="Drop a card here to create a new lane"
              aria-label="Drop a card here to create a new lane"
            />
          </div>
          <aside className="h-full w-60 shrink-0 border-l border-amber-200/25 bg-gradient-to-r from-amber-950/20 to-transparent pl-2.5 pr-2 min-[1400px]:w-72">
            <LaneColumn
              lane={sideboardLane}
              picks={lanesApi.grouped.get(SIDEBOARD_LANE_ID) ?? []}
              cards={cards}
              cardW={cardW}
              laneH={laneH}
              sideboard
              lanesApi={lanesApi}
              dragOver={dragOver}
              setDragOver={setDragOver}
              onPackPick={onPackPick}
            />
          </aside>
        </div>
    </footer>
  );
}
