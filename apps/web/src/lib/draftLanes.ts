/**
 * Draft picks lane model: user-organizable vertical lanes (columns) for the
 * picks tray, persisted to localStorage per draftId so organizing survives
 * refresh/reconnect. Only *explicit* user placements are stored — unassigned
 * picks derive their lane from cmc bucket at render time, so new picks landing
 * mid-organization never disturb existing assignments.
 *
 * Deckbuild reads the same key via `sideboardedInstanceIds()` to seed cards
 * from the draft's Sideboard lane into its "side" zone.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CardData, DraftCard } from "@mtg-cube/shared";
import { cmcBucket } from "./cards";

export const SIDEBOARD_LANE_ID = "sb";

export interface Lane {
  id: string;
  name: string;
}

const DEFAULT_LANES: Lane[] = [
  { id: "cmc01", name: "0-1" },
  { id: "cmc2", name: "2" },
  { id: "cmc3", name: "3" },
  { id: "cmc4", name: "4" },
  { id: "cmc5", name: "5" },
  { id: "cmc6", name: "6+" },
];

const DEFAULT_LANE_IDS = new Set(DEFAULT_LANES.map((l) => l.id));
const DEFAULT_LANE_NAMES = new Map(DEFAULT_LANES.map((l) => [l.id, l.name]));

export function isDefaultLane(id: string): boolean {
  return DEFAULT_LANE_IDS.has(id);
}

/**
 * True while a default cmc lane still carries its factory numeric name
 * ("0-1", "2", …). Such lanes render without header text; once the user gives
 * the lane a real name it shows like any custom lane.
 */
export function isUnnamedDefaultLane(lane: Lane): boolean {
  return DEFAULT_LANE_NAMES.get(lane.id) === lane.name;
}

/** Factory-created lanes also stay visually unnamed until the user renames them. */
export function isUnnamedLane(lane: Lane): boolean {
  return isUnnamedDefaultLane(lane) || /^Lane \d+$/.test(lane.name);
}

interface LaneState {
  /** Ordered lanes (sideboard excluded — it is pinned and implicit). */
  lanes: Lane[];
  /** instanceId -> laneId. Only explicit user placements live here. */
  assignments: Record<string, string>;
}

const storageKey = (draftId: string): string => `mtg-cube-draft-lanes:${draftId}`;

function freshState(): LaneState {
  return { lanes: DEFAULT_LANES.map((l) => ({ ...l })), assignments: {} };
}

function loadState(draftId: string | undefined): LaneState {
  if (!draftId) return freshState();
  try {
    const raw = localStorage.getItem(storageKey(draftId));
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as Partial<LaneState> | null;
    if (!parsed || typeof parsed !== "object") return freshState();
    const lanes: Lane[] = [];
    if (Array.isArray(parsed.lanes)) {
      for (const l of parsed.lanes) {
        if (
          l &&
          typeof l === "object" &&
          typeof (l as Lane).id === "string" &&
          typeof (l as Lane).name === "string" &&
          (l as Lane).id !== SIDEBOARD_LANE_ID &&
          !lanes.some((x) => x.id === (l as Lane).id)
        ) {
          lanes.push({ id: (l as Lane).id, name: (l as Lane).name });
        }
      }
    }
    // Default lanes always exist (stored order/name wins; missing ones appended).
    for (const d of DEFAULT_LANES) {
      if (!lanes.some((l) => l.id === d.id)) lanes.push({ ...d });
    }
    const assignments: Record<string, string> = {};
    if (parsed.assignments && typeof parsed.assignments === "object") {
      for (const [k, v] of Object.entries(parsed.assignments)) {
        if (typeof v === "string") assignments[k] = v;
      }
    }
    return { lanes, assignments };
  } catch {
    return freshState();
  }
}

function saveState(draftId: string | undefined, state: LaneState): void {
  if (!draftId) return;
  try {
    localStorage.setItem(storageKey(draftId), JSON.stringify(state));
  } catch {
    // localStorage unavailable — organizing just won't survive reloads.
  }
}

/** Default lane for an (unassigned) pick, from its cmc bucket. */
export function defaultLaneId(cmc: number | undefined): string {
  const b = cmcBucket(cmc ?? 0);
  if (b <= 1) return "cmc01";
  if (b >= 6) return "cmc6";
  return `cmc${b}`;
}

/**
 * InstanceIds the user parked in the draft's Sideboard lane (for Deckbuild
 * seeding). Bad/absent stored data yields an empty set.
 */
