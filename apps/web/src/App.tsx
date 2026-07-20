/**
 * Top-level shell: routes screens from app state (no router library).
 *   - not joined            -> Home
 *   - viewer in active game -> Game
 *   - else by room.phase    -> Lobby / Draft / Deckbuild
 */
import { AccountMenu } from "./components/AccountMenu";
import { CardPreviewProvider } from "./components/Card";
import { ToastLayer } from "./components/Toast";
import { useApp } from "./store";
import { AdminPortal } from "./screens/AdminPortal";
import { Home } from "./screens/Home";
import { Lobby } from "./screens/Lobby";
import { Draft } from "./screens/Draft";
import { Deckbuild } from "./screens/Deckbuild";
import { Game } from "./screens/Game";

function Router(): JSX.Element {
  const { state } = useApp();
  const { session, joined, room, game } = state;

  if (!joined || !room || !session) return <Home />;

  if (game && state.dismissedGameId !== game.gameId) {
    const participant = game.state.players.some((p) => p.playerId === session.playerId);
    if (participant) return <Game />;
  }

  switch (room.phase) {
    case "lobby":
      return <Lobby />;
    case "drafting":
      return <Draft />;
    case "deckbuild":
    case "playing":
      return <Deckbuild />;
    default:
      return <Lobby />;
  }
}

/** Admin portal overlay: sits above the router when the client-side flag is set. */
function AdminLayer(): JSX.Element | null {
  const { state } = useApp();
  if (!state.adminOpen) return null;
  return <AdminPortal />;
}

function ConnectionBanner(): JSX.Element | null {
  const { state } = useApp();
  if (state.connected || !state.joined) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[110] flex items-center justify-center gap-2 bg-red-900/90 py-1.5 text-xs font-semibold text-red-100 shadow-card">
      <span className="h-2 w-2 animate-pulse rounded-full bg-red-300" />
      Connection lost — reconnecting…
    </div>
  );
}

function TopBar(): JSX.Element {
  return (
    <div className="relative z-40 flex h-11 shrink-0 items-center justify-between border-b border-amber-100/[0.07] bg-felt-950/40 px-3">
      <div className="flex items-center gap-1.5 text-xs font-black tracking-tight text-zinc-400">
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-brass-300/80">
          <path d="M12 1.5 3 6.75v10.5L12 22.5l9-5.25V6.75L12 1.5Z" />
        </svg>
        MTG <span className="text-brass-300/90">Cube</span>
      </div>
      <AccountMenu />
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <CardPreviewProvider>
      <div className="flex h-full flex-col">
        <ConnectionBanner />
        <TopBar />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Router />
        </div>
        <AdminLayer />
        <ToastLayer />
      </div>
    </CardPreviewProvider>
  );
}
