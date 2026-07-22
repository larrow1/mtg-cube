import { useEffect, useMemo, useState } from "react";
import { ChatPanel } from "../components/ChatPanel";
import { call } from "../socket";
import { useApp } from "../store";

export function MatchLobby({
  suppressEntranceAnimation = false,
}: {
  suppressEntranceAnimation?: boolean;
} = {}): JSX.Element {
  const { state, pushToast } = useApp();
  const room = state.room;
  const me = state.session;
  const [pairA, setPairA] = useState("");
  const [pairB, setPairB] = useState("");
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);

  const readyPlayers = useMemo(
    () => room?.players.filter((player) => room.decksSubmitted.includes(player.id)) ?? [],
    [room],
  );
  const readyKey = readyPlayers.map((player) => player.id).join(":");

  useEffect(() => {
    const readyIds = readyKey ? readyKey.split(":") : [];
    setPairA(readyIds[0] ?? "");
    setPairB(readyIds[1] ?? "");
  }, [readyKey]);

  if (!room || !me) {
    return (
      <div className="lobby-scene flex h-full items-center justify-center">
        <div className="panel px-6 py-4 text-sm text-zinc-400">Loading match lobby…</div>
      </div>
    );
  }

  const isHost = room.hostId === me.playerId;
  const selectedPlayersReady = room.decksSubmitted.includes(pairA)
    && room.decksSubmitted.includes(pairB);
  const nameOfPlayer = (playerId: string): string =>
    room.players.find((player) => player.id === playerId)?.name ?? "Unknown";

  const copyCode = (): void => {
    void navigator.clipboard.writeText(room.id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => pushToast(`Room code: ${room.id}`, "info"));
  };

  const startMatch = async (): Promise<void> => {
    if (!pairA || !pairB || pairA === pairB || !selectedPlayersReady) return;
    setStarting(true);
    const result = await call("startMatch", { playerA: pairA, playerB: pairB });
    setStarting(false);
    if (result.ok) pushToast("Match started", "success");
    else pushToast(result.error ?? "Could not start match");
  };

  return (
    <div className="lobby-scene h-full min-h-0 overflow-y-auto px-4 py-5 md:px-6 md:py-6">
      <div className={`relative z-10 mx-auto flex min-h-full max-w-6xl flex-col ${
        suppressEntranceAnimation ? "" : "animate-fade-in"
      }`}>
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-brass-300/80">
              Draft complete
            </div>
            <h1 className="font-display text-3xl font-black text-zinc-50">Match Lobby</h1>
            <p className="mt-1 text-xs text-zinc-400">
              {room.ranked
                ? "Your submitted deck is ready for automatic pairing."
                : "Pair two ready players, then start the game."}
            </p>
          </div>
          <button type="button" className="panel flex items-center gap-3 px-4 py-2 text-left" onClick={copyCode}>
            <span>
              <span className="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">Room code</span>
              <span className="font-mono text-lg font-black tracking-[0.24em] text-amber-100">{room.id}</span>
            </span>
            <span className="text-[10px] font-bold text-brass-300">{copied ? "Copied" : "Copy"}</span>
          </button>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_1fr_20rem]">
          <div className="flex min-h-0 flex-col gap-4">
            <section className="panel p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-[10px] font-black uppercase tracking-[0.14em] text-zinc-400">Players</h2>
                <span className="chip border-emerald-400/30 text-emerald-300">
                  {room.decksSubmitted.length}/{room.players.length} ready
                </span>
              </div>
              <ul className="space-y-2">
                {room.players.map((player) => {
                  const ready = room.decksSubmitted.includes(player.id);
                  return (
                    <li key={player.id} className="panel-inset flex items-center gap-3 px-3 py-2.5">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${player.connected ? "bg-emerald-400" : "bg-zinc-600"}`} />
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-sm font-bold ${player.id === me.playerId ? "text-brass-300" : "text-zinc-100"}`}>
                          {player.name}{player.id === me.playerId ? " (you)" : ""}
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          {player.id === room.hostId ? "Host · " : ""}{player.connected ? "Connected" : "Disconnected"}
                        </div>
                      </div>
                      <span className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-wider ${
                        ready
                          ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-300"
                          : "border-amber-300/20 bg-amber-300/5 text-amber-200/60"
                      }`}>
                        {ready ? "Deck ready" : "Building"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="panel flex-1 p-4">
              <h2 className="mb-3 text-[10px] font-black uppercase tracking-[0.14em] text-zinc-400">Matches</h2>
              {room.matches.length === 0 ? (
                <div className="flex min-h-28 items-center justify-center text-center text-xs text-zinc-500">
                  No matches have started yet.
                </div>
              ) : (
                <ul className="space-y-2">
                  {room.matches.map((match) => (
                    <li key={match.id} className="panel-inset flex items-center justify-between gap-3 px-3 py-3">
                      <span className="truncate text-sm font-bold text-zinc-100">
                        {nameOfPlayer(match.playerIds[0])}
                        <span className="mx-2 text-zinc-600">vs</span>
                        {nameOfPlayer(match.playerIds[1])}
                      </span>
                      <span className={`chip ${match.finished ? "text-brass-300" : "border-emerald-400/35 text-emerald-300"}`}>
                        {match.finished
                          ? match.winnerId ? `${nameOfPlayer(match.winnerId)} won` : "Draw"
                          : "Live"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="panel flex min-h-[18rem] flex-col p-5">
            <div className="mb-5">
              <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full border border-brass-300/30 bg-brass-300/10 text-2xl text-brass-200">
                ⚔
              </div>
              <h2 className="font-display text-2xl font-black text-zinc-50">
                {room.ranked ? "Finding a match" : isHost ? "Start a game" : "Waiting for the host"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                {room.ranked
                  ? "Pairing starts automatically as soon as every required deck is submitted."
                  : isHost
                    ? "Choose two players whose decks are ready. The game opens automatically for both players."
                    : "The room host can pair ready players and launch the next match."}
              </p>
            </div>

            {room.ranked ? (
              <div className="mt-auto rounded-xl border border-sky-300/20 bg-sky-300/[0.06] px-4 py-3 text-center text-xs font-bold text-sky-200">
                {readyPlayers.length >= 2 ? "Pairing players…" : "Waiting for another deck…"}
              </div>
            ) : isHost ? (
              <div className="mt-auto space-y-3">
                <label className="block">
                  <span className="label">Player one</span>
                  <select className="input" value={pairA} onChange={(event) => setPairA(event.target.value)}>
                    <option value="">Choose a ready player…</option>
                    {readyPlayers.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="label">Player two</span>
                  <select className="input" value={pairB} onChange={(event) => setPairB(event.target.value)}>
                    <option value="">Choose a ready player…</option>
                    {readyPlayers.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn-gold w-full !py-3"
                  disabled={starting || !pairA || !pairB || pairA === pairB || !selectedPlayersReady}
                  onClick={() => void startMatch()}
                >
                  {starting ? "Starting game…" : "Start Game"}
                </button>
                {readyPlayers.length < 2 && (
                  <p className="text-center text-[10px] text-zinc-500">Two submitted decks are required.</p>
                )}
              </div>
            ) : (
              <div className="mt-auto rounded-xl border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3 text-center text-xs font-bold text-amber-100/80">
                Your deck is submitted and ready.
              </div>
            )}
          </section>

          <ChatPanel className="min-h-[24rem] lg:min-h-0" />
        </div>
      </div>
    </div>
  );
}
