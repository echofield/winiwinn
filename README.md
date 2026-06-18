# FIELD — backend

A recommendation economy. People pass **warm intros** to merchants' deals; when a
real guest covers a real bill, the **merchant-funded** reward flows **back along the
warm-intro chain** in a capped split, settled via **Mollie**. Reputation (**aura**)
is a parallel, unbuyable ledger that *modulates* the money.

- **Node.js + TypeScript + Express**
- **SQLite** (better-sqlite3) — zero-config, file-based, boots with the schema
- **Mollie** Node SDK in **test mode** — supports an Organization Access Token
  (`access_…`) or a profile API key (`test_…`); falls back to simulation with no key
- No auth — pass `x-user-id` if you like; ids come back from `POST /users`

### Two layers

1. **Value (money)** — merchant-funded. A **Contract** is the *consented %* a merchant
   pre-agrees. A **Conversion** (a real covered bill) fires the contract: the reward pool
   (`bill × %`) is split backward along the warm-intro chain, capped at `capDepth`,
   **aura-weighted**; the merchant keeps the remainder. Friend→friend edges are **free** —
   money only ever comes from a merchant. Real payment → real webhook → real split;
   **only multi-party disbursement is simulated** (Mollie Connect in production).
2. **Aura (reputation)** — non-monetary, non-transferable, confirmation-gated. Earned by
   helping (`/help`), validated by the recipient (`/thank`). A bounded **0.8×–1.2×** trust
   factor modulates each connector's share (never exceeding the contract %). Crosses 1.0×
   (a *premium*) around aura ≈ 35 (~7 confirmed vouches).

> A legacy friend-to-friend `/convert` (whole-payment split with a payee remainder) remains
> for the original demo, but **merchant-funded `/conversions` is canonical**.

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

### Frontend

The Next.js App Router frontend lives in `web/`.

```bash
cd web
npm install
cp .env.example .env.local  # NEXT_PUBLIC_API_URL=http://localhost:8080
npm run dev                 # http://localhost:3000
```

From the repo root you can also run:

```bash
npm run web:dev
npm run web:build
```

The current web merge slice ports the Winwinn field/canvas language and runs the
canonical backend flow: `users -> recommendations -> join -> merchants ->
contracts -> conversions -> settlement`. The client renders settlement rows from
`GET /conversions/:id/settlement`; it does not compute money or aura payouts.

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

Two pure, unit-testable functions in **`src/split.ts`**:

**Merchant-funded (canonical) — `computeContractSplit()`.** The merchant funds a reward
pool = `bill × rewardValue%` (or a flat fee). Connector *i* along the warm-intro chain
gets `round(pool × splitCurve[i] × auraFactor(score_i))`, capped so connectors never
exceed the pool (the contracted %); the **merchant keeps `bill − connectorsPaid`**. Rows
sum to the full bill. Example — €100 bill, 8% pool (800¢), curve `[0.6,0.3,0.1]`, Carol
(hop1) at aura 30:

| who | hop | aura | factor | share |
|-----|-----|-----|--------|-------|
| merchant (net) | 0 | — | — | 9270¢ |
| Carol | 1 | 30 | 0.98 | 470¢ |
| Bob | 2 | 2 | 0.816 | 196¢ |
| Alice | 3 | 0 | 0.80 | 64¢ |

**Legacy (friend-to-friend) — `computeSplit()`** with `SPLIT_CURVE = [0.12, 0.05, 0.03]`:
payee keeps the remainder, recommenders take decaying hop shares (€80/€12/€5/€3 on €100).

Both feed **`writeSettlement()`** in `src/server.ts` — the single source of truth that
commits rows, credits earnings, and is **idempotent** per `paymentId`. Aura logic lives
in **`src/aura.ts`** (`computeAura`, `auraTrustFactor`, `reputationLabel`).

