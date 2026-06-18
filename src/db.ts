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

  -- A "stake": a standing Mollie authorization (mandate / subscription) one user
  -- holds into another user's field. Data = "position"; UI may call it "stake".
  -- This is NOT locked capital — it's a programmable claim backed by Mollie.
  CREATE TABLE IF NOT EXISTS stakes (
    id              TEXT PRIMARY KEY,
    staker_user_id  TEXT NOT NULL,
    in_user_id      TEXT NOT NULL,
    amount_cents    INTEGER NOT NULL,
    interval        TEXT NOT NULL,
    mandate_id      TEXT,
    subscription_id TEXT,
    status          TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Merchant: the entity that FUNDS the economy. Money comes from here.
  CREATE TABLE IF NOT EXISTS merchants (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    mollie_customer_id TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Contract: the consented %. The merchant pre-agrees how much of a bill flows
  -- back along the warm-intro chain, so settlement is never extractive.
  CREATE TABLE IF NOT EXISTS contracts (
    id               TEXT PRIMARY KEY,
    merchant_id      TEXT NOT NULL,
    title            TEXT NOT NULL,
    reward_type      TEXT NOT NULL,           -- 'pct' | 'flat'
    reward_value     REAL NOT NULL,           -- pct (8) or flat cents (1500)
    conversion_def   TEXT NOT NULL,           -- 'covered_bill' | 'booking' | 'visit'
    cap_depth        INTEGER NOT NULL,
    split_curve      TEXT NOT NULL,           -- JSON number[]
    token            TEXT NOT NULL UNIQUE,    -- shareable merchant deal token
    payment_link_id  TEXT,
    payment_link_url TEXT,                    -- the merchant's collection point
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Conversion: a real guest covering a real bill at a merchant -> the contract fires.
  CREATE TABLE IF NOT EXISTS conversions (
    id            TEXT PRIMARY KEY,
    contract_id   TEXT NOT NULL,
    guest_user_id TEXT,
    connector_token TEXT,                     -- the recommendation link the guest arrived through
    amount_cents  INTEGER NOT NULL,           -- the bill
    reward_cents  INTEGER NOT NULL,           -- pool carved out by the contract
    payment_id    TEXT,
    status        TEXT NOT NULL,              -- 'pending' | 'settled'
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Aura: the reputation ledger. NON-monetary. Earned by helping, gated by /thank.
  CREATE TABLE IF NOT EXISTS help_events (
    id           TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL,               -- giver
    to_user_id   TEXT NOT NULL,               -- recipient
    kind         TEXT NOT NULL,               -- intro|advice|job_lead|showed_up|vouch
    note         TEXT,
    confirmed    INTEGER NOT NULL DEFAULT 0,  -- 0 until recipient /thank-confirms
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at TEXT
  );
`);

// ---- Migrations (add columns to pre-existing tables) -----------------------
function ensureColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
}
ensureColumn('users', 'aura_score', 'aura_score REAL NOT NULL DEFAULT 0');
ensureColumn('users', 'aura_given', 'aura_given INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'aura_received', 'aura_received INTEGER NOT NULL DEFAULT 0');
ensureColumn('recommendations', 'contract_id', 'contract_id TEXT');
// Reward rule carried by a recommendation (the recommender's "rule").
ensureColumn('recommendations', 'reward_kind', "reward_kind TEXT");          // cut | free | off | gift
ensureColumn('recommendations', 'reward_pct', 'reward_pct REAL');            // % for cut/off
ensureColumn('recommendations', 'reward_funder', "reward_funder TEXT");      // self | merchant
ensureColumn('recommendations', 'cap_hops', 'cap_hops INTEGER NOT NULL DEFAULT 3');

// ---- Types -----------------------------------------------------------------
export interface Dna { vector: number[]; color: string }
export interface User {
  id: string;
  name: string;
  dna: Dna;
  mollie_customer_id: string | null;
  earnings_cents: number;
  aura_score: number;
  aura_given: number;
  aura_received: number;
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

export function setMollieCustomerId(userId: string, customerId: string): void {
  db.prepare(`UPDATE users SET mollie_customer_id = ? WHERE id = ?`).run(customerId, userId);
}

// ---- Edges -----------------------------------------------------------------
export function createEdge(fromUserId: string, toUserId: string): void {
  db.prepare(`INSERT OR IGNORE INTO edges (id, from_user_id, to_user_id) VALUES (?, ?, ?)`)
    .run(randomUUID(), fromUserId, toUserId);
}

/** Does a directed edge from->to exist? */
export function edgeExists(fromUserId: string, toUserId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM edges WHERE from_user_id = ? AND to_user_id = ?`).get(fromUserId, toUserId);
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
export interface RewardRule {
  rewardKind?: "cut" | "free" | "off" | "gift" | null;
  rewardPct?: number | null;
  rewardFunder?: "self" | "merchant" | null;
  capHops?: number;
}
export interface Recommendation {
  token: string;
  from_user_id: string;
  title: string;
  amount_cents: number;
  contract_id: string | null;
  reward_kind: string | null;
  reward_pct: number | null;
  reward_funder: string | null;
  cap_hops: number;
  created_at: string;
}
export function createRecommendation(
  token: string,
  fromUserId: string,
  title: string,
  amountCents: number,
  contractId: string | null = null,
  reward: RewardRule = {},
): Recommendation {
  db.prepare(
    `INSERT INTO recommendations (token, from_user_id, title, amount_cents, contract_id, reward_kind, reward_pct, reward_funder, cap_hops)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    token, fromUserId, title, amountCents, contractId,
    reward.rewardKind ?? null, reward.rewardPct ?? null, reward.rewardFunder ?? null, reward.capHops ?? 3,
  );
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

// ---- Stakes ----------------------------------------------------------------
export interface StakeRow {
  id: string; staker_user_id: string; in_user_id: string; amount_cents: number;
  interval: string; mandate_id: string | null; subscription_id: string | null;
  status: string; created_at: string;
}
export function createStake(s: Omit<StakeRow, 'created_at'>): StakeRow {
  db.prepare(
    `INSERT INTO stakes (id, staker_user_id, in_user_id, amount_cents, interval, mandate_id, subscription_id, status)
     VALUES (@id, @staker_user_id, @in_user_id, @amount_cents, @interval, @mandate_id, @subscription_id, @status)`
  ).run(s);
  return db.prepare(`SELECT * FROM stakes WHERE id = ?`).get(s.id) as StakeRow;
}
export function stakesByStaker(stakerId: string): StakeRow[] {
  return db.prepare(`SELECT * FROM stakes WHERE staker_user_id = ?`).all(stakerId) as StakeRow[];
}

// ---- Refund / reversal -----------------------------------------------------
/** Has this original payment already been reversed (disputed)? */
export function reversalExists(originalPaymentId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ledger WHERE payment_id = ? LIMIT 1`).get(`refund_${originalPaymentId}`);
}

// ---- Merchants -------------------------------------------------------------
export interface Merchant { id: string; name: string; mollie_customer_id: string | null; created_at: string }
export function createMerchant(name: string, mollieCustomerId: string | null): Merchant {
  const id = `mch_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO merchants (id, name, mollie_customer_id) VALUES (?, ?, ?)`).run(id, name, mollieCustomerId);
  return db.prepare(`SELECT * FROM merchants WHERE id = ?`).get(id) as Merchant;
}
export function getMerchant(id: string): Merchant | null {
  return (db.prepare(`SELECT * FROM merchants WHERE id = ?`).get(id) as Merchant) || null;
}

/** Resolve a ledger actor's display name across users AND merchants. */
export function actorName(id: string): string {
  return getUser(id)?.name ?? getMerchant(id)?.name ?? 'unknown';
}

// ---- Contracts -------------------------------------------------------------
export interface Contract {
  id: string; merchant_id: string; title: string; reward_type: 'pct' | 'flat'; reward_value: number;
  conversion_def: string; cap_depth: number; split_curve: number[];
  token: string; payment_link_id: string | null; payment_link_url: string | null; created_at: string;
}
interface ContractRow extends Omit<Contract, 'split_curve'> { split_curve: string }
function hydrateContract(r: ContractRow | undefined): Contract | null {
  return r ? { ...r, split_curve: JSON.parse(r.split_curve) as number[] } : null;
}
export function createContract(c: {
  merchantId: string; title: string; rewardType: 'pct' | 'flat'; rewardValue: number;
  conversionDef: string; capDepth: number; splitCurve: number[]; token: string;
  paymentLinkId: string | null; paymentLinkUrl: string | null;
}): Contract {
  const id = `ctr_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO contracts (id, merchant_id, title, reward_type, reward_value, conversion_def, cap_depth, split_curve, token, payment_link_id, payment_link_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, c.merchantId, c.title, c.rewardType, c.rewardValue, c.conversionDef, c.capDepth, JSON.stringify(c.splitCurve), c.token, c.paymentLinkId, c.paymentLinkUrl);
  return getContract(id)!;
}
export function getContract(id: string): Contract | null {
  return hydrateContract(db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(id) as ContractRow | undefined);
}
export function getContractByToken(token: string): Contract | null {
  return hydrateContract(db.prepare(`SELECT * FROM contracts WHERE token = ?`).get(token) as ContractRow | undefined);
}
export function contractsByMerchant(merchantId: string): Contract[] {
  return (db.prepare(`SELECT * FROM contracts WHERE merchant_id = ?`).all(merchantId) as ContractRow[])
    .map((r) => hydrateContract(r)!);
}
export function updateContractLink(contractId: string, linkId: string | null, linkUrl: string | null): void {
  db.prepare(`UPDATE contracts SET payment_link_id = ?, payment_link_url = ? WHERE id = ?`).run(linkId, linkUrl, contractId);
}

// ---- Conversions -----------------------------------------------------------
export interface Conversion {
  id: string; contract_id: string; guest_user_id: string | null; connector_token: string | null;
  amount_cents: number; reward_cents: number; payment_id: string | null; status: string; created_at: string;
}
export function createConversion(c: Omit<Conversion, 'created_at'>): Conversion {
  db.prepare(
    `INSERT INTO conversions (id, contract_id, guest_user_id, connector_token, amount_cents, reward_cents, payment_id, status)
     VALUES (@id, @contract_id, @guest_user_id, @connector_token, @amount_cents, @reward_cents, @payment_id, @status)`
  ).run(c);
  return getConversion(c.id)!;
}
export function getConversion(id: string): Conversion | null {
  return (db.prepare(`SELECT * FROM conversions WHERE id = ?`).get(id) as Conversion) || null;
}
export function getConversionByPayment(paymentId: string): Conversion | null {
  return (db.prepare(`SELECT * FROM conversions WHERE payment_id = ?`).get(paymentId) as Conversion) || null;
}
export function markConversionSettled(id: string): void {
  db.prepare(`UPDATE conversions SET status = 'settled' WHERE id = ?`).run(id);
}

// ---- Aura / help -----------------------------------------------------------
export interface HelpEvent {
  id: string; from_user_id: string; to_user_id: string; kind: string; note: string | null;
  confirmed: number; created_at: string; confirmed_at: string | null;
}
export function createHelpEvent(fromUserId: string, toUserId: string, kind: string, note: string | null): HelpEvent {
  const id = `help_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO help_events (id, from_user_id, to_user_id, kind, note) VALUES (?, ?, ?, ?, ?)`)
    .run(id, fromUserId, toUserId, kind, note);
  db.prepare(`UPDATE users SET aura_given = aura_given + 1 WHERE id = ?`).run(fromUserId);
  return getHelpEvent(id)!;
}
export function getHelpEvent(id: string): HelpEvent | null {
  return (db.prepare(`SELECT * FROM help_events WHERE id = ?`).get(id) as HelpEvent) || null;
}
export function confirmHelpEvent(id: string): void {
  db.prepare(`UPDATE help_events SET confirmed = 1, confirmed_at = datetime('now') WHERE id = ?`).run(id);
}
/** Confirmed help a user received, with each giver's current aura score. */
export function confirmedReceived(userId: string): { giverId: string; kind: string; giverScore: number }[] {
  return db.prepare(
    `SELECT h.from_user_id AS giverId, h.kind AS kind, COALESCE(u.aura_score, 0) AS giverScore
       FROM help_events h LEFT JOIN users u ON u.id = h.from_user_id
      WHERE h.to_user_id = ? AND h.confirmed = 1
      ORDER BY h.created_at ASC`
  ).all(userId) as { giverId: string; kind: string; giverScore: number }[];
}
export function setAuraScore(userId: string, score: number, received: number): void {
  db.prepare(`UPDATE users SET aura_score = ?, aura_received = ? WHERE id = ?`).run(score, received, userId);
}
export function vouchCountFor(userId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM help_events WHERE to_user_id = ? AND kind = 'vouch' AND confirmed = 1`).get(userId) as { c: number }).c;
}
export function recentHelpFor(userId: string, limit = 10): HelpEvent[] {
  return db.prepare(
    `SELECT * FROM help_events WHERE to_user_id = ? OR from_user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(userId, userId, limit) as HelpEvent[];
}
/** Confirmed vouchers (who vouched for this user). */
export function vouchersFor(userId: string): string[] {
  return (db.prepare(`SELECT DISTINCT from_user_id FROM help_events WHERE to_user_id = ? AND kind = 'vouch' AND confirmed = 1`).all(userId) as { from_user_id: string }[])
    .map((r) => r.from_user_id);
}
