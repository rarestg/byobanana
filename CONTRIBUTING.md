# Contributing

How to work in this repo. It covers the rules that are actually enforced or observable here —
not general taste. For the shape of the code and the invariants you must not break, read
`ARCHITECTURE.md` first.

## Design system: Mantine-first

The app UI is built on [Mantine](https://mantine.dev). New UI should use Mantine components,
hooks, and the theme rather than hand-rolling equivalents of things Mantine already ships.

- `src/theme.ts` is the design system's home: the `workbench` teal primary, the zinc `dark`/`gray`
  neutral ladders, the `red` danger scale, the radius scale, and the `primaryShade` `{light:7,
  dark:4}`. Take spacing, radius, and color from the theme, not magic numbers.
- Contrast is handled deliberately. Mantine `autoContrast` is **off** because, with a
  `{light,dark}` `primaryShade`, it computes contrast off the wrong shade and fails WCAG AA on
  the accent. Filled-control text color is resolved by the theme's `variantColorResolver` via
  `--nb-primary-contrast` / `--nb-danger-contrast` (defined per scheme in `app.css`). If you add a
  filled variant in a new color, check its contrast in both schemes and extend that pattern
  rather than re-enabling `autoContrast`.
- Scheme-aware Mantine component corrections that **cannot** be expressed through theme variables
  live in `src/app.css`; keep them token-based and cover pre-initialized states where applicable.
  The SegmentedControl ring documents one such cascade exception, including why `:root:root`
  cannot be combined with `light-dark()`.

## Polish is intentional

Spacing and geometry here were tuned on purpose; match the surrounding tokens before and after a
change, and do not "clean up" values you have not measured. Load-bearing pieces:

- The **56px toolbar** height is a contract: the sticky inspector offsets by exactly 56px
  (`SessionView.module.css` vs `Workbench.module.css`). Changing one means changing the other.
- The **split-flap spend board** geometry (`SpendPill.module.css` + `flapMath.ts`) is exact — cell
  size, strip math, and roll/settle timing are coupled.
- **Header parity** between the static site and the app is deliberate: `Workbench.module.css`
  mirrors the `.byo-*` classes in `public/landing.css` (tag x-position, border and muted tokens,
  the tag's drop breakpoint) so the app header lines up with the landing header.
- The layout reserves space to avoid shift as state changes (loading gates, entering contact-sheet
  cells). Prefer reserving space over letting content jump.

When you touch UI, capture **screenshots in both light and dark** — that is part of review.
`npm run screenshot` drives a mock run and shoots every screen in both schemes into
`scripts/screenshots/`.

## Color schemes

Every surface ships light **and** dark. Two token layers coexist (see the static/Mantine boundary
in `ARCHITECTURE.md`): the static `--byo-*` tokens in `landing.css`, keyed off
`data-mantine-color-scheme`, and the Mantine `theme` in the app. The app page uses both (static
tokens set the pre-mount background, Mantine styles the mounted UI), but static CSS must never reach
for a Mantine runtime variable. Test both schemes. If you change a page's base tone, update the
matching `theme-color` metas.

## Public copy rules

This is the canonical home for the public-copy guardrails. The **shipped HTML is the copy of
record**: the crawlable, user-facing claims live in `index.html` and `public/guides/*/index.html`,
and those files are what must conform to the rules below. Do not invent new public claims.

- **No unqualified free / private / no-account claims.** BYOBanana itself has no account and no
  subscription, but generation spends the user's own Google API budget, so any "free" or "no cost"
  statement must be qualified. The qualifiers are **load-bearing**, not filler:
  - "Google API charges apply" (or equivalent) must accompany any free/no-account claim.
  - The plaintext-`localStorage` honesty is required: a remembered key is stored in plaintext that
    any same-origin script can read, and the UI and docs say so plainly. Never soften this into an
    unconditional privacy or security promise. The CSP is defense-in-depth, not a full egress lock.
- **No em/en dashes in the built static HTML** (literal or entity). `check-dashes.mjs` runs as the
  last step of `npm run build`, scans `dist/`, and fails the build on any hit. Rewrite with a
  colon, comma, or two sentences. (React-rendered app copy is not scanned, but follows the same
  house style.)

## Mock mode (harness-only)

There is **no Google API key in the dev/CI environment**, so the whole flow must stay exercisable
without one. The user-facing mock toggle was removed: without a validated key the app shows the
onboarding banner and gates Generate. Tests and browser harnesses use the invisible **`?mock=1`
query parameter** instead, which routes generation through the local mock runner (placeholder SVGs
plus synthesized usage/cost, no provider call, no charges) and **always wins over a validated key**,
so a harness can never spend real money. All screenshots and the automated drive-throughs load
`?mock=1`.

## Cost honesty

Generation spends the user's real money, so the cost UI must never overstate certainty (the full
rule set is in `ARCHITECTURE.md` cross-cutting). In short: never render an unknown cost as `$0`;
a folded ceiling keeps its `up to $X` qualifier in the spend popover and the accessible labels while
the pill face shows the bare folded number; `?mock=1` can never spend and always wins over a
validated key. Check `cost.status` before reaching for a number.

## Verifying your work (definition of done)

```sh
npm test           # vitest — ported core logic, grounding parser, UI drive-throughs
npm run build      # tsc --noEmit && vite build && site-url.mjs && the dash gate
```

Both must be green. For UI changes, also run the relevant real-browser harness (these need a real
Chromium via `npx playwright install chromium` and are not part of `npm test`):

```sh
npm run screenshot      # mock drive-through + axe, both schemes
npm run verify:tabs     # single-tab Web Locks guard
npm run verify:bfcache  # single-tab guard survives same-tab bfcache round trip (auto-uses xvfb)
npm run verify:idb      # persistence / interrupted-run recovery
# ...see package.json "verify:*" for the rest
```

`scripts/verify-live.mjs` has no shortcut on purpose: it bills a real Google key (see
`docs/manual-smoke-test.md`).

Known flake: `verify:p8` sometimes times out at its hover-zoom step (cause not found), so rerun it
before treating that as a regression.

Deploy (only when asked): `byobanana.com` runs the generated Worker, so deploy it with
`npm run deploy:worker`. Forks use the native `npm run deploy` (Workers Static Assets), which on the
author's account would replace the live Worker. See `docs/DEPLOYING.md` for the full guide,
including `SITE_URL` for forks.
