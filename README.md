# FIELD — backend

A recommendation economy. People recommend people and places; when a
recommendation converts into a payment, the value flows **back up the
recommendation chain** in a capped "domino" split, settled via **Mollie**.

- **Node.js + TypeScript + Express**
- **SQLite** (better-sqlite3) — zero-config, file-based, boots with the schema
- **Mollie** Node SDK in **test mode** (falls back to a simulation mode with no key)
- No auth — pass `x-user-id` if you like; ids come back from `POST /users`

---

## Setup

```bash
npm install
cp .env.example .env       # then paste your Mollie test_ key (optional)
npm run seed               # creates Alice -> Bob -> Carol + one recommendation
npm run dev                # http://localhost:8080
```

On boot the server prints a few **example domino splits** so you can see the math
without a frontend. `npm run build` + `npm start` runs the compiled version.

### Env

| var | meaning |
|-----|---------|
| `MOLLIE_API_KEY` | Mollie **test** key (`test_…`). Blank → simulation mode. |
| `PORT` | listen port (Cloud Run sets `8080`). |
| `BASE_URL` | public base for QR / redirect / webhook URLs. |
| `DB_PATH` | SQLite file (`./field.db`; use `/tmp/field.db` on Cloud Run). |

**Simulation mode:** with no `test_` key, `/convert` returns a fake checkout URL
and you settle by calling `/webhooks/mollie` manually (see below). The full
domino loop works either way.

---

## The split (the heart)

Configured in **`src/split.ts`**:

```ts
export const SPLIT_CURVE = [0.12, 0.05, 0.03]; // shares for hop 1, 2, 3
```

`SPLIT_CURVE[i]` is the share for the recommender `i+1` hops above the payee; its
length is the **hop cap**. The payee keeps the remainder. On a €100 conversion
over a full chain:

| who | hop | share |
|-----|-----|-------|
| payee (recommendation owner) | 0 | **€80** |
| direct recommender | 1 | €12 |
| +1 hop | 2 | €5 |
| +2 hop | 3 | €3 |
| beyond 3 hops | — | nothing |

`computeSplit()` is **pure** (no DB), rounds to whole cents, and the payee
absorbs rounding so payouts always sum back to the exact total. `splitAndSettle()`
in `src/server.ts` wraps it: it walks the chain, writes ledger rows, credits
cached earnings, and is **idempotent** per `paymentId`.

> Settlement is simulated in the ledger. Real multi-party payout would use
> **Mollie Connect** transfers — see the `// PRODUCTION:` comment in `server.ts`.

---

## Endpoints

| method | path | does |
|--------|------|------|
| POST | `/users` | create user `{ name, dna }` + Mollie test customer |
| GET | `/users/:id` | profile |
| GET | `/users/:id/field` | `{ nodes[], edges[] }` reachable from user (with `color`, `earningsCents`) |
| POST | `/recommendations` | `{ fromUserId, title, amount }` → `{ token, qrUrl, recommendation }` |
| GET | `/r/:token` | resolve token → `{ recommendation, fromUser, fieldPreview }` |
| POST | `/join` | `{ token, newUserName, dna }` → new user + edge + field state |
| POST | `/convert` | `{ token, payerUserId }` → Mollie checkout URL |
| POST | `/webhooks/mollie` | on paid → domino split (idempotent). Manual trigger supported. |
| GET | `/users/:id/ledger` | incoming domino shares |
| GET | `/agent/suggest/:userId` | cosmetic fake agent suggestion from the field |
| GET | `/settlement/:paymentId` | **the receipt** — full split: payee, chain, capped-forfeiture, live Mollie state |
| GET | `/users/:id/positions` | programmable claims this user holds on descendants' conversions |
| GET | `/mollie/health` | proves the test key is live + returns the profile |
| GET | `/mollie/methods` | enabled Mollie payment methods (breadth for the pitch) |
| GET | `/economy` | one-call aggregate: settled total, payments, nodes, edges, avg depth, top earners |

`dna` is `{ vector: number[4], color: string }` — derived from the frontend's
4-question quiz. `amount` on a recommendation is in **euros** (stored as cents).

---

## Fastest demo: `npm run demo`

With the server running (`npm run dev`), in another terminal:

```bash
npm run demo
```

This builds a **5-deep chain**, converts a €100 recommendation, settles it, and
prints the settlement receipt — so you can see the hop cap (hops 4–5 get nothing)
and the `hop4PlusForfeitedCents` projection. No `jq`/`curl` needed. Point it
elsewhere with `BASE_URL=https://your-service node demo.mjs`.

---

## The financial centerpiece (for judges)

