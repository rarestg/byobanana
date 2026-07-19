// Full-app visual + a11y drive-through in a REAL headless Chromium (Playwright).
//
// Builds the app, serves the production bundle with `vite preview`, then drives a MOCK run
// (no API key needed) and screenshots every screen in BOTH color schemes. Also runs axe-core
// against the key screens and prints violations. Screenshots land in scripts/screenshots/.
//
// Run:  node scripts/screenshot.mjs           (build + preview + shoot both schemes + axe)
//       node scripts/screenshot.mjs --no-build (reuse an existing dist/)
// Requires a Playwright Chromium (npx playwright install chromium) and a prior `npm i`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outDir = join(root, "scripts", "screenshots");
const axeSource = readFileSync(join(root, "node_modules", "axe-core", "axe.min.js"), "utf8");

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

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// Start `vite preview`, resolve once it prints its Local URL.
function startPreview() {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["vite", "preview", "--port", "4319", "--strictPort"], { cwd: root });
    let url = "";
    const onData = (buf) => {
      const text = buf.toString();
      process.stdout.write(text);
      const match = /http:\/\/localhost:(\d+)\//.exec(text);
      if (match && !url) {
        url = `http://localhost:${match[1]}/`;
        resolve({ child, url });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`vite preview exited ${code}`)));
    setTimeout(() => reject(new Error("vite preview did not start in time")), 30_000);
  });
}

async function runAxe(page, label, violationsAll) {
  await page.evaluate(axeSource);
  const results = await page.evaluate(async () => {
    // WCAG 2.2 AA-relevant rule sets.
    return await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
  });
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    help: v.help,
    targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")),
    summaries: v.nodes.slice(0, 4).map((n) => (n.failureSummary || "").replace(/\s+/g, " ").slice(0, 200)),
    html: v.nodes.slice(0, 4).map((n) => (n.html || "").slice(0, 160)),
  }));
  violationsAll.push({ label, violations });
  const tag = violations.length === 0 ? "clean" : `${violations.length} rule(s)`;
  console.log(`  axe[${label}]: ${tag}`);
  for (const v of violations) {
    console.log(`    - ${v.id} (${v.impact}, ${v.nodes} node/s): ${v.help}`);
    for (const t of v.targets) console.log(`        @ ${t}`);
  }
}

