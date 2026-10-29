# Shift Planner

No-login shift sign-up app. Cloudflare Worker (API) + D1 + vanilla JS frontend styled with Tailwind v4.
`wrangler dev` / `wrangler deploy` run `npm run build` first (Tailwind CLI -> `public/styles.css`, self-hosted Inter -> `public/fonts/`, both gitignored).

Live: https://shift-planner.egregore85.workers.dev

## Develop

```sh
npm install
npm run db:migrate:local
npm run dev             # http://localhost:8787
```

## Deploy

```sh
npm run db:migrate:remote   # applies new files in migrations/
npm run deploy
```

## Layout

- `src/worker.js` - `/api/*` handlers; everything else is served from `public/`
- `public/` - SPA (`index.html`, `app.js`), hash routing `#/plan/:id/:tab`
- `src/styles.css` - Tailwind entry: theme, component classes, print layout for the overview
- `migrations/` - D1 schema (`plans`, `shifts`, `signups`, `versions`), applied in order by wrangler

## Notes

- Every mutation stores a full JSON snapshot in `versions` (last 100 per plan); restore replaces shifts + sign-ups and is itself versioned.
- Optional admin password per plan (PBKDF2-SHA256, salted) guards layout edits, restore and delete. Sign-ups and removals are open to anyone with the link.
- Sign-up capacity is enforced in a single `INSERT ... SELECT` so concurrent sign-ups can't overfill a shift.
