// P8 behavioral verification in a REAL headless Chromium (Playwright): the API-key
// onboarding banner flow, the harness mock gate, the spend-pill run animation, the history
// count bubble, and the inspector hover-zoom.
//
// No key and no billing: the zero-cost GET /v1beta/models validation call is intercepted
// and fulfilled with a fake model list, and the generation run uses the ?mock=1 gate.
//
// Run:  node scripts/verify-p8.mjs   (requires a prior `npm run build`)
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

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
    const child = spawn("npx", ["vite", "preview", "--port", "4322", "--strictPort"], { cwd: root });
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

const FAKE_MODELS = {
  models: [
    { name: "models/gemini-3.1-flash-image" },
    { name: "models/gemini-3.1-flash-lite-image" },
    { name: "models/gemini-3-pro-image" },
  ],
};

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function interceptModels(context) {
  await context.route("**/v1beta/models*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FAKE_MODELS) }),
  );
}

// Stage A: onboarding banner → inline validate → banner flies away → pill flashes.
async function stageBanner(browser, url, errors, { reducedMotion }) {
  const label = reducedMotion ? " (reduced motion)" : "";
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await interceptModels(context);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${url}app/`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=First things first");
  check(`banner visible with no key${label}`, true);

  const generate = page.getByRole("button", { name: "Generate" });
  // The form is inert: its content is not reachable (getByRole with inert subtree fails),
  // so probe the DOM directly.
  const inert = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Set up a run");
    return Boolean(heading?.closest("[inert]"));
  });
  check(`setup form inert behind the banner${label}`, inert);

  await page.getByLabel("Google API key").fill("AIza-p8-verify");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("text=First things first", { state: "detached", timeout: 5000 });
  check(`banner dismissed after validation${label}`, true);

  const pillFlash = await page.evaluate(() => {
    const pill = document.getElementById("nb-key-pill");
    return Boolean(pill && /pillFlash/.test(pill.className) && /API key configured/.test(pill.textContent ?? ""));
  });
  check(`key pill flashes and reads configured${label}`, pillFlash);

  const uninert = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Set up a run");
    return heading ? heading.closest("[inert]") === null : false;
  });
  check(`setup form interactive after validation${label}`, uninert);
  check(`Generate enabled after validation${label}`, await generate.isEnabled());

  await context.close();
}

// Stage B (?mock=1): run → spend pill animates while live and calms after → history bubble →
// hover-zoom on the inspector preview.
async function stageRun(browser, url, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");
  check("?mock=1 suppresses the banner", (await page.locator("text=First things first").count()) === 0);

  // Slow the mock run down a touch by using 4 variants so the live-animation state is
  // observable, then generate.
  await page.getByRole("button", { name: /Reference images and settings/ }).click(); // collapse
  const chips = await page.getByTestId("settings-chips").textContent();
  check(
    "collapsed settings chips show defaults",
    /NB 2 Lite/.test(chips) && /1K/.test(chips) && /1:1/.test(chips) && /2 variants/.test(chips) && /No references/.test(chips),
    chips.trim(),
  );
  await page.getByRole("button", { name: /Reference images and settings/ }).click(); // expand
  await page.getByLabel("Variants per style").fill("4");

  await page.getByLabel("Subject prompt").fill("a friendly robot mascot holding a banana");
  await page.getByRole("button", { name: "Generate" }).click();
  // While the run is live the spend pill carries the live-state marker (P12: the pill
  // is no longer a Mantine Badge — data-spend-pill/data-live are the stable hooks).
  const activeDuringRun = await page
    .waitForFunction(() => document.querySelector('[data-spend-pill][data-live="true"]') !== null, undefined, {
      timeout: 3000,
    })
    .then(() => true)
    .catch(() => false);
  check("spend pill animates during the run", activeDuringRun);

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
  await page.waitForTimeout(300);
  const activeAfterRun = await page.evaluate(
    () => document.querySelector('[data-spend-pill][data-live="true"]') !== null,
  );
  check("spend pill calm after the run", !activeAfterRun);

  // History bubble: one stored run.
  const burgerLabel = await page.getByRole("button", { name: /^History/ }).getAttribute("aria-label");
  check("history bubble label counts the stored run", burgerLabel === "History, 1 run", String(burgerLabel));

  // Inspector hover-zoom.
  await page.locator("[data-candidate] button").first().click();
  await page.waitForSelector("text=Status and cost");
  const preview = page.locator('img[alt^="Generated"]').last();
  await preview.hover({ position: { x: 150, y: 150 } });
  const panel = page.locator('[data-testid="zoom-panel"]');
  await panel.waitFor({ state: "visible", timeout: 3000 });
  const geometry = await page.evaluate(() => {
    const zoomEl = document.querySelector('[data-testid="zoom-panel"]');
    const imgs = [...document.querySelectorAll('img[alt^="Generated"]')];
    const img = imgs[imgs.length - 1];
    if (!zoomEl || !img) return null;
    const z = zoomEl.getBoundingClientRect();
    const i = img.getBoundingClientRect();
    return {
      leftOfImage: z.right <= i.left,
      inViewport: z.left >= 0 && z.top >= 0 && z.right <= window.innerWidth && z.bottom <= window.innerHeight,
    };
  });
  check("zoom panel visible left of the inspector image, inside the viewport", Boolean(geometry?.leftOfImage && geometry?.inViewport), JSON.stringify(geometry));

  // Leaving the image hides the panel immediately.
  await page.getByRole("heading", { name: /style/ }).first().hover();
  await panel.waitFor({ state: "detached", timeout: 2000 });
  check("zoom panel gone on pointer leave", true);

  await context.close();
}

async function main() {
  const chromium = loadChromium();
  const { child: preview, url } = await startPreview();
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    await stageBanner(browser, url, errors, { reducedMotion: false });
    await stageBanner(browser, url, errors, { reducedMotion: true });
    await stageRun(browser, url, errors);
  } finally {
    await browser.close();
    preview.kill("SIGTERM");
  }
  check("zero console errors", errors.length === 0, errors.join(" | "));
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length === 0 ? "\nPASS: all P8 behavioral checks green" : `\nFAIL: ${failed.length} check(s) failed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
