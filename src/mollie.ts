/**
 * mollie.ts — Mollie test-mode client helpers.
 *
 * If MOLLIE_API_KEY is missing or not a test_ key, the backend drops into
 * SIMULATION mode: /convert returns a fake checkout URL and you settle by
 * hitting /webhooks/mollie manually with { token, amountCents }. This keeps the
 * full domino loop demoable with zero external setup.
 */
import { createMollieClient, MollieClient, PaymentStatus } from '@mollie/api-client';

const apiKey = process.env.MOLLIE_API_KEY || '';
export const mollieEnabled = apiKey.startsWith('test_');
const client: MollieClient | null = mollieEnabled ? createMollieClient({ apiKey }) : null;

if (!mollieEnabled) {
  console.warn('[mollie] No test_ API key found — running in SIMULATION mode.');
}

export async function createCustomer(name: string): Promise<string | null> {
  if (!client) return null;
  const customer = await client.customers.create({ name });
  return customer.id;
}

export interface CreatedPayment {
  id: string;
  checkoutUrl: string | null;
}

export async function createPayment(opts: {
  amountCents: number;
  description: string;
  redirectUrl: string;
  webhookUrl: string;
  metadata: Record<string, unknown>;
}): Promise<CreatedPayment> {
  if (!client) {
    // Simulation: synthesize a payment id and a fake hosted-checkout URL.
    const id = `tr_sim_${Math.random().toString(36).slice(2, 12)}`;
    return { id, checkoutUrl: `${opts.redirectUrl}?simulated=${id}` };
  }
  const payment = await client.payments.create({
    amount: { currency: 'EUR', value: (opts.amountCents / 100).toFixed(2) },
    description: opts.description,
    redirectUrl: opts.redirectUrl,
    webhookUrl: opts.webhookUrl,
    metadata: opts.metadata,
  });
  return { id: payment.id, checkoutUrl: payment.getCheckoutUrl() };
}

export interface FetchedPayment {
  id: string;
  paid: boolean;
  amountCents: number;
  metadata: Record<string, unknown>;
}

export async function getPayment(id: string): Promise<FetchedPayment | null> {
  if (!client) return null;
  const p = await client.payments.get(id);
  return {
    id: p.id,
    paid: p.status === PaymentStatus.paid,
    amountCents: Math.round(parseFloat(p.amount.value) * 100),
    metadata: (p.metadata as Record<string, unknown>) || {},
  };
}

/** Raw payment status/method/currency for the settlement receipt. */
export async function getPaymentDetail(id: string): Promise<{ status: string; method: string | null; settlementCurrency: string | null } | null> {
  if (!client) return null;
  const p = await client.payments.get(id);
  return {
    status: p.status,
    method: (p.method as string) || null,
    settlementCurrency: (p as { settlementAmount?: { currency: string } }).settlementAmount?.currency || p.amount.currency || null,
  };
}

/** Prove the key is live and return the test profile. */
export async function getProfile() {
  if (!client) return { mode: 'simulation', live: false };
  const profile = await client.profiles.getCurrent();
  return {
    mode: 'live-test',
    live: true,
    profileId: profile.id,
    name: profile.name,
    website: profile.website,
    status: profile.status,
  };
}

/** Enabled payment methods — shows Mollie's breadth for the pitch. */
export async function listMethods() {
  if (!client) {
    return [{ id: 'simulation', description: 'Simulation mode — set a test_ key for real methods' }];
  }
  const methods = await client.methods.list();
  return methods.map((m) => ({ id: m.id, description: m.description, minAmount: m.minimumAmount, maxAmount: m.maximumAmount }));
}
