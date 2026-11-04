# Architecture

This is a map for contributors: the coarse shape of the code and the invariants that hold it
together. It names files and types but does not link them (links rot) — use symbol search. It
is deliberately short and revised rarely; it describes what is unlikely to change, not the
current line count.

## The problem

BYOBanana is a browser-only workbench for generating and comparing images from Google's Gemini
image API. You bring your own Google API key; it stays in the browser and the page talks
**directly** to Google. There is no backend — the whole site is static assets served from
Cloudflare's edge.

The core job: fan out a *contact sheet* of candidate generations (styles × variants), let the
user inspect and compare them, mark one Primary, export raw images / production icons / ZIP
bundles, and do it all while reporting honest cost and persisting history locally. Everything
runs client-side.

## Two rendering worlds

One build produces two front doors:

- **The static site** — `index.html` (landing) and `public/guides/*/index.html`, styled by
  `public/landing.css`, with color scheme bootstrapped by `public/theme-init.js` and toggled by
  `public/theme-toggle.js`. It loads **no React and no Mantine**. This is the crawlable,
  SEO-facing surface.
- **The app SPA** — `app/index.html` boots `src/main.tsx` → `src/App.tsx` (which mounts
  `MantineProvider` with the `theme`) → `src/Workbench.tsx`. This is the workbench at `/app/`,
  marked `noindex`.

They share a pre-paint layer, not a component runtime: the app page loads `landing.css` and
`theme-init.js` too, so its background and color scheme are set from the same `--byo-*` tokens and
the same `data-mantine-color-scheme` attribute *before* React mounts; Mantine is layered on only
after. Header geometry is tuned to line up (`Workbench.module.css` mirrors `.byo-*` classes from
`landing.css`), and `theme-color` metas match across both.

## Codemap

### `src/` — app shell

`Workbench.tsx` is the orchestrator where the other groups meet: it boots the repository (and
runs interrupted-run recovery), drives the submission pipeline (`handleSubmit` builds a
`RunQueue` and picks the runner), owns the onboarding-banner state machine and the sticky
toolbar, and enforces the single-tab write rule. It is the most complex file and the home of the
trickiest concurrency invariants (view-intent counter, submission-generation busy flag, coalesced
history refresh).

`App.tsx` is the provider tree. `useApiKey.tsx` holds the BYO key as a React context
(memory-first, opt-in `localStorage`, versioned validation via `validateApiKey`). `useSingleTab.ts`
is the Web Lock guard that assigns each tab a `primary`/`secondary` role. `KeyPanel.tsx` is the
header key pill + entry modal; `OnboardingBanner.tsx` is the first-run key prompt; `ThemeToggle.tsx`
is the light/dark switch. `theme.ts` is the design system (see below).

### `src/core/` — framework-free layer

No React or Mantine imports. It splits into pure, node-testable domain logic (`cost.ts`,
`models.ts`, `session.ts` types, `recipes.ts`, `palettes.ts`, `formatCost.ts`) and browser
infrastructure that necessarily touches web APIs (`gemini.ts` uses `fetch`, `idbRepository.ts`
uses IndexedDB, `sessionsChannel.ts` uses BroadcastChannel, `compressWorker.ts` runs in a Worker,
`image.ts`/`exportBundle.ts` use Canvas). Much of the pure logic is ported byte-faithfully from
`nano-banana-2 @ 54e0224` (the ported modules say so in a `// Ported from…` header) so pricing and
wire behavior do not drift.

- `gemini.ts` — the Gemini wire client. **The only code that calls the provider.** `generateImage`
  is the paid `:generateContent` path (retry/backoff, abort, typed errors, `GeminiFatalError`);
  `validateApiKey` is the free `GET /models` key check; `parseGroundingMetadata` parses the
  attribution block. The key travels only in the `x-goog-api-key` header.
- `models.ts` — the model catalog, per-token rates, per-image USD estimates, and the 3-model
  allowlist. The pricing snapshot.
- `cost.ts` — usage classification and cost math (`classifyUsage`, `calculateGenerationCost`,
  `estimateSessionCost`, `summarizeSpend`, confirmation gates).
- `session.ts` — the boundary types and the `SessionRepository` interface (the central seam),
  plus `InMemorySessionRepository`, `sha256Hex`, and the manifest/candidate shapes. Image bytes
  live as Blobs addressed by id, kept out of the JSON manifest.