- **`GET /settlement/:paymentId`** is the receipt of a multi-party settlement:
  `payee`, the `chain` of domino recipients (with `pct`), `uncapped.hop4PlusForfeitedCents`
  (money the cap kept from leaking up the chain), and live `mollie` status/method/currency.
- **`GET /users/:id/positions`** surfaces each recommender edge as a *programmable
  claim* on a payment stream — `realizedCents` (already paid out) + `pendingCount`.
  Honest framing: split rights settled by Mollie, **not** locked capital or yield.
- **Strict settlement:** with a real `test_` key, `/webhooks/mollie` settles **only**
  after fetching the payment from Mollie and confirming `status=paid`. No verified
  payment → no split. Amount and token come from Mollie, never the request body.
- **`GET /mollie/health`** proves the key is live in one call; **`/mollie/methods`**
  shows Mollie's payment breadth.
- **`GET /economy`** proves the whole economy is moving in one call.

`splitAndSettle()` in `src/server.ts` is the **single source of truth** for dividing
money; `/settlement` only reads the ledger it writes.

---

## Full demo loop (curl)

```bash
# 1. Create the origin user
ALICE=$(curl -s -X POST localhost:8080/users -H 'Content-Type: application/json' \
  -d '{"name":"Alice","dna":{"vector":[0.9,0.2,0.5,0.1],"color":"#E4572E"}}' | jq -r .id)

# 2. Alice recommends Bob's link by creating a recommendation she'll share
REC=$(curl -s -X POST localhost:8080/recommendations -H 'Content-Type: application/json' \
  -d "{\"fromUserId\":\"$ALICE\",\"title\":\"Dinner at Septime\",\"amount\":100}")
TOKEN=$(echo "$REC" | jq -r .token)

# 3. Bob joins through Alice's link (edge Alice -> Bob)
BOB=$(curl -s -X POST localhost:8080/join -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"newUserName\":\"Bob\",\"dna\":{\"vector\":[0.3,0.8,0.4,0.6],\"color\":\"#17BEBB\"}}" | jq -r .user.id)

# 4. Bob makes his own recommendation; Carol joins through it; Carol recommends a place
BOBREC=$(curl -s -X POST localhost:8080/recommendations -H 'Content-Type: application/json' \
  -d "{\"fromUserId\":\"$BOB\",\"title\":\"Bob's pick\",\"amount\":100}" | jq -r .token)
CAROL=$(curl -s -X POST localhost:8080/join -H 'Content-Type: application/json' \
  -d "{\"token\":\"$BOBREC\",\"newUserName\":\"Carol\",\"dna\":{\"vector\":[0.5,0.5,0.9,0.3],\"color\":\"#FFC914\"}}" | jq -r .user.id)
CAROLREC=$(curl -s -X POST localhost:8080/recommendations -H 'Content-Type: application/json' \
  -d "{\"fromUserId\":\"$CAROL\",\"title\":\"Carol's place\",\"amount\":100}" | jq -r .token)

# 5. Convert (creates a Mollie test payment — open checkoutUrl to pay in test mode)
curl -s -X POST localhost:8080/convert -H 'Content-Type: application/json' \
  -d "{\"token\":\"$CAROLREC\",\"payerUserId\":\"$ALICE\"}"

# 6. Trigger settlement. Real Mollie calls the webhook itself; for a local demo
#    (no public tunnel / simulation mode) trigger it manually:
curl -s -X POST localhost:8080/webhooks/mollie -H 'Content-Type: application/json' \
  -d "{\"token\":\"$CAROLREC\",\"amountCents\":10000}"

# 7. See the domino land
curl -s localhost:8080/users/$CAROL/ledger     # Carol: hop0 = 8000¢
curl -s localhost:8080/users/$BOB/ledger        # Bob:   hop1 = 1200¢
curl -s localhost:8080/users/$ALICE/ledger      # Alice: hop2 =  500¢
curl -s localhost:8080/users/$ALICE/field       # the round graph
curl -s localhost:8080/agent/suggest/$ALICE     # cosmetic agent line
```

Or skip steps 1–4: `npm run seed` prints a ready-made Alice→Bob→Carol chain plus
the exact `/convert` + webhook curls.

---

## Deploy to Cloud Run (optional)

Only needed if you want Mollie's real webhook to reach you over a public URL.

```bash
MOLLIE_API_KEY=test_xxx ./deploy-to-cloud-run.sh
```

Defaults to project `symionemarket-prod`, region `europe-west1`, service
`field-backend`. **Caveat:** SQLite lives in `/tmp`, which Cloud Run wipes on
cold start — fine for a live demo, not for persistence. Swap `db.ts` for
Postgres/Supabase if you need durable state.
