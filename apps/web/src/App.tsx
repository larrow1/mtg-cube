/**
 * Top-level shell: routes screens from app state (no router library).
 *   - not joined            -> Home
 *   - viewer in active game -> Game
 *   - else by room.phase    -> Lobby / Draft / Deckbuild
 */
import { useState } from "react";
import { AccountMenu } from "./components/AccountMenu";
import { AuthModal } from "./components/AuthModal";
import { CardPreviewProvider } from "./components/Card";
import { Modal } from "./components/Modal";
import { ToastLayer } from "./components/Toast";
import { useVisualTheme, VisualThemeProvider } from "./components/VisualThemeProvider";
import { useApp } from "./store";
import { AdminPortal } from "./screens/AdminPortal";
import { Home } from "./screens/Home";
import { Lobby } from "./screens/Lobby";
import { Draft } from "./screens/Draft";
import { Deckbuild } from "./screens/Deckbuild";
import { Game } from "./screens/Game";
import { demoGameView, demoRoom, demoSession } from "./lib/demoGame";

function Router(): JSX.Element {
  const { state } = useApp();
  const { session, joined, room, game } = state;

  // A standalone, fully populated table for visual UI work — no room or draft needed.
  if (new URLSearchParams(window.location.search).get("demo") === "game") {
    return <Game demoView={demoGameView} demoRoom={demoRoom} demoSession={demoSession} />;
  }

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

/** Phase-aware copy for the global leave confirmation. */
function leaveCopy(
  phase: string,
  inActiveMatch: boolean,
  ranked: boolean
): { title: string; body: string; confirm: string; danger: boolean } {
  if (phase === "drafting") {
    return {
      title: "Quit the draft?",
      body: ranked
        ? "This is a ranked draft — a bot takes over your seat, and abandoning the match will count against you. This can't be undone."
        : "A bot takes over your seat for the rest of the draft and keeps your picks. This can't be undone.",
      confirm: "Quit draft",
      danger: true,
    };
  }
  if (inActiveMatch) {
    return {
      title: "Leave mid-match?",
      body: ranked
        ? "Leaving a ranked match starts a 3-minute clock — if you don't return, you concede the match."
        : "Your opponent will be left at the table. If the game is decided, consider conceding first so the result is recorded.",
      confirm: "Leave anyway",
      danger: true,
    };
  }
  if (phase === "deckbuild" || phase === "playing") {
    return {
      title: "Leave the room?",
      body: ranked
        ? "This is a ranked room — leaving before your match resolves counts against you."
        : "Your drafted pool stays behind and you won't be able to rejoin this draft.",
      confirm: "Leave room",
      danger: true,
    };
  }
  return {
    title: "Leave this room?",
    body: "You can join again with the room code while the room is open.",
    confirm: "Leave room",
    danger: false,
  };
}

/**
 * Global exit: visible on every screen while in a room. Confirms with
 * phase-aware stakes, then leaves the room and returns to the home screen.
 * The wordmark doubles as a home button through the same confirmation.
 */
function TopBar(): JSX.Element {
  const { state, leaveRoom } = useApp();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const joined = state.joined && state.room != null;
  const demoGame = new URLSearchParams(window.location.search).get("demo") === "game";

  if ((!joined && !demoGame) || (joined && state.room?.phase === "lobby")) return <></>;

  const room = state.room;
  const inActiveMatch =
    joined &&
    state.session != null &&
    room!.matches.some((m) => !m.finished && m.playerIds.includes(state.session!.playerId));
  const copy = joined ? leaveCopy(room!.phase, inActiveMatch, room!.ranked) : null;

  const openConfirm = (): void => {
    if (joined) setConfirmOpen(true);
  };

  return (
    <div className="relative z-40 flex h-11 shrink-0 items-center justify-between border-b border-amber-100/[0.07] bg-felt-950/40 px-3">
      <button
        type="button"
        onClick={openConfirm}
        className={`flex items-center gap-1.5 text-xs font-black tracking-tight text-zinc-400 transition-colors duration-150 ${
          joined ? "hover:text-zinc-200" : "cursor-default"
        }`}
        title={joined ? "Return to the home screen" : undefined}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-brass-300/80">
          <path d="M12 1.5 3 6.75v10.5L12 22.5l9-5.25V6.75L12 1.5Z" />
        </svg>
        MTG <span className="text-brass-300/90">Cube</span>
      </button>
      <div className="flex items-center gap-2">
        {joined && (
          <button
            type="button"
            onClick={openConfirm}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold text-zinc-300 transition-colors duration-150 hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-200"
            title="Leave and return to the home screen"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
              <path d="M10 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-8v-2h7V5h-7V3Zm1.5 6.5V7l-6 5 6 5v-2.5H16v-3h-4.5Z" />
            </svg>
            Leave
          </button>
        )}
        <AccountMenu />
      </div>
      {confirmOpen && copy && (
        <Modal
          title={copy.title}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            leaveRoom();
          }}
          confirmLabel={copy.confirm}
          danger={copy.danger}
          width="sm"
        >
          <p className="text-sm text-zinc-300">{copy.body}</p>
        </Modal>
      )}
    </div>
  );
}

function AppShell(): JSX.Element {
  const { state } = useApp();
  const { theme } = useVisualTheme();

  return (
    <CardPreviewProvider>
      <div className="visual-theme-shell flex h-full flex-col" data-visual-theme={theme}>
        <ConnectionBanner />
        <TopBar />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Router />
        </div>
        {state.authOpen && <AuthModal />}
        <AdminLayer />
        <ToastLayer />
      </div>
    </CardPreviewProvider>
  );
}

export default function App(): JSX.Element {
  return (
    <VisualThemeProvider>
      <AppShell />
    </VisualThemeProvider>
  );
}
