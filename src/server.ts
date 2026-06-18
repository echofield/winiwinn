/**
 * server.ts — FIELD Express app. All endpoints, the settlement glue around the
 * pure split, and a couple of startup example runs so the domino is visible
 * without any frontend.
 */
import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomBytes } from 'crypto';
import {
  createUser, getUser, addEarnings,
  createEdge, recommenderChain, fieldEdges, usersByIds,
  createRecommendation, getRecommendation,
  writeLedgerRow, ledgerFor, alreadyProcessed, markProcessed,
  settlementRows, descendantsWithin, realizedFromOwner, pendingRecCount,
  economyStats, avgChainDepth,
  Dna,
} from './db';
import { computeSplit, forfeitedBeyondCap, SPLIT_CURVE, Payout } from './split';
import { mollieEnabled, createCustomer, createPayment, getPayment, getPaymentDetail, getProfile, listMethods } from './mollie';

const PORT = Number(process.env.PORT) || 8080;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const app = express();
app.use(cors());
app.use(express.json());

const token = () => randomBytes(6).toString('hex');
const bad = (res: Response, msg: string) => res.status(400).json({ error: msg });

// ---------------------------------------------------------------------------
// splitAndSettle — walk the chain, apply the pure split, write the ledger.
// Idempotent on paymentId. Returns the payouts it wrote (empty if a no-op).
// ---------------------------------------------------------------------------
function splitAndSettle(token: string, totalAmountCents: number, paymentId: string): Payout[] {
  if (alreadyProcessed(paymentId)) {
    console.log(`[settle] payment ${paymentId} already processed — skipping.`);
    return [];
  }
  const rec = getRecommendation(token);
  if (!rec) throw new Error(`unknown recommendation token: ${token}`);

  const chain = recommenderChain(rec.from_user_id, SPLIT_CURVE.length);
  const payouts = computeSplit(rec.from_user_id, chain, totalAmountCents);

  for (const p of payouts) {
    // PRODUCTION: Mollie Connect transfer — split the captured payment to each
    // party's connected account here. For the demo we credit the local ledger.
    writeLedgerRow(p.userId, p.amountCents, p.hop, token, paymentId);
    addEarnings(p.userId, p.amountCents);
  }
  markProcessed(paymentId);
  console.log(`[settle] token=${token} total=${totalAmountCents}¢ ->`,
    payouts.map((p) => `${p.hop}:${p.userId.slice(0, 8)}=${p.amountCents}`).join('  '));
  return payouts;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, mollie: mollieEnabled ? 'live-test' : 'simulation' }));

// POST /users -> create user + Mollie test customer
app.post('/users', async (req: Request, res: Response) => {
  const { name, dna } = req.body as { name?: string; dna?: Dna };
  if (!name || !dna || !Array.isArray(dna.vector) || !dna.color) {
    return bad(res, 'name and dna { vector:number[4], color } required');
  }
  const customerId = await createCustomer(name);
  const user = createUser(name, dna, customerId);
  res.status(201).json(user);
});

// GET /users/:id -> profile
app.get('/users/:id', (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(user);
});

// GET /users/:id/field -> { nodes[], edges[] } reachable from this user
app.get('/users/:id/field', (req, res) => {
  const root = getUser(req.params.id);
  if (!root) return res.status(404).json({ error: 'user not found' });

  const edges = fieldEdges(root.id);
  const ids = new Set<string>([root.id]);
  edges.forEach((e) => { ids.add(e.from); ids.add(e.to); });

  const nodes = usersByIds([...ids]).map((u) => ({
    id: u.id,
    name: u.name,
    color: u.dna.color,
    earningsCents: u.earnings_cents,
  }));
  res.json({ nodes, edges });
});

// POST /recommendations -> { token, qrUrl, recommendation }
app.post('/recommendations', (req, res) => {
  const { fromUserId, title, amount } = req.body as { fromUserId?: string; title?: string; amount?: number };
  if (!fromUserId || !title) return bad(res, 'fromUserId and title required');
  if (!getUser(fromUserId)) return res.status(404).json({ error: 'fromUser not found' });

  const amountCents = Math.round((Number(amount) || 0) * 100); // amount is in euros
  const tok = token();
  const recommendation = createRecommendation(tok, fromUserId, title, amountCents);
  res.status(201).json({ token: tok, qrUrl: `${BASE_URL}/r/${tok}`, recommendation });
});

// GET /r/:token -> resolve a recommendation
app.get('/r/:token', (req, res) => {
  const rec = getRecommendation(req.params.token);
  if (!rec) return res.status(404).json({ error: 'recommendation not found' });
  const fromUser = getUser(rec.from_user_id);
  const edges = fieldEdges(rec.from_user_id);
  res.json({
    recommendation: rec,
    fromUser,
    fieldPreview: { nodeCount: new Set(edges.flatMap((e) => [e.from, e.to])).size + 1, edges },
  });
});

