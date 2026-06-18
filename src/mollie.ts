/**
 * mollie.ts — Mollie client helpers (TEST MODE).
 *
 * Supports two credential shapes:
 *   - Organization Access Token (access_…)  -> accessToken + testmode:true + profileId
 *   - Profile API key          (test_…)      -> apiKey (testmode is implicit)
 * With neither, we drop into SIMULATION mode so the loop still runs with no setup.
 *
 * Everything here stays in test mode. Where real multi-party payout would run in
 * production via Mollie Connect, the // PRODUCTION notes live in server.ts.
 */
import { createMollieClient, MollieClient, PaymentStatus } from '@mollie/api-client';

const key = process.env.MOLLIE_API_KEY || '';
const isOAT = key.startsWith('access_');
const isApiKey = key.startsWith('test_') || key.startsWith('live_');
export const mollieEnabled = isOAT || isApiKey;

const client: MollieClient | null = isOAT
  ? createMollieClient({ accessToken: key })
  : isApiKey
  ? createMollieClient({ apiKey: key })
  : null;

// OAT calls must carry testmode:true; profile-bound API keys must not. The SDK's
// TS types don't model OAT testmode/profileId, so SDK call args are cast (`as any`);
// every call here is verified working against the live test token.
/* eslint-disable @typescript-eslint/no-explicit-any */
const TM: any = isOAT ? { testmode: true } : {};
const eur = (cents: number) => ({ currency: 'EUR', value: (cents / 100).toFixed(2) });
const isPublicHttps = (url: string) => /^https:\/\//i.test(url); // Mollie rejects localhost webhooks

if (!mollieEnabled) console.warn('[mollie] No API key — running in SIMULATION mode.');

// OAT requires an explicit profileId on payments/links/subscriptions. Cache it.
let cachedProfileId: string | undefined;
async function profileId(): Promise<string | undefined> {
  if (!isOAT || !client) return undefined;
  if (cachedProfileId) return cachedProfileId;
  for await (const p of client.profiles.iterate({ testmode: true } as any)) { cachedProfileId = p.id; break; }
  return cachedProfileId;
}

// ---- Customers -------------------------------------------------------------
export async function createCustomer(name: string): Promise<string | null> {
  if (!client) return null;
  const customer = await client.customers.create({ name, ...TM } as any);
  return customer.id;
}

// ---- Payments --------------------------------------------------------------
export interface CreatedPayment { id: string; checkoutUrl: string | null }

export async function createPayment(opts: {
  amountCents: number; description: string; redirectUrl: string; webhookUrl: string; metadata: Record<string, unknown>;
}): Promise<CreatedPayment> {
  if (!client) {
    const id = `tr_sim_${Math.random().toString(36).slice(2, 12)}`;
    return { id, checkoutUrl: `${opts.redirectUrl}?simulated=${id}` };
  }
  const params: Record<string, unknown> = {
    amount: eur(opts.amountCents),
    description: opts.description,
    redirectUrl: opts.redirectUrl,
    metadata: opts.metadata,
    ...TM,
  };
  const pid = await profileId();
  if (pid) params.profileId = pid;
  if (isPublicHttps(opts.webhookUrl)) params.webhookUrl = opts.webhookUrl; // else settle via manual paymentId
  const payment = await client.payments.create(params as any);
  return { id: payment.id, checkoutUrl: payment.getCheckoutUrl() };
}

export interface FetchedPayment { id: string; paid: boolean; amountCents: number; metadata: Record<string, unknown> }
export async function getPayment(id: string): Promise<FetchedPayment | null> {
  if (!client) return null;
  const p = await client.payments.get(id, TM as any);
  return {
    id: p.id,
    paid: p.status === PaymentStatus.paid,
    amountCents: Math.round(parseFloat(p.amount.value) * 100),
    metadata: (p.metadata as Record<string, unknown>) || {},
  };
}

export async function getPaymentDetail(id: string): Promise<{ status: string; method: string | null; settlementCurrency: string | null } | null> {
  if (!client) return null;
  const p = await client.payments.get(id, TM as any);
  return {
    status: p.status,
    method: (p.method as string) || null,
    settlementCurrency: (p as { settlementAmount?: { currency: string } }).settlementAmount?.currency || p.amount.currency || null,
  };
}

