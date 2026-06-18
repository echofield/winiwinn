/**
 * server.ts — FIELD Express app. All endpoints, the settlement glue around the
 * pure split, and a couple of startup example runs so the domino is visible
 * without any frontend.
 */
import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomBytes } from 'crypto';
import {
  createUser, getUser, addEarnings, setMollieCustomerId,
  createEdge, edgeExists, recommenderChain, fieldEdges, usersByIds,
  createRecommendation, getRecommendation,
  writeLedgerRow, ledgerFor, alreadyProcessed, markProcessed,
  settlementRows, descendantsWithin, realizedFromOwner, pendingRecCount,
  economyStats, avgChainDepth,
  createStake, stakesByStaker, reversalExists,
  createMerchant, getMerchant, actorName,
  createContract, getContract, getContractByToken, contractsByMerchant, updateContractLink,
  createConversion, getConversion, getConversionByPayment, markConversionSettled,
  createHelpEvent, getHelpEvent, confirmHelpEvent, confirmedReceived, setAuraScore,
  vouchCountFor, recentHelpFor, vouchersFor,
  Contract, Conversion,
  Dna,
} from './db';
import { computeSplit, computeContractSplit, rewardPool, forfeitedBeyondCap, SPLIT_CURVE, Payout, ContractTerms } from './split';
import { computeAura, auraTrustFactor, reputationLabel, KIND_WEIGHT } from './aura';
import {
  mollieEnabled, createCustomer, createPayment, getPayment, getPaymentDetail,
  getProfile, listMethods, createPaymentLink, createTestMandate, createSubscription,
  getSubscription, createRefund, listSettlements, getBalanceReport,
} from './mollie';

const PORT = Number(process.env.PORT) || 8080;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const app = express();
app.use(cors());
app.use(express.json());

const token = () => randomBytes(6).toString('hex');
const bad = (res: Response, msg: string) => res.status(400).json({ error: msg });

// ---------------------------------------------------------------------------
// writeSettlement — the SINGLE source of truth for committing a division to the
// ledger. Pure computation (computeSplit / computeContractSplit) produces the
// payouts; this writes rows, credits earnings, and is idempotent on paymentId.
// ---------------------------------------------------------------------------
function writeSettlement(sourceToken: string, payouts: Payout[], paymentId: string): Payout[] {
  if (alreadyProcessed(paymentId)) {
    console.log(`[settle] payment ${paymentId} already processed — skipping.`);
    return [];
  }
  for (const p of payouts) {
    // PRODUCTION: Mollie Connect routing/transfers disburse to each connector /
    // the merchant here (or claw back on refund). Demo: credit the local ledger.
    // This is the ONE simulated step — payment, scan, webhook, and split are real.
    writeLedgerRow(p.userId, p.amountCents, p.hop, sourceToken, paymentId);
    addEarnings(p.userId, p.amountCents); // merchant ids simply no-op against users
  }
  markProcessed(paymentId);
  console.log(`[settle] token=${sourceToken} pay=${paymentId} ->`,
    payouts.map((p) => `${p.hop}:${p.userId.slice(0, 8)}=${p.amountCents}`).join('  '));
  return payouts;
}

// LEGACY (friend-to-friend) whole-payment split with payee remainder. Kept for
// /convert + earlier receipts; the merchant-funded /conversions path is canonical.
function splitAndSettle(token: string, totalAmountCents: number, paymentId: string): Payout[] {
  const rec = getRecommendation(token);
  if (!rec) throw new Error(`unknown recommendation token: ${token}`);
  const chain = recommenderChain(rec.from_user_id, SPLIT_CURVE.length);
  const payouts = computeSplit(rec.from_user_id, chain, totalAmountCents);
  return writeSettlement(token, payouts, paymentId);
}

/** Reverse-domino: negate the original settlement through the same division. */
function reverseSettle(originalPaymentId: string): Payout[] {
  const rows = settlementRows(originalPaymentId);
  if (rows.length === 0) throw new Error('no settlement to reverse for that paymentId');
  const reversed = rows.map((r) => ({ userId: r.user_id, amountCents: -r.amount_cents, hop: r.hop }));
  return writeSettlement(rows[0].source_token, reversed, `refund_${originalPaymentId}`);
}

