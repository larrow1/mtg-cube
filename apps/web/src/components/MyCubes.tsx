/**
 * Saved-cube management, shared by the account menu ("My cubes" modal) and the
 * Lobby cube panel: list rows with ranked-pool toggle, delete (confirmed) and
 * — host in a lobby only — a gold "Use" button that loads the cube into the
 * room. Also exports the "Save to my cubes" mini dialog used next to Upload.
 */
import { useEffect, useState } from "react";
import type { SavedCubeSummary } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { Modal } from "./Modal";

export function MyCubesList(): JSX.Element {
  const { state, pushToast } = useApp();
  const [cubes, setCubes] = useState<SavedCubeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SavedCubeSummary | null>(null);

  const room = state.room;
  const me = state.session;
  const canUse =
    room !== null && me !== null && room.phase === "lobby" && !room.ranked && room.hostId === me.playerId;

  useEffect(() => {
    let alive = true;
    void call("listMyCubes").then((r) => {
      if (!alive) return;
      if (r.ok && r.data) setCubes(r.data.cubes);
      else setError(r.error ?? "Could not load your cubes");
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggleRanked = async (cube: SavedCubeSummary): Promise<void> => {
    if (busyId) return;
    setBusyId(cube.id);
    const r = await call("setCubeRankedEligible", { cubeId: cube.id, rankedEligible: !cube.rankedEligible });
    setBusyId(null);
    if (r.ok && r.data) {
      const updated = r.data.cube;
      setCubes((cur) => cur?.map((c) => (c.id === updated.id ? updated : c)) ?? cur);
    } else {
      pushToast(r.error ?? "Could not update the cube");
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const cube = pendingDelete;
    if (!cube || busyId) return;
    setBusyId(cube.id);
    const r = await call("deleteCube", { cubeId: cube.id });
    setBusyId(null);
    setPendingDelete(null);
    if (r.ok) {
      setCubes((cur) => cur?.filter((c) => c.id !== cube.id) ?? cur);
      pushToast(`“${cube.name}” deleted`, "info");
    } else {
      pushToast(r.error ?? "Could not delete the cube");
    }
  };

  const useCube = async (cube: SavedCubeSummary): Promise<void> => {
    if (busyId) return;
    setBusyId(cube.id);
    const r = await call("loadCubeIntoRoom", { cubeId: cube.id });
    setBusyId(null);
    if (r.ok && r.data) {
      pushToast(`“${cube.name}” loaded into the room — ${r.data.cardCount} cards ready`, "success");
    } else {
      pushToast(r.error ?? "Could not load the cube into the room");
    }
  };

  if (error) {
    return <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>;
  }

  if (!cubes) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-xs text-zinc-400">
        <span className="h-2 w-2 animate-pulse rounded-full bg-brass-400" />
        Fetching your collection…
      </div>
    );
  }

  if (cubes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-amber-100/15 py-6 text-center text-xs text-zinc-400">
        No saved cubes yet — paste a list in a lobby and hit “Save to my cubes”.
      </div>
    );
  }

  return (
    <>
      <ul className="space-y-1.5">
        {cubes.map((cube) => (
          <li key={cube.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-bold text-zinc-100">{cube.name}</div>
              <div className="text-[10px] text-zinc-500">
                {cube.cardCount} cards
                {cube.unresolvedCount > 0 && (
                  <span className="text-amber-300/80"> · {cube.unresolvedCount} unresolved</span>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={busyId === cube.id}
              onClick={() => void toggleRanked(cube)}
              className={`chip transition-all duration-150 disabled:opacity-40 ${
                cube.rankedEligible
                  ? "!border-brass-400/50 !text-brass-300"
                  : "opacity-60 hover:opacity-100"
              }`}
              title={
                cube.rankedEligible
                  ? "In the ranked cube pool — click to withdraw it"
                  : "Not in the ranked pool — click to allow it in ranked drafts"
              }
            >
              {cube.rankedEligible ? "Ranked ✓" : "Ranked"}
            </button>
            {canUse && (
              <button
                type="button"
                className="btn-gold !px-2.5 !py-1 !text-[10px]"
                disabled={busyId === cube.id}
                onClick={() => void useCube(cube)}
                title="Load this cube into the room"
              >
                Use
              </button>
            )}
            <button
              type="button"
              className="btn-ghost !px-2 !py-1 !text-[10px] hover:!border-red-400/40 hover:!text-red-300"
              disabled={busyId === cube.id}
              onClick={() => setPendingDelete(cube)}
              aria-label={`Delete ${cube.name}`}
              title="Delete this cube"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h1.5v-8H10Zm3 0v8h1.5v-8H13Z" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      {pendingDelete && (
        <Modal
          title="Delete this cube?"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
          confirmLabel="Delete"
          danger
          width="sm"
        >
          <p className="text-sm text-zinc-300">
            “{pendingDelete.name}” ({pendingDelete.cardCount} cards) will be gone for good. Rooms already using it are
            unaffected.
          </p>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Save-cube mini dialog
// ---------------------------------------------------------------------------

export interface SaveCubeDialogProps {
  defaultName: string;
  list: string;
  onClose: () => void;
}

export function SaveCubeDialog({ defaultName, list, onClose }: SaveCubeDialogProps): JSX.Element {
  const { pushToast } = useApp();
  const [name, setName] = useState(defaultName);
  const [rankedEligible, setRankedEligible] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (saving || trimmed.length === 0) return;
    setSaving(true);
    const r = await call("saveCube", { name: trimmed, list, rankedEligible });
    setSaving(false);
    if (r.ok && r.data) {
      pushToast(`“${r.data.cube.name}” saved to your cubes (${r.data.cube.cardCount} cards)`, "success");
      onClose();
    } else {
      pushToast(r.error ?? "Could not save the cube");
    }
  };

  return (
    <Modal
      title="Save to my cubes"
      onClose={onClose}
      onConfirm={() => void save()}
      confirmLabel={saving ? "Resolving…" : "Save cube"}
      confirmDisabled={saving || name.trim().length === 0}
      width="sm"
    >
      <label className="label" htmlFor="save-cube-name">Cube name</label>
      <input
        id="save-cube-name"
        className="input mb-3"
        value={name}
        maxLength={60}
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          className="accent-amber-400"
          checked={rankedEligible}
          onChange={(e) => setRankedEligible(e.target.checked)}
        />
        Allow this cube in the ranked matchmaking pool
      </label>
      <p className="mt-2 text-[11px] text-zinc-500">The list is re-checked against Scryfall when saved.</p>
    </Modal>
  );
}