// ---- Payment links (shareable recommendations) -----------------------------
// NOTE: Mollie payment links do NOT accept `metadata` (only payments do). The
// link is the merchant's reusable, scannable collection point; split attribution
// flows through /conversions (a real payment that carries metadata + a webhook).
export async function createPaymentLink(opts: { amountCents: number; description: string }): Promise<{ id: string; url: string } | null> {
  if (!client) return null;
  const params: Record<string, unknown> = { description: opts.description, amount: eur(opts.amountCents), ...TM };
  const pid = await profileId();
  if (pid) params.profileId = pid;
  const link = await client.paymentLinks.create(params as any);
  const url = (link as { getPaymentUrl?: () => string }).getPaymentUrl?.()
    || (link as { _links?: { paymentLink?: { href: string } } })._links?.paymentLink?.href
    || '';
  return { id: link.id, url };
}

// ---- Mandates + subscriptions (the "stake" = standing authorization) -------
export async function createTestMandate(customerId: string, name: string): Promise<{ id: string; status: string }> {
  if (!client) return { id: `mdt_sim_${Math.random().toString(36).slice(2, 8)}`, status: 'valid' };
  const mandate = await client.customerMandates.create({
    customerId, method: 'directdebit', consumerName: name, consumerAccount: 'NL55INGB0000000000', ...TM,
  } as any);
  return { id: mandate.id, status: mandate.status };
}

export interface SubscriptionInfo { id: string; status: string; nextChargeAt: string | null }
/** Best-effort: unverified test profiles have no recurring method, so this can
 *  throw "No suitable payment methods found". Callers fall back to mandate-only. */
export async function createSubscription(customerId: string, opts: { amountCents: number; interval: string; description: string }): Promise<SubscriptionInfo> {
  if (!client) return { id: `sub_sim_${Math.random().toString(36).slice(2, 8)}`, status: 'active', nextChargeAt: null };
  const params: Record<string, unknown> = {
    customerId, amount: eur(opts.amountCents), interval: opts.interval, description: opts.description, ...TM,
  };
  const pid = await profileId();
  if (pid) params.profileId = pid;
  const sub = await client.customerSubscriptions.create(params as any);
  return { id: sub.id, status: sub.status, nextChargeAt: (sub.nextPaymentDate as string) || null };
}

export async function getSubscription(customerId: string, subscriptionId: string): Promise<SubscriptionInfo | null> {
  if (!client) return null;
  try {
    const sub = await client.customerSubscriptions.get(subscriptionId, { customerId, ...TM } as any);
    return { id: sub.id, status: sub.status, nextChargeAt: (sub.nextPaymentDate as string) || null };
  } catch {
    return null;
  }
}

// ---- Refunds (reverse-domino / "slash") ------------------------------------
export async function createRefund(paymentId: string, amountCents: number): Promise<{ id: string; status: string }> {
  if (!client) return { id: `re_sim_${Math.random().toString(36).slice(2, 8)}`, status: 'refunded' };
  const refund = await client.paymentRefunds.create({ paymentId, amount: eur(amountCents), ...TM } as any);
  return { id: refund.id, status: refund.status };
}

// ---- Proof-it's-real reads -------------------------------------------------
export async function getProfile() {
  if (!client) return { mode: 'simulation', live: false };
  if (isApiKey) {
    const p = await client.profiles.getCurrent();
    return { mode: 'live-test', live: true, profileId: p.id, name: p.name, website: p.website, status: p.status };
  }
  const pid = await profileId();
  return { mode: 'oat-test', live: true, profileId: pid, tokenType: 'organization access token' };
}

export async function listMethods() {
  if (!client) return [{ id: 'simulation', description: 'Simulation mode — set a key for real methods' }];
  const pid = await profileId();
  const methods = await client.methods.list({ ...(pid ? { profileId: pid } : {}), ...TM } as any);
  return methods.map((m) => ({ id: m.id, description: m.description }));
}

/** Settlements are live-only; in test mode we surface Mollie's own explanation. */
export async function listSettlements() {
  if (!client) return { available: false, reason: 'simulation mode' };
  try {
    const open: any = await client.settlements.getOpen(TM as any);
    return { available: true, open: { id: open.id, status: open.status, createdAt: open.createdAt } };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

/** Balance report has no SDK binder; hit the REST endpoint directly (live-only too). */
export async function getBalanceReport() {
  if (!client) return { available: false, reason: 'simulation mode' };
  const until = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const r = await fetch(`https://api.mollie.com/v2/balances/primary/report?from=${from}&until=${until}&grouping=status-balances`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { available: false, reason: (body as { detail?: string }).detail || `http ${r.status}` };
  return { available: true, report: body };
}
