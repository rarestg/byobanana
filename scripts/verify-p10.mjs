// P10 (feedback round 3) behavioral verification in a REAL headless Chromium (Playwright).
// Covers items 2-5 of the batch (item 1, multi-tab takeover, is covered by verify-tabs.mjs):
//   2. History rail has no refresh button; entries get the full rail width.
//   3. Hover-zoom magnification is anchored to natural pixels — the SAME backgroundSize/natural
//      ratio for the SAME natural size across different panel sizes/viewports (1085px vs 1600px),
//      AND correctly DIFFERENT magnification for different natural sizes at the SAME displayed
//      size (512px vs 2K source). See stageZoomRatio's own comment for why a literal "1600px vs
//      ~900px stacked layout" comparison (the original framing) is infeasible in this app: the
//      inspector's displayed preview size is binary (fixed ~302px in the two-column layout, or
//      near-edge-to-edge once the layout stacks below 1080px with no room left for the panel at
//      all) — these are the two axes that ARE independently reachable.
//   4. "Style recipe and full prompt" widens well past the old 64ch cap when space allows.
//   5. The contact-sheet region's left edge lines up with the padded content of the stacked
//      inspector card below it (RunSummary/SetupForm are NOT valid comparisons — see
//      stagePaddingAlignment's own comment for why).
// Screenshots (light + dark) land in scripts/screenshots/p10/.
//
// Run:  node scripts/verify-p10.mjs   (requires a prior `npm run build`)
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outDir = join(root, "scripts", "screenshots", "p10");
mkdirSync(outDir, { recursive: true });

function loadChromium() {
  const roots = [];
  const npxCache = join(homedir(), ".npm", "_npx");
  if (existsSync(npxCache)) for (const e of readdirSync(npxCache)) roots.push(join(npxCache, e, "node_modules"));
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      return require(spec).chromium;
    } catch {
      /* next */
    }
    for (const r of roots) {
      try {
        return createRequire(join(r, "index.js"))(spec).chromium;
      } catch {
        /* next */
      }
    }
  }
  console.error("Playwright missing. Run `npx playwright install chromium`.");
  process.exit(2);
}

function startPreview() {
  return new Promise((resolve, reject) => {
    // detached so we can kill the whole process group on cleanup — `npx` otherwise leaves the
    // actual `vite` grandchild (and the port) alive after a plain SIGTERM to the wrapper.
    const child = spawn("npx", ["vite", "preview", "--port", "4323", "--strictPort"], {
      cwd: root,
      detached: true,
    });
    let url = "";
    const onData = (buf) => {
      const m = /http:\/\/localhost:(\d+)\//.exec(buf.toString());
      if (m && !url) {
        url = `http://localhost:${m[1]}/`;
        resolve({ child, url });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (c) => reject(new Error(`vite preview exited ${c}`)));
    setTimeout(() => reject(new Error("preview did not start")), 30_000);
  });
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

// Drive a mock run to a succeeded candidate so the contact sheet + inspector are populated.
// `resolution`, when given (e.g. "512px", "2K"), sets the Resolution select before generating —
// used by stageZoomRatio to vary the generated image's NATURAL size independent of viewport.
async function driveRun(page, url, viewport, resolution) {
  await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
  await page.setViewportSize(viewport);
  await page.waitForSelector("text=Set up a run");
  if (resolution) {
    // "Reference images and settings" starts EXPANDED (SetupForm's useDisclosure(true)) — no
    // click needed. getByLabel also (spuriously) matches the (closed, empty) options listbox
    // that shares the same aria-labelledby — the actual <input role="combobox"> is always first.
    // The default model (NB 2 Lite) only offers "1K" — switch to the full-range model first so
    // 512px/2K are actually selectable.
    await page.getByLabel("Model").first().click();
    await page.getByRole("option", { name: /Nano Banana 2 ·/ }).click();
    await page.getByLabel("Resolution").first().click();
    await page.getByRole("option", { name: resolution }).click();
  }
  await page.getByLabel("Subject prompt").fill("a friendly robot mascot holding a banana");
  await page.getByRole("button", { name: "Generate" }).click();
  await page.waitForFunction(
    () => {
      const statuses = [...document.querySelectorAll('[role="status"]')];
      return statuses.some((el) => {
        const t = el.textContent ?? "";
        return t.includes("succeeded") && !t.includes("running") && !t.includes("queued");
      });
    },
    undefined,
    { timeout: 20_000 },
  );
}

async function stageLayout(browser, url, errors, scheme) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await driveRun(page, url, { width: 1600, height: 1000 });

  // --- Item 2: history rail — no refresh button, full-width entries -----------------------
  await page.getByRole("button", { name: /^History/ }).click();
  await page.waitForSelector("text=No workbench sessions yet.", { state: "detached" }).catch(() => {});
  const refreshCount = await page.getByRole("button", { name: "Refresh history" }).count();
  check(`[${scheme}] history rail has no refresh button`, refreshCount === 0);
  await page.screenshot({ path: join(outDir, `history-rail-${scheme}.png`) });
  await page.getByRole("button", { name: /^History/ }).click(); // close nav

  // --- Item 4: widened prompt -------------------------------------------------------------
  await page.locator("summary", { hasText: "Style recipe and full prompt" }).first().click();
  const promptBox = await page.locator("pre").first().boundingBox();
  // Measure the ch unit IN THE <pre>'s OWN font context (browsers default <pre> to monospace,
  // distinct from the page's sans-serif UI font) — ch is spec'd as the width of the "0" glyph.
  const chPx = await page.locator("pre").first().evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.cssText = `position:absolute;visibility:hidden;font:${getComputedStyle(el).font};`;
    probe.textContent = "0";
    document.body.appendChild(probe);
    const px = probe.getBoundingClientRect().width;
    probe.remove();
    return px;
  });
  check(
    `[${scheme}] prompt block reaches the P14 min(100%, 114ch) cap at this viewport`,
    Boolean(promptBox && promptBox.width > 110 * chPx),
    `promptBox=${JSON.stringify(promptBox)}, 110ch=${(110 * chPx).toFixed(1)}px, 114ch=${(114 * chPx).toFixed(1)}px`,
  );
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  check(`[${scheme}] no horizontal page scroll from the widened prompt`, scrollWidth <= 1600 + 1, `scrollWidth=${scrollWidth}`);
  await page.screenshot({ path: join(outDir, `prompt-width-${scheme}.png`), fullPage: false });

  await context.close();
}

