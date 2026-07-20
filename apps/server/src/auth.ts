/**
 * Accounts: validation, bcrypt password hashing, SHA-256-hashed session
 * tokens, an in-memory login rate limiter, and the socket<->account binding
 * maps (forward + reverse) so rating updates can be pushed to every socket a
 * user has open.
 */
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { rankFor } from "@mtg-cube/shared";
import type { Account, RatingInfo } from "@mtg-cube/shared";
import {
  createSession,
  createUser,
  deleteSession,
  findSession,
  findUserById,
  findUserByUsername,
  getRating,
} from "./db.js";

const BCRYPT_COST = 10;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateUsername(raw: unknown): string {
  const username = String(raw ?? "").trim();
  if (!USERNAME_RE.test(username)) {
    throw new Error("Username must be 3-20 characters: letters, digits, underscores");
  }
  return username;
}

export function validatePassword(raw: unknown): string {
  const password = String(raw ?? "");
  if (password.length < 8 || password.length > 100) {
    throw new Error("Password must be 8-100 characters");
  }
  return password;
}

// ---------------------------------------------------------------------------
// Login rate limiting: 10 failed attempts per username+IP per 15 minutes
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 10;

/** username(lowercased)|ip -> timestamps of recent failures. */
const loginFailures = new Map<string, number[]>();

function rateKey(username: string, ip: string): string {
  return `${username.toLowerCase()}|${ip}`;
}

function assertNotRateLimited(username: string, ip: string): void {
  const key = rateKey(username, ip);
  const now = Date.now();
  const recent = (loginFailures.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_FAILURES) {
    throw new Error("Too many failed login attempts — try again in a few minutes");
  }
  if (recent.length > 0) loginFailures.set(key, recent);
  else loginFailures.delete(key);
}

function recordLoginFailure(username: string, ip: string): void {
  const key = rateKey(username, ip);
  const now = Date.now();
  const recent = (loginFailures.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  loginFailures.set(key, recent);
}

function clearLoginFailures(username: string, ip: string): void {
  loginFailures.delete(rateKey(username, ip));
}

// ---------------------------------------------------------------------------
// Tokens & sessions
// ---------------------------------------------------------------------------

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issueSession(userId: string): { token: string; tokenHash: string } {
  const token = nanoid(32);
  const tokenHash = hashToken(token);
  createSession(tokenHash, userId, Date.now() + SESSION_TTL_MS);
  return { token, tokenHash };
}

function toAccount(user: { id: string; username: string; created_at: number }): Account {
  return { id: user.id, username: user.username, createdAt: user.created_at };
}

export interface AuthResult {
  token: string;
  tokenHash: string;
  account: Account;
}

/** Create an account (username must be free) and open a session. */
export async function registerUser(username: string, password: string): Promise<AuthResult> {
  if (findUserByUsername(username)) throw new Error("That username is already taken");
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const user = createUser(username, passwordHash);
  const { token, tokenHash } = issueSession(user.id);
  return { token, tokenHash, account: toAccount(user) };
}

/** Verify credentials (rate limited per username+IP) and open a session. */
export async function loginUser(username: string, password: string, ip: string): Promise<AuthResult> {
  assertNotRateLimited(username, ip);
  const user = findUserByUsername(username);
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !ok) {
    recordLoginFailure(username, ip);
    throw new Error("Invalid username or password");
  }
  clearLoginFailures(username, ip);
  const { token, tokenHash } = issueSession(user.id);
  return { token, tokenHash, account: toAccount(user) };
}

/** Resolve a raw session token to its account, or null if invalid/expired. */
export function verifyToken(token: string): { account: Account; tokenHash: string } | null {
  if (typeof token !== "string" || token.length < 8 || token.length > 128) return null;
  const tokenHash = hashToken(token);
  const session = findSession(tokenHash);
  if (!session) return null;
  const user = findUserById(session.user_id);
  if (!user) return null;
  return { account: toAccount(user), tokenHash };
}

export function revokeSessionByHash(tokenHash: string): void {
  deleteSession(tokenHash);
}

// ---------------------------------------------------------------------------
// Socket <-> account binding
// ---------------------------------------------------------------------------

interface SocketBinding {
  userId: string;
  /** Hash of the session token this socket authenticated with (for logout). */
  tokenHash: string;
}

const socketBindings = new Map<string, SocketBinding>();
const userSockets = new Map<string, Set<string>>();

export function bindSocket(socketId: string, userId: string, tokenHash: string): void {
  unbindSocket(socketId); // a socket has at most one bound account
  socketBindings.set(socketId, { userId, tokenHash });
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(socketId);
}

/** Remove the binding for a socket; returns the userId it was bound to, if any. */
export function unbindSocket(socketId: string): string | undefined {
  const binding = socketBindings.get(socketId);
  if (!binding) return undefined;
  socketBindings.delete(socketId);
  const set = userSockets.get(binding.userId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(binding.userId);
  }
  return binding.userId;
}

export function bindingForSocket(socketId: string): SocketBinding | undefined {
  return socketBindings.get(socketId);
}

export function userIdForSocket(socketId: string): string | undefined {
  return socketBindings.get(socketId)?.userId;
}

export function socketIdsForUser(userId: string): ReadonlySet<string> {
  return userSockets.get(userId) ?? new Set();
}

// ---------------------------------------------------------------------------
// Account snapshots
// ---------------------------------------------------------------------------

export function ratingInfoFor(userId: string): RatingInfo {
  const row = getRating(userId);
  return {
    rating: row.rating,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    gamesPlayed: row.wins + row.losses + row.draws,
    rank: rankFor(row.rating),
  };
}

/** Payload for the accountState event, or null if the user vanished. */
export function accountStateFor(userId: string): { account: Account; rating: RatingInfo } | null {
  const user = findUserById(userId);
  if (!user) return null;
  return { account: toAccount(user), rating: ratingInfoFor(userId) };
}
