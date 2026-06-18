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
