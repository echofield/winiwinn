# Winwinn Web

Next.js App Router port of the `Winwinn.dc.html` prototype, wired to the existing Express backend.

## Run locally

```bash
cd web
npm install
cp .env.example .env.local
npm run dev
```

In another terminal, run the backend from the repo root:

```bash
npm install
npm run dev
```

The web app reads `NEXT_PUBLIC_API_URL` and defaults to `http://localhost:8080`.

## Current merge slice

- Prototype visual language and field canvas ported into React.
- API client typed against the backend contract.
- Demo flow uses live backend calls:
  `users -> recommendations -> join -> merchants -> contracts -> conversions -> settlement`.
- Settlement rows and aura factors render from `GET /conversions/:id/settlement`.
- The client does not compute money or aura payouts.

## QR scanning (two-phone stage demo)

The app both **generates** and **scans** Winwinn codes. Generated QR codes encode the
absolute deep-link URL (`<origin>/r/{token}`), so any phone camera — the in-app scanner
**or** the native iOS/Android camera — opens them.

Routes:
- `/scan` — live camera scanner (`@zxing/browser`, rear camera, gold reticle). On decode it
  routes to `/r/{token}`. Camera blocked → paste the link/token instead (same routing).
- `/r/[token]` — the deep-link landing: resolves the inviter (`GET /r/:token`), runs the DNA
  ritual, `POST /users` + `POST /join`, then shows the joined field. Scanning ≡ opening the link.

### Runbook
1. **Phone A** — open the app → onboard (or "See a deal settle") → tap **✦ Show my code** →
   a QR appears encoding `https://winwinn.vercel.app/r/{token}`.
2. **Phone B** — open `winwinn.vercel.app` → **Scan a code** → point at phone A → lands on
   `/r/{token}` → DNA ritual → joins phone A's field → "You bloomed in."
3. Either phone: run a conversion → settlement → **See the win · win · win**.

Notes: camera needs HTTPS (Vercel) or localhost, and a user gesture (the Scan tap covers it).
`<video>` is `playsinline + muted + autoplay`; all tracks stop on unmount. The native camera
app also opens these codes since they're plain https URLs — two valid scan paths.