async function driveScheme(browser, url, scheme, violationsAll) {
  const dir = join(outDir, scheme);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: scheme,
  });
  // Force the app's stored color scheme before any page script runs (theme-init.js reads it).
  await context.addInitScript((value) => {
    try {
      window.localStorage.setItem("mantine-color-scheme-value", value);
    } catch {
      /* ignore */
    }
  }, scheme);
  const page = await context.newPage();
  const shot = (name) => page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`  [console.error] ${msg.text()}`);
  });

  // 0. Onboarding banner (no key, no mock param): the two-column key card + greyed/inert setup
  // form. Default persistence is "This session only".
  await page.goto(`${url}app/`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=First things first");
  await shot("00-onboarding-banner");
  await runAxe(page, `${scheme}/onboarding`, violationsAll);

  // 0b. The other segmented option: pick "Remember" (click the visible label — the underlying
  // radio has zero dimensions), let the ~200ms indicator transition settle, and shoot the
  // disclosure caption.
  await page.getByText("Remember", { exact: true }).click();
  await page.waitForSelector("text=Avoid on shared computers");
  await page.waitForTimeout(250);
  await shot("00b-onboarding-remember");

  // 0c. Narrow/stacked layout (below the sm breakpoint the two columns collapse to one). Reuse
  // THIS page — a second same-origin page would take the single-tab Web Lock and render the
  // "open in another tab" banner over the card. Reset to "This session only", shrink to 560px,
  // shoot, then restore the desktop width for the rest of the drive-through.
  await page.getByText("This session only", { exact: true }).click();
  await page.waitForSelector("text=reloading or closing this tab");
  await page.waitForTimeout(250);
  await page.setViewportSize({ width: 560, height: 900 });
  await page.waitForTimeout(150);
  await shot("00c-onboarding-narrow");
  await page.setViewportSize({ width: 1280, height: 900 });

  // The rest of the drive-through uses the harness mock gate (?mock=1): no key, no banner,
  // generation runs through the local mock runner.
  await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");

  // 1. Setup form — empty state.
  await shot("01-setup-empty");
  await runAxe(page, `${scheme}/setup`, violationsAll);

  // 1b. Icon family: the icon background control, enabled beside a styled recipe and
  // disabled (anchored in place) when Custom icon is the only selection. Mantine's
  // SegmentedControl hides its radio inputs, so click the visible label text.
  await page.getByText("Icons", { exact: true }).click();
  await page.waitForSelector("text=Icon background");
  await shot("01b-setup-icons");
  await runAxe(page, `${scheme}/setup-icons`, violationsAll);
  await page.getByRole("checkbox", { name: /Custom icon/ }).click();
  await page.waitForSelector("text=Background not used in Custom mode.");
  await shot("01c-setup-icons-custom");
  await page.getByText("Images", { exact: true }).click();
  await page.waitForSelector("text=Icon background", { state: "detached" });

  // 2. Key modal.
  await page.getByRole("button", { name: /API key/ }).first().click();
  await page.waitForSelector("text=Bring your own Google API key");
  await page.waitForTimeout(400); // let the modal fade-in transition settle before the shot
  await shot("02-key-modal");
  await runAxe(page, `${scheme}/key-modal`, violationsAll);
  await page.keyboard.press("Escape");
  await page.waitForSelector("text=Bring your own Google API key", { state: "detached" });

  // 2b. Collapsed settings bar with summary chips.
  await page.getByRole("button", { name: /Reference images and settings/ }).click();
  await page.waitForSelector('[data-testid="settings-chips"]');
  await shot("03-settings-chips");
  await page.getByRole("button", { name: /Reference images and settings/ }).click();

  // Add a second style recipe so the contact sheet shows a comparison (2 styles × 4 = 8 cards).
  const recipeCards = page.locator('[role="checkbox"]');
  const recipeCount = await recipeCards.count();
  if (recipeCount > 1) {
    // Click the second recipe card (first is already selected by default).
    await recipeCards.nth(1).click().catch(() => {});
  }

  // 3. Fill subject + generate.
  await page.getByLabel("Subject prompt").fill("a friendly robot mascot holding a banana");
  const progressShot = shot("04-contact-progress"); // fire immediately after submit
  await page.getByRole("button", { name: "Generate" }).click();
  await progressShot.catch(() => {});
  // Screenshot the in-flight sheet (queued/running visible) as soon as cards mount.
  await page.waitForSelector("[data-candidate]", { timeout: 10_000 }).catch(() => {});
  await shot("04b-contact-progress");

  // 4. Wait for the run to finish (progress line reports 0 running/queued). There can be
  // more than one role=status element (the recipe picker has a live region) — check them all.
  await page
    .waitForFunction(
      () => {
        return [...document.querySelectorAll('[role="status"]')].some((el) => {
          const t = el.textContent ?? "";
          return t.includes("succeeded") && !t.includes("running") && !t.includes("queued");
        });
      },
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(400); // let images decode
  await shot("05-run-complete");
  await runAxe(page, `${scheme}/results`, violationsAll);

  // 5. Inspector — click the first candidate.
  const firstCard = page.locator("[data-candidate] button").first();
  await firstCard.click();
  await page.waitForSelector("text=Status and cost");
  await page.waitForTimeout(200);
  await shot("06-inspector");
  await runAxe(page, `${scheme}/inspector`, violationsAll);

  // 5b. Hover-zoom magnifier over the inspector preview. VIEWPORT shot, not fullPage — a
  // fullPage capture scrolls the page, which (by design) hides the zoom panel.
  const preview = page.locator('img[alt^="Generated"]').last();
  await preview.hover({ position: { x: 150, y: 150 } }).catch(() => {});
  const zoomVisible = await page
    .waitForSelector('[data-testid="zoom-panel"]', { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (zoomVisible) await page.screenshot({ path: join(dir, "06b-inspector-zoom.png") });
  await page.mouse.move(10, 10); // leave — the panel must vanish before later shots

  // 6. Export tray — select two candidates for export.
  const checkboxes = page.locator('[data-candidate] input[type="checkbox"]');
  const cbCount = await checkboxes.count();
  if (cbCount > 0) await checkboxes.nth(0).check().catch(() => {});
  if (cbCount > 1) await checkboxes.nth(1).check().catch(() => {});
  await page.waitForSelector("text=/selected for export/").catch(() => {});
  await page.waitForTimeout(150);
  await shot("07-export-tray");

  // 7. History rail — open the overlay Drawer (P17; the burger label carries the run count).
  await page.getByRole("button", { name: /^History/ }).click();
  await page.waitForSelector("#history-navbar");
  await page.waitForTimeout(250);
  await shot("08-history-rail");
  // Close the Drawer before touching the toolbar again — its overlay intercepts clicks.
  await page.keyboard.press("Escape");
  await page.waitForSelector("#history-navbar", { state: "detached" }).catch(() => {});

  // 8. Spend popover.
  const spend = page.getByRole("button", { name: /stored runs spend|Open breakdown/ });
  if (await spend.count()) {
    await spend.first().click();
    await page.waitForTimeout(250);
    await shot("09-spend-popover");
  }

  // 9. Icon export suite: a fresh mock ICON run so the inspector shows the circular split
  // button (primary 512) and its size menu (full resolution / 256px / complete suite ZIP).
  await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");
  await page.getByText("Icons", { exact: true }).click();
  await page.waitForSelector("text=Icon background");
  await page.getByLabel("Subject prompt").fill("a friendly robot mascot holding a banana");
  await page.getByRole("button", { name: "Generate" }).click();
  await page
    .waitForFunction(
      () => {
        return [...document.querySelectorAll('[role="status"]')].some((el) => {
          const t = el.textContent ?? "";
          return t.includes("succeeded") && !t.includes("running") && !t.includes("queued");
        });
      },
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(400);
  await page.locator("[data-candidate] button").first().click();
  await page.waitForSelector("text=Status and cost");
  await page.waitForTimeout(200);
  await shot("10-icon-inspector");
  await runAxe(page, `${scheme}/icon-inspector`, violationsAll);

  // 9b. The open size menu. VIEWPORT shot — the portaled dropdown is positioned against the
  // current scroll, which a fullPage capture would fake out.
  await page.getByRole("button", { name: "More circular icon sizes" }).click();
  await page.waitForSelector('[role="menuitem"]');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(dir, "10b-icon-export-menu.png") });
  await page.keyboard.press("Escape");

  await context.close();
}

async function main() {
  const noBuild = process.argv.includes("--no-build");
  if (!noBuild) {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
    await run("npm", ["run", "build"]);
  }
  const chromium = loadChromium();
  const { child: preview, url } = await startPreview();
  const browser = await chromium.launch({ headless: true });
  const violationsAll = [];
  try {
    for (const scheme of ["light", "dark"]) {
      console.log(`\n=== ${scheme} ===`);
      await driveScheme(browser, url, scheme, violationsAll);
    }
  } finally {
    await browser.close();
    preview.kill("SIGTERM");
  }

  const total = violationsAll.reduce((n, r) => n + r.violations.length, 0);
  console.log(`\n=== axe summary: ${total} violation rule(s) across ${violationsAll.length} screens ===`);
  const reportPath = join(outDir, "axe-report.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(reportPath, JSON.stringify(violationsAll, null, 2));
  console.log(`Screenshots written to ${outDir}`);
  console.log(`Full axe report: ${reportPath}`);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