const termsOf = (c: Contract): ContractTerms => ({
  rewardType: c.reward_type, rewardValue: c.reward_value, capDepth: c.cap_depth, splitCurve: c.split_curve,
});

/** Resolve the warm-intro chain (nearest the guest first) that delivered a conversion. */
function warmIntroChain(conv: Conversion, capDepth: number): string[] {
  if (conv.connector_token) {
    const rec = getRecommendation(conv.connector_token);
    return rec ? [rec.from_user_id, ...recommenderChain(rec.from_user_id, capDepth - 1)] : [];
  }
  if (conv.guest_user_id) return recommenderChain(conv.guest_user_id, capDepth);
  return []; // walk-in: no connector -> merchant keeps everything
}

// CANONICAL merchant-funded execution: the contract FIRES on a real paid bill.
// Reward pool is carved per contract %, split BACKWARD along the warm-intro chain,
// aura-weighted (Addendum 6), capped at contract.capDepth. splitAndSettle stays
// the single source of truth via writeSettlement.
function executeContract(conv: Conversion, paymentId: string): Payout[] {
  const contract = getContract(conv.contract_id);
  if (!contract) throw new Error(`unknown contract: ${conv.contract_id}`);
  const chainIds = warmIntroChain(conv, contract.cap_depth);
  const chain = chainIds.map((id) => ({ userId: id, auraScore: getUser(id)?.aura_score ?? 0 }));
  const payouts = computeContractSplit(contract.merchant_id, chain, conv.amount_cents, termsOf(contract), auraTrustFactor);
  const written = writeSettlement(conv.id, payouts, paymentId);
  if (written.length) markConversionSettled(conv.id);
  return written;
}

/** Recompute and store a user's aura from their CONFIRMED received help. */
function recomputeAura(userId: string): number {
  const confirmed = confirmedReceived(userId);
  const score = computeAura(confirmed);
  setAuraScore(userId, score, confirmed.length);
  return score;
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
    earningsCents: u.earnings_cents, // money axis
    auraScore: u.aura_score,         // reputation axis
  }));
  res.json({ nodes, edges });
});

// POST /recommendations -> { token, qrUrl, recommendation }
app.post('/recommendations', async (req, res) => {
  const { fromUserId, title, amount, contractId, rewardKind, rewardPct, rewardFunder, capHops } = req.body as
    { fromUserId?: string; title?: string; amount?: number; contractId?: string;
      rewardKind?: 'cut' | 'free' | 'off' | 'gift'; rewardPct?: number; rewardFunder?: 'self' | 'merchant'; capHops?: number };
  if (!fromUserId || !title) return bad(res, 'fromUserId and title required');
  if (!getUser(fromUserId)) return res.status(404).json({ error: 'fromUser not found' });

  // A recommendation may carry a merchant contract — you're passing a warm intro
  // to that deal. The reward is merchant-funded; `amount` (legacy) is optional.
  let contract: Contract | null = null;
  if (contractId) {
    contract = getContract(contractId);
    if (!contract) return res.status(404).json({ error: 'contract not found' });
  }

  const amountCents = Math.round((Number(amount) || 0) * 100);
  const tok = token();
  const recommendation = createRecommendation(tok, fromUserId, title, amountCents, contractId ?? null, {
    rewardKind: rewardKind ?? null,
    rewardPct: rewardPct ?? null,
    rewardFunder: rewardFunder ?? (contractId ? 'merchant' : null),
    capHops: capHops ?? 3,
  });

  // Mint a Mollie payment link — the WhatsApp-droppable shareable deal/QR. (Links
  // can't carry metadata; attributed settlement runs through /conversions, which
  // takes connectorToken/guestUserId and creates a metadata-carrying payment.)
  let paymentLinkUrl: string | null = null;
  const linkAmount = contract ? Number(req.body.linkAmountCents) || 5000 : amountCents;
  if (mollieEnabled && linkAmount > 0) {
    try {
      const link = await createPaymentLink({ amountCents: linkAmount, description: title });
      paymentLinkUrl = link?.url ?? null;
    } catch (err) {
      console.warn('[recommendations] payment link failed:', (err as Error).message);
    }
  }
  res.status(201).json({ token: tok, qrUrl: `${BASE_URL}/r/${tok}`, paymentLinkUrl, recommendation });
});