- `idbRepository.ts` — `IdbSessionRepository`, the durable adapter over two IndexedDB stores
  (`manifests` + `blobs`). Writes are atomic read-modify-write in one transaction (IDB's native
  serialization replaces the source's mutex, which is what makes the concurrent queue safe).
  `recover()` reconciles interrupted runs on boot.
- `sessionsChannel.ts` — the BroadcastChannel that pings peers to re-list history after a write.
- `compress.ts` / `compressWorker.ts` — lazy WASM image compression (jSquash) and circular-icon
  palette quantization (libimagequant) off the main thread.
- `image.ts` / `exportBundle.ts` / `zip.ts` — Canvas circular-icon export, ZIP assembly, and a
  dependency-free stored-ZIP writer.
- `recipes.ts` (+ `recipes/*.json`), `palettes.ts` — the art-style and palette catalogs.
- `formatCost.ts` — the shared approximate-cost display formatter.

### `src/run/` — run execution + results UI

`queue.ts` is `RunQueue`, the concurrency-clamped worker pool that executes one session's
candidates against an injected `GenerationRunner` and pushes fresh manifests to `onUpdate`.
`mockRunner.ts` is the mock runner selected by `?mock=1`. The results UI — `SessionView`,
`ContactSheet`, `CandidateCard`, `InspectorSlot`, `RunSummary`, `HistoryRail`, `ExportTray` —
renders the contact sheet, sticky inspector, history, and export. `SpendPill.tsx` with
`flapMath.ts` is the split-flap spend board; `spendAggregate.ts` computes the cross-session spend
report. `statusCopy.ts`, `zoomScale.ts`, and `useBlobUrl.ts` are helpers.

### `src/setup/` — run assembly UI

`SetupForm.tsx` is the run-assembly form (recipes, subject, palette, references, model settings,
live cost estimate); `buildSessionInput.ts` is its pure assembler of a `CreateSessionInput`.
`RecipePicker`, `PalettePicker`, and `ReferenceInput` are the pickers; `references.ts` validates
reference images by magic bytes (not `File.type`); `editSeed.ts` reconstructs a form seed
(including rehydrated reference blobs) for edit-and-regenerate.

### `scripts/` — build, deploy, verify

`build-worker.mjs` packages `dist/` into the generated deploy Worker; `check-dashes.mjs` is the
em/en-dash gate; `build-og.mjs` builds the OG card; `screenshot.mjs` and the `verify-*.mjs`
harnesses drive a real browser. `public/_headers` is the single source of security headers.

## Runtime flow

A run moves `setup/` → `core/session` (repository) → `run/queue` → `core/gemini` (or
`run/mockRunner`), all orchestrated by `Workbench.tsx`. (This is the flow of a submission, not the
import graph — UI modules import each other freely; the one-directional rule is that nothing in
`core/` imports UI.) Two seams keep it flexible: the `SessionRepository` interface (IndexedDB in
prod, in-memory in tests — the queue is unchanged either way) and the injected `GenerationRunner`
(real vs mock — the queue and repository never know which).

## Architectural invariants

- **No backend, one programmatic egress.** The only host the app *fetches* is
  `generativelanguage.googleapis.com`, and the only code that reaches it is `core/gemini.ts`.
  Nothing else does provider I/O. (User-initiated navigations to outside links — the AI Studio
  key page, grounding sources — are separate and not fetches.)
- **`/v1beta`, never `/v1`.** The image models' fields (`tools`, `responseModalities`,
  `imageConfig`) exist only on `/v1beta`; `/v1` 400s and does not expose the Pro model. See the
  header comment in `gemini.ts` and `docs/manual-smoke-test.md`.
- **CSP pins the fetch surface.** `connect-src` allows only `'self'` and the Google endpoint
  (in `public/_headers`, and mirrored as a `<meta>` in every shipped HTML document — landing, app,
  and the three guides), so a BYO key cannot be POSTed to another origin. Defense-in-depth, not a
  full egress lock — CSP does not govern navigation.
- **`core/` is one-directional.** It has no React/UI imports; `run/` and `setup/` import down
  into `core/`, and `core/` never imports UI. Its pure modules are node-testable; its browser
  adapters (`idbRepository`, `sessionsChannel`, `compressWorker`, `image`, `gemini`) are the
  intended home for web-API access.
