/**
 * Home: name entry, create room, join by 6-char code, rejoin card for a
 * stored session.
 */
import { useState } from "react";
import { call } from "../socket";
import { useApp } from "../store";

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

        <p className="mt-6 text-center text-[11px] text-zinc-500">
          Rooms hold up to 8 drafters — empty seats are filled with bots.
        </p>
      </div>
    </div>
  );
}
