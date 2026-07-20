/**
 * Typed socket.io singleton + promisified `call` helper for acked emits.
 */
import { io, type Socket } from "socket.io-client";
import type { Ack, ClientToServerEvents, ServerToClientEvents } from "@mtg-cube/shared";

/**
 * Server URL resolution:
 * - VITE_SERVER_URL always wins when set (dev or prod).
 * - Dev builds fall back to the standalone dev server on localhost:3001.
 * - Production builds connect same-origin (the Node server serves both the
 *   static client and Socket.IO on one port).
 */
const SERVER_URL: string | undefined =
  import.meta.env.VITE_SERVER_URL ?? (import.meta.env.DEV ? "http://localhost:3001" : undefined);

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const socketOptions = {
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 4000,
};

export const socket: AppSocket = SERVER_URL ? io(SERVER_URL, socketOptions) : io(socketOptions);

type C2S = ClientToServerEvents;

/** Event names whose last parameter is an ack callback. */
type AckedEvent = {
  [E in keyof C2S]: Parameters<C2S[E]> extends [...unknown[], (r: Ack<never>) => void]
    ? E
    : Parameters<C2S[E]> extends [...unknown[], (r: Ack<infer _D>) => void]
      ? E
      : never;
}[keyof C2S];

type ArgsOf<E extends AckedEvent> = Parameters<C2S[E]> extends [...infer A, (r: Ack<infer _D>) => void]
  ? A
  : never;

type DataOf<E extends AckedEvent> = Parameters<C2S[E]> extends [...unknown[], (r: Ack<infer D>) => void]
  ? D
  : never;

const CALL_TIMEOUT_MS = 10_000;

/**
 * Emit an acked event and resolve with the server's Ack. Never rejects: a
 * missing server / timeout resolves with `{ ok: false, error }` so callers can
 * uniformly toast the error string.
 */
export function call<E extends AckedEvent>(event: E, ...args: ArgsOf<E>): Promise<Ack<DataOf<E>>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: "Server did not respond — is it running?" });
      }
    }, CALL_TIMEOUT_MS);
    const emit = socket.emit.bind(socket) as unknown as (ev: string, ...rest: unknown[]) => void;
    emit(event, ...args, (r: Ack<DataOf<E>>) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timer);
        resolve(r);
      }
    });
  });
}

/** Fire-and-forget chat message (no ack in the contract). */
export function sendChat(message: string): void {
  socket.emit("chat", message);
}
