/**
 * aura.ts — the reputation layer. Pure and unit-testable.
 *
 * Aura is NON-monetary, non-transferable, non-cashable. It is EARNED by helping
 * and only counts once the recipient CONFIRMS the help (the anti-gaming gate).
 * Money rides on top of aura: a connector's payout is modulated by their aura
 * trust factor (see auraTrustFactor), but aura itself can never be bought.
 */

/** Relative weight of each kind of help. A vouch is worth more than showing up. */
export const KIND_WEIGHT: Record<string, number> = {
  vouch: 5,
  job_lead: 4,
  intro: 3,
  advice: 2,
  showed_up: 1,
};

export interface ConfirmedHelp {
  giverId: string;
  kind: string;
  giverScore: number; // the giver's own aura at compute time — a vouch from a trusted person is worth more
}

/**
 * Compute a user's aura score from the CONFIRMED help they received.
 * Pure: callers resolve each giver's current score and pass it in.
 *
 *   - weight by kind (KIND_WEIGHT)
 *   - weight by the giver's trust (high-aura givers confer more)
 *   - diminishing returns per giver: the Nth help from the same person counts
 *     less (1, 1/2, 1/3, …) so you can't farm aura from one ally.
 */
export function computeAura(confirmed: ConfirmedHelp[]): number {
  const countByGiver: Record<string, number> = {};
  let score = 0;
  // Stable order so diminishing returns are deterministic.
  for (const h of confirmed) {
    const n = (countByGiver[h.giverId] = (countByGiver[h.giverId] || 0) + 1);
    const kindWeight = KIND_WEIGHT[h.kind] ?? 1;
    const giverTrust = 1 + clamp(h.giverScore / 100, 0, 1); // 1x..2x
    score += (kindWeight * giverTrust) / n; // diminishing returns
  }
  return Math.round(score * 100) / 100;
}

/**
 * Bounded multiplier applied to a connector's money share. 0 aura -> 0.8x,
 * rising smoothly toward 1.2x for high aura. Never outside [0.8, 1.2] so a
 * single connector can't drain a contract, and totals stay rebalanceable.
 */
export function auraTrustFactor(score: number): number {
  const f = 0.8 + 0.4 * (1 - Math.exp(-score / 50));
  return Math.min(1.2, Math.max(0.8, Math.round(f * 1000) / 1000));
}

/** Derived reputation label from the two flows + score. */
export function reputationLabel(score: number, given: number, received: number, vouchCount: number): string {
  if (given + received < 3 && score < 3) return 'New';
  if (vouchCount >= 2 && score >= 10) return 'Trusted';
  if (given > received * 1.5) return 'Giver';
  return 'Connector';
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
