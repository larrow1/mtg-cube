/**
 * Home: name entry, create room, join by 6-char code, rejoin card for a
 * stored session, and the Ranked panel (queue up for matchmaking).
 */
import { useEffect, useMemo, useState } from "react";
import type { QueueState } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { RankBadge } from "../components/RankBadge";

const NAME_KEY = "mtg-cube-name";

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore
  }
}

function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

/** Server wait time plus local ticking between periodic queueState emits. */
function useQueueElapsed(queue: QueueState | null): number {
  const receivedAt = useMemo(() => Date.now(), [queue]);
  const [now, setNow] = useState(() => Date.now());
  const searching = queue !== null && queue.inQueue;
  useEffect(() => {
    if (!searching) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [searching]);
  if (!queue || !searching) return 0;
  return queue.waitSeconds + Math.max(0, Math.floor((now - receivedAt) / 1000));
}

function RankedPanel(): JSX.Element {
  const { state, dispatch, pushToast } = useApp();
  const acct = state.account;
  const queue = state.queue;
  const searching = queue !== null && queue.inQueue;
  const [busy, setBusy] = useState(false);
  const elapsed = useQueueElapsed(queue);

  const joinQueue = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const r = await call("queueJoin");
    setBusy(false);
    if (!r.ok) pushToast(r.error ?? "Could not join the ranked queue");
  };

  const leaveQueue = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const r = await call("queueLeave");
    setBusy(false);
    if (!r.ok) pushToast(r.error ?? "Could not leave the queue");
  };

  return (
    <div className="panel mt-4 p-5">
      <div className="mb-3 flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-brass-300">
          <path d="M5 3h14v2h3v4a5 5 0 0 1-4.5 4.97A6.5 6.5 0 0 1 13 17.4V19h3v2H8v-2h3v-1.6a6.5 6.5 0 0 1-4.5-3.43A5 5 0 0 1 2 9V5h3V3Zm0 4H4v2a3 3 0 0 0 1.6 2.66A11 11 0 0 1 5 7Zm15 0h-1a11 11 0 0 1-.6 4.66A3 3 0 0 0 20 9V7Z" />
        </svg>
        <h2 className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Ranked</h2>
      </div>

      {!acct ? (
        <>
          <p className="text-xs leading-relaxed text-zinc-400">
            Get matched against a drafter near your rating and climb from Bronze to Mythic. Ranked play needs an
            account — your rank travels with it.
          </p>
          <button type="button" className="btn-primary mt-3 w-full" onClick={() => dispatch({ type: "openAuth" })}>
            Sign in to play ranked
          </button>
        </>
      ) : searching && queue ? (
        <div className="flex flex-col items-center gap-3 py-1">
          <div className="relative flex h-20 w-20 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full border-2 border-brass-400/40" />
            <span className="absolute inset-1.5 animate-pulse rounded-full border border-brass-300/50" />
            <svg viewBox="0 0 24 24" className="h-8 w-8 fill-brass-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.45)]">
              <path d="M5 3h14v2h3v4a5 5 0 0 1-4.5 4.97A6.5 6.5 0 0 1 13 17.4V19h3v2H8v-2h3v-1.6a6.5 6.5 0 0 1-4.5-3.43A5 5 0 0 1 2 9V5h3V3Zm0 4H4v2a3 3 0 0 0 1.6 2.66A11 11 0 0 1 5 7Zm15 0h-1a11 11 0 0 1-.6 4.66A3 3 0 0 0 20 9V7Z" />
            </svg>
          </div>
          <div className="text-sm font-bold text-zinc-100">Searching for an opponent…</div>
          <div className="flex flex-wrap justify-center gap-1.5">
            <span className="chip tabular-nums" title="Time in queue">{formatElapsed(elapsed)} waited</span>
            <span className="chip tabular-nums" title="Current rating search window">±{queue.windowNow} rating</span>
            <span className="chip tabular-nums">{queue.playersInQueue} in queue</span>
          </div>
          <button type="button" className="btn-ghost !px-6 !text-xs" disabled={busy} onClick={() => void leaveQueue()}>
            Cancel search
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <RankBadge rank={acct.rating.rank} size="md" />
              <span className="text-xl font-black tabular-nums text-zinc-50">{acct.rating.rating}</span>
            </div>
            <span className="text-[11px] tabular-nums text-zinc-500">
              {acct.rating.wins}W · {acct.rating.losses}L · {acct.rating.draws}D
            </span>
          </div>
          <button
            type="button"
            className="btn-gold mt-3 w-full !py-2.5"
            disabled={busy || !state.connected}
            onClick={() => void joinQueue()}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
              <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
            </svg>
            Find opponent
          </button>
          <p className="mt-2 text-center text-[11px] text-zinc-500">
            Best-of-one drafts against a rival at your level. Win to climb the ladder.
          </p>
        </>
      )}
    </div>
  );
}