- **The static/Mantine boundary.** Static pages key color off `data-mantine-color-scheme` (set
  pre-paint by `theme-init.js`) and must **never** reference Mantine runtime CSS variables — a
  static page has no `MantineProvider`, so those variables are simply never defined there (on the
  app page they exist only after mount, which is why a stray reference flashes). `theme-init.js`
  must stay in lock-step with `MantineProvider` (same key, default, attribute).
- **Frozen compatibility identifiers.** These are named for continuity, not convenience; renaming
  any of them breaks something for returning users. The severe two govern retained data — the
  localStorage key `nano-banana-web:gemini-key` (a rename orphans the remembered key) and the
  IndexedDB name `nano-banana-web` (a rename orphans all stored history and image bytes). The rest
  preserve, respectively, live cross-tab coordination (Web Lock `nano-banana-web:primary-tab`,
  BroadcastChannel `nano-banana-web:sessions`), the saved color preference
  (`mantine-color-scheme-value`), and deployment identity (Worker name `nano-banana-web`, which the
  custom domains bind to).
- **Single-tab writes.** Where the Web Locks API is available, one tab holds the lock and may
  generate/recover; a second tab is view-only and does not live-promote (it must be reloaded to
  take over). Browsers without Web Locks fall back to primary. **bfcache caveat (portable to any
  Web-Lock single-tab guard):** a lock held for "the document's lifetime" via an unresolved promise
  is *not* freed by same-tab navigation — the back/forward cache freezes the holder with the lock
  still held, so returning to `/app/` sees its own frozen predecessor and falsely reports "another
  tab". `useSingleTab.ts` therefore releases on `pagehide` and re-arbitrates on `pageshow` when
  `persisted` (re-acquire, not reload, so a restored primary stays primary and a contended one
  degrades to secondary). Guarded by `useSingleTab.test.tsx` (wiring) and `verify:bfcache` (real
  Chromium round trip).
- **`public/_headers` is the single source of headers.** Forks deploy with native Workers Static
  Assets (`npm run deploy`). `byobanana.com` runs a generated Worker (`build-worker.mjs`,
  `npm run deploy:worker`), which additionally applies `public/_headers` to every response it serves
  (redirects and errors included) and does host-aware canonicalization: `noindex` is decided per
  request from the host (`hostname !== PROD_HOST`, where `PROD_HOST` is derived from `SITE_URL`,
  defaulting to `byobanana.com`). See `docs/DEPLOYING.md`.

## Cross-cutting concerns

- **Color scheme.** Every surface ships light *and* dark. Two token systems: the static site's
  `data-mantine-color-scheme` pattern in `landing.css`, and the Mantine `theme.ts` in the app.
  `theme-color` metas match real page tones (`#f4f4f5` / `#141418`).
- **Cost honesty.** An unknown cost is never rendered as a resting `$0`; a folded ceiling keeps its
  `up to $X` qualifier in the spend popover (total line + rows) and the accessible labels, while the
  spend-pill face shows the bare folded number; a live run with unknown dollars rolls the flap board
  (motion texture) rather than resting on a number; cancellations that may have billed say so.
  `?mock=1` can never spend money and always wins over a validated key. The rules live at the call
  sites and in `spendAggregate.ts` / `formatCost.ts`.
- **Accessibility.** axe is run in the screenshot harness (it reports; it does not fail the run),
  AA contrast in both schemes (the reason `theme.ts` leaves Mantine `autoContrast` at its default
  off and resolves filled-control contrast itself), reduced-motion honored.
- **Security posture.** BYOK: the key is browser-held, sent only to Google, stored in plaintext
  `localStorage` only when the user opts in. CSP narrows the fetch surface. See the README's
  "BYOK & security posture" for the user-facing statement.
- **No em/en dashes in built static HTML** — enforced by `check-dashes.mjs` in `npm run build`
  (it scans `dist/` HTML, not React-rendered app copy).
- **Provenance.** The pure domain logic is ported from `nano-banana-2 @ 54e0224`; pricing in
  `models.ts` is a snapshot. The shipped public copy lives in `index.html` and the guide HTML and
  is the copy of record: its **public copy rules and claim guardrails** are in `CONTRIBUTING.md`
  ("Public copy rules"). Do not invent new public claims here.
