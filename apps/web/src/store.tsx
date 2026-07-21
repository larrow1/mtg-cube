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
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import type { Account, DraftView, GameView, QueueState, RatingInfo, RoomState } from "@mtg-cube/shared";
import { call, socket } from "./socket";
import { preloadCardImages, primeCards } from "./lib/cardCache";

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

/** A signed-in account plus its current ranked rating, as one unit. */
export interface AccountState {
  account: Account;
  rating: RatingInfo;
}

export type ToastKind = "error" | "success" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface CubeCardPreloadState {
  cubeId: string;
  loaded: number;
  total: number;
  failed: number;
  ready: boolean;
  error?: string;
}

export interface AppState {
  session: Session | null;
  connected: boolean;
  /** True once we have successfully joined (or rejoined) our room this run. */
  joined: boolean;
  /** Set when an automatic token rejoin was rejected (room gone, seat taken…). */
  rejoinFailed: boolean;
  room: RoomState | null;
  /** Lobby-time card metadata and artwork preparation for the loaded cube. */
  cardPreload: CubeCardPreloadState | null;
  draft: DraftView | null;
  game: GameView | null;
  /** GameId the viewer dismissed after it finished (returns to the room UI). */
  dismissedGameId: string | null;
  chat: ChatMessage[];
  toasts: ToastItem[];
  /** Signed-in account (null = anonymous). Accounts are optional everywhere outside ranked. */
  account: AccountState | null;
  /** Ranked matchmaking status while searching; null when not queued. */
  queue: QueueState | null;
  /** Sign-in / create-account modal visibility (openable from any screen). */
  authOpen: boolean;
  /** Admin portal visibility (client-side route flag; admins only). */
  adminOpen: boolean;
}

export type AppEvent =
  | { type: "connected"; connected: boolean }
  | { type: "sessionEstablished"; session: Session }
  | { type: "sessionCleared" }
  | { type: "rejoinFailed" }
  | { type: "roomState"; room: RoomState }
  | { type: "cardPreloadState"; preload: CubeCardPreloadState | null }
  | { type: "draftState"; draft: DraftView }
  | { type: "gameState"; game: GameView }
  | { type: "dismissGame"; gameId: string }
  | { type: "rejoinGame" }
  | { type: "chat"; msg: ChatMessage }
  | { type: "toast"; kind: ToastKind; message: string }
  | { type: "dismissToast"; id: number }
  | { type: "accountState"; account: AccountState | null }
  | { type: "queueState"; queue: QueueState | null }
  | { type: "openAuth" }
  | { type: "closeAuth" }
  | { type: "openAdmin" }
  | { type: "closeAdmin" };

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
// Account token persistence
// ---------------------------------------------------------------------------

const ACCOUNT_KEY = "mtg-cube-account";

