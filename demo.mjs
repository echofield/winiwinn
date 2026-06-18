/**
 * demo.mjs — drive the whole FIELD loop against a running server and print the
 * receipt. No jq, no curl, just `node demo.mjs` (server must be up).
 *
 *   npm run dev          # in one terminal
 *   npm run demo         # in another  (or: BASE_URL=http://host node demo.mjs)
 *
 * Builds a 5-deep chain so the hop cap and the forfeiture projection are visible.
 */
const B = process.env.BASE_URL || 'http://localhost:8080';
const J = (m, p, body) =>
  fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then((r) => r.json());

const mkuser = (n, c) => J('POST', '/users', { name: n, dna: { vector: [0.5, 0.5, 0.5, 0.5], color: c } }).then((u) => u.id);
const rec = (id, t) => J('POST', '/recommendations', { fromUserId: id, title: t, amount: 100 }).then((r) => r.token);
const join = (tok, n, c) => J('POST', '/join', { token: tok, newUserName: n, dna: { vector: [0.1, 0.2, 0.3, 0.4], color: c } }).then((r) => r.user.id);
const show = (label, v) => console.log(`\n=== ${label} ===\n` + JSON.stringify(v, null, 2));

const health = await J('GET', '/health').catch(() => null);
if (!health) { console.error(`No server at ${B} — run "npm run dev" first.`); process.exit(1); }
console.log(`server: ${B}  mollie: ${health.mollie}`);

// 5-deep chain: U0 -> U1 -> U2 -> U3 -> U4 -> U5, U5 publishes the recommendation.
const U0 = await mkuser('U0', '#E4572E'); let t = await rec(U0, 'U0 link');
const U1 = await join(t, 'U1', '#17BEBB'); t = await rec(U1, 'U1 link');
const U2 = await join(t, 'U2', '#FFC914'); t = await rec(U2, 'U2 link');
const U3 = await join(t, 'U3', '#76B041'); t = await rec(U3, 'U3 link');
const U4 = await join(t, 'U4', '#5B5F97'); t = await rec(U4, 'U4 link');
const U5 = await join(t, 'U5', '#C44536');
const TF = await rec(U5, 'Dinner at Septime');
console.log(`\n5-deep chain built. payee=U5 token=${TF}`);

const conv = await J('POST', '/convert', { token: TF, payerUserId: U0 });
show('/convert', conv);

// Settle. With a real test_ key you'd pay at checkoutUrl then POST { paymentId }.
// In simulation we trigger directly.
const settle = health.mollie === 'simulation'
  ? await J('POST', '/webhooks/mollie', { token: TF, amountCents: 10000, paymentId: conv.paymentId })
  : await J('POST', '/webhooks/mollie', { paymentId: conv.paymentId });
show('webhook settle', settle);

show(`/settlement/${conv.paymentId} (the receipt)`, await J('GET', '/settlement/' + conv.paymentId));
show('U2 positions (mid-chain claims)', await J('GET', '/users/' + U2 + '/positions'));
show('/economy', await J('GET', '/economy'));
console.log('\nagent line:', (await J('GET', '/agent/suggest/' + U2)).suggestion);