export function sideboardedInstanceIds(draftId: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!draftId) return out;
  try {
    const raw = localStorage.getItem(storageKey(draftId));
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Partial<LaneState> | null;
    if (!parsed || typeof parsed !== "object") return out;
    if (parsed.assignments && typeof parsed.assignments === "object") {
      for (const [k, v] of Object.entries(parsed.assignments)) {
        if (v === SIDEBOARD_LANE_ID) out.add(k);
      }
    }
  } catch {
    // Fall through to empty set — Deckbuild behaves exactly as before.
  }
  return out;
}

export interface DraftLanes {
  lanes: Lane[];
  /** Resolved lane id for a pick (explicit assignment or cmc default). */
  laneOf: (pick: DraftCard) => string;
  /** laneId -> picks, sorted; includes SIDEBOARD_LANE_ID. */
  grouped: Map<string, DraftCard[]>;
  moveCard: (instanceId: string, laneId: string) => void;
  /** Create a new custom lane containing the dragged card, optionally at an index. */
  addLaneWithCard: (instanceId: string, index?: number) => string;
  renameLane: (laneId: string, name: string) => void;
}

export function useDraftLanes(
  draftId: string | undefined,
  picks: readonly DraftCard[],
  cards: Record<string, CardData>
): DraftLanes {
  const [box, setBox] = useState<{ id: string | undefined; s: LaneState }>(() => ({
    id: draftId,
    s: loadState(draftId),
  }));
  // Derived-state reset: a different draft swaps in its own stored lanes.
  if (box.id !== draftId) {
    setBox({ id: draftId, s: loadState(draftId) });
  }
  const state = box.s;

  useEffect(() => {
    if (box.id === draftId) saveState(draftId, box.s);
  }, [draftId, box]);

  const laneOf = useCallback(
    (pick: DraftCard): string => {
      const a = state.assignments[pick.instanceId];
      if (a === SIDEBOARD_LANE_ID) return a;
      if (a && state.lanes.some((l) => l.id === a)) return a;
      return defaultLaneId(cards[pick.cardId]?.cmc);
    },
    [state, cards]
  );

  /**
   * Drop custom lanes no assignment references. Moving a card away rewrites
   * its assignment value, so a lane's last reference disappearing still prunes
   * it — while lanes created for an in-flight pack pick (whose card hasn't
   * landed in `picks` yet) survive.
   */
  const prune = useCallback((s: LaneState): LaneState => {
    const used = new Set<string>(Object.values(s.assignments));
    const lanes = s.lanes.filter((l) => DEFAULT_LANE_IDS.has(l.id) || used.has(l.id));
    return lanes.length === s.lanes.length ? s : { ...s, lanes };
  }, []);

  const moveCard = useCallback(
    (instanceId: string, laneId: string): void => {
      setBox((cur) => ({
        ...cur,
        s: prune({ ...cur.s, assignments: { ...cur.s.assignments, [instanceId]: laneId } }),
      }));
    },
    [prune]
  );

  const addLaneWithCard = useCallback(
    (instanceId: string, index?: number): string => {
      const id = `lane-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setBox((cur) => {
        const n = cur.s.lanes.filter((l) => !DEFAULT_LANE_IDS.has(l.id)).length + 1;
        const insertionIndex = Math.max(0, Math.min(index ?? cur.s.lanes.length, cur.s.lanes.length));
        return {
          ...cur,
          s: prune({
            lanes: [
              ...cur.s.lanes.slice(0, insertionIndex),
              { id, name: `Lane ${n}` },
              ...cur.s.lanes.slice(insertionIndex),
            ],
            assignments: { ...cur.s.assignments, [instanceId]: id },
          }),
        };
      });
      return id;
    },
    [prune]
  );

  const renameLane = useCallback((laneId: string, name: string): void => {
    const trimmed = name.trim().slice(0, 24);
    if (!trimmed) return;
    setBox((cur) => ({
      ...cur,
      s: {
        ...cur.s,
        lanes: cur.s.lanes.map((l) => (l.id === laneId ? { ...l, name: trimmed } : l)),
      },
    }));
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, DraftCard[]>();
    for (const lane of state.lanes) map.set(lane.id, []);
    map.set(SIDEBOARD_LANE_ID, []);
    for (const pick of picks) {
      const id = laneOf(pick);
      const arr = map.get(id);
      if (arr) arr.push(pick);
      else map.set(id, [pick]);
    }
    return map;
  }, [state.lanes, picks, laneOf]);

  return { lanes: state.lanes, laneOf, grouped, moveCard, addLaneWithCard, renameLane };
}