> Real payment → real webhook → real split. The **only** simulated step is multi-party
> **disbursement** (Mollie Connect transfers in production) — marked `// PRODUCTION:` at
> the payout write in `server.ts`.

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
| GET | `/settlement/:paymentId` | legacy receipt — payee, chain, capped-forfeiture, live Mollie state |
| GET | `/users/:id/positions` | programmable claims this user holds on descendants' conversions |
| GET | `/mollie/health` | proves the key is live + returns the profile/token type |
| GET | `/mollie/methods` | enabled Mollie payment methods (breadth for the pitch) |
| GET | `/mollie/settlements` `/mollie/balance` | passthrough Mollie reads (live-only; surfaces Mollie's own reason in test) |
| GET | `/economy` | one-call aggregate: settled total, payments, nodes, edges, avg depth, top earners |
| **Merchants & contracts** | | |
| POST | `/merchants` | `{ name }` → a merchant (funds the economy) |
| POST | `/contracts` | `{ merchantId, title, rewardType:"pct"\|"flat", rewardValue, conversionDef?, capDepth?, splitCurve? }` → contract + `dealToken` + **collection point** (`paymentLinkUrl`, `qrPayload`) |
| GET | `/contracts/:id` | contract terms (the consented %) |
| GET | `/merchants/:id/contracts` | a merchant's active deals |
| POST | `/conversions` | `{ contractId, guestUserId?, connectorToken?, amountCents }` → real Mollie payment (the bill); fires the contract on webhook (or immediately in sim) |
| GET | `/conversions/:id/settlement` | **the merchant-funded receipt**: contract terms + real Mollie status + aura-weighted split |
| **Aura (reputation)** | | |
| POST | `/help` | `{ fromUserId, toUserId, kind, note? }` — `kind`: intro\|advice\|job_lead\|showed_up\|vouch (unconfirmed) |
| POST | `/thank` | `{ helpEventId, byUserId }` — recipient confirms; recomputes aura |
| GET | `/users/:id/aura` | `{ score, given, received }` + recent help |
| GET | `/users/:id/reputation` | label (New\|Connector\|Giver\|Trusted) + who vouched |
| GET | `/edge/:from/:to/mutual` | connection + trust context between two users |

`/users/:id/field` nodes now carry both axes: `{ earningsCents, auraScore }`.

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

`writeSettlement()` in `src/server.ts` is the **single source of truth** that commits
a division to the ledger; the pure `computeSplit` / `computeContractSplit` produce the
numbers, and every receipt reads the ledger it writes.

---

## Merchant-funded conversion (canonical, curl)

```bash
# Merchant + their consented deal (8% back, 3 hops, decay 0.6/0.3/0.1)
M=$(curl -s -X POST localhost:8080/merchants -H 'Content-Type: application/json' \
  -d '{"name":"Chez Janou"}' | jq -r .id)
CTR=$(curl -s -X POST localhost:8080/contracts -H 'Content-Type: application/json' \
  -d "{\"merchantId\":\"$M\",\"title\":\"Chez Janou — warm intro deal\",\"rewardType\":\"pct\",\"rewardValue\":8,\"capDepth\":3,\"splitCurve\":[0.6,0.3,0.1]}")
echo "$CTR" | jq '{contract:.contract.id, qr:.qrPayload}'   # qrPayload = real Mollie payment link
CID=$(echo "$CTR" | jq -r .contract.id)

# (build a warm-intro chain A->B->Carol->Guest with /join; give Carol aura via /help + /thank)

# A real guest covers a real €100 bill -> the contract fires
CONV=$(curl -s -X POST localhost:8080/conversions -H 'Content-Type: application/json' \
  -d "{\"contractId\":\"$CID\",\"guestUserId\":\"$GUEST\",\"amountCents\":10000}")
# live: open .checkoutUrl, pay in test mode, then:
curl -s -X POST localhost:8080/webhooks/mollie -H 'Content-Type: application/json' \
  -d "{\"paymentId\":\"$(echo "$CONV" | jq -r .conversionId)\"}"   # strict: settles only if Mollie says paid
# sim mode: already settled on creation.

curl -s localhost:8080/conversions/$(echo "$CONV" | jq -r .conversionId)/settlement | jq .
# -> contract terms (the consented %), real Mollie status, merchant net, and the
#    aura-weighted backward split (hop, amount, auraScore, auraFactor).
```

### Aura (reputation) in one breath

```bash
H=$(curl -s -X POST localhost:8080/help -H 'Content-Type: application/json' \
  -d "{\"fromUserId\":\"$VOUCHER\",\"toUserId\":\"$CAROL\",\"kind\":\"vouch\"}" | jq -r .helpEvent.id)
curl -s -X POST localhost:8080/thank -H 'Content-Type: application/json' \
  -d "{\"helpEventId\":\"$H\",\"byUserId\":\"$CAROL\"}"     # confirmation gate — unconfirmed help counts for nothing
curl -s localhost:8080/users/$CAROL/reputation              # label + who vouched
```

---

## Full demo loop (legacy friend-to-friend, curl)

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
