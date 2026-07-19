// Render scripts/og-card.html to public/og.png (exactly 1200x630) with headless Chromium.
//
// The Open Graph image is a build artifact but committed (reproducible social preview). Run:
//   node scripts/build-og.mjs
// Requires a Playwright Chromium (npx playwright install chromium) and a prior `npm i`.
// Shares the Chromium-discovery shim with scripts/screenshot.mjs.
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function loadChromium() {
  const roots = [];
  const npxCache = join(homedir(), ".npm", "_npx");
  if (existsSync(npxCache)) {
    for (const entry of readdirSync(npxCache)) roots.push(join(npxCache, entry, "node_modules"));
  }
  for (const specifier of ["playwright", "playwright-core"]) {
    try {
      return require(specifier).chromium;
    } catch {
      /* discovered roots next */
    }
    for (const r of roots) {
      try {
        return createRequire(join(r, "index.js"))(specifier).chromium;
      } catch {
        /* next */
      }
    }
  }
  console.error("Playwright missing. Run `npx playwright install chromium`.");
  process.exit(2);
}

const out = join(root, "public", "og.png");
const cardUrl = new URL("file://" + join(root, "scripts", "og-card.html")).href;

const chromium = loadChromium();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(cardUrl, { waitUntil: "networkidle" });
  // Clip to exactly the 1200x630 card so the PNG dimensions are guaranteed.
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log(`Wrote ${out}`);
} finally {
  await browser.close();
}
