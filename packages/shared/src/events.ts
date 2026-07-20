/**
 * Socket.IO event contract. Server implements ServerToClientEvents emitters
 * and ClientToServerEvents handlers; client is the mirror image.
 */
import type {
  Account,
  DraftCard,
  DraftView,
  GameAction,
  GameView,
  QueueState,
  RankedMatchRecord,
  RatingInfo,
  RoomState,
  SavedCubeSummary,
} from "./types.js";

export interface Ack<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ClientToServerEvents {
  /** Create a room; ack returns the room id. Also joins the room. */
  createRoom: (playerName: string, ack: (r: Ack<{ roomId: string; playerId: string; token: string }>) => void) => void;
  /** Join (or rejoin with token) an existing room. */
  joinRoom: (
    args: { roomId: string; playerName: string; token?: string },
    ack: (r: Ack<{ playerId: string; token: string }>) => void
  ) => void;
  leaveRoom: (ack: (r: Ack) => void) => void;

  /** Host uploads a cube list (raw text, one card per line, "4 Name" counts ok). */
  uploadCube: (args: { name: string; list: string }, ack: (r: Ack<{ cardCount: number; unresolved: string[] }>) => void) => void;

  /** Host configures + starts the draft. Empty seats are filled with bots. */
  startDraft: (
    args: { seatCount: number; packsPerPlayer: number; cardsPerPack: number; pickTimerSeconds: number | null },
    ack: (r: Ack) => void
  ) => void;
  makePick: (args: { instanceId: string }, ack: (r: Ack) => void) => void;

  /** Submit deck after draft. main/side are instance ids from your picks; basics by name count. */
  submitDeck: (
    args: { main: DraftCard[]; sideboard: DraftCard[]; basics: Record<string, number> },
    ack: (r: Ack) => void
  ) => void;

  /** Host pairs two players and starts a match. */
  startMatch: (args: { playerA: string; playerB: string }, ack: (r: Ack<{ matchId: string }>) => void) => void;

  /** Any in-game action; server validates actor + rules, applies, broadcasts. */
  gameAction: (args: { matchId: string; action: GameAction }, ack: (r: Ack) => void) => void;

  chat: (message: string) => void;

  // -- Accounts (all optional to use; rooms still work anonymously) ---------
  /** Create an account. Also authenticates this socket. */
  register: (
    args: { username: string; password: string },
    ack: (r: Ack<{ token: string; account: Account; rating: RatingInfo }>) => void
  ) => void;
  /** Log in with credentials. Also authenticates this socket. */
  login: (
    args: { username: string; password: string },
    ack: (r: Ack<{ token: string; account: Account; rating: RatingInfo }>) => void
  ) => void;
  /** Bind a stored account token to this socket (on connect/refresh). */
  authenticate: (
    args: { token: string },
    ack: (r: Ack<{ account: Account; rating: RatingInfo }>) => void
  ) => void;
  /** Invalidate the token and unbind the socket. */
  logout: (ack: (r: Ack) => void) => void;
  getProfile: (
    ack: (r: Ack<{ account: Account; rating: RatingInfo; history: RankedMatchRecord[] }>) => void
  ) => void;

  // -- Saved cubes (require an authenticated socket) ------------------------
  /** Save a cube list to the account (server re-resolves via Scryfall). */
  saveCube: (
    args: { name: string; list: string; rankedEligible: boolean },
    ack: (r: Ack<{ cube: SavedCubeSummary }>) => void
  ) => void;
  listMyCubes: (ack: (r: Ack<{ cubes: SavedCubeSummary[] }>) => void) => void;
  deleteCube: (args: { cubeId: string }, ack: (r: Ack) => void) => void;
  setCubeRankedEligible: (
    args: { cubeId: string; rankedEligible: boolean },
    ack: (r: Ack<{ cube: SavedCubeSummary }>) => void
  ) => void;
  /** Host+lobby only: set the room's cube from one of your saved cubes. */
  loadCubeIntoRoom: (args: { cubeId: string }, ack: (r: Ack<{ cardCount: number }>) => void) => void;

  // -- Ranked matchmaking (require an authenticated socket) -----------------
  /** Join the ranked queue. Server emits queueState while searching and
   *  queueMatched when paired; the client then joins the created room. */
  queueJoin: (ack: (r: Ack) => void) => void;
  queueLeave: (ack: (r: Ack) => void) => void;
}

export interface ServerToClientEvents {
  roomState: (state: RoomState) => void;
  draftState: (view: DraftView) => void;
  gameState: (view: GameView) => void;
  chat: (msg: { playerId: string; playerName: string; message: string; ts: number }) => void;
  errorMsg: (message: string) => void;
  /** Account bound to this socket changed (login/logout/rating update). */
  accountState: (state: { account: Account; rating: RatingInfo } | null) => void;
  /** Periodic queue status while searching; null when no longer queued. */
  queueState: (state: QueueState | null) => void;
  /** A ranked pairing was made — join `roomId` (joinRoom) to enter the draft. */
  queueMatched: (info: { roomId: string; opponentUsername: string; opponentRank: string }) => void;
}
