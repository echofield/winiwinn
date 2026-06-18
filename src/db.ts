/**
 * db.ts — SQLite connection, schema (auto-created on boot) and data helpers.
 * Everything that touches the database lives here so server.ts and seed.ts
 * share one source of truth.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

const DB_PATH = process.env.DB_PATH || './field.db';
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    dna                TEXT NOT NULL,            -- JSON: { vector:number[4], color:string }
    mollie_customer_id TEXT,
    earnings_cents     INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- An edge from_user -> to_user means "from_user recommended to_user into the field".
  -- to_user_id is UNIQUE: a node joins through exactly one link, giving every node a
  -- single recommender so the domino chain is well-defined.
  CREATE TABLE IF NOT EXISTS edges (
    id           TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL,
    to_user_id   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recommendations (
    token        TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL,                  -- the payee (recommendation owner)
    title        TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    hop          INTEGER NOT NULL,               -- 0 = payee, 1 = direct recommender, ...
    source_token TEXT NOT NULL,
    payment_id   TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Idempotency guard: a payment id is processed at most once.
  CREATE TABLE IF NOT EXISTS processed_payments (
    payment_id   TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- Types -----------------------------------------------------------------
export interface Dna { vector: number[]; color: string }
export interface User {
  id: string;
  name: string;
  dna: Dna;
  mollie_customer_id: string | null;
  earnings_cents: number;
  created_at: string;
}
interface UserRow extends Omit<User, 'dna'> { dna: string }

function hydrate(row: UserRow | undefined): User | null {
  if (!row) return null;
  return { ...row, dna: JSON.parse(row.dna) as Dna };
}

// ---- Users -----------------------------------------------------------------
export function createUser(name: string, dna: Dna, mollieCustomerId: string | null): User {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, name, dna, mollie_customer_id) VALUES (?, ?, ?, ?)`
  ).run(id, name, JSON.stringify(dna), mollieCustomerId);
  return getUser(id)!;
}

export function getUser(id: string): User | null {
  return hydrate(db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined);
}

export function addEarnings(userId: string, cents: number): void {
  db.prepare(`UPDATE users SET earnings_cents = earnings_cents + ? WHERE id = ?`).run(cents, userId);
}

// ---- Edges -----------------------------------------------------------------
export function createEdge(fromUserId: string, toUserId: string): void {
  db.prepare(`INSERT OR IGNORE INTO edges (id, from_user_id, to_user_id) VALUES (?, ?, ?)`)
    .run(randomUUID(), fromUserId, toUserId);
}

/** Who recommended this user? Returns the parent user id, or null at the root. */
export function recommenderOf(userId: string): string | null {
  const row = db.prepare(`SELECT from_user_id FROM edges WHERE to_user_id = ?`).get(userId) as
    | { from_user_id: string }
    | undefined;
  return row ? row.from_user_id : null;
}