// POST /recommendations/:token/book -> a SELF-funded recommendation settles its
// own reward. For kind 'cut', the provider (recommendation owner) funds pct of the
// bill, split backward along the chain that delivered the booker, aura-weighted,
// and keeps the remainder (hop 0). Non-money kinds credit trust, no payout.
// PRODUCTION: Mollie Connect transfer disburses the provider's cut to connectors here.
app.post('/recommendations/:token/book', (req, res) => {
  const rec = getRecommendation(req.params.token);
  if (!rec) return res.status(404).json({ error: 'recommendation not found' });
  const { guestUserId, amountCents } = req.body as { guestUserId?: string; amountCents?: number };
  const bill = Number(amountCents) || 0;
  if (bill <= 0) return bad(res, 'amountCents required');

  const capHops = rec.cap_hops || 3;
  const chainIds = guestUserId ? recommenderChain(guestUserId, capHops) : recommenderChain(rec.from_user_id, capHops);

  if (rec.reward_kind && rec.reward_kind !== 'cut') {
    return res.json({ ok: true, kind: rec.reward_kind, settled: [], note: 'Non-money reward — trust credited to the chain, no payout.' });
  }

  const pct = rec.reward_pct ?? 8;
  const terms: ContractTerms = { rewardType: 'pct', rewardValue: pct, capDepth: capHops, splitCurve: [0.6, 0.3, 0.1] };
  const chain = chainIds.map((id) => ({ userId: id, auraScore: getUser(id)?.aura_score ?? 0 }));
  const paymentId = `bk_${randomBytes(6).toString('hex')}`;
  const settled = writeSettlement(rec.token, computeContractSplit(rec.from_user_id, chain, bill, terms, auraTrustFactor), paymentId);
  res.json({ ok: true, kind: 'cut', funder: rec.reward_funder || 'self', paymentId, billCents: bill, rewardPct: pct, settled });
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

// Route a paid payment to the right settlement: contract execution (canonical),
// a pre-created conversion, or the legacy friend-to-friend split.
function settleFromMetadata(meta: Record<string, unknown>, amountCents: number, paymentId: string): { kind: string; settled: Payout[]; conversionId?: string } {
  const contractId = meta.contractId ? String(meta.contractId) : '';
  const conversionId = meta.conversionId ? String(meta.conversionId) : '';
  const connectorToken = meta.connectorToken ? String(meta.connectorToken) : null;
  const guestUserId = meta.guestUserId ? String(meta.guestUserId) : null;
  const legacyToken = meta.token ? String(meta.token) : '';

  // 1. Pre-created conversion (via POST /conversions).
  let conv = conversionId ? getConversion(conversionId) : getConversionByPayment(paymentId);
  // 2. Collection-point link with only a contractId -> create the conversion now.
  if (!conv && contractId) {
    const contract = getContract(contractId);
    if (!contract) throw new Error(`unknown contract: ${contractId}`);
    conv = createConversion({
      id: `cnv_${randomBytes(6).toString('hex')}`,
      contract_id: contractId, guest_user_id: guestUserId, connector_token: connectorToken,
      amount_cents: amountCents, reward_cents: rewardPool(termsOf(contract), amountCents),
      payment_id: paymentId, status: 'pending',
    });
  }
  if (conv) return { kind: 'contract', settled: executeContract(conv, paymentId), conversionId: conv.id };

  // 3. Legacy recommendation split.
  if (legacyToken) return { kind: 'legacy', settled: splitAndSettle(legacyToken, amountCents, paymentId) };
  throw new Error('payment metadata has no contractId / conversionId / token');
}

// POST /webhooks/mollie -> the contract FIRES on a real paid event. Idempotent.
//
// STRICT with a real Mollie key: { paymentId }/{ id } REQUIRED; we fetch it from
// Mollie and settle ONLY if status=paid. Amount + metadata come from Mollie, not
// the body. Real scan -> real payment -> real webhook -> real split. The only
// simulated step is multi-party DISBURSEMENT (Mollie Connect in production).
//
// Simulation mode (no key) accepts manual triggers:
//   { conversionId }            -> execute a merchant contract
//   { token, amountCents }      -> legacy friend-to-friend split
app.post('/webhooks/mollie', async (req, res) => {
  try {
    const paymentId: string | undefined = req.body.paymentId || req.body.id;

    if (mollieEnabled) {
      if (!paymentId) return bad(res, 'paymentId required — settlement only follows a real Mollie payment');
      const payment = await getPayment(paymentId);
      if (!payment) return res.status(404).json({ error: 'payment not found at Mollie' });
      if (!payment.paid) return res.json({ ok: true, settled: [], status: 'not paid yet — no split' });
      const out = settleFromMetadata(payment.metadata, payment.amountCents, payment.id);
      return res.json({ ok: true, paymentId: payment.id, ...out });
    }

    // Simulation-only manual paths.
    if (req.body.conversionId) {
      const conv = getConversion(String(req.body.conversionId));
      if (!conv) return res.status(404).json({ error: 'conversion not found' });
      const id = paymentId || conv.payment_id || `tr_sim_${randomBytes(4).toString('hex')}`;
      return res.json({ ok: true, kind: 'contract', conversionId: conv.id, paymentId: id, settled: executeContract(conv, id) });
    }
    const { token: tok, amountCents } = req.body as { token?: string; amountCents?: number };
    if (!tok || !amountCents) return bad(res, 'simulation mode: provide { conversionId } or { token, amountCents }');
    const id = paymentId || `tr_sim_${randomBytes(4).toString('hex')}`;
    res.json({ ok: true, kind: 'legacy', paymentId: id, settled: splitAndSettle(tok, Number(amountCents), id) });
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
  // Prefer the highest-aura two-hop node — agents route along the reliable layer.
  const ranked = twoHop.map((id) => getUser(id)).filter((u): u is NonNullable<typeof u> => !!u)
    .sort((a, b) => b.aura_score - a.aura_score);
  const pick = ranked[0];
  res.json({ suggestion: `An agent in your field suggests connecting with ${pick.name} (aura ${pick.aura_score}) — two hops out, the most trusted path.` });
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
// Implicit edge-claims are enriched with any explicit /stake (mandate/subscription),
// and stake status/nextChargeAt are read live from Mollie.
app.get('/users/:id/positions', async (req, res) => {
  const user = getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });

  type Position = {
    inUserId: string; inUserName: string; hop: number | null; sharePct: number | null;
    realizedCents: number; pendingCount: number;
    mandateId: string | null; subscriptionId: string | null; status: string | null; nextChargeAt: string | null;
  };
  const byUser = new Map<string, Position>();

  // 1. Implicit edge-claims: every descendant within the hop cap.
  for (const d of descendantsWithin(user.id, SPLIT_CURVE.length)) {
    byUser.set(d.userId, {
      inUserId: d.userId,
      inUserName: getUser(d.userId)?.name ?? 'unknown',
      hop: d.hop,
      sharePct: Math.round(SPLIT_CURVE[d.hop - 1] * 10000) / 100,
      realizedCents: realizedFromOwner(user.id, d.userId),
      pendingCount: pendingRecCount(d.userId),
      mandateId: null, subscriptionId: null, status: null, nextChargeAt: null,
    });
  }

  // 2. Explicit stakes: attach mandate/subscription + live Mollie status.
  for (const s of stakesByStaker(user.id)) {
    let status = s.status;
    let nextChargeAt: string | null = null;
    if (s.subscription_id && user.mollie_customer_id) {
      const live = await getSubscription(user.mollie_customer_id, s.subscription_id).catch(() => null);
      if (live) { status = live.status; nextChargeAt = live.nextChargeAt; }
    }
    const existing = byUser.get(s.in_user_id);
    const stakeFields = { mandateId: s.mandate_id, subscriptionId: s.subscription_id, status, nextChargeAt };
    if (existing) Object.assign(existing, stakeFields);
    else byUser.set(s.in_user_id, {
      inUserId: s.in_user_id, inUserName: getUser(s.in_user_id)?.name ?? 'unknown',
      hop: null, sharePct: null,
      realizedCents: realizedFromOwner(user.id, s.in_user_id), pendingCount: pendingRecCount(s.in_user_id),
      ...stakeFields,
    });
  }

  res.json({ positions: [...byUser.values()] });
});

// POST /stake -> create a standing Mollie authorization (mandate + subscription)
// representing a commitment into inUser's field. Stored as a position.
// Honest framing: a stake is a Mollie authorization, NOT locked capital.
app.post('/stake', async (req, res) => {
  const { stakerUserId, inUserId, amountCents, interval } = req.body as
    { stakerUserId?: string; inUserId?: string; amountCents?: number; interval?: string };
  if (!stakerUserId || !inUserId || !amountCents) return bad(res, 'stakerUserId, inUserId, amountCents required');
  const staker = getUser(stakerUserId);
  const inUser = getUser(inUserId);
  if (!staker || !inUser) return res.status(404).json({ error: 'staker or inUser not found' });
  if (!mollieEnabled) return bad(res, 'staking needs a real Mollie key (mandate/subscription)');

  try {
    // Ensure the staker has a Mollie customer.
    let customerId = staker.mollie_customer_id;
    if (!customerId) {
      customerId = await createCustomer(staker.name);
      if (customerId) setMollieCustomerId(staker.id, customerId);
    }
    if (!customerId) return res.status(502).json({ error: 'could not create Mollie customer' });

    // Mandate = the standing authorization. Subscription is best-effort on top.
    const mandate = await createTestMandate(customerId, staker.name);
    let subscriptionId: string | null = null;
    let status = `mandate:${mandate.status}`;
    let nextChargeAt: string | null = null;
    try {
      const sub = await createSubscription(customerId, { amountCents, interval: interval || '1 months', description: `Stake in ${inUser.name}'s field` });
      subscriptionId = sub.id; status = sub.status; nextChargeAt = sub.nextChargeAt;
    } catch (err) {
      // Unverified test profiles have no recurring method — mandate-only is still
      // a real standing Mollie authorization. PRODUCTION: a live profile with an
      // enabled method makes this a full recurring subscription.
      console.warn('[stake] subscription fell back to mandate-only:', (err as Error).message);
    }

    const stake = createStake({
      id: randomBytes(8).toString('hex'),
      staker_user_id: staker.id, in_user_id: inUser.id,
      amount_cents: amountCents, interval: interval || '1 months',
      mandate_id: mandate.id, subscription_id: subscriptionId, status,
    });
    res.status(201).json({ stake, nextChargeAt, note: 'A stake is a standing Mollie authorization, not locked capital.' });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// POST /dispute -> real Mollie refund + reverse-domino. Writes negative payout
// rows along the same chain so the frontend can animate money flowing BACKWARD.
app.post('/dispute', async (req, res) => {
  const { paymentId, reason } = req.body as { paymentId?: string; reason?: string };
  if (!paymentId) return bad(res, 'paymentId required');
  const rows = settlementRows(paymentId);
  if (rows.length === 0) return res.status(404).json({ error: 'no settlement for that paymentId' });
  if (reversalExists(paymentId)) return bad(res, 'this payment was already disputed/refunded');

  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  try {
    // Real Mollie refund (skipped only for simulated/manual ids that Mollie won't know).
    let refund: { id: string; status: string } | null = null;
    if (mollieEnabled && paymentId.startsWith('tr_') && !paymentId.startsWith('tr_sim_')) {
      // PRODUCTION: Mollie Connect would also claw back each party's transfer here.
      refund = await createRefund(paymentId, total);
    }
    const reversed = reverseSettle(paymentId); // negative rows through the same split
    res.json({
      ok: true,
      reason: reason || null,
      refund: refund ?? { id: 'simulated', status: 'reversed-in-ledger' },
      reversedPaymentId: `refund_${paymentId}`,
      reversedChain: reversed, // negative amounts, payee + each hop
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
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

// GET /mollie/settlements -> passthrough of Mollie settlements (live-only API;
// in test mode Mollie returns its own "live only" explanation — still a real call).
app.get('/mollie/settlements', async (_req, res) => {
  res.json(await listSettlements());
});

// GET /mollie/balance -> passthrough of the Mollie balance report (live-only too).
app.get('/mollie/balance', async (_req, res) => {
  res.json(await getBalanceReport());
});

// GET /economy -> one call proving the whole economy is moving.
app.get('/economy', (_req, res) => {
  res.json({ ...economyStats(), avgChainDepth: avgChainDepth() });
});

// === Merchants + Contracts (Addenda 4/8) ===================================

// POST /merchants -> the entity that funds the economy.
app.post('/merchants', async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) return bad(res, 'name required');
  const customerId = await createCustomer(name).catch(() => null);
  res.status(201).json(createMerchant(name, customerId));
});

// POST /contracts -> the consented %. Also mints the merchant's COLLECTION POINT:
// a real Mollie payment link + QR payload (the reusable object the merchant
// displays). Attribution + execution run through /conversions, which creates a
// metadata-carrying payment that fires the webhook against this contract.
app.post('/contracts', async (req, res) => {
  const b = req.body as {
    merchantId?: string; title?: string; rewardType?: 'pct' | 'flat'; rewardValue?: number;
    conversionDef?: string; capDepth?: number; splitCurve?: number[]; linkAmountCents?: number;
  };
  if (!b.merchantId || !b.title || !b.rewardType || b.rewardValue == null) {
    return bad(res, 'merchantId, title, rewardType, rewardValue required');
  }
  if (!getMerchant(b.merchantId)) return res.status(404).json({ error: 'merchant not found' });
  if (b.rewardType !== 'pct' && b.rewardType !== 'flat') return bad(res, 'rewardType must be pct|flat');

  const contract = createContract({
    merchantId: b.merchantId,
    title: b.title,
    rewardType: b.rewardType,
    rewardValue: Number(b.rewardValue),
    conversionDef: b.conversionDef || 'covered_bill',
    capDepth: b.capDepth ?? 3,
    splitCurve: Array.isArray(b.splitCurve) && b.splitCurve.length ? b.splitCurve : [0.6, 0.3, 0.1],
    token: token(),
    paymentLinkId: null,
    paymentLinkUrl: null,
  });

  // Collection point: real Mollie payment link the merchant displays as a QR.
  let paymentLinkUrl: string | null = null;
  let qrPayload: string | null = null;
  if (mollieEnabled) {
    try {
      const link = await createPaymentLink({ amountCents: Number(b.linkAmountCents) || 5000, description: `${b.title} (deal)` });
      paymentLinkUrl = link?.url ?? null;
      qrPayload = paymentLinkUrl;
      updateContractLink(contract.id, link?.id ?? null, paymentLinkUrl);
    } catch (err) {
      console.warn('[contracts] payment link failed:', (err as Error).message);
    }
  }
  res.status(201).json({ contract: getContract(contract.id), dealToken: contract.token, paymentLinkUrl, qrPayload });
});

// GET /contracts/:id -> contract terms (the consented %).
app.get('/contracts/:id', (req, res) => {
  const c = getContract(req.params.id);
  if (!c) return res.status(404).json({ error: 'contract not found' });
  res.json(c);
});

// GET /merchants/:id/contracts -> a merchant's active deals.
app.get('/merchants/:id/contracts', (req, res) => {
  if (!getMerchant(req.params.id)) return res.status(404).json({ error: 'merchant not found' });
  res.json({ contracts: contractsByMerchant(req.params.id) });
});

// POST /conversions -> a real guest covers a real bill at a merchant. Creates the
// real Mollie payment (the bill); the contract fires on the webhook (paid). In
// simulation mode it settles immediately so the loop is demoable with no tunnel.
app.post('/conversions', async (req, res) => {
  const { contractId, guestUserId, amountCents, connectorToken } = req.body as
    { contractId?: string; guestUserId?: string; amountCents?: number; connectorToken?: string };
  if (!contractId || !amountCents) return bad(res, 'contractId and amountCents required');
  const contract = getContract(contractId);
  if (!contract) return res.status(404).json({ error: 'contract not found' });

  const reward = rewardPool(termsOf(contract), Number(amountCents));
  const convId = `cnv_${randomBytes(6).toString('hex')}`;

  const payment = await createPayment({
    amountCents: Number(amountCents),
    description: `${contract.title} — covered bill`,
    redirectUrl: `${BASE_URL}/conversions/${convId}/settlement`,
    webhookUrl: `${BASE_URL}/webhooks/mollie`,
    metadata: { contractId, conversionId: convId, guestUserId: guestUserId ?? null, connectorToken: connectorToken ?? null },
  });

  const conv = createConversion({
    id: convId, contract_id: contractId, guest_user_id: guestUserId ?? null,
    connector_token: connectorToken ?? null, amount_cents: Number(amountCents),
    reward_cents: reward, payment_id: payment.id, status: 'pending',
  });

  // Simulation has no real checkout to complete — fire the contract now.
  let settled: Payout[] = [];
  if (!mollieEnabled) settled = executeContract(conv, payment.id);

  res.status(201).json({
    conversionId: conv.id,
    checkoutUrl: payment.checkoutUrl,
    rewardCents: reward,
    mode: mollieEnabled ? 'live-test' : 'simulation',
    settled,
    hint: mollieEnabled
      ? `Pay the bill at checkoutUrl, then: curl -X POST ${BASE_URL}/webhooks/mollie -d '{"paymentId":"${payment.id}"}' -H "Content-Type: application/json"`
      : `Already settled (simulation). See: ${BASE_URL}/conversions/${conv.id}/settlement`,
  });
});

// GET /conversions/:id/settlement -> the merchant-funded receipt: contract terms
// (the consented %), real Mollie payment status, and the computed split.
app.get('/conversions/:id/settlement', async (req, res) => {
  const conv = getConversion(req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversion not found' });
  const contract = getContract(conv.contract_id);
  const rows = conv.payment_id ? settlementRows(conv.payment_id) : [];

  const total = rows.reduce((s, r) => s + r.amount_cents, 0) || conv.amount_cents;
  const pct = (c: number) => (total ? Math.round((c / total) * 10000) / 100 : 0);
  const merchantRow = rows.find((r) => r.hop === 0);
  const connectorRows = rows.filter((r) => r.hop > 0);

  let mollie: Record<string, unknown> = { paymentId: conv.payment_id, status: mollieEnabled ? 'unknown' : 'simulated' };
  if (mollieEnabled && conv.payment_id) {
    const detail = await getPaymentDetail(conv.payment_id).catch(() => null);
    if (detail) mollie = { paymentId: conv.payment_id, ...detail };
  }

  res.json({
    conversionId: conv.id,
    status: conv.status,
    billCents: conv.amount_cents,
    rewardPoolCents: conv.reward_cents,
    contract: contract && {
      id: contract.id, title: contract.title, merchantId: contract.merchant_id, merchantName: actorName(contract.merchant_id),
      rewardType: contract.reward_type, rewardValue: contract.reward_value, conversionDef: contract.conversion_def,
      capDepth: contract.cap_depth, splitCurve: contract.split_curve,
    },
    merchant: merchantRow && { userId: merchantRow.user_id, name: actorName(merchantRow.user_id), netCents: merchantRow.amount_cents, pct: pct(merchantRow.amount_cents) },
    chain: connectorRows.map((r) => ({
      userId: r.user_id, name: actorName(r.user_id), hop: r.hop,
      amountCents: r.amount_cents, pct: pct(r.amount_cents),
      auraScore: getUser(r.user_id)?.aura_score ?? 0, auraFactor: auraTrustFactor(getUser(r.user_id)?.aura_score ?? 0),
    })),
    mollie,
    note: 'Real payment + split. Only multi-party disbursement is simulated (Mollie Connect in production).',
  });
});

// === Aura layer (Addendum 6) ===============================================

// POST /help -> record a help event (UNCONFIRMED; no aura until /thank).
app.post('/help', (req, res) => {
  const { fromUserId, toUserId, kind, note } = req.body as { fromUserId?: string; toUserId?: string; kind?: string; note?: string };
  if (!fromUserId || !toUserId || !kind) return bad(res, 'fromUserId, toUserId, kind required');
  if (!getUser(fromUserId) || !getUser(toUserId)) return res.status(404).json({ error: 'user not found' });
  if (!(kind in KIND_WEIGHT)) return bad(res, `kind must be one of: ${Object.keys(KIND_WEIGHT).join(', ')}`);
  const event = createHelpEvent(fromUserId, toUserId, kind, note ?? null);
  res.status(201).json({ helpEvent: event, note: 'Aura is granted only after the recipient confirms via /thank.' });
});

// POST /thank -> the recipient confirms the help was real. The anti-gaming gate:
// unconfirmed help counts for nothing. Recomputes the recipient's aura.
app.post('/thank', (req, res) => {
  const { helpEventId, byUserId } = req.body as { helpEventId?: string; byUserId?: string };
  if (!helpEventId || !byUserId) return bad(res, 'helpEventId and byUserId required');
  const event = getHelpEvent(helpEventId);
  if (!event) return res.status(404).json({ error: 'help event not found' });
  if (event.to_user_id !== byUserId) return res.status(403).json({ error: 'only the recipient can confirm this help' });
  if (event.confirmed) return res.json({ ok: true, alreadyConfirmed: true, auraScore: getUser(byUserId)?.aura_score });

  confirmHelpEvent(helpEventId);
  const score = recomputeAura(event.to_user_id);
  res.json({ ok: true, confirmed: helpEventId, recipient: event.to_user_id, auraScore: score });
});

// GET /users/:id/aura -> the reputation object + recent help.
app.get('/users/:id/aura', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  res.json({
    aura: { score: u.aura_score, given: u.aura_given, received: u.aura_received },
    recent: recentHelpFor(u.id),
  });
});

// GET /users/:id/reputation -> derived label + who vouched.
app.get('/users/:id/reputation', (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  const vouchers = vouchersFor(u.id).map((id) => ({ id, name: actorName(id) }));
  res.json({
    label: reputationLabel(u.aura_score, u.aura_given, u.aura_received, vouchCountFor(u.id)),
    score: u.aura_score, given: u.aura_given, received: u.aura_received,
    vouchedBy: vouchers,
  });
});

// GET /edge/:from/:to/mutual -> connection + trust context between two users.
app.get('/edge/:from/:to/mutual', (req, res) => {
  const a = getUser(req.params.from);
  const b = getUser(req.params.to);
  if (!a || !b) return res.status(404).json({ error: 'user not found' });
  const fwd = edgeExists(a.id, b.id);
  const rev = edgeExists(b.id, a.id);
  res.json({
    connected: fwd || rev,
    mutualEdge: fwd && rev,
    direction: fwd && rev ? 'mutual' : fwd ? 'from->to' : rev ? 'to->from' : 'none',
    fromAura: a.aura_score,
    toAura: b.aura_score,
    mutualHighAura: a.aura_score >= 10 && b.aura_score >= 10,
    trust: { fromFactor: auraTrustFactor(a.aura_score), toFactor: auraTrustFactor(b.aura_score) },
  });
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
