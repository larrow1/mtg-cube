/**
 * Socket.IO event contract. Server implements ServerToClientEvents emitters
 * and ClientToServerEvents handlers; client is the mirror image.
 */
import type {
  Account,
  AdminStats,
  AdminUserRow,
  DraftCard,
  DraftView,
  GameAction,
  GameView,
  QueueState,
  RankedMatchRecord,
  RatingInfo,
  RoomState,
  SavedCubeSummary,
  SpawnZone,
  SystemCubeSummary,
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
    args: { seatCount: number; packsPerPlayer: number; cardsPerPack: number; pickTimerSeconds: number | "dynamic" | null },
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

  // -- Admin portal (require an authenticated ADMIN socket) -----------------
  adminListSystemCubes: (ack: (r: Ack<{ cubes: SystemCubeSummary[] }>) => void) => void;
  /** Upload a preloaded cube into the ranked pool (resolved via Scryfall). */
  adminUploadSystemCube: (
    args: { name: string; list: string; active: boolean },
    ack: (r: Ack<{ cube: SystemCubeSummary }>) => void
  ) => void;
  adminSetSystemCubeActive: (
    args: { cubeId: string; active: boolean },
    ack: (r: Ack<{ cube: SystemCubeSummary }>) => void
  ) => void;
  adminDeleteSystemCube: (args: { cubeId: string }, ack: (r: Ack) => void) => void;
  adminGetStats: (ack: (r: Ack<{ stats: AdminStats }>) => void) => void;
  adminListUsers: (ack: (r: Ack<{ users: AdminUserRow[] }>) => void) => void;
  /**
   * Permanently delete a user: account, sessions, saved cubes, rating, and
   * ranked history rows involving them; live sockets are signed out. Admins
   * cannot delete their own account.
   */
  adminDeleteUser: (args: { userId: string }, ack: (r: Ack) => void) => void;
  /**
   * v7.1: grant or revoke another user's admin flag. Admins cannot demote
   * themselves. Live sockets of the target get a fresh accountState. Note:
   * ADMIN_USERNAMES re-grants listed names on their next sign-in.
   */
  adminSetUserAdmin: (args: { userId: string; isAdmin: boolean }, ack: (r: Ack) => void) => void;

  // -- Admin engine sandbox (v4.1; admin verified per call) -----------------
  /** Leave any current room and enter a fresh sandbox match vs a phantom
   *  opponent (basic-land decks). Ack = normal join credentials. */
  sandboxStart: (ack: (r: Ack<{ roomId: string; playerId: string; token: string }>) => void) => void;
  /**
   * Resolve any card name via Scryfall and conjure it into `zone` for
   * `playerId` (either match seat; default = your current seat). Registers
   * the card's data + script with the match, then applies spawnCard.
   */
  sandboxAddCard: (
    args: { name: string; zone: SpawnZone; playerId?: string },
    ack: (r: Ack<{ cardName: string }>) => void
  ) => void;
  /** Rebind this socket to the other sandbox seat and re-emit views. */
  sandboxSwitchSeat: (ack: (r: Ack<{ playerId: string; token: string; name: string }>) => void) => void;
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
