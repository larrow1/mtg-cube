/**
 * Resizable bottom picks tray for the Draft screen ("Cards" view):
 * Arena/CubeCobra-style vertical lanes where cards stack with only a name band
 * visible, drag-to-move between lanes, drag-to-create lanes, inline lane
 * rename, and a pinned Sideboard lane. Height is user-draggable via the grip
 * handle (double-click toggles minimized).
 */
import { useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { CardData, DraftCard } from "@mtg-cube/shared";
import { Card } from "./Card";
import { SIDEBOARD_LANE_ID, type DraftLanes, type Lane } from "../lib/draftLanes";

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
      {!editing && <span className="text-[10px] font-semibold tabular-nums text-zinc-500">{count}</span>}
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
}: {
  lane: Lane;
  picks: DraftCard[];
  cards: Record<string, CardData>;
  cardW: number;
  sideboard: boolean;
  lanesApi: DraftLanes;
  dragOver: string | null;
  setDragOver: (id: string | null) => void;
}): JSX.Element {
  // Top margin percentages resolve against the column *width*, so "-119%"
  // is exactly 85% of the card height (aspect 5/7 -> height = 140% of width)
  // even when a scrollbar shrinks the rendered card.
  const overlap = "-119%";
  const isOver = dragOver === lane.id;

  return (
    <div
      className={`flex h-full shrink-0 flex-col rounded-lg px-1 pt-0.5 transition-colors duration-100 ${
        sideboard
          ? `border border-dashed ${isOver ? "border-amber-300/80 bg-amber-400/10" : "border-amber-400/40 bg-amber-400/[0.04]"}`
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
          <div
            className={`flex h-16 items-center justify-center rounded-md border border-dashed text-[9px] uppercase tracking-wider ${
              sideboard ? "border-amber-400/30 text-amber-400/60" : "border-amber-100/10 text-zinc-600"
            }`}
          >
            {sideboard ? "side" : "empty"}
          </div>
        ) : (
          picks.map((pick, i) => (
            <div
              key={pick.instanceId}
              className="relative transition-transform duration-100 hover:z-30 hover:-translate-y-1"
              style={{ marginTop: i === 0 ? 0 : overlap }}
            >
              <Card
                data={cards[pick.cardId]}
                size="md"
                className="!w-full"
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
      {(["cards", "list"] as const).map((v) => (
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
  minimized: boolean;
  onResize: (h: number) => void;
  onToggleMinimized: () => void;
  view: "cards" | "list";
  onView: (v: "cards" | "list") => void;
}

export function PicksTray(props: PicksTrayProps): JSX.Element {
  const { picks, cards, lanesApi, trayH, minimized, onResize, onToggleMinimized, view, onView } = props;
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

  // Card width scales with the lane area height (taller tray = bigger cards).
  const laneH = Math.max(40, trayH - 64);
  const cardW = Math.max(66, Math.min(240, Math.round(((laneH * 0.85) * 5) / 7)));

  const sideboardLane: Lane = { id: SIDEBOARD_LANE_ID, name: "Sideboard" };
  const sideCount = lanesApi.grouped.get(SIDEBOARD_LANE_ID)?.length ?? 0;

  const handle = (
    <div
      className="group flex h-3.5 w-full shrink-0 cursor-row-resize items-center justify-center"
      onMouseDown={minimized ? undefined : startResize}
      onDoubleClick={onToggleMinimized}
      title="Drag to resize · double-click to minimize"
    >
      <div className="h-1 w-20 rounded-full bg-white/15 transition-colors duration-150 group-hover:bg-brass-400/70" />
    </div>
  );

  if (minimized) {
    return (
      <footer className="panel shrink-0 animate-fade-in">
        {handle}
        <div className="scrollbar-slim flex items-center gap-2 overflow-x-auto px-3 pb-2">
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Your picks</span>
          <span className="chip shrink-0">{picks.length}</span>
          {lanesApi.lanes.map((lane) => {
            const n = lanesApi.grouped.get(lane.id)?.length ?? 0;
            if (n === 0) return null;
            return (
              <span key={lane.id} className="chip shrink-0">
                {lane.name} · {n}
              </span>
            );
          })}
          {sideCount > 0 && (
            <span className="chip shrink-0 border-amber-400/40 text-amber-300">Sideboard · {sideCount}</span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            className="btn-ghost shrink-0 !px-2 !py-0.5 !text-[10px]"
            onClick={onToggleMinimized}
            title="Expand the picks tray"
          >
            Expand
          </button>
        </div>
      </footer>
    );
  }

  return (
    <footer className="panel flex shrink-0 flex-col overflow-hidden" style={{ height: trayH }}>
      {handle}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Your picks</span>
        <span className="chip">{picks.length}</span>
        <span className="hidden text-[10px] text-zinc-600 sm:inline">drag cards between lanes · click a lane name to rename</span>
        <div className="flex-1" />
        <ViewToggle view={view} onView={onView} />
        <button
          type="button"
          className="btn-ghost !px-2 !py-0.5 !text-[10px]"
          onClick={onToggleMinimized}
          title="Minimize the picks tray"
        >
          Min
        </button>
      </div>
      {picks.length === 0 ? (
        <div className="mx-3 mb-3 flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-amber-100/15 text-xs text-zinc-400">
          No picks yet — grab something spicy and it&apos;ll land here, stacked by mana value.
        </div>
      ) : (
        <div className="scrollbar-slim flex min-h-0 flex-1 gap-2 overflow-x-auto px-3 pb-2">
          {lanesApi.lanes.map((lane) => (
            <LaneColumn
              key={lane.id}
              lane={lane}
              picks={lanesApi.grouped.get(lane.id) ?? []}
              cards={cards}
              cardW={cardW}
              sideboard={false}
              lanesApi={lanesApi}
              dragOver={dragOver}
              setDragOver={setDragOver}
            />
          ))}
          {/* Drop target: create a new lane */}
          <div
            className={`flex h-full w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed transition-colors duration-100 ${
              newLaneOver ? "border-brass-400/80 bg-brass-400/10 text-brass-300" : "border-amber-100/15 text-zinc-600"
            }`}
            onDragOver={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              setNewLaneOver(true);
            }}
            onDragLeave={() => setNewLaneOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setNewLaneOver(false);
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) lanesApi.addLaneWithCard(id);
            }}
            title="Drop a card here to create a new lane"
          >
            <span className="text-lg leading-none">+</span>
            <span className="text-[9px] font-bold uppercase tracking-wider">lane</span>
          </div>
          <div className="w-1 shrink-0" />
          <LaneColumn
            lane={sideboardLane}
            picks={lanesApi.grouped.get(SIDEBOARD_LANE_ID) ?? []}
            cards={cards}
            cardW={cardW}
            sideboard
            lanesApi={lanesApi}
            dragOver={dragOver}
            setDragOver={setDragOver}
          />
        </div>
      )}
    </footer>
  );
}
