/**
 * Top-level shell: routes screens from app state (no router library).
 *   - not joined            -> Home
 *   - viewer in active game -> Game
 *   - else by room.phase    -> Lobby / Draft / Deckbuild
 */
import { CardPreviewProvider } from "./components/Card";
import { ToastLayer } from "./components/Toast";
import { useApp } from "./store";
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

export default function App(): JSX.Element {
  return (
    <CardPreviewProvider>
      <div className="min-h-full">
        <ConnectionBanner />
        <Router />
        <ToastLayer />
      </div>
    </CardPreviewProvider>
  );
}
