/**
 * Socket.IO event contract. Server implements ServerToClientEvents emitters
 * and ClientToServerEvents handlers; client is the mirror image.
 */
import type { DraftView, GameAction, GameView, RoomState, DraftCard } from "./types.js";

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
}

export interface ServerToClientEvents {
  roomState: (state: RoomState) => void;
  draftState: (view: DraftView) => void;
  gameState: (view: GameView) => void;
  chat: (msg: { playerId: string; playerName: string; message: string; ts: number }) => void;
  errorMsg: (message: string) => void;
}