// Item 5, below the 1080px results-layout breakpoint where the sticky inspector drops to
// `position: static` and stacks BELOW the contact sheet, both full-width children of the same
// grid track. RunSummary/SetupForm are NOT a valid comparison here: they're `maw={880} mx="auto"`
// flex items, and auto margins make a flex item shrink-to-fit its content instead of stretching
// (align-items: stretch loses to explicit auto margins per the flexbox spec) — so they center at
// whatever width their content needs and are not generally edge-comparable. The inspector's own
// Paper (p="md", no maw/mx) IS genuinely full-width, making it the one legitimate "card below" to
// compare the contact sheet's new padding-inline against.
async function stagePaddingAlignment(browser, url, errors, scheme) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 }, colorScheme: scheme });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await driveRun(page, url, { width: 900, height: 1200 });
  const armTitle = await page.locator('[id^="arm-"]').first().boundingBox();
  const inspectorText = await page.getByText("Select a candidate to inspect it.").boundingBox();
  const aligned = Boolean(armTitle && inspectorText && Math.abs(armTitle.x - inspectorText.x) <= 2);
  check(
    `[${scheme}] contact-sheet left edge matches the stacked inspector card's padded content`,
    aligned,
    JSON.stringify({ armTitle: armTitle?.x, inspectorText: inspectorText?.x }),
  );
  await page.screenshot({ path: join(outDir, `padding-alignment-${scheme}.png`), fullPage: true });
  await context.close();
}