// POST /join -> create user B, edge fromUser->B, return B + new field state
app.post('/join', async (req, res) => {
  const { token: tok, newUserName, dna } = req.body as { token?: string; newUserName?: string; dna?: Dna };
  if (!tok || !newUserName || !dna) return bad(res, 'token, newUserName and dna required');
  const rec = getRecommendation(tok);
  if (!rec) return res.status(404).json({ error: 'recommendation not found' });

  const customerId = await createCustomer(newUserName);
  const newUser = createUser(newUserName, dna, customerId);
  createEdge(rec.from_user_id, newUser.id);

  const edges = fieldEdges(rec.from_user_id);
  res.status(201).json({ user: newUser, field: { rootId: rec.from_user_id, edges } });
});

// POST /convert -> create a Mollie test payment for the recommendation amount
app.post('/convert', async (req, res) => {
  const { token: tok, payerUserId } = req.body as { token?: string; payerUserId?: string };
  if (!tok || !payerUserId) return bad(res, 'token and payerUserId required');
  const rec = getRecommendation(tok);
  if (!rec) return res.status(404).json({ error: 'recommendation not found' });
  if (rec.amount_cents <= 0) return bad(res, 'recommendation has no amount to convert');

  const payment = await createPayment({
    amountCents: rec.amount_cents,
    description: rec.title,
    redirectUrl: `${BASE_URL}/r/${tok}`,
    webhookUrl: `${BASE_URL}/webhooks/mollie`,
    metadata: { token: tok, payerUserId },
  });
  res.json({
    checkoutUrl: payment.checkoutUrl,
    paymentId: payment.id,
    mode: mollieEnabled ? 'live-test' : 'simulation',
    // How to settle from here:
    hint: mollieEnabled
      ? `Pay at checkoutUrl (test mode), then: curl -X POST ${BASE_URL}/webhooks/mollie -H "Content-Type: application/json" -d '{"paymentId":"${payment.id}"}'  (settles ONLY if Mollie reports paid)`
      : `Simulation: curl -X POST ${BASE_URL}/webhooks/mollie -H "Content-Type: application/json" -d '{"token":"${tok}","amountCents":${rec.amount_cents},"paymentId":"${payment.id}"}'`,
  });
});

