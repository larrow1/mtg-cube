/**
 * Admin portal: full-screen overlay (client-side route flag, no URL) for
 * managing the preloaded ranked cube pool. Sections per SPEC v2.1:
 *   1. stats tiles via adminGetStats (on open + refresh button)
 *   2. user table via adminListUsers: username / rank + rating / W-L-D /
 *      saved cubes / joined date / delete with confirm (never your own row)
 *   3. system cube table: name / card count / unresolved badge / active toggle
 *      (re-rendered from the ack, no optimistic update) / updated date /
 *      delete with confirm (the server's never-empty-pool rejection toasts)
 *   4. upload form: name + paste textarea + .txt file + active-on-upload
 *      toggle, "Resolving via Scryfall…" progress state, upload report
 * Only rendered for accounts with isAdmin; anyone else is bounced (closeAdmin).
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { AdminStats, AdminUserRow, SystemCubeSummary } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { Modal } from "../components/Modal";
import { RankBadge } from "../components/RankBadge";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Stats tiles
// ---------------------------------------------------------------------------

interface StatsSectionProps {
  stats: AdminStats | null;
  error: string | null;
  busy: boolean;
  onRefresh: () => void;
}

function StatsSection({ stats, error, busy, onRefresh }: StatsSectionProps): JSX.Element {
  const tiles: { label: string; value: number | null }[] = [
    { label: "Users", value: stats?.users ?? null },
    { label: "Saved cubes", value: stats?.savedCubes ?? null },
    { label: "Ranked matches", value: stats?.rankedMatchesPlayed ?? null },
    { label: "Active rooms", value: stats?.activeRooms ?? null },
    { label: "In queue", value: stats?.playersInQueue ?? null },
    { label: "User ranked cubes", value: stats?.userEligibleCubes ?? null },
  ];

  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Server stats</h2>
        <button
          type="button"
          className="btn-ghost !px-2.5 !py-1 !text-[11px]"
          disabled={busy}
          onClick={onRefresh}
          title="Refresh stats"
        >
          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 fill-current ${busy ? "animate-spin" : ""}`}>
            <path d="M12 4V1L7.5 5.5 12 10V6.5a5.5 5.5 0 1 1-5.5 5.5H4a8 8 0 1 0 8-8Z" />
          </svg>
          Refresh
        </button>
      </div>
      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {tiles.map((t) => (
            <div key={t.label} className="panel-inset px-3 py-2.5 text-center">
              <div className="text-2xl font-black tabular-nums text-brass-300">
                {t.value === null ? <span className="text-zinc-600">—</span> : t.value}
              </div>
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{t.label}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// User table
// ---------------------------------------------------------------------------

interface UsersSectionProps {
  users: AdminUserRow[] | null;
  error: string | null;
  busy: boolean;
  busyId: string | null;
  /** The signed-in admin's own account id (their row cannot be deleted). */
  selfId: string | undefined;
  onRefresh: () => void;
  onDelete: (user: AdminUserRow) => void;
}