/** Admin-only: one click into an engine-testing match vs a phantom opponent. */
function SandboxPanel(): JSX.Element | null {
  const { state, dispatch, pushToast } = useApp();
  const acct = state.account;
  const [busy, setBusy] = useState(false);
  if (!acct?.account.isAdmin) return null;

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const r = await call("sandboxStart");
    setBusy(false);
    if (r.ok && r.data) {
      dispatch({
        type: "sessionEstablished",
        session: {
          roomId: r.data.roomId,
          playerId: r.data.playerId,
          token: r.data.token,
          name: acct.account.username,
        },
      });
    } else {
      pushToast(r.error ?? "Could not start the engine sandbox");
    }
  };

  return (
    <div className="panel mt-4 border-purple-400/20 p-5">
      <div className="mb-3 flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-purple-300">
          <path d="M9.5 2h5v2h-1v4.6l5.7 9.5A2 2 0 0 1 17.5 21h-11a2 2 0 0 1-1.7-2.9L10.5 8.6V4h-1V2Zm3 7.1V4h-1v5.1L8.6 13h6.8l-2.9-3.9Z" />
        </svg>
        <h2 className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Engine sandbox · admin</h2>
      </div>
      <p className="text-xs leading-relaxed text-zinc-400">
        Jump straight into a test match against a goldfish. Conjure any card into any zone, drive both seats, and
        watch its triggers resolve on the stack.
      </p>
      <button
        type="button"
        className="btn-primary mt-3 w-full"
        disabled={busy || !state.connected}
        onClick={() => void start()}
      >
        Enter the sandbox
      </button>
    </div>
  );
}

export function Home(): JSX.Element {
  const { state, dispatch, pushToast } = useApp();
  const [name, setName] = useState(() => state.session?.name ?? loadName());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const trimmedName = name.trim();
  const canAct = trimmedName.length > 0 && !busy && state.connected;

  const createRoom = async (): Promise<void> => {
    if (!canAct) return;
    setBusy(true);
    saveName(trimmedName);
    const r = await call("createRoom", trimmedName);
    setBusy(false);
    if (r.ok && r.data) {
      dispatch({
        type: "sessionEstablished",
        session: { roomId: r.data.roomId, playerId: r.data.playerId, token: r.data.token, name: trimmedName },
      });
    } else {
      pushToast(r.error ?? "Could not create room");
    }
  };

  const joinRoom = async (roomId: string, token?: string): Promise<void> => {
    if (trimmedName.length === 0 || busy) return;
    setBusy(true);
    saveName(trimmedName);
    const r = await call("joinRoom", { roomId, playerName: trimmedName, token });
    setBusy(false);
    if (r.ok && r.data) {
      dispatch({
        type: "sessionEstablished",
        session: { roomId, playerId: r.data.playerId, token: r.data.token, name: trimmedName },
      });
    } else {
      pushToast(r.error ?? "Could not join room");
    }
  };

  const stored = state.session;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md animate-fade-in">
        {/* Logo treatment */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-2xl border border-brass-400/40 bg-gradient-to-br from-felt-700 to-felt-950 shadow-card-lg">
            <svg viewBox="0 0 24 24" className="h-10 w-10 fill-brass-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.55)]">
              <path d="M12 1.5 3 6.75v10.5L12 22.5l9-5.25V6.75L12 1.5Zm0 2.3 7 4.08v8.24l-7 4.08-5-2.92V8.7l-2-1.17L12 3.8Zm-5 6.06 5 2.92v5.83l-5-2.92v-5.83Z" />
            </svg>
          </div>
          <h1 className="text-4xl font-black tracking-tight text-zinc-50">
            MTG <span className="bg-gradient-to-r from-sky-300 via-brass-300 to-amber-400 bg-clip-text text-transparent">Cube</span>
          </h1>
          <p className="mt-2 text-sm text-zinc-400">Upload a cube · draft with friends · play at the table</p>
        </div>

        {!state.connected && (
          <div className="panel mb-4 flex items-center gap-2 border-amber-500/30 px-3 py-2.5 text-xs text-amber-200">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            Connecting to server…
          </div>
        )}

        {/* Rejoin card */}
        {stored && !state.joined && (
          <div className="panel mb-4 p-4">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-brass-300">Recent session</div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-zinc-100">
                  Room <span className="font-mono tracking-widest text-brass-300">{stored.roomId}</span>
                </div>
                <div className="text-xs text-zinc-500">as {stored.name}</div>
                {state.rejoinFailed && <div className="mt-1 text-[11px] text-red-400">Automatic rejoin failed — the room may be gone.</div>}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  className="btn-primary !px-3 !py-1.5 !text-xs"
                  disabled={busy || !state.connected}
                  onClick={() => void joinRoom(stored.roomId, stored.token)}
                >
                  Rejoin
                </button>
                <button
                  type="button"
                  className="btn-ghost !px-3 !py-1.5 !text-xs"
                  onClick={() => dispatch({ type: "sessionCleared" })}
                >
                  Forget
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="panel p-5">
          <label className="label" htmlFor="player-name">Your name</label>
          <input
            id="player-name"
            className="input mb-4"
            placeholder="Jace, the Mind Sculptor"
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          <button type="button" className="btn-gold w-full !py-2.5" disabled={!canAct} onClick={() => void createRoom()}>
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z" /></svg>
            Create a room
          </button>

          <div className="my-4 flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            <div className="h-px flex-1 bg-amber-100/15" />
            or join
            <div className="h-px flex-1 bg-amber-100/15" />
          </div>

          <div className="flex gap-2">
            <input
              className="input flex-1 text-center font-mono text-base uppercase tracking-[0.4em]"
              placeholder="ABC123"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.length === 6 && canAct) void joinRoom(code);
              }}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={!canAct || code.length !== 6}
              onClick={() => void joinRoom(code)}
            >
              Join
            </button>
          </div>
        </div>

        <RankedPanel />
        <SandboxPanel />

        <p className="mt-6 text-center text-[11px] text-zinc-500">
          Rooms hold up to 8 drafters — empty seats are filled with bots.
        </p>
      </div>
    </div>
  );
}
