/**
 * Lobby: room code + copy, player list (host crown, connection dots), cube
 * upload panel (paste / .txt file), draft config form, start draft (host),
 * chat.
 */
import { useRef, useState, type ChangeEvent } from "react";
import type { RoomState } from "@mtg-cube/shared";
import { call } from "../socket";
import { useApp } from "../store";
import { ChatPanel } from "../components/ChatPanel";

function CrownIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-brass-300" aria-label="Host">
      <path d="m3 7 4.5 4L12 4l4.5 7L21 7l-1.5 11h-15L3 7Zm3.2 13h11.6v2H6.2v-2Z" />
    </svg>
  );
}

function TimerOption({ value, current, onSelect }: { value: number | null; current: number | null; onSelect: (v: number | null) => void }): JSX.Element {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-all duration-150 ${
        active ? "bg-gradient-to-b from-brass-300 to-brass-500 text-amber-950 shadow-card" : "bg-white/[0.05] text-zinc-400 hover:bg-white/10"
      }`}
    >
      {value === null ? "Off" : `${value}s`}
    </button>
  );
}

interface CubePanelProps {
  room: RoomState;
  isHost: boolean;
}

function CubePanel({ room, isHost }: CubePanelProps): JSX.Element {
  const { pushToast } = useApp();
  const [cubeName, setCubeName] = useState("My Cube");
  const [list, setList] = useState("");
  const [uploading, setUploading] = useState(false);
  const [showUnresolved, setShowUnresolved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setList(reader.result);
        setCubeName(file.name.replace(/\.txt$/i, "") || "My Cube");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const upload = async (): Promise<void> => {
    const text = list.trim();
    if (text.length === 0) {
      pushToast("Paste a cube list or choose a .txt file first");
      return;
    }
    setUploading(true);
    const r = await call("uploadCube", { name: cubeName.trim() || "My Cube", list: text });
    setUploading(false);
    if (r.ok && r.data) {
      pushToast(
        `Cube uploaded: ${r.data.cardCount} cards${r.data.unresolved.length > 0 ? `, ${r.data.unresolved.length} unresolved` : ""}`,
        r.data.unresolved.length > 0 ? "info" : "success"
      );
    } else {
      pushToast(r.error ?? "Cube upload failed");
    }
  };

  const cube = room.cube;

  return (
    <section className="panel p-4">
      <h2 className="mb-3 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Cube</h2>

      {cube && (
        <div className="panel-inset mb-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-brass-300">{cube.name}</div>
              <div className="text-xs text-zinc-500">{cube.cardCount} cards resolved</div>
            </div>
            <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0 fill-brass-400/80"><path d="M12 1.5 3 6.75v10.5L12 22.5l9-5.25V6.75L12 1.5Z" /></svg>
          </div>
          {cube.unresolved.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] font-semibold text-amber-300 transition-colors duration-150 hover:text-amber-200"
                onClick={() => setShowUnresolved((v) => !v)}
              >
                <svg viewBox="0 0 24 24" className={`h-3 w-3 fill-current transition-transform duration-150 ${showUnresolved ? "rotate-90" : ""}`}>
                  <path d="M9 5l7 7-7 7V5Z" />
                </svg>
                {cube.unresolved.length} line{cube.unresolved.length === 1 ? "" : "s"} could not be resolved
              </button>
              {showUnresolved && (
                <ul className="scrollbar-slim mt-1.5 max-h-32 space-y-0.5 overflow-y-auto rounded-md bg-black/30 p-2 font-mono text-[11px] text-amber-200/80">
                  {cube.unresolved.map((line, i) => (
                    <li key={`${line}-${i}`} className="truncate">{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {isHost ? (
        <>
          <label className="label" htmlFor="cube-name">Cube name</label>
          <input id="cube-name" className="input mb-2" value={cubeName} maxLength={60} onChange={(e) => setCubeName(e.target.value)} />
          <label className="label" htmlFor="cube-list">Card list — one per line, “4 Lightning Bolt” counts ok</label>
          <textarea
            id="cube-list"
            className="input scrollbar-slim mb-2 h-36 resize-y font-mono text-xs leading-relaxed"
            placeholder={"Lightning Bolt\nCounterspell\n2 Llanowar Elves\n…"}
            value={list}
            onChange={(e) => setList(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={onFile} />
            <button type="button" className="btn-ghost !text-xs" onClick={() => fileRef.current?.click()}>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="M12 3 6 9h4v6h4V9h4l-6-6ZM5 19h14v2H5v-2Z" /></svg>
              .txt file
            </button>
            <span className="flex-1 truncate text-[11px] text-zinc-500">
              {list.trim().length > 0 ? `${list.trim().split("\n").filter((l) => l.trim().length > 0).length} lines ready` : "No list loaded"}
            </span>
            <button type="button" className="btn-primary !text-xs" disabled={uploading || list.trim().length === 0} onClick={() => void upload()}>
              {uploading ? "Resolving…" : cube ? "Replace cube" : "Upload cube"}
            </button>
          </div>
        </>
      ) : (
        !cube && (
          <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-amber-100/15 py-6 text-center">
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-indigo-400/50"><path d="M12 1.5 3 6.75v10.5L12 22.5l9-5.25V6.75L12 1.5Z" /></svg>
            <span className="text-xs text-zinc-400">No cube yet — the host is still rummaging through their binder…</span>
          </div>
        )
      )}
    </section>
  );
}

export function Lobby(): JSX.Element {
  const { state, pushToast, leaveRoom } = useApp();
  const room = state.room;
  const me = state.session;
  const [copied, setCopied] = useState(false);
  const [seatCount, setSeatCount] = useState(4);
  const [packsPerPlayer, setPacksPerPlayer] = useState(3);
  const [cardsPerPack, setCardsPerPack] = useState(15);
  const [pickTimerSeconds, setPickTimerSeconds] = useState<number | null>(60);
  const [starting, setStarting] = useState(false);

  if (!room || !me) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="panel animate-fade-in px-6 py-4 text-sm text-zinc-400">Loading room…</div>
      </div>
    );
  }

  const isHost = room.hostId === me.playerId;

  const copyCode = (): void => {
    void navigator.clipboard
      .writeText(room.id)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => pushToast("Could not copy — code is " + room.id, "info"));
  };

  const startDraft = async (): Promise<void> => {
    setStarting(true);
    const r = await call("startDraft", { seatCount, packsPerPlayer, cardsPerPack, pickTimerSeconds });
    setStarting(false);
    if (!r.ok) pushToast(r.error ?? "Could not start draft");
  };

  const humanCount = room.players.length;

  return (
    <div className="mx-auto max-w-6xl animate-fade-in p-4 md:p-6">
      {/* Header: room code */}
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 24 24" className="h-8 w-8 fill-brass-300 drop-shadow-[0_0_6px_rgba(251,191,36,0.4)]"><path d="M12 1.5 3 6.75v10.5L12 22.5l9-5.25V6.75L12 1.5Z" /></svg>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Room code</div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-3xl font-black tracking-[0.3em] text-zinc-50">{room.id}</span>
              <button
                type="button"
                onClick={copyCode}
                className="btn-ghost !px-2 !py-1.5 !text-[11px]"
                title="Copy room code"
              >
                {copied ? (
                  <>
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-emerald-400"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" /></svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z" /></svg>
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
        <button type="button" className="btn-ghost !text-xs" onClick={leaveRoom}>
          Leave room
        </button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_20rem]">
        {/* Players */}
        <section className="panel p-4">
          <h2 className="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            Players <span className="chip">{humanCount}</span>
          </h2>
          <ul className="space-y-1.5">
            {room.players.map((p) => (
              <li key={p.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${p.connected ? "bg-emerald-400" : "bg-red-500"}`}
                  title={p.connected ? "Connected" : "Disconnected"}
                />
                <span className={`flex-1 truncate text-sm font-semibold ${p.id === me.playerId ? "text-brass-300" : "text-zinc-200"}`}>
                  {p.name}
                  {p.id === me.playerId && <span className="text-zinc-500"> (you)</span>}
                </span>
                {p.id === room.hostId && <CrownIcon />}
              </li>
            ))}
          </ul>
          {humanCount < seatCount && (
            <p className="mt-3 text-[11px] text-zinc-500">
              {seatCount - humanCount} empty seat{seatCount - humanCount === 1 ? "" : "s"} will be filled with bots.
            </p>
          )}

          {/* Draft config */}
          <div className="mt-4 border-t border-amber-100/[0.08] pt-4">
            <h3 className="mb-3 text-[10px] font-bold uppercase tracking-wider text-zinc-400">Draft setup {!isHost && <span className="normal-case text-zinc-600">(host controls)</span>}</h3>
            <div className={isHost ? "" : "pointer-events-none opacity-50"}>
              <label className="label">Seats: {seatCount}</label>
              <input
                type="range"
                min={2}
                max={8}
                value={seatCount}
                onChange={(e) => setSeatCount(Number(e.target.value))}
                className="mb-3 w-full accent-amber-400"
              />
              <div className="mb-3 grid grid-cols-2 gap-2">
                <div>
                  <label className="label" htmlFor="packs">Packs / player</label>
                  <input
                    id="packs"
                    type="number"
                    min={1}
                    max={6}
                    className="input"
                    value={packsPerPlayer}
                    onChange={(e) => setPacksPerPlayer(Math.max(1, Math.min(6, Number(e.target.value) || 1)))}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="cpp">Cards / pack</label>
                  <input
                    id="cpp"
                    type="number"
                    min={5}
                    max={20}
                    className="input"
                    value={cardsPerPack}
                    onChange={(e) => setCardsPerPack(Math.max(5, Math.min(20, Number(e.target.value) || 15)))}
                  />
                </div>
              </div>
              <label className="label">Pick timer</label>
              <div className="flex gap-1.5">
                {([null, 30, 60, 90] as const).map((v) => (
                  <TimerOption key={String(v)} value={v} current={pickTimerSeconds} onSelect={setPickTimerSeconds} />
                ))}
              </div>
            </div>
            {isHost && (
              <button
                type="button"
                className="btn-gold mt-4 w-full !py-2.5"
                disabled={!room.cube || starting}
                onClick={() => void startDraft()}
                title={room.cube ? "Start the draft" : "Upload a cube first"}
              >
                {starting ? "Dealing packs…" : "Start draft"}
              </button>
            )}
            {isHost && !room.cube && <p className="mt-2 text-center text-[11px] text-zinc-500">Upload a cube to enable the draft.</p>}
          </div>
        </section>

        {/* Cube */}
        <CubePanel room={room} isHost={isHost} />

        {/* Chat */}
        <ChatPanel className="min-h-[24rem] lg:min-h-0" />
      </div>
    </div>
  );
}
