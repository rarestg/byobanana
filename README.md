# BYOBanana

A browser-only image-generation and selection workbench over Google's Gemini ("Nano Banana")
image API. Bring your own Google API key: it stays in your browser, and the page sends it, your
prompts, and your reference images **directly** to Google, never to a BYOBanana server (there is
none). There is no BYOBanana account. The whole site is static assets served from the edge.

https://github.com/user-attachments/assets/dab62d13-0c4f-468e-aff7-d9ffaafffbfd

**Live:** <https://byobanana.com>

## What it is

Set up a run (pick art styles, a subject, reference images, model and size), generate a *contact
sheet* of candidate images, inspect and compare them side by side, mark a Primary, and export the
keepers as raw images, production icons, or ZIP bundles. History, spend, and edit-and-regenerate
are persisted locally in your browser (IndexedDB). Everything runs client-side; the only network
call the app makes is to Google's Gemini endpoint, with your key.

One build serves two front doors: a crawlable static site (landing page + guides, no React) and a
React 19 + [Mantine](https://mantine.dev) single-page workbench at `/app/`.

## Key features

- **Bring-your-own-key, no BYOBanana account.** Paste a Google Gemini API key; it lives in your
  browser. Your key, prompts, and reference images go straight to Google, not to any BYOBanana
  backend (there is none). Google API charges apply to your key.
- **Contact-sheet workflow.** Fan out candidates across art styles and palettes, compare them, and
  keep the winners.
- **Honest cost.** The UI never shows an unknown cost as `$0`; a folded ceiling keeps its `up to $X`
  qualifier in the spend popover and the accessible labels, while the pill face shows the bare folded total.
- **Local persistence.** Runs, history, and image bytes are stored in IndexedDB, so a reload picks
  up where you left off. Clearing browser storage wipes it.
- **Exports.** Raw images, Canvas-rendered circular production icons, and ZIP bundles.
- **Light and dark**, accessible, no-flash theming.

## Quick start

```sh
npm install
npm run dev        # Vite dev server
npm test           # vitest: ported core logic + grounding parser + UI drive-throughs
npm run build      # tsc --noEmit && vite build -> dist/ (includes the em/en-dash gate)
```

There is no Google API key in the dev/CI environment, so tests and browser harnesses exercise the
whole flow through the invisible `?mock=1` query parameter (placeholder images, synthesized cost,
no provider call). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the mock runner and the real-browser
`verify:*` harnesses.

## Key handling and security posture

- The key lives in React state and is gone on reload **unless** you pick "Remember" (over the
  default "This session only"), which mirrors it into `localStorage` as **plaintext** that any
  same-origin script can read. Leave it on "This session only" on shared machines; the UI says
  this in plain English.
- A remembered key is auto-validated on boot via the zero-cost `GET /v1beta/models`.
- **CSP narrows the fetch surface.** `connect-src` allows only `'self'` and
  `https://generativelanguage.googleapis.com` (in `public/_headers` and mirrored as a `<meta>` in
  every shipped HTML document), so a remembered key cannot be POSTed to another origin via
  fetch/XHR/beacon. This is defense-in-depth, **not** a full egress lock: CSP does not restrict
  top-level navigation, so compromised same-origin JavaScript (including a bad dependency) could
  still leak a remembered key. Treat "remember my key" accordingly.
- Google is migrating away from standard API keys during 2026; expect the key model to change.

## Deploy your own

BYOBanana has no backend and no secrets, so deploying it only uploads static files to Cloudflare.
Cloudflare's free plan is enough. Google API charges still apply to the key used in the app.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rarestg/byobanana)

The button copies this repo to your GitHub account and deploys it. Or deploy from a clone:

```sh
npm ci
npx wrangler login
npm run deploy
```

Either way, you get a `*.workers.dev` URL with no configuration. If your copy will be public or use
your own domain, set `SITE_URL` so its canonical URLs point at your site, not `byobanana.com`. See
**[`docs/DEPLOYING.md`](docs/DEPLOYING.md)**.

## Contributing

- [`ARCHITECTURE.md`](ARCHITECTURE.md) maps the code and the invariants you must not break.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) is how to work here (conventions, copy rules, verification).
- LLM-assisted sessions start from [`AGENTS.md`](AGENTS.md).

## Origin

BYOBanana grew out of the *Workbench* in
[`nano-banana-2`](https://github.com/rarestg/nano-banana-2-skill); its pure domain logic
(models/pricing, palettes, recipes, cost math, stored-ZIP writer) is ported from there, and model
IDs and pricing (`src/core/models.ts`) are a snapshot of Google's catalog. Revisit the numbers
against <https://ai.google.dev/gemini-api/docs/pricing> when Google changes models or prices.

## License

[AGPL-3.0-only](LICENSE). If you run a modified version as a network service, the AGPL requires you
to offer its users the corresponding source. Built with care by Rareș Gosman ·
[rares.blog](https://rares.blog).