function UsersSection({ users, error, busy, busyId, selfId, onRefresh, onDelete }: UsersSectionProps): JSX.Element {
  const th = "px-2.5 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-zinc-500";

  let body: JSX.Element;
  if (error) {
    body = <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>;
  } else if (!users) {
    body = (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-400">
        <span className="h-2 w-2 animate-pulse rounded-full bg-brass-400" />
        Loading users…
      </div>
    );
  } else if (users.length === 0) {
    body = (
      <div className="rounded-xl border border-dashed border-amber-100/15 py-8 text-center text-xs text-zinc-400">
        No accounts registered yet.
      </div>
    );
  } else {
    body = (
      <div className="scrollbar-slim overflow-x-auto">
        <table className="w-full min-w-[38rem] border-collapse text-xs">
          <thead>
            <tr className="border-b border-amber-100/[0.08]">
              <th className={th}>User</th>
              <th className={th}>Rank</th>
              <th className={th}>W / L / D</th>
              <th className={`${th} text-right`}>Cubes</th>
              <th className={th}>Joined</th>
              <th className={`${th} text-right`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === selfId;
              const rowBusy = busyId === user.id;
              return (
                <tr key={user.id} className="border-b border-amber-100/[0.05] last:border-b-0 hover:bg-white/[0.02]">
                  <td className="max-w-[14rem] px-2.5 py-2.5">
                    <div className="flex items-center gap-1.5">
                      {user.online && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]"
                          title="Online now"
                        />
                      )}
                      <span className="truncate font-bold text-zinc-100" title={user.username}>
                        {user.username}
                      </span>
                      {isSelf && <span className="shrink-0 text-[10px] text-zinc-500">(you)</span>}
                      {user.isAdmin && <span className="chip shrink-0 !border-brass-400/60 !text-brass-300">Admin</span>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2.5">
                    <span className="flex items-center gap-1.5">
                      <RankBadge rank={user.rank} />
                      <span className="tabular-nums text-zinc-400">{user.rating}</span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums text-zinc-300">
                    {user.wins} / {user.losses} / {user.draws}
                  </td>
                  <td className="px-2.5 py-2.5 text-right tabular-nums text-zinc-300">{user.savedCubes}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 text-zinc-400">{formatDate(user.createdAt)}</td>
                  <td className="px-2.5 py-2.5 text-right">
                    {!isSelf && (
                      <button
                        type="button"
                        className="btn-ghost !px-2 !py-1 !text-[10px] hover:!border-red-400/40 hover:!text-red-300"
                        disabled={rowBusy}
                        onClick={() => onDelete(user)}
                        aria-label={`Delete ${user.username}`}
                        title="Delete this user"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                          <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h1.5v-8H10Zm3 0v8h1.5v-8H13Z" />
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
          Users
          {users && <span className="chip">{users.length}</span>}
        </h2>
        <button
          type="button"
          className="btn-ghost !px-2.5 !py-1 !text-[11px]"
          disabled={busy}
          onClick={onRefresh}
          title="Refresh users"
        >
          <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 fill-current ${busy ? "animate-spin" : ""}`}>
            <path d="M12 4V1L7.5 5.5 12 10V6.5a5.5 5.5 0 1 1-5.5 5.5H4a8 8 0 1 0 8-8Z" />
          </svg>
          Refresh
        </button>
      </div>
      {body}
    </section>
  );
}

// ---------------------------------------------------------------------------
// System cube table
// ---------------------------------------------------------------------------

interface CubeTableProps {
  cubes: SystemCubeSummary[] | null;
  error: string | null;
  busyId: string | null;
  onToggleActive: (cube: SystemCubeSummary) => void;
  onDelete: (cube: SystemCubeSummary) => void;
}

function CubeTable({ cubes, error, busyId, onToggleActive, onDelete }: CubeTableProps): JSX.Element {
  if (error) {
    return <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>;
  }
  if (!cubes) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-400">
        <span className="h-2 w-2 animate-pulse rounded-full bg-brass-400" />
        Loading system cubes…
      </div>
    );
  }
  if (cubes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-amber-100/15 py-8 text-center text-xs text-zinc-400">
        No system cubes yet — upload one below to seed the ranked pool.
      </div>
    );
  }

  const th = "px-2.5 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-zinc-500";

  return (
    <div className="scrollbar-slim overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-xs">
        <thead>
          <tr className="border-b border-amber-100/[0.08]">
            <th className={th}>Cube</th>
            <th className={`${th} text-right`}>Cards</th>
            <th className={th}>Unresolved</th>
            <th className={th}>Active</th>
            <th className={th}>Updated</th>
            <th className={`${th} text-right`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {cubes.map((cube) => {
            const busy = busyId === cube.id;
            return (
              <tr key={cube.id} className="border-b border-amber-100/[0.05] last:border-b-0 hover:bg-white/[0.02]">
                <td className="max-w-[14rem] truncate px-2.5 py-2.5 font-bold text-zinc-100" title={cube.name}>
                  {cube.name}
                </td>
                <td className="px-2.5 py-2.5 text-right tabular-nums text-zinc-300">{cube.cardCount}</td>
                <td className="px-2.5 py-2.5">
                  {cube.unresolvedCount > 0 ? (
                    <span
                      className="chip !border-amber-400/50 !text-amber-300"
                      title={`${cube.unresolvedCount} line${cube.unresolvedCount === 1 ? "" : "s"} could not be resolved on Scryfall`}
                    >
                      {cube.unresolvedCount} unresolved
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-2.5 py-2.5">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={cube.active}
                    aria-label={`${cube.name}: ${cube.active ? "active in" : "excluded from"} the ranked pool`}
                    disabled={busy}
                    onClick={() => onToggleActive(cube)}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-40 ${
                      cube.active ? "bg-gradient-to-b from-brass-300 to-brass-500" : "bg-white/10"
                    }`}
                    title={cube.active ? "In the ranked pool — click to deactivate" : "Inactive — click to add to the ranked pool"}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-zinc-100 shadow-card transition-all duration-150 ${
                        cube.active ? "left-[1.125rem]" : "left-0.5"
                      }`}
                    />
                  </button>
                </td>
                <td className="whitespace-nowrap px-2.5 py-2.5 text-zinc-400">{formatDate(cube.updatedAt)}</td>
                <td className="px-2.5 py-2.5 text-right">
                  <button
                    type="button"
                    className="btn-ghost !px-2 !py-1 !text-[10px] hover:!border-red-400/40 hover:!text-red-300"
                    disabled={busy}
                    onClick={() => onDelete(cube)}
                    aria-label={`Delete ${cube.name}`}
                    title="Delete this system cube"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
                      <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h1.5v-8H10Zm3 0v8h1.5v-8H13Z" />
                    </svg>
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload form
// ---------------------------------------------------------------------------

interface UploadReport {
  name: string;
  cardCount: number;
  unresolvedCount: number;
  /** Lines submitted, kept so the report can be inspected (the contract only returns a count). */
  submittedLines: number;
}

interface UploadFormProps {
  onUploaded: () => void;
}

function UploadForm({ onUploaded }: UploadFormProps): JSX.Element {
  const { pushToast } = useApp();
  const [name, setName] = useState("");
  const [list, setList] = useState("");
  const [active, setActive] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<UploadReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setList(reader.result);
        if (name.trim().length === 0) setName(file.name.replace(/\.txt$/i, ""));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const lineCount = list
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0).length;

  const upload = async (): Promise<void> => {
    const trimmedName = name.trim();
    const trimmedList = list.trim();
    if (uploading) return;
    if (trimmedName.length === 0) {
      pushToast("Give the system cube a name first");
      return;
    }
    if (trimmedList.length === 0) {
      pushToast("Paste a cube list or choose a .txt file first");
      return;
    }
    setUploading(true);
    setReport(null);
    const r = await call("adminUploadSystemCube", { name: trimmedName, list: trimmedList, active });
    setUploading(false);
    if (r.ok && r.data) {
      const cube = r.data.cube;
      pushToast(
        `“${cube.name}” uploaded — ${cube.cardCount} cards${cube.active ? ", active in the ranked pool" : ""}`,
        cube.unresolvedCount > 0 ? "info" : "success"
      );
      setReport({
        name: cube.name,
        cardCount: cube.cardCount,
        unresolvedCount: cube.unresolvedCount,
        submittedLines: lineCount,
      });
      setReportOpen(cube.unresolvedCount > 0);
      setName("");
      setList("");
      onUploaded();
    } else {
      pushToast(r.error ?? "Upload failed — the server did not accept the cube");
    }
  };

  return (
    <>
      <label className="label" htmlFor="admin-cube-name">Cube name</label>
      <input
        id="admin-cube-name"
        className="input mb-2"
        value={name}
        maxLength={60}
        placeholder="Vintage Cube 2026"
        onChange={(e) => setName(e.target.value)}
      />
      <label className="label" htmlFor="admin-cube-list">Card list — one per line, “4 Lightning Bolt” counts ok</label>
      <textarea
        id="admin-cube-list"
        className="input scrollbar-slim mb-2 h-36 resize-y font-mono text-xs leading-relaxed"
        placeholder={"Lightning Bolt\nCounterspell\n2 Llanowar Elves\n…"}
        value={list}
        onChange={(e) => setList(e.target.value)}
      />
      <div className="mb-3 flex items-center gap-2">
        <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={onFile} />
        <button type="button" className="btn-ghost !text-xs" onClick={() => fileRef.current?.click()}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="M12 3 6 9h4v6h4V9h4l-6-6ZM5 19h14v2H5v-2Z" /></svg>
          .txt file
        </button>
        <span className="flex-1 truncate text-[11px] text-zinc-500">
          {lineCount > 0 ? `${lineCount} lines ready` : "No list loaded"}
        </span>
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          className="accent-amber-400"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        Active immediately (joins the ranked cube pool on upload)
      </label>
      <button
        type="button"
        className="btn-primary w-full !text-xs"
        disabled={uploading || list.trim().length === 0 || name.trim().length === 0}
        onClick={() => void upload()}
      >
        {uploading ? (
          <>
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-900" />
            Resolving via Scryfall…
          </>
        ) : (
          "Upload system cube"
        )}
      </button>

      {report && (
        <div className="panel-inset mt-3 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 text-xs text-zinc-300">
              <span className="font-bold text-brass-300">“{report.name}”</span> resolved:{" "}
              <span className="font-bold tabular-nums">{report.cardCount}</span> cards from {report.submittedLines} lines.
            </div>
            <button
              type="button"
              className="rounded-md p-0.5 text-zinc-500 transition-colors duration-150 hover:bg-white/10 hover:text-zinc-200"
              onClick={() => setReport(null)}
              aria-label="Dismiss upload report"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3 1.4 1.4Z" /></svg>
            </button>
          </div>
          {report.unresolvedCount > 0 && (
            <div className="mt-2">
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] font-semibold text-amber-300 transition-colors duration-150 hover:text-amber-200"
                onClick={() => setReportOpen((v) => !v)}
              >
                <svg viewBox="0 0 24 24" className={`h-3 w-3 fill-current transition-transform duration-150 ${reportOpen ? "rotate-90" : ""}`}>
                  <path d="M9 5l7 7-7 7V5Z" />
                </svg>
                {report.unresolvedCount} line{report.unresolvedCount === 1 ? "" : "s"} could not be resolved
              </button>
              {reportOpen && (
                <p className="mt-1.5 rounded-md bg-black/30 p-2 text-[11px] leading-relaxed text-amber-200/80">
                  {report.unresolvedCount} of the {report.submittedLines} submitted lines did not match a card on
                  Scryfall and were dropped from the cube. Check the list for typos or set-specific spellings, fix the
                  lines and upload again — the unresolved badge in the table above tracks the count.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Portal screen
// ---------------------------------------------------------------------------

export function AdminPortal(): JSX.Element | null {
  const { state, dispatch, pushToast } = useApp();
  const isAdmin = state.account?.account.isAdmin === true;

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersBusy, setUsersBusy] = useState(false);
  const [userBusyId, setUserBusyId] = useState<string | null>(null);
  const [pendingDeleteUser, setPendingDeleteUser] = useState<AdminUserRow | null>(null);
  const [cubes, setCubes] = useState<SystemCubeSummary[] | null>(null);
  const [cubesError, setCubesError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SystemCubeSummary | null>(null);

  const fetchStats = useCallback(async (): Promise<void> => {
    setStatsBusy(true);
    const r = await call("adminGetStats");
    setStatsBusy(false);
    if (r.ok && r.data) {
      setStats(r.data.stats);
      setStatsError(null);
    } else {
      setStatsError(r.error ?? "Could not load server stats");
    }
  }, []);

  const fetchUsers = useCallback(async (): Promise<void> => {
    setUsersBusy(true);
    const r = await call("adminListUsers");
    setUsersBusy(false);
    if (r.ok && r.data) {
      setUsers(r.data.users);
      setUsersError(null);
    } else {
      setUsersError(r.error ?? "Could not load users");
    }
  }, []);

  const fetchCubes = useCallback(async (): Promise<void> => {
    const r = await call("adminListSystemCubes");
    if (r.ok && r.data) {
      setCubes(r.data.cubes);
      setCubesError(null);
    } else {
      setCubesError(r.error ?? "Could not load system cubes");
    }
  }, []);

  // Guard: the portal only exists for admins. If admin status evaporates
  // mid-session (sign-out, revoked account) render nothing and close the flag.
  useEffect(() => {
    if (!isAdmin) dispatch({ type: "closeAdmin" });
  }, [isAdmin, dispatch]);

  useEffect(() => {
    if (!isAdmin) return;
    void fetchStats();
    void fetchUsers();
    void fetchCubes();
  }, [isAdmin, fetchStats, fetchUsers, fetchCubes]);

  if (!isAdmin) return null;

  const toggleActive = async (cube: SystemCubeSummary): Promise<void> => {
    if (busyId) return;
    setBusyId(cube.id);
    const r = await call("adminSetSystemCubeActive", { cubeId: cube.id, active: !cube.active });
    setBusyId(null);
    if (r.ok && r.data) {
      // No optimistic update: the row re-renders from the server's ack.
      const updated = r.data.cube;
      setCubes((cur) => cur?.map((c) => (c.id === updated.id ? updated : c)) ?? cur);
    } else {
      pushToast(r.error ?? "Could not update the cube");
    }
  };

  const confirmDeleteUser = async (): Promise<void> => {
    const user = pendingDeleteUser;
    if (!user || userBusyId) return;
    setUserBusyId(user.id);
    const r = await call("adminDeleteUser", { userId: user.id });
    setUserBusyId(null);
    setPendingDeleteUser(null);
    if (r.ok) {
      setUsers((cur) => cur?.filter((u) => u.id !== user.id) ?? cur);
      pushToast(`“${user.username}” deleted`, "info");
      void fetchUsers();
      void fetchStats();
    } else {
      // Includes the server's own-account rejection.
      pushToast(r.error ?? "Could not delete the user");
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const cube = pendingDelete;
    if (!cube || busyId) return;
    setBusyId(cube.id);
    const r = await call("adminDeleteSystemCube", { cubeId: cube.id });
    setBusyId(null);
    setPendingDelete(null);
    if (r.ok) {
      setCubes((cur) => cur?.filter((c) => c.id !== cube.id) ?? cur);
      pushToast(`“${cube.name}” deleted`, "info");
      void fetchStats();
    } else {
      // Includes the server's never-empty-pool rejection.
      pushToast(r.error ?? "Could not delete the cube");
    }
  };

  const onUploaded = (): void => {
    void fetchCubes();
    void fetchStats();
  };

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-felt-950/95 backdrop-blur-sm">
      <div className="mx-auto max-w-5xl animate-fade-in p-4 md:p-6">
        {/* Header */}
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 24 24" className="h-8 w-8 fill-brass-300 drop-shadow-[0_0_6px_rgba(251,191,36,0.4)]">
              <path d="M12 1.75 4 5v6c0 5.05 3.41 9.76 8 11.25 4.59-1.49 8-6.2 8-11.25V5l-8-3.25Zm-1.2 14.3-3.3-3.3 1.4-1.4 1.9 1.9 4.3-4.3 1.4 1.4-5.7 5.7Z" />
            </svg>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Signed in as {state.account?.account.username}</div>
              <h1 className="text-2xl font-black tracking-tight text-zinc-50">
                Admin <span className="text-brass-300">portal</span>
              </h1>
            </div>
          </div>
          <button type="button" className="btn-ghost !text-xs" onClick={() => dispatch({ type: "closeAdmin" })}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2Z" /></svg>
            Back
          </button>
        </header>

        <div className="space-y-4">
          <StatsSection stats={stats} error={statsError} busy={statsBusy} onRefresh={() => void fetchStats()} />

          <UsersSection
            users={users}
            error={usersError}
            busy={usersBusy}
            busyId={userBusyId}
            selfId={state.account?.account.id}
            onRefresh={() => void fetchUsers()}
            onDelete={setPendingDeleteUser}
          />

          <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
            {/* System cubes */}
            <section className="panel p-4">
              <h2 className="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                System cubes
                {cubes && <span className="chip">{cubes.length}</span>}
              </h2>
              <CubeTable
                cubes={cubes}
                error={cubesError}
                busyId={busyId}
                onToggleActive={(cube) => void toggleActive(cube)}
                onDelete={setPendingDelete}
              />
              <p className="mt-3 text-[11px] text-zinc-500">
                Active system cubes plus user cubes marked ranked-eligible form the ranked matchmaking pool.
              </p>
            </section>

            {/* Upload */}
            <section className="panel p-4">
              <h2 className="mb-3 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Upload system cube</h2>
              <UploadForm onUploaded={onUploaded} />
            </section>
          </div>
        </div>
      </div>

      {pendingDeleteUser && (
        <Modal
          title="Delete this user?"
          onClose={() => setPendingDeleteUser(null)}
          onConfirm={() => void confirmDeleteUser()}
          confirmLabel="Delete"
          danger
          width="sm"
        >
          <p className="text-sm text-zinc-300">
            “{pendingDeleteUser.username}” will be deleted for good — along with their saved cubes, rating, and
            ranked match history. Any open sessions are signed out immediately. This cannot be undone.
          </p>
        </Modal>
      )}

      {pendingDelete && (
        <Modal
          title="Delete this system cube?"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
          confirmLabel="Delete"
          danger
          width="sm"
        >
          <p className="text-sm text-zinc-300">
            “{pendingDelete.name}” ({pendingDelete.cardCount} cards) will be removed from the ranked pool for good.
            The server refuses the delete if it would leave the pool empty.
          </p>
        </Modal>
      )}
    </div>
  );
}
