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