/** Walk upward from userId collecting up to `max` ancestors (recommender chain). */
export function recommenderChain(userId: string, max: number): string[] {
  const chain: string[] = [];
  let current: string | null = userId;
  while (chain.length < max) {
    const parent = recommenderOf(current);
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** All edges whose endpoints are reachable downstream from rootId (BFS). */
export function fieldEdges(rootId: string): { from: string; to: string }[] {
  const seen = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  const edges: { from: string; to: string }[] = [];
  const childStmt = db.prepare(`SELECT to_user_id FROM edges WHERE from_user_id = ?`);
  while (queue.length) {
    const u = queue.shift()!;
    for (const r of childStmt.all(u) as { to_user_id: string }[]) {
      edges.push({ from: u, to: r.to_user_id });
      if (!seen.has(r.to_user_id)) {
        seen.add(r.to_user_id);
        queue.push(r.to_user_id);
      }
    }
  }
  return edges;
}

export function usersByIds(ids: string[]): User[] {
  return ids.map((id) => getUser(id)).filter((u): u is User => u !== null);
}

// ---- Recommendations -------------------------------------------------------
export interface Recommendation {
  token: string;
  from_user_id: string;
  title: string;
  amount_cents: number;
  created_at: string;
}
export function createRecommendation(token: string, fromUserId: string, title: string, amountCents: number): Recommendation {
  db.prepare(`INSERT INTO recommendations (token, from_user_id, title, amount_cents) VALUES (?, ?, ?, ?)`)
    .run(token, fromUserId, title, amountCents);
  return getRecommendation(token)!;
}
export function getRecommendation(token: string): Recommendation | null {
  return (db.prepare(`SELECT * FROM recommendations WHERE token = ?`).get(token) as Recommendation) || null;
}

// ---- Ledger + idempotency --------------------------------------------------
export function writeLedgerRow(userId: string, amountCents: number, hop: number, sourceToken: string, paymentId: string): void {
  db.prepare(
    `INSERT INTO ledger (id, user_id, amount_cents, hop, source_token, payment_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), userId, amountCents, hop, sourceToken, paymentId);
}
export function ledgerFor(userId: string) {
  return db.prepare(`SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC`).all(userId);
}
export function alreadyProcessed(paymentId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM processed_payments WHERE payment_id = ?`).get(paymentId);
}
export function markProcessed(paymentId: string): void {
  db.prepare(`INSERT OR IGNORE INTO processed_payments (payment_id) VALUES (?)`).run(paymentId);
}

export interface LedgerRow {
  id: string; user_id: string; amount_cents: number; hop: number;
  source_token: string; payment_id: string; created_at: string;
}

/** All payout rows for one payment, the settlement source of truth. hop ascending. */
export function settlementRows(paymentId: string): LedgerRow[] {
  return db.prepare(`SELECT * FROM ledger WHERE payment_id = ? ORDER BY hop ASC`).all(paymentId) as LedgerRow[];
}

// ---- Positions -------------------------------------------------------------
/** Descendants reachable within `maxDepth` hops downstream, with their distance. */
export function descendantsWithin(rootId: string, maxDepth: number): { userId: string; hop: number }[] {
  const out: { userId: string; hop: number }[] = [];
  const seen = new Set<string>([rootId]);
  let frontier: string[] = [rootId];
  const childStmt = db.prepare(`SELECT to_user_id FROM edges WHERE from_user_id = ?`);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const u of frontier) {
      for (const r of childStmt.all(u) as { to_user_id: string }[]) {
        if (seen.has(r.to_user_id)) continue;
        seen.add(r.to_user_id);
        out.push({ userId: r.to_user_id, hop: depth });
        next.push(r.to_user_id);
      }
    }
    frontier = next;
  }
  return out;
}

/** Tokens of recommendations owned by a user. */
export function recTokensOwnedBy(userId: string): string[] {
  return (db.prepare(`SELECT token FROM recommendations WHERE from_user_id = ?`).all(userId) as { token: string }[])
    .map((r) => r.token);
}

/** Cents already paid to `userId` from conversions on `ownerId`'s recommendations. */
export function realizedFromOwner(userId: string, ownerId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(l.amount_cents), 0) AS total
       FROM ledger l JOIN recommendations r ON r.token = l.source_token
      WHERE l.user_id = ? AND r.from_user_id = ?`
  ).get(userId, ownerId) as { total: number };
  return row.total;
}

/** How many of an owner's recommendations have not yet been settled. */
export function pendingRecCount(ownerId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM recommendations r
      WHERE r.from_user_id = ?
        AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.source_token = r.token)`
  ).get(ownerId) as { c: number };
  return row.c;
}

// ---- Economy aggregate -----------------------------------------------------
export function economyStats() {
  const settled = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS c FROM ledger`).get() as { c: number };
  const payments = db.prepare(`SELECT COUNT(DISTINCT payment_id) AS c FROM ledger`).get() as { c: number };
  const nodes = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
  const edges = db.prepare(`SELECT COUNT(*) AS c FROM edges`).get() as { c: number };
  const topRows = db.prepare(
    `SELECT name, earnings_cents FROM users WHERE earnings_cents > 0 ORDER BY earnings_cents DESC LIMIT 5`
  ).all() as { name: string; earnings_cents: number }[];
  return {
    totalSettledCents: settled.c,
    totalPayments: payments.c,
    totalNodes: nodes.c,
    totalEdges: edges.c,
    topEarners: topRows.map((r) => ({ name: r.name, earningsCents: r.earnings_cents })),
  };
}

/** Average recommender-chain depth across all users (uncapped). */
export function avgChainDepth(): number {
  const users = db.prepare(`SELECT id FROM users`).all() as { id: string }[];
  if (users.length === 0) return 0;
  const total = users.reduce((sum, u) => sum + recommenderChain(u.id, 1000).length, 0);
  return Math.round((total / users.length) * 100) / 100;
}