export function loadAccountToken(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

export function persistAccountToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(ACCOUNT_KEY, token);
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // localStorage unavailable — the sign-in just won't survive reloads.
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
  cardPreload: null,
  draft: null,
  game: null,
  dismissedGameId: null,
  chat: [],
  toasts: [],
  account: null,
  queue: null,
  authOpen: false,
  adminOpen: false,
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
        cardPreload: null,
        draft: null,
        game: null,
        dismissedGameId: null,
        chat: [],
      };
    case "rejoinFailed":
      return { ...state, rejoinFailed: true };
    case "roomState":
      return { ...state, room: event.room };
    case "cardPreloadState":
      return { ...state, cardPreload: event.preload };
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
    case "accountState":
      // Losing the account also ends any ranked queue membership; losing admin
      // (sign-out mid-session) also closes the admin portal.
      return {
        ...state,
        account: event.account,
        queue: event.account ? state.queue : null,
        adminOpen: state.adminOpen && event.account?.account.isAdmin === true,
      };
    case "queueState":
      return { ...state, queue: event.queue };
    case "openAuth":
      return { ...state, authOpen: true };
    case "closeAuth":
      return { ...state, authOpen: false };
    case "openAdmin":
      return { ...state, adminOpen: true };
    case "closeAdmin":
      return { ...state, adminOpen: false };
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
  signOut: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Latest account, readable from the (mount-once) socket listeners below.
  const accountRef = useRef<AccountState | null>(state.account);
  accountRef.current = state.account;
  const activeCubeIdRef = useRef<string | null>(null);
  const catalogLoadsRef = useRef(new Map<string, Promise<void>>());
  const catalogProgressRef = useRef(new Map<string, CubeCardPreloadState>());

  const pushToast = useCallback((message: string, kind: ToastKind = "error") => {
    dispatch({ type: "toast", kind, message });
  }, []);

  const leaveRoom = useCallback(() => {
    void call("leaveRoom").then(() => undefined);
    dispatch({ type: "sessionCleared" });
  }, []);

  const signOut = useCallback(() => {
    void call("logout").then(() => undefined);
    persistAccountToken(null);
    dispatch({ type: "accountState", account: null });
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
      const accountToken = loadAccountToken();
      if (accountToken) {
        // Re-bind the stored account to this socket; a stale/invalid token is
        // discarded silently (the user simply stays anonymous).
        void call("authenticate", { token: accountToken }).then((r) => {
          if (r.ok && r.data) {
            dispatch({ type: "accountState", account: { account: r.data.account, rating: r.data.rating } });
          } else {
            persistAccountToken(null);
            dispatch({ type: "accountState", account: null });
          }
        });
      }
    };
    const onDisconnect = (): void => {
      dispatch({ type: "connected", connected: false });
      // A dropped socket also drops us from the matchmaking queue server-side.
      dispatch({ type: "queueState", queue: null });
    };
    const onRoomState = (room: RoomState): void => {
      dispatch({ type: "roomState", room });
      const cube = room.cube;
      activeCubeIdRef.current = cube?.id ?? null;
      if (!cube) {
        dispatch({ type: "cardPreloadState", preload: null });
        return;
      }

      const known = catalogProgressRef.current.get(cube.id);
      if (known) dispatch({ type: "cardPreloadState", preload: known });
      if (catalogLoadsRef.current.has(cube.id) || known?.ready) return;

      const initial: CubeCardPreloadState = {
        cubeId: cube.id,
        loaded: 0,
        total: cube.cardCount,
        failed: 0,
        ready: false,
      };
      catalogProgressRef.current.set(cube.id, initial);
      dispatch({ type: "cardPreloadState", preload: initial });

      const load = (async (): Promise<void> => {
        const response = await call("getCubeCardCatalog");
        if (!response.ok || !response.data) {
          throw new Error(response.error ?? "Could not prepare the cube's cards");
        }
        if (response.data.cubeId !== cube.id) {
          throw new Error("The cube changed while its cards were being prepared");
        }

        primeCards(response.data.cards);
        const result = await preloadCardImages(response.data.cards, (progress) => {
          const next: CubeCardPreloadState = { cubeId: cube.id, ...progress, ready: false };
          catalogProgressRef.current.set(cube.id, next);
          if (activeCubeIdRef.current === cube.id) {
            dispatch({ type: "cardPreloadState", preload: next });
          }
        });
        const complete: CubeCardPreloadState = { cubeId: cube.id, ...result, ready: true };
        catalogProgressRef.current.set(cube.id, complete);
        if (activeCubeIdRef.current === cube.id) {
          dispatch({ type: "cardPreloadState", preload: complete });
        }
      })().catch((err: unknown) => {
        const failed: CubeCardPreloadState = {
          cubeId: cube.id,
          loaded: 0,
          total: cube.cardCount,
          failed: 0,
          ready: false,
          error: err instanceof Error ? err.message : String(err),
        };
        catalogProgressRef.current.set(cube.id, failed);
        catalogLoadsRef.current.delete(cube.id);
        if (activeCubeIdRef.current === cube.id) {
          dispatch({ type: "cardPreloadState", preload: failed });
        }
      });
      catalogLoadsRef.current.set(cube.id, load);
    };
    const onDraftState = (draft: DraftView): void => dispatch({ type: "draftState", draft });
    const onGameState = (game: GameView): void => dispatch({ type: "gameState", game });
    const onChat = (msg: ChatMessage): void => dispatch({ type: "chat", msg });
    const onErrorMsg = (message: string): void => dispatch({ type: "toast", kind: "error", message });
    const onAccountState = (s: { account: Account; rating: RatingInfo } | null): void =>
      dispatch({ type: "accountState", account: s });
    const onQueueState = (queue: QueueState | null): void => dispatch({ type: "queueState", queue });
    const onQueueMatched = (info: { roomId: string; opponentUsername: string; opponentRank: string }): void => {
      dispatch({ type: "queueState", queue: null });
      dispatch({
        type: "toast",
        kind: "success",
        message: `Opponent found: ${info.opponentUsername} (${info.opponentRank}) — joining the draft…`,
      });
      // Auto-join the ranked room, reusing the normal join/session flow.
      const playerName = accountRef.current?.account.username ?? "Player";
      void call("joinRoom", { roomId: info.roomId, playerName }).then((r) => {
        if (r.ok && r.data) {
          dispatch({
            type: "sessionEstablished",
            session: { roomId: info.roomId, playerId: r.data.playerId, token: r.data.token, name: playerName },
          });
        } else {
          dispatch({ type: "toast", kind: "error", message: r.error ?? "Could not join the ranked room" });
        }
      });
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("roomState", onRoomState);
    socket.on("draftState", onDraftState);
    socket.on("gameState", onGameState);
    socket.on("chat", onChat);
    socket.on("errorMsg", onErrorMsg);
    socket.on("accountState", onAccountState);
    socket.on("queueState", onQueueState);
    socket.on("queueMatched", onQueueMatched);
    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("roomState", onRoomState);
      socket.off("draftState", onDraftState);
      socket.off("gameState", onGameState);
      socket.off("chat", onChat);
      socket.off("errorMsg", onErrorMsg);
      socket.off("accountState", onAccountState);
      socket.off("queueState", onQueueState);
      socket.off("queueMatched", onQueueMatched);
    };
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({ state, dispatch, pushToast, leaveRoom, signOut }),
    [state, pushToast, leaveRoom, signOut]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}
