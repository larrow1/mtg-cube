/**
 * SQLite persistence via the Node built-in `node:sqlite` (no native deps).
 * ALL SQL lives in this module (data-access layer); callers get typed
 * functions. The database opens lazily on first use, runs idempotent
 * CREATE TABLE IF NOT EXISTS migrations, and uses WAL mode.
 *
 * Location: DB_PATH env, default `<apps/server>/data/mtg-cube.db`
 * (production: /app/data/mtg-cube.db on a mounted volume).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { STARTING_RATING } from "@mtg-cube/shared";
import type { CardData, Cube } from "@mtg-cube/shared";

// ---------------------------------------------------------------------------
// Open + migrate
// ---------------------------------------------------------------------------

/** src/db.ts -> apps/server/data; bundled dist/index.js -> apps/server/data. */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(moduleDir, "..", "data", "mtg-cube.db");

/** Cubes with this owner are admin-managed system cubes (the ranked pool). */
export const SYSTEM_OWNER_ID = "system";

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS cubes (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  list_text       TEXT NOT NULL,
  cards_json      TEXT NOT NULL,
  card_count      INTEGER NOT NULL,
  unresolved_json TEXT NOT NULL,
  ranked_eligible INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cubes_owner ON cubes(owner_id);

CREATE TABLE IF NOT EXISTS ratings (
  user_id TEXT PRIMARY KEY,
  rating  INTEGER NOT NULL,
  wins    INTEGER NOT NULL DEFAULT 0,
  losses  INTEGER NOT NULL DEFAULT 0,
  draws   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ranked_matches (
  id             TEXT PRIMARY KEY,
  user_a         TEXT NOT NULL,
  user_b         TEXT NOT NULL,
  winner_user_id TEXT,
  delta_a        INTEGER NOT NULL,
  delta_b        INTEGER NOT NULL,
  ts             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ranked_matches_a ON ranked_matches(user_a, ts);
CREATE INDEX IF NOT EXISTS idx_ranked_matches_b ON ranked_matches(user_b, ts);
`;

let db: DatabaseSync | null = null;

/** Idempotently ALTER a pre-existing table that is missing a newer column. */
function ensureColumn(database: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`SQLite migration: added ${table}.${column}`);
  }
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const dbPath = process.env.DB_PATH?.trim() || DEFAULT_DB_PATH;
  mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(MIGRATIONS);
  // v2.1 columns for databases created before they existed in MIGRATIONS.
  ensureColumn(db, "users", "is_admin", "is_admin INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "cubes", "active", "active INTEGER NOT NULL DEFAULT 1");
  // Opportunistic hygiene: drop long-expired sessions on boot.
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  console.log(`SQLite database ready at ${path.resolve(dbPath)}`);
  return db;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  created_at: number;
}

export function createUser(username: string, passwordHash: string): UserRow {
  const row: UserRow = {
    id: nanoid(12),
    username,
    password_hash: passwordHash,
    is_admin: 0,
    created_at: Date.now(),
  };
  try {
    getDb()
      .prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(row.id, row.username, row.password_hash, row.created_at);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new Error("That username is already taken");
    }
    throw err;
  }
  return row;
}

export function findUserByUsername(username: string): UserRow | undefined {
  // Column collation is NOCASE, so `=` compares case-insensitively.
  return getDb().prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | UserRow
    | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** Grant admin (idempotent). There is deliberately no revoke path (v2.1). */
export function setUserAdmin(userId: string): void {
  getDb().prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(userId);
}

// ---------------------------------------------------------------------------
// Sessions (tokens arrive here already hashed — hashing lives in auth.ts)
// ---------------------------------------------------------------------------

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export function createSession(tokenHash: string, userId: string, expiresAt: number): void {
  getDb()
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash, userId, Date.now(), expiresAt);
}

/** Look up a live session; expired sessions are treated as absent (and pruned). */
export function findSession(tokenHash: string): SessionRow | undefined {
  const row = getDb().prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
    | SessionRow
    | undefined;
  if (!row) return undefined;
  if (row.expires_at <= Date.now()) {
    deleteSession(tokenHash);
    return undefined;
  }
  return row;
}

export function deleteSession(tokenHash: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

// ---------------------------------------------------------------------------
// Cubes
// ---------------------------------------------------------------------------

/** Resolved cube payload stored as cards_json. */
export interface StoredCubeCards {
  cardIds: string[];
  cards: Record<string, CardData>;
}

export interface CubeSummaryRow {
  id: string;
  owner_id: string;
  name: string;
  card_count: number;
  unresolved: string[];
  ranked_eligible: boolean;
  /** System cubes only: inactive cubes are excluded from the ranked pool. */
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface CubeFullRow extends CubeSummaryRow {
  list_text: string;
  cards: StoredCubeCards;
}

interface RawCubeRow {
  id: string;
  owner_id: string;
  name: string;
  list_text: string;
  cards_json: string;
  card_count: number;
  unresolved_json: string;
  ranked_eligible: number;
  active: number;
  created_at: number;
  updated_at: number;
}

function toSummary(raw: RawCubeRow): CubeSummaryRow {
  return {
    id: raw.id,
    owner_id: raw.owner_id,
    name: raw.name,
    card_count: raw.card_count,
    unresolved: JSON.parse(raw.unresolved_json) as string[],
    ranked_eligible: raw.ranked_eligible !== 0,
    active: raw.active !== 0,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

const SUMMARY_COLUMNS =
  "id, owner_id, name, card_count, unresolved_json, ranked_eligible, active, created_at, updated_at";

export function insertCube(args: {
  id?: string;
  ownerId: string;
  name: string;
  listText: string;
  cards: StoredCubeCards;
  unresolved: string[];
  rankedEligible: boolean;
  /** System cubes only; defaults to true. */
  active?: boolean;
}): CubeSummaryRow {
  const now = Date.now();
  const raw: RawCubeRow = {
    id: args.id ?? nanoid(12),
    owner_id: args.ownerId,
    name: args.name,
    list_text: args.listText,
    cards_json: JSON.stringify(args.cards),
    card_count: args.cards.cardIds.length,
    unresolved_json: JSON.stringify(args.unresolved),
    ranked_eligible: args.rankedEligible ? 1 : 0,
    active: args.active === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO cubes (id, owner_id, name, list_text, cards_json, card_count, unresolved_json,
                          ranked_eligible, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      raw.id,
      raw.owner_id,
      raw.name,
      raw.list_text,
      raw.cards_json,
      raw.card_count,
      raw.unresolved_json,
      raw.ranked_eligible,
      raw.active,
      raw.created_at,
      raw.updated_at
    );
  return toSummary(raw);
}

export function countCubesByOwner(ownerId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM cubes WHERE owner_id = ?").get(ownerId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

export function listCubesByOwner(ownerId: string): CubeSummaryRow[] {
  const rows = getDb()
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM cubes WHERE owner_id = ? ORDER BY updated_at DESC`)
    .all(ownerId) as unknown as (RawCubeRow & { unresolved_json: string })[];
  return rows.map((r) => toSummary({ ...r, list_text: "", cards_json: "" }));
}

export function getCubeById(id: string): CubeFullRow | undefined {
  const raw = getDb().prepare("SELECT * FROM cubes WHERE id = ?").get(id) as RawCubeRow | undefined;
  if (!raw) return undefined;
  return {
    ...toSummary(raw),
    list_text: raw.list_text,
    cards: JSON.parse(raw.cards_json) as StoredCubeCards,
  };
}

/** Build a room-ready Cube from a stored row (no Scryfall hit). */
export function cubeFromRow(row: CubeFullRow): Cube {
  return {
    id: row.id,
    name: row.name,
    cardIds: row.cards.cardIds,
    cards: row.cards.cards,
    unresolved: row.unresolved,
  };
}

/** Delete a cube the owner owns. Returns false if it did not exist / isn't theirs. */
export function deleteCube(id: string, ownerId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM cubes WHERE id = ? AND owner_id = ?")
    .run(id, ownerId);
  return result.changes > 0;
}

export function setCubeRankedEligible(
  id: string,
  ownerId: string,
  rankedEligible: boolean
): CubeSummaryRow | undefined {
  const result = getDb()
    .prepare("UPDATE cubes SET ranked_eligible = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .run(rankedEligible ? 1 : 0, Date.now(), id, ownerId);
  if (result.changes === 0) return undefined;
  const raw = getDb().prepare("SELECT * FROM cubes WHERE id = ?").get(id) as RawCubeRow | undefined;
  return raw ? toSummary(raw) : undefined;
}

/** The ranked cube pool: ACTIVE system cubes + user cubes opted into ranked. */
export function listRankedPool(): CubeSummaryRow[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM cubes
       WHERE (owner_id = ? AND active = 1) OR (owner_id != ? AND ranked_eligible = 1)`
    )
    .all(SYSTEM_OWNER_ID, SYSTEM_OWNER_ID) as unknown as (RawCubeRow & { unresolved_json: string })[];
  return rows.map((r) => toSummary({ ...r, list_text: "", cards_json: "" }));
}

// ---------------------------------------------------------------------------
// System cubes (admin-managed; owner_id = SYSTEM_OWNER_ID)
// ---------------------------------------------------------------------------

export function listSystemCubes(): CubeSummaryRow[] {
  const rows = getDb()
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM cubes WHERE owner_id = ? ORDER BY updated_at DESC`)
    .all(SYSTEM_OWNER_ID) as unknown as (RawCubeRow & { unresolved_json: string })[];
  return rows.map((r) => toSummary({ ...r, list_text: "", cards_json: "" }));
}

/** Toggle a system cube in/out of the ranked pool. Undefined if not a system cube. */
export function setCubeActive(id: string, active: boolean): CubeSummaryRow | undefined {
  const result = getDb()
    .prepare("UPDATE cubes SET active = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .run(active ? 1 : 0, Date.now(), id, SYSTEM_OWNER_ID);
  if (result.changes === 0) return undefined;
  const raw = getDb().prepare("SELECT * FROM cubes WHERE id = ?").get(id) as RawCubeRow | undefined;
  return raw ? toSummary(raw) : undefined;
}

/** Rename a cube in place (used to migrate the seeded default cube's name). */
export function renameCube(id: string, name: string): void {
  getDb().prepare("UPDATE cubes SET name = ? WHERE id = ?").run(name, id);
}

// ---------------------------------------------------------------------------
// Admin stats counts
// ---------------------------------------------------------------------------

function countRow(sql: string, ...params: (string | number)[]): number {
  const row = getDb().prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function countUsers(): number {
  return countRow("SELECT COUNT(*) AS n FROM users");
}

/** User-saved cubes (system cubes excluded). */
export function countSavedCubes(): number {
  return countRow("SELECT COUNT(*) AS n FROM cubes WHERE owner_id != ?", SYSTEM_OWNER_ID);
}

export function countRankedMatches(): number {
  return countRow("SELECT COUNT(*) AS n FROM ranked_matches");
}

/** User-owned cubes currently opted into the ranked pool. */
export function countUserEligibleCubes(): number {
  return countRow(
    "SELECT COUNT(*) AS n FROM cubes WHERE owner_id != ? AND ranked_eligible = 1",
    SYSTEM_OWNER_ID
  );
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

export interface RatingRow {
  user_id: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

/** Current rating, defaulting to the starting rating for unrated players. */
export function getRating(userId: string): RatingRow {
  const row = getDb().prepare("SELECT * FROM ratings WHERE user_id = ?").get(userId) as
    | RatingRow
    | undefined;
  return row ?? { user_id: userId, rating: STARTING_RATING, wins: 0, losses: 0, draws: 0 };
}

export function upsertRating(row: RatingRow): void {
  getDb()
    .prepare(
      `INSERT INTO ratings (user_id, rating, wins, losses, draws) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         rating = excluded.rating, wins = excluded.wins,
         losses = excluded.losses, draws = excluded.draws`
    )
    .run(row.user_id, row.rating, row.wins, row.losses, row.draws);
}

// ---------------------------------------------------------------------------
// Ranked match history
// ---------------------------------------------------------------------------

export interface RankedMatchRow {
  id: string;
  user_a: string;
  user_b: string;
  winner_user_id: string | null;
  delta_a: number;
  delta_b: number;
  ts: number;
}

export function insertRankedMatch(row: RankedMatchRow): void {
  getDb()
    .prepare(
      `INSERT INTO ranked_matches (id, user_a, user_b, winner_user_id, delta_a, delta_b, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.id, row.user_a, row.user_b, row.winner_user_id, row.delta_a, row.delta_b, row.ts);
}

export interface RankedHistoryRow extends RankedMatchRow {
  username_a: string;
  username_b: string;
}

/** Most recent ranked matches for a user (default last 20), with usernames. */
export function listRankedHistory(userId: string, limit = 20): RankedHistoryRow[] {
  return getDb()
    .prepare(
      `SELECT m.*, ua.username AS username_a, ub.username AS username_b
       FROM ranked_matches m
       JOIN users ua ON ua.id = m.user_a
       JOIN users ub ON ub.id = m.user_b
       WHERE m.user_a = ? OR m.user_b = ?
       ORDER BY m.ts DESC
       LIMIT ?`
    )
    .all(userId, userId, limit) as unknown as RankedHistoryRow[];
}
