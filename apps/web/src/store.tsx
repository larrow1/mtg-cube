/**
 * App-wide store: plain React context + useReducer.
 * - session persisted under localStorage "mtg-cube-session"
 * - latest RoomState / DraftView / GameView (stale GameView seq ignored)
 * - auto-rejoin with stored token on socket connect
 * - toast queue
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { DraftView, GameView, RoomState } from "@mtg-cube/shared";
import { call, socket } from "./socket";
import { primeCards } from "./lib/cardCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  roomId: string;
  playerId: string;
  token: string;
  name: string;
}

export interface ChatMessage {
  playerId: string;
  playerName: string;
  message: string;
  ts: number;
}

export type ToastKind = "error" | "success" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface AppState {
  session: Session | null;
  connected: boolean;
  /** True once we have successfully joined (or rejoined) our room this run. */
  joined: boolean;
  /** Set when an automatic token rejoin was rejected (room gone, seat taken…). */
  rejoinFailed: boolean;
  room: RoomState | null;
  draft: DraftView | null;
  game: GameView | null;
  /** GameId the viewer dismissed after it finished (returns to the room UI). */
  dismissedGameId: string | null;
  chat: ChatMessage[];
  toasts: ToastItem[];
}

export type AppEvent =
  | { type: "connected"; connected: boolean }
  | { type: "sessionEstablished"; session: Session }
  | { type: "sessionCleared" }
  | { type: "rejoinFailed" }
  | { type: "roomState"; room: RoomState }
  | { type: "draftState"; draft: DraftView }
  | { type: "gameState"; game: GameView }
  | { type: "dismissGame"; gameId: string }
  | { type: "rejoinGame" }
  | { type: "chat"; msg: ChatMessage }
  | { type: "toast"; kind: ToastKind; message: string }
  | { type: "dismissToast"; id: number };

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

const SESSION_KEY = "mtg-cube-session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Session>;
    if (
      typeof s.roomId === "string" &&
      typeof s.playerId === "string" &&
      typeof s.token === "string" &&
      typeof s.name === "string"
    ) {
      return { roomId: s.roomId, playerId: s.playerId, token: s.token, name: s.name };
    }
    return null;
  } catch {
    return null;
  }
}

function persistSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // localStorage unavailable — session just won't survive reloads.
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

let toastId = 0;
const MAX_CHAT = 250;

const initialState: AppState = {
  session: loadSession(),
  connected: false,
  joined: false,
  rejoinFailed: false,
  room: null,
  draft: null,
  game: null,
  dismissedGameId: null,
  chat: [],
  toasts: [],
};

function reducer(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "connected":
      return { ...state, connected: event.connected };
    case "sessionEstablished":
      persistSession(event.session);
      return { ...state, session: event.session, joined: true, rejoinFailed: false };
    case "sessionCleared":
      persistSession(null);
      return {
        ...state,
        session: null,
        joined: false,
        rejoinFailed: false,
        room: null,
        draft: null,
        game: null,
        dismissedGameId: null,
        chat: [],
      };
    case "rejoinFailed":
      return { ...state, rejoinFailed: true };
    case "roomState":
      return { ...state, room: event.room };
    case "draftState":
      return { ...state, draft: event.draft };
    case "gameState": {
      const next = event.game;
      const cur = state.game;
      // Ignore stale views: lower seq for the same game.
      if (cur && cur.gameId === next.gameId && next.state.seq < cur.state.seq) return state;
      // Ignore re-broadcasts of a finished game the viewer already left.
      if (state.dismissedGameId === next.gameId && next.state.finished) return state;
      primeCards(next.cards);
      // A dismissal sticks (even for live games) until the viewer explicitly
      // rejoins — updates still land in `game` so "Return to match" stays fresh.
      return { ...state, game: next };
    }
    case "dismissGame": {
      // Keep the game view for live games (so the room can offer "Return to
      // match"); drop it once the game is finished.
      const game =
        state.game && state.game.gameId === event.gameId && state.game.state.finished
          ? null
          : state.game;
      return { ...state, game, dismissedGameId: event.gameId };
    }
    case "rejoinGame":
      return { ...state, dismissedGameId: null };
    case "chat": {
      const chat = [...state.chat, event.msg];
      if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT);
      return { ...state, chat };
    }
    case "toast": {
      const toast: ToastItem = { id: ++toastId, kind: event.kind, message: event.message };
      return { ...state, toasts: [...state.toasts.slice(-4), toast] };
    }
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== event.id) };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppEvent>;
  pushToast: (message: string, kind?: ToastKind) => void;
  leaveRoom: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);

  const pushToast = useCallback((message: string, kind: ToastKind = "error") => {
    dispatch({ type: "toast", kind, message });
  }, []);

  const leaveRoom = useCallback(() => {
    void call("leaveRoom").then(() => undefined);
    dispatch({ type: "sessionCleared" });
  }, []);

  useEffect(() => {
    const onConnect = (): void => {
      dispatch({ type: "connected", connected: true });
      const s = loadSession();
      if (s) {
        // Auto-rejoin with the stored token; server re-emits current views.
        void call("joinRoom", { roomId: s.roomId, playerName: s.name, token: s.token }).then((r) => {
          if (r.ok && r.data) {
            dispatch({
              type: "sessionEstablished",
              session: { ...s, playerId: r.data.playerId, token: r.data.token },
            });
          } else {
            dispatch({ type: "rejoinFailed" });
          }
        });
      }
    };
    const onDisconnect = (): void => dispatch({ type: "connected", connected: false });
    const onRoomState = (room: RoomState): void => dispatch({ type: "roomState", room });
    const onDraftState = (draft: DraftView): void => dispatch({ type: "draftState", draft });
    const onGameState = (game: GameView): void => dispatch({ type: "gameState", game });
    const onChat = (msg: ChatMessage): void => dispatch({ type: "chat", msg });
    const onErrorMsg = (message: string): void => dispatch({ type: "toast", kind: "error", message });

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("roomState", onRoomState);
    socket.on("draftState", onDraftState);
    socket.on("gameState", onGameState);
    socket.on("chat", onChat);
    socket.on("errorMsg", onErrorMsg);
    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("roomState", onRoomState);
      socket.off("draftState", onDraftState);
      socket.off("gameState", onGameState);
      socket.off("chat", onChat);
      socket.off("errorMsg", onErrorMsg);
    };
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ state, dispatch, pushToast, leaveRoom }),
    [state, pushToast, leaveRoom]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}
