# Winwinn — Engineer Handoff (for Codex)

**Goal:** merge two existing artifacts into one production app, deployed cleanly.

1. **Backend** — this repo (`github.com/echofield/winiwinn`). Node + TypeScript + Express
   + SQLite + Mollie (test mode, Organization Access Token). Already built, typechecks,
   runs, verified live. **It is the source of truth for all money + reputation logic.**
2. **Frontend** — `Winwinn.dc.html` (1324 lines, in the "Mollie settlement visualization
   design" folder). A high-fidelity prototype of the whole product. **It is the source of
   truth for copy, flows, screen states, visual language, and the canvas rendering math.**

Your job: produce a single **Next.js (App Router) + TypeScript** app on **Vercel** that
ports the prototype to real React and wires it to the live backend API. Do not invent new
product behavior — both artifacts already define it. Reconcile them per the rules below.

---

## 0. Read first (don't skip)

- **`Winwinn.dc.html`** — the prototype. It's a React class component wrapped in an `<x-dc>`
  DSL (`{{ binding }}`, `<sc-if>`, `<sc-for>`, `ref=`, `onClick=`). Read these directly,
  they are the spec: `componentDidMount`, `buildField`/`setupGraph`, `draw`/`drawPeek`/
  `nodePos` (canvas math), `runDomino`/`startConvert`/`chainFrom` (settlement), `renderVals`,
  and the tables `REWARD_SELF`, `REWARD_THING`, `SELF_PCT`, `CONV_CURVE`, `ROLES`, `DOMAINS`.
- **This repo's `README.md`** — the full backend API + the two-layer model (money + aura).
- **`src/split.ts`, `src/aura.ts`, `src/server.ts`** — the canonical math. The prototype's
  `runDomino()` reimplements the *same* model locally; in the merged app that math is
  **deleted from the client** and replaced by backend calls (see §4).

---

## 1. Target architecture (recommended — least rework, true to a hackathon)

```
winwinn/                      (NEW Next.js app, deploy to Vercel)
  app/                        App Router — the ported prototype as React
  components/Field/           canvas renderer (ported ~as-is from the prototype)
  lib/api.ts                  typed client for the backend
  lib/types.ts                shared response types (mirror backend)
  ...
backend  (THIS repo)          stays Express + SQLite, deploy to Cloud Run
```

- **Frontend → Vercel.** Next.js, static + client canvas. Talks to the backend over HTTPS via
  `NEXT_PUBLIC_API_URL`.
- **Backend → Google Cloud Run** (already Dockerized: `Dockerfile` + `deploy-to-cloud-run.sh`,
  project `symionemarket-prod`). **Do not try to run the backend as Vercel serverless** —
  it uses `better-sqlite3` (a native module + a file DB), which Vercel's ephemeral functions
  can't persist. Cloud Run is the right home and is one command away.
- Set the backend's `BASE_URL` to its Cloud Run URL and the frontend's `NEXT_PUBLIC_API_URL`
  to the same, so QR / payment-link / webhook URLs resolve.

> **Alternative (only if a single Vercel deploy is mandatory):** port the Express routes to
> Next.js Route Handlers and swap `better-sqlite3` for **Vercel Postgres or Supabase**. This
> is a real migration (rewrite `src/db.ts`’s SQL layer). Prefer the recommended split unless
> told otherwise. Note SQLite on Cloud Run is also ephemeral (resets on cold start) — fine
> for a demo; move to Postgres/Supabase if persistence is needed.

---

## 2. Source-of-truth rules (resolve every conflict with these)

| Concern | Truth | Note |
|---|---|---|
| Copy, screen states, flows, animations, fonts, colors | **Prototype** | pixel-faithful port |
| Canvas field rendering (positions, halos, euros, domino) | **Prototype** | port the math verbatim |
| Money: pools, splits, caps, who gets paid | **Backend** | client never computes money |
| Reputation/trust/aura: scores, factors, labels, vouch gate | **Backend** | client renders, never computes |
| Identity (DNA / color), onboarding → seed | **Prototype UX, Backend storage** | see §5 |
| Names in seed/examples/demo | **Backend's chosen names** | keep Alice, Bob, Carol, Chez Janou, Septime — they're better than the prototype's. Replace the prototype's placeholder names (Ezra/Maya/Ivo/Noa/Vee…) with these. |

The prototype runs entirely on local mock state (`this.byId`, hardcoded `_eco`, etc.). In the
merged app, **that mock state is replaced by live backend data**, but the *visual treatment*
of that data stays exactly as the prototype renders it.

---

## 3. Backend API contract (already live — consume, don't change)

Base: `NEXT_PUBLIC_API_URL`. No auth (optional `x-user-id` header). `dna = { vector:number[4], color:string }`.

**Identity & field**
- `POST /users {name, dna}` → user `{id, name, dna, earnings_cents, aura_score, ...}`
- `GET /users/:id` → user
- `GET /users/:id/field` → `{ nodes:[{id,name,color,earningsCents,auraScore}], edges:[{from,to}] }` ← **drives the canvas graph** (size = earningsCents, halo = auraScore)
- `POST /join {token, newUserName, dna}` → `{ user, field }` (creates the edge fromUser→B)

**Merchants & contracts (canonical money path)**
- `POST /merchants {name}` → merchant `{id,name,...}`
- `POST /contracts {merchantId, title, rewardType:"pct"|"flat", rewardValue, conversionDef?, capDepth?, splitCurve?, linkAmountCents?}`
  → `{ contract, dealToken, paymentLinkUrl, qrPayload }` ← **paymentLinkUrl/qrPayload = real Mollie collection-point QR**
- `GET /contracts/:id`, `GET /merchants/:id/contracts`
- `POST /conversions {contractId, guestUserId?, connectorToken?, amountCents}`
  → `{ conversionId, checkoutUrl, rewardCents, mode, settled }` ← **checkoutUrl = real Mollie checkout**
- `GET /conversions/:id/settlement` → **the settlement receipt** the domino animation reads:
  `{ billCents, rewardPoolCents, contract{rewardValue,capDepth,splitCurve,...}, merchant{name,netCents,pct}, chain:[{userId,name,hop,amountCents,pct,auraScore,auraFactor}], mollie:{paymentId,status,method}, note }`

**Recommendations (shareable warm intro)**
- `POST /recommendations {fromUserId, title, amount?, contractId?}` → `{ token, qrUrl, paymentLinkUrl, recommendation }`
- `GET /r/:token` → `{ recommendation, fromUser, fieldPreview }`

**Aura (reputation, parallel to money)**
- `POST /help {fromUserId, toUserId, kind, note?}` — kind ∈ `intro|advice|job_lead|showed_up|vouch` (UNCONFIRMED)
- `POST /thank {helpEventId, byUserId}` — recipient confirms → recomputes aura (the anti-gaming gate)
- `GET /users/:id/aura` → `{ aura:{score,given,received}, recent }`
- `GET /users/:id/reputation` → `{ label:"New|Connector|Giver|Trusted", score, given, received, vouchedBy:[{id,name}] }`
- `GET /edge/:from/:to/mutual` → `{ connected, mutualEdge, fromAura, toAura, mutualHighAura, trust:{fromFactor,toFactor} }`

**Proof / dashboard**
- `GET /economy` → `{ totalSettledCents, totalPayments, totalNodes, totalEdges, avgChainDepth, topEarners }`
- `GET /mollie/health` → proves the Mollie key is live (use for the "Secured by Mollie" badge)
- `GET /mollie/methods`, `GET /mollie/settlements`, `GET /mollie/balance` (live-only reads)
- Legacy: `POST /convert`, `GET /settlement/:paymentId`, `GET /users/:id/positions`, `GET /users/:id/ledger`, `GET /agent/suggest/:userId`

---

## 4. The one math reconciliation that matters (read carefully)

The prototype's `runDomino()` computes the split **on the client**. The same model already
lives on the backend (`computeContractSplit` in `src/split.ts`, aura-weighted via
`auraTrustFactor` in `src/aura.ts`). **In the merged app:**

1. **Delete** the client-side pool/curve/aura math from `runDomino()`.
2. On "guest converts", call `POST /conversions` then `GET /conversions/:id/settlement`.
3. Feed the returned `chain[]` (each has `hop, amountCents, pct, auraScore, auraFactor`) and
   `merchant{netCents}` straight into the **existing domino animation** — the euros flying to
   each node, the staggered row reveal, the `settleDeal`/`settleTrust` strings. Keep all the
   prototype's animation timing, easing, and copy; only the *numbers* now come from the API.

The two models are intentionally aligned, so behavior won't visibly change:
- pool = `bill × pct%` (merchant-funded) ✔ both
- decaying base curve across hops, capped at `min(capHops, dealHops)` ✔ both
- aura premium on each slice ✔ both — note the **factor scales differ**: prototype uses
  `0.7 + aura×0.7` (aura 0–1 → 0.7–1.4); backend uses `auraTrustFactor(score)` bounded
  **0.8–1.2**. **Backend wins.** Render `auraFactor` from the receipt; do not recompute.
- **Trust display:** prototype shows trust as 0–1 and "0–100". Map from backend: halo
  intensity/radius ← `auraScore` (normalize, e.g. `min(1, auraScore/50)`); the node detail
  sheet's "trust · vouched" number ← `auraScore`; premium copy ← `auraFactor > 1`.

**Non-money reward kinds** (`free`, `gift`, `off` in `REWARD_SELF`/`REWARD_THING`): the
prototype credits *trust* to the chain instead of money. The backend's money path covers
`cut`/`pct`. For these non-money kinds, **do not create a Mollie payment** — instead record
trust along the chain via `POST /help` (kind `intro`/`vouch`) + the recipient's `POST /thank`,
and animate the "trust exchanged ✦" state. (If a true "credit trust to the whole chain on
arrival" endpoint is wanted, that's a small backend extension — flag it, don't fake money.)

---

## 5. Onboarding → identity (DNA) mapping

Prototype: welcome → 4 taste questions → seeds `this.dna = {h,s,l}` + `dnaTraits`
(`reach`, `domain`, `conviction`, `incentive`) + a default reward + `capHops`. Keep the exact
questions/copy/animations. On finish:

- Build `dna = { vector:[...4 numbers from the answers], color: "hsl(h s% l%)" }`.
- `POST /users {name, dna}` → store the returned `id` (localStorage) as "you" (hop 0).
- `dnaTraits.conviction` and `capHops` are presentation hints; the **contract's** `splitCurve`
  + `capDepth` govern real splits. Keep the prototype's conviction-curve *visual*, but the
  paid numbers come from `/conversions` settlement.

---

## 6. Screens to port (all present in the prototype)

welcome → onboarding (4 Q) → **field** (animated canvas graph + left/right panels on desktop,
overlay on mobile; view toggle value/aura/agents; theme night/day; layout toggle) → node
detail sheet (person vs merchant variants) → **recommend / open-yourself** sheet (category +
reward-kind pickers) → **QR card** (`winwinn.app/r/{token}` + real `paymentLinkUrl`) → "they
enter your field" (join) → **convert** (Mollie screen → flash → domino) → **settlement
breakdown** (rows, mutual-win card, Mollie receipt) → vouch/give flow → Mollie "record"
overlay → SYMIONE intent envelope overlay (cosmetic; `/agent/suggest` can feed it).

Faithfully reproduce states: whisper toasts, activity feed, positions strip, economy ticker
(`GET /economy` instead of the mock `_eco` interval), reduced-motion handling.

---

## 7. Visual language (from the prototype — keep exact)

- Themes: dark "night" (`#050507` bg) + light "day". CSS vars: `--phone,--ink,--muted,--faint,
  --accent,--brd,--brdg,--glass,--glass2,--card,--card2,--peekBg,--welcomeWash`.
- Identity = hue per person. Node **size = money earned**, **halo intensity/radius = trust**.
- Gold accent `#c2a25f`; merchant teal `hsl(168 48% 50%)`.
- Fonts: Cormorant Garamond (display), Instrument Sans (UI), JetBrains Mono (data).
- Port the canvas (`draw`, `drawPeek`, `nodePos`, `drawIntents`, euro particles, domino flares,
  3D-ish rotation/pitch, ring radii `{0:0,1:.20,2:.34,3:.46}`) into a `useRef<canvas>` +
  `requestAnimationFrame` component. It's framework-agnostic; lift it nearly verbatim.

---

## 8. Deliverables & deployment

1. **Next.js app** (App Router, TS, strict). Client components where canvas/interactivity is
   structural; everything else server components. No CRA, no Pages Router.
2. `lib/api.ts` typed against §3; `lib/types.ts` mirrors backend responses. One `NEXT_PUBLIC_API_URL`.
3. Graceful loading / empty / error states for every fetch (the prototype never shows NaN —
   keep that bar).
4. **Vercel**: import the repo, set `NEXT_PUBLIC_API_URL`, deploy. Add `vercel.json` only if
   needed. Confirm a production build (`next build`) passes.
5. **Backend**: `MOLLIE_API_KEY=access_… ./deploy-to-cloud-run.sh`, then set its `BASE_URL` to
   the returned URL and point `NEXT_PUBLIC_API_URL` at it. (Mollie key lives in env only —
   never commit it; `.env` is gitignored.)

## 9. Acceptance criteria

- [ ] Full flow works against the **live backend**: create user → recommend (real QR +
      `paymentLinkUrl`) → join → merchant+contract → conversion (real Mollie `checkoutUrl`) →
      settlement breakdown animates the **backend-computed** chain → field updates.
- [ ] Field canvas renders from `GET /users/:id/field` (size=money, halo=aura), not mock data.
- [ ] Vouch flow: `POST /help` (vouch) + recipient `POST /thank` → aura rises → halo grows;
      reputation label + `vouchedBy` shown on the node sheet.
- [ ] No client-side money/aura computation remains. The client only renders API numbers.
- [ ] Economy ticker, "Secured by Mollie" badge (`/mollie/health`), and settlement receipt
      (real `mollie.paymentId/status`) all read live.
- [ ] `next build` passes; deployed on Vercel; backend on Cloud Run; QR/checkout/webhook URLs
      resolve end to end.
- [ ] Seed/example/demo identities use the backend's names (Alice, Bob, Carol, Chez Janou,
      Septime), not the prototype placeholders.

**Honest line to preserve in the UI:** real QR, real scan, real Mollie payment, real webhook,
real contract execution + split. The *only* simulated step is multi-party disbursement (Mollie
Connect in production) — it's marked `// PRODUCTION:` at the payout write in `src/server.ts`.
Don't claim more than that.