// POST /webhooks/mollie -> on paid, run the domino split. Idempotent.
//
// STRICT when a real Mollie key is configured: a { paymentId }/{ id } is REQUIRED,
// we fetch it from Mollie, and we ONLY settle if Mollie reports status=paid.
// No verified payment => no split. The amount and token come from Mollie, never
// the request body — so the settlement is provably backed by a real payment.
//
// In simulation mode (no test_ key) we accept a manual demo trigger
// { token, amountCents, paymentId? } so the loop is still demoable with no setup.
app.post('/webhooks/mollie', async (req, res) => {
  try {
    const paymentId: string | undefined = req.body.paymentId || req.body.id;

    if (mollieEnabled) {
      if (!paymentId) return bad(res, 'paymentId required — settlement only follows a real Mollie payment');
      const payment = await getPayment(paymentId);
      if (!payment) return res.status(404).json({ error: 'payment not found at Mollie' });
      if (!payment.paid) return res.json({ ok: true, settled: [], status: 'not paid yet — no split' });
      const tok = String(payment.metadata.token || '');
      if (!tok) return bad(res, 'payment has no recommendation token in metadata');
      const payouts = splitAndSettle(tok, payment.amountCents, payment.id);
      return res.json({ ok: true, paymentId: payment.id, settled: payouts });
    }

    // Simulation-only manual path.
    const { token: tok, amountCents } = req.body as { token?: string; amountCents?: number };
    if (!tok || !amountCents) return bad(res, 'simulation mode: provide { token, amountCents }');
    const id = paymentId || `tr_sim_${randomBytes(4).toString('hex')}`;
    const payouts = splitAndSettle(tok, Number(amountCents), id);
    res.json({ ok: true, paymentId: id, settled: payouts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /users/:id/ledger -> incoming domino shares for this user
app.get('/users/:id/ledger', (req, res) => {
  if (!getUser(req.params.id)) return res.status(404).json({ error: 'user not found' });
  res.json({ ledger: ledgerFor(req.params.id) });
});

// GET /agent/suggest/:userId -> COSMETIC fake agent suggestion from the field
app.get('/agent/suggest/:userId', (req, res) => {
  const user = getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // Find 2-hop-away nodes: children of children.
  const edges = fieldEdges(user.id);
  const direct = new Set(edges.filter((e) => e.from === user.id).map((e) => e.to));
  const twoHop = edges.filter((e) => direct.has(e.from)).map((e) => e.to);

  if (twoHop.length === 0) {
    return res.json({ suggestion: 'Your field is young. Recommend someone to grow it — agents wake up when the field does.' });
  }
  const pick = getUser(twoHop[Math.floor(Math.random() * twoHop.length)]);
  res.json({ suggestion: `An agent in your field suggests connecting with ${pick?.name} — two hops out, same current.` });
});

// GET /settlement/:paymentId -> the full receipt of a multi-party settlement.
// Reads from the ledger (splitAndSettle is the single source of truth).
app.get('/settlement/:paymentId', async (req, res) => {
  const rows = settlementRows(req.params.paymentId);
  if (rows.length === 0) return res.status(404).json({ error: 'no settlement for this paymentId' });

  const totalCents = rows.reduce((s, r) => s + r.amount_cents, 0);
  const pct = (c: number) => Math.round((c / totalCents) * 10000) / 100;
  const named = (userId: string) => getUser(userId)?.name ?? 'unknown';

  const payeeRow = rows.find((r) => r.hop === 0)!;
  const chainRows = rows.filter((r) => r.hop > 0);

  // How much WOULD have flowed past the cap, had the chain been deeper.
  const token = rows[0].source_token;
  const rec = getRecommendation(token);
  const fullChain = rec ? recommenderChain(rec.from_user_id, 1000) : [];
  const extraAncestors = Math.max(0, fullChain.length - SPLIT_CURVE.length);
  const hop4PlusForfeitedCents = forfeitedBeyondCap(extraAncestors, totalCents);

  // Live Mollie state (or simulated if no key / synthetic id).
  let mollie = { paymentId: req.params.paymentId, status: 'simulated', method: null as string | null, settlementCurrency: 'EUR' as string | null };
  if (mollieEnabled && req.params.paymentId.startsWith('tr_')) {
    const detail = await getPaymentDetail(req.params.paymentId).catch(() => null);
    if (detail) mollie = { paymentId: req.params.paymentId, ...detail };
  }

  res.json({
    totalCents,
    payee: { userId: payeeRow.user_id, name: named(payeeRow.user_id), amountCents: payeeRow.amount_cents, pct: pct(payeeRow.amount_cents) },
    chain: chainRows.map((r) => ({ userId: r.user_id, name: named(r.user_id), hop: r.hop, amountCents: r.amount_cents, pct: pct(r.amount_cents) })),
    uncapped: { hop4PlusForfeitedCents, extraAncestors },
    mollie,
  });
});

// GET /users/:id/positions -> programmable claims this user holds on the future
// conversions of nodes they recommended (split rights, NOT yield/locked capital).
app.get('/users/:id/positions', (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // A position exists for every descendant within the hop cap: the user is
  // `hop` above them and holds SPLIT_CURVE[hop-1] of their conversions.
  const positions = descendantsWithin(user.id, SPLIT_CURVE.length).map((d) => {
    const inUser = getUser(d.userId);
    return {
      inUserId: d.userId,
      inUserName: inUser?.name ?? 'unknown',
      hop: d.hop,
      sharePct: Math.round(SPLIT_CURVE[d.hop - 1] * 10000) / 100,
      realizedCents: realizedFromOwner(user.id, d.userId),
      pendingCount: pendingRecCount(d.userId),
    };
  });
  res.json({ positions });
});

// GET /mollie/health -> prove the key is live and show the test profile.
app.get('/mollie/health', async (_req, res) => {
  try {
    res.json(await getProfile());
  } catch (err) {
    res.status(502).json({ live: false, error: (err as Error).message });
  }
});

// GET /mollie/methods -> enabled payment methods (Mollie breadth for the pitch).
app.get('/mollie/methods', async (_req, res) => {
  try {
    res.json({ methods: await listMethods() });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// GET /economy -> one call proving the whole economy is moving.
app.get('/economy', (_req, res) => {
  res.json({ ...economyStats(), avgChainDepth: avgChainDepth() });
});

// ---------------------------------------------------------------------------
// Startup: print a few pure-split example runs so the domino is visible.
// ---------------------------------------------------------------------------
function demoSplits() {
  const show = (label: string, payouts: Payout[]) =>
    console.log(`  ${label.padEnd(22)} ${payouts.map((p) => `h${p.hop}=${p.amountCents}`).join('  ')}`);
  console.log('\n[domino] example splits on a €100.00 (10000¢) conversion:');
  console.log(`  SPLIT_CURVE = [${SPLIT_CURVE.join(', ')}]  (payee keeps the remainder)`);
  show('full 3-hop chain', computeSplit('payee', ['rec1', 'rec2', 'rec3'], 10000));
  show('2-hop chain', computeSplit('payee', ['rec1', 'rec2'], 10000));
  show('direct recommender', computeSplit('payee', ['rec1'], 10000));
  show('lone payee (root)', computeSplit('payee', [], 10000));
  console.log('  beyond 3 hops -> no payout (chain is capped at SPLIT_CURVE.length).\n');
}

app.listen(PORT, () => {
  console.log(`FIELD backend listening on ${BASE_URL}  (Mollie: ${mollieEnabled ? 'live-test' : 'simulation'})`);
  demoSplits();
});