// Item 3: the zoom's natural-pixel scale (bgW / natural width) must not depend on the DISPLAYED
// preview size — only on the source's natural resolution and the panel size.
//
// A structural finding while building this check (unrelated to the P10 fix, pre-existing P8/P9
// placement logic, deliberately left untouched — see the brief's "Keep: left-preferred
// placement"): the inspector's image column is EITHER a fixed 336px (results layout >=1080px,
// so the displayed preview is a constant ~302px regardless of how wide the window is) OR, below
// the 1080px breakpoint, the layout stacks to a single column and the preview grows to fill
// nearly the full width edge-to-edge — leaving under 10px of gutter on either side, well under
// the placement algorithm's own 200px minimum. So the magnifier never has room to open AT ALL in
// the stacked layout, at any narrow width — there is no real viewport where "big monitor, small
// preview" and "narrow window, large preview" can be compared side by side with the panel visible
// in both. This check instead exercises the two axes that ARE independently reachable in the
// live app, matching what the unit tests already prove in isolation (zoomScale.test.ts):
//   A) SAME viewport, DIFFERENT natural size (512px vs 2K/2048px Resolution setting) — the
//      inspector column is fixed, so the DISPLAYED size is identical in both; the magnification
//      must still differ, scaling with the natural resolution (proves natural-anchoring: the old
//      dispW-only formula would have produced the SAME bgW for both, blind to resolution).
//   B) DIFFERENT viewport (1085px vs 1600px, both >=1080px so the column stays fixed and the
//      panel remains visible), SAME natural size — the panel's OWN size legitimately varies with
//      viewport (`round(innerWidth * 0.3)`, clamped), but the ratio (bgW / naturalWidth) must stay
//      IDENTICAL — proving the magnification feel is independent of viewport/panel size.
async function stageZoomRatio(browser, url, errors) {
  async function zoomGeometry(viewport, resolution) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await driveRun(page, url, viewport, resolution);
    await page.locator("[data-candidate] button").first().click();
    await page.waitForSelector("text=Status and cost");
    // "Status and cost" renders for ANY focused candidate, even one still queued/running (no
    // image yet) — wait for the actual succeeded preview to attach before measuring it.
    const preview = page.locator('img[alt^="Generated"]').last();
    await preview.waitFor({ state: "attached", timeout: 20_000 });
    const box = await preview.boundingBox();
    await preview.hover({ position: { x: box.width / 2, y: box.height / 2 } });
    const panel = page.locator('[data-testid="zoom-panel"]');
    await panel.waitFor({ state: "visible", timeout: 5000 });
    const geometry = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="zoom-panel"]');
      const img = [...document.querySelectorAll('img[alt^="Generated"]')].pop();
      return {
        bgSize: el.style.backgroundSize,
        panelWidth: el.getBoundingClientRect().width,
        naturalWidth: img.naturalWidth,
        displayedWidth: img.getBoundingClientRect().width,
      };
    });
    await context.close();
    const bgW = parseFloat(geometry.bgSize.split(" ")[0]);
    return { ...geometry, bgW, ratio: bgW / geometry.naturalWidth };
  }

  // A) same viewport, different NATURAL size.
  const small = await zoomGeometry({ width: 1600, height: 1000 }, "512px");
  const large = await zoomGeometry({ width: 1600, height: 1000 }, "2K");
  console.log("zoom geometry (512px source):", JSON.stringify(small));
  console.log("zoom geometry (2K source):", JSON.stringify(large));
  check(
    "same displayed preview size for both natural sizes (the inspector column is fixed-width)",
    small.displayedWidth === large.displayedWidth,
    `512px displayedWidth=${small.displayedWidth}, 2K displayedWidth=${large.displayedWidth}`,
  );
  check(
    "magnification (bgW) scales with the NATURAL source size, not just the display size",
    large.bgW > small.bgW * 1.5,
    `512px bgW=${small.bgW}, 2K bgW=${large.bgW}`,
  );

  // B) different viewport (different panel size), same natural size.
  const narrowViewport = await zoomGeometry({ width: 1085, height: 1000 }, "1K");
  const wideViewport = await zoomGeometry({ width: 1600, height: 1000 }, "1K");
  console.log("zoom geometry (1085px viewport):", JSON.stringify(narrowViewport));
  console.log("zoom geometry (1600px viewport):", JSON.stringify(wideViewport));
  check(
    "panel size differs between viewports (the axis this half of the check varies)",
    narrowViewport.panelWidth !== wideViewport.panelWidth,
    `1085px panelWidth=${narrowViewport.panelWidth}, 1600px panelWidth=${wideViewport.panelWidth}`,
  );
  check(
    "zoom natural-pixel scale (bgW / naturalWidth) is IDENTICAL across viewports/panel sizes",
    Math.abs(narrowViewport.ratio - wideViewport.ratio) < 1e-6,
    `1085px ratio=${narrowViewport.ratio}, 1600px ratio=${wideViewport.ratio}`,
  );
}

async function main() {
  const chromium = loadChromium();
  const { child: preview, url } = await startPreview();
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    await stageLayout(browser, url, errors, "light");
    await stageLayout(browser, url, errors, "dark");
    await stagePaddingAlignment(browser, url, errors, "light");
    await stagePaddingAlignment(browser, url, errors, "dark");
    await stageZoomRatio(browser, url, errors);
  } finally {
    await browser.close();
    try {
      process.kill(-preview.pid, "SIGKILL"); // whole detached group: npx wrapper + vite child
    } catch {
      preview.kill("SIGKILL");
    }
  }
  check("zero console errors", errors.length === 0, errors.join(" | "));
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length === 0 ? "\nPASS: all P10 layout checks green" : `\nFAIL: ${failed.length} check(s) failed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
