# AGENTS.md

Orientation for LLM-assisted work in this repo. This is a map, not the truth — it routes you to
the sources of truth and calls out what you must not break. When this file and the code disagree,
the code wins; fix this file.

## What this is

BYOBanana: a browser-only image-generation and selection workbench over Google's Gemini image API.
Bring your own Google API key; the browser talks directly to Google. No backend — static assets on
Cloudflare's edge. One build serves two front doors: a static SEO site (landing + guides, no
React) and a React 19 + Mantine SPA workbench at `/app/`.

## Repo map

Read `ARCHITECTURE.md` for the codemap and invariants. The short version: `src/core/` is the
framework-free layer (wire client, cost, persistence — pure logic plus browser adapters); `src/run/`
runs a session and renders results; `src/setup/` assembles a run; `src/Workbench.tsx` orchestrates.
The static site lives in `index.html` + `public/`.

## Sources of truth

- **Design system** → `src/theme.ts` (colors, radius, contrast handling) + `src/app.css`
  (per-scheme contrast vars); static-site tokens live in `public/landing.css`.
- **Security headers / CSP** → `public/_headers` (single source; applied by the generated Worker).
- **Wire contract to Google** → `src/core/gemini.ts` + `docs/manual-smoke-test.md`.
- **Model catalog & pricing snapshot** → `src/core/models.ts`.
- **Deploy (native + generated-Worker fallback) & `SITE_URL` for forks** → `docs/DEPLOYING.md`.
- **How to work here (conventions)** → `CONTRIBUTING.md`.
- **Public copy rules & claim guardrails** → `CONTRIBUTING.md` ("Public copy rules"). The shipped
  copy in `index.html` + guide HTML is the copy of record and must conform to it; do not invent
  public claims.

## Non-negotiable invariants

Breaking one of these is a regression even if tests pass. `ARCHITECTURE.md` explains each.

- **One egress.** Only `src/core/gemini.ts` calls the provider; the only network destination is
  `generativelanguage.googleapis.com`. Do not add other fetch destinations.
- **`/v1beta`, never `/v1`** for the image API.
- **CSP `connect-src`** stays `'self'` + the Google endpoint, in `public/_headers` and both HTML
  `<meta>` tags. A BYO key must never become POSTable elsewhere.
- **Static pages never touch Mantine runtime CSS variables** — they key off
  `data-mantine-color-scheme` (set pre-paint by `public/theme-init.js`), which must stay in
  lock-step with `MantineProvider`.
- **Frozen identifiers** (renaming breaks returning users — see `ARCHITECTURE.md` for which):
  localStorage `nano-banana-web:gemini-key`, IndexedDB `nano-banana-web`, Web Lock
  `nano-banana-web:primary-tab`, BroadcastChannel `nano-banana-web:sessions`,
  `mantine-color-scheme-value`, Worker name `nano-banana-web`.
- **Cost honesty:** never show an unknown cost as `$0`; a folded ceiling keeps its `up to $X`
  qualifier in the spend popover (total line + rows) and the accessible labels, while the spend-pill
  face shows the bare folded number; a live run with no known dollars rolls the flap board (motion
  texture) rather than resting on a number; `?mock=1` never spends and always wins over a validated key.
- **No em/en dashes in built static HTML** (enforced by `scripts/check-dashes.mjs` in the build;
  it scans `dist/`, not React app copy).

## Validation & definition of done

```sh
npm test        # vitest (all pure logic + UI drive-throughs) — must be green
npm run build   # tsc --noEmit && vite build && the dash gate — must be green
```

UI changes also need the relevant `verify:*` / `screenshot` harness in `package.json` (real
Chromium, not part of `npm test`) and screenshots in both color schemes. There is no API key in
CI, so exercise flows with `?mock=1`. Deploy only when asked: `npm run deploy` (native Workers
Static Assets) is the default; `npm run deploy:worker` is a fallback (see `docs/DEPLOYING.md`).

## Going deeper

- Where does X live / why is it shaped this way → `ARCHITECTURE.md`
- How do I build UI / what's enforced → `CONTRIBUTING.md`
- What is this + how do I run it → `README.md`
- Live wire contract & key handling → `docs/manual-smoke-test.md`
- Deploy & `SITE_URL` for forks → `docs/DEPLOYING.md`
