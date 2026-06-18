/**
 * split.ts — the domino split. Pure and unit-testable: no DB, no I/O.
 *
 * When a payment lands on a recommendation, the total is split UPWARD along the
 * recommender chain, capped at 3 hops with decaying shares. The payee (the
 * recommendation owner) keeps whatever is left.
 *
 *   100 over a full cap-3 chain ->  payee 80 | hop1 12 | hop2 5 | hop3 3
 *
 * Tune the curve here. SPLIT_CURVE[i] is the share for the recommender i+1 hops
 * above the payee. Its length is the hop cap. The payee's share is the remainder.
 */
export const SPLIT_CURVE = [0.12, 0.05, 0.03];

/**
 * Hypothetical decay used ONLY to visualise the cap. If the chain had extended
 * past hop 3, each further hop is projected at this fraction of the previous
 * hop's share. This money never actually leaves the payee — it's the "leak the
 * cap prevented", surfaced in /settlement as hop4PlusForfeitedCents.
 */
export const UNCAPPED_DECAY = 0.5;

export interface Payout {
  userId: string;
  amountCents: number;
  hop: number; // 0 = payee, 1 = direct recommender, 2 = +1 hop, ...
}

/**
 * @param payeeUserId      recommendation owner (keeps the remainder, hop 0)
 * @param recommenderChain ancestors upward: [hop1, hop2, hop3, ...]
 * @param totalCents       full amount paid, in cents
 *
 * Shares are rounded to whole cents; the payee absorbs any rounding remainder so
 * the payouts always sum back to exactly totalCents (no leaked or minted cents).
 */
export function computeSplit(payeeUserId: string, recommenderChain: string[], totalCents: number): Payout[] {
  const cap = SPLIT_CURVE.length;
  const payouts: Payout[] = [];
  let distributed = 0;

  for (let i = 0; i < recommenderChain.length && i < cap; i++) {
    const share = Math.round(totalCents * SPLIT_CURVE[i]);
    if (share <= 0) continue;
    payouts.push({ userId: recommenderChain[i], amountCents: share, hop: i + 1 });
    distributed += share;
  }

  // Payee keeps the remainder (hop 0), listed first.
  payouts.unshift({ userId: payeeUserId, amountCents: totalCents - distributed, hop: 0 });
  return payouts;
}

/**
 * Projected money that WOULD have flowed to recommenders past the hop cap, had
 * the chain not been capped. Pure visualisation of the cap working — this stays
 * with the payee in reality. `extraAncestorCount` = ancestors beyond the cap.
 */
export function forfeitedBeyondCap(extraAncestorCount: number, totalCents: number): number {
  let share = totalCents * SPLIT_CURVE[SPLIT_CURVE.length - 1]; // baseline: last in-curve hop
  let total = 0;
  for (let i = 0; i < extraAncestorCount; i++) {
    share = Math.round(share * UNCAPPED_DECAY);
    total += share;
  }
  return total;
}

// ---------------------------------------------------------------------------
// MERCHANT-FUNDED contract split (Addenda 4/6/8). Money comes from the merchant,
// never friend-to-friend. The guest pays a BILL; the contract carves a REWARD
// pool out of it; connectors along the warm-intro chain share that pool,
// aura-weighted; the merchant keeps the rest. Pure + unit-testable.
// ---------------------------------------------------------------------------
export interface ChainConnector {
  userId: string;
  auraScore: number; // drives the bounded trust factor
}

export interface ContractTerms {
  rewardType: 'pct' | 'flat';
  rewardValue: number; // pct (e.g. 8) or flat reward in cents
  capDepth: number;
  splitCurve: number[]; // decay across hops, merchant-funded
}

/** Reward pool the merchant funds for one conversion. */
export function rewardPool(terms: ContractTerms, billCents: number): number {
  return terms.rewardType === 'pct'
    ? Math.round(billCents * (terms.rewardValue / 100))
    : Math.min(terms.rewardValue, billCents);
}

/**
 * @param merchantId  receives hop 0 (the merchant's net cut)
 * @param chain       warm-intro connectors, nearest the guest first: [hop1, hop2, ...]
 * @param billCents   what the guest actually paid at the merchant
 * @param terms       the consented contract (reward %, cap, curve)
 * @param auraFactor  score -> bounded multiplier (inject aura.auraTrustFactor)
 *
 * Connector i gets round(pool * curve[i] * auraFactor(score_i)), capped so the
 * connectors' total NEVER exceeds the reward pool (i.e. the contracted %). The
 * merchant keeps bill - connectorsPaid, so ledger rows always sum to the bill.
 */
export function computeContractSplit(
  merchantId: string,
  chain: ChainConnector[],
  billCents: number,
  terms: ContractTerms,
  auraFactor: (score: number) => number,
): Payout[] {
  const pool = rewardPool(terms, billCents);
  const cap = Math.min(terms.capDepth, terms.splitCurve.length);

  const raw: Payout[] = [];
  for (let i = 0; i < chain.length && i < cap; i++) {
    const base = pool * terms.splitCurve[i];
    const share = Math.round(base * auraFactor(chain[i].auraScore));
    if (share > 0) raw.push({ userId: chain[i].userId, amountCents: share, hop: i + 1 });
  }

  // Never exceed the contracted pool: scale down proportionally if aura premiums
  // pushed connectors over it. (Rebalanced remainder stays with the merchant.)
  let connectorsTotal = raw.reduce((s, p) => s + p.amountCents, 0);
  if (connectorsTotal > pool && connectorsTotal > 0) {
    const k = pool / connectorsTotal;
    for (const p of raw) p.amountCents = Math.round(p.amountCents * k);
    connectorsTotal = raw.reduce((s, p) => s + p.amountCents, 0);
  }

  // Merchant keeps the rest (hop 0). Sums to the full bill.
  return [{ userId: merchantId, amountCents: billCents - connectorsTotal, hop: 0 }, ...raw];
}
