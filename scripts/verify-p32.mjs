// P32 round observation harness (real headless Chromium, ?mock=1). Confirms the four
// owner-decided changes on the spend pill + setup form:
//   (a) from click-Generate to first known dollars the pill shows a ROLLING flap board,
//       never the text "Calculating…";
//   (b) the board settles on the real mock total (glyphs == popover aggregate);
//   (c) the decimal card is the SAME width as a digit cell (getBoundingClientRect);
//   (d) no visible "up to" on the pill face; "up to" IS present in the opened popover;
//   (e) the setup form opens with Images selected by default.
// Screenshots: pill mid-roll, settled, and popover-open, in BOTH color schemes, into
// P32_SHOT_DIR (defaults to scripts/screenshots/p32/).
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
// Portable default; the round harness pointed P32_SHOT_DIR at its scratch shots dir.
const shotDir = process.env.P32_SHOT_DIR || join(root, "scripts", "screenshots", "p32");

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
    const child = spawn("npx", ["vite", "preview", "--port", "4331", "--strictPort"], { cwd: root });
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

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const boardValue = () => {
  const cells = [...document.querySelectorAll("[data-digit]")];
  if (cells.length === 0) return null;
  const s = cells.map((c) => c.dataset.digit).join("");
  return `$${s.slice(0, -2)}.${s.slice(-2)}`;
};

async function run(browser, url, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");

  // (e) Setup form opens with Images selected by default.
  const family = await page.evaluate(() => {
    const images = document.querySelector('input[type="radio"][value="image"]');
    const icons = document.querySelector('input[type="radio"][value="icon"]');
    return { imagesChecked: images?.checked ?? null, iconsChecked: icons?.checked ?? null };
  });
  check(
    "(e) setup form opens with Images selected by default",
    family.imagesChecked === true && family.iconsChecked === false,
    JSON.stringify(family),
  );

  // Install a from-click observer: record whether "Calculating…" ever appears and whether
  // a rolling board (unknown-roll OR committed data-digit roll) is ever seen.
  await page.evaluate(() => {
    window.__p32 = { calcSeen: false, unknownRollSeen: false, realRollSeen: false };
    const tick = () => {
      const pill = document.querySelector("[data-spend-pill]");
      if (pill) {
        if ((pill.textContent || "").includes("Calculating")) window.__p32.calcSeen = true;
        if (pill.querySelector('[class*="unknownBoard"] [class*="rolling"]'))
          window.__p32.unknownRollSeen = true;
        if ([...pill.querySelectorAll("[data-digit]")].some((c) => c.className.includes("rolling")))
          window.__p32.realRollSeen = true;
      }
      window.__p32.raf = requestAnimationFrame(tick);
    };
    tick();
  });

  // 6 variants slows the mock run so the rolling state is observable.
  await page.getByLabel("Variants per style").fill("6");
  await page.getByLabel("Subject prompt").fill("a friendly robot mascot holding a banana");
  await page.getByRole("button", { name: "Generate" }).click();

  // Wait until the board is live + rolling for the mid-roll screenshot.
  await page.waitForFunction(
    () =>
      document.querySelector('[data-spend-pill][data-live="true"]') !== null &&
      (document.querySelector('[data-spend-pill] [class*="unknownBoard"] [class*="rolling"]') !==
        null ||
        [...document.querySelectorAll("[data-digit]")].some((c) => c.className.includes("rolling"))),
    undefined,
    { timeout: 6000 },
  );
  const header = page.locator("[data-workbench-toolbar]");
  await header.screenshot({ path: join(shotDir, "pill-midroll-light.png") });

  // (a) No "Calculating…" text at any point; the UNKNOWN board specifically rolled before
  // dollars arrived (proving item 1's live-unknown path, not merely the real-board roll).
  const live = await page.evaluate(() => window.__p32);
  check("(a) no visible 'Calculating…' text from click to dollars", live.calcSeen === false);
  check("(a) unknown flap board rolled while dollars were still unknown", live.unknownRollSeen === true);
  check("(a) real board rolled once dollars arrived (Mode A)", live.realRollSeen === true);

  // Wait for the run to finish and settle.
  await page.waitForFunction(
    () => document.querySelector('[data-spend-pill][data-live="true"]') === null,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-digit]")].every((c) => !c.className.includes("rolling")),
    undefined,
    { timeout: 5000 },
  );
  await page.waitForTimeout(1700);
  await page.evaluate(() => cancelAnimationFrame(window.__p32.raf));

  const settled = await page.evaluate(boardValue);
  check("(b) board settled onto a real dollar total", /^\$\d+\.\d\d$/.test(settled ?? ""), settled ?? "null");
  await header.screenshot({ path: join(shotDir, "pill-settled-light.png") });

  // (c) Decimal card width == digit card width (getBoundingClientRect).
  const widths = await page.evaluate(() => {
    const digit = document.querySelector("[data-digit]");
    const dot = document.querySelector('[data-spend-pill] [class*="dotcell"]');
    return {
      digit: digit ? digit.getBoundingClientRect().width : null,
      dot: dot ? dot.getBoundingClientRect().width : null,
    };
  });
  check(
    "(c) decimal card width equals digit card width",
    widths.digit !== null && widths.dot !== null && Math.abs(widths.digit - widths.dot) < 0.5,
    `digit=${widths.digit} dot=${widths.dot}`,
  );

  // (d) No visible "up to" on the pill face.
  const faceHasUpTo = await page.evaluate(() =>
    (document.querySelector("[data-spend-pill]")?.textContent || "").includes("up to"),
  );
  check("(d) pill face shows NO visible 'up to'", faceHasUpTo === false);

  // (d) Open the popover; "up to" IS present, and the total line matches the board.
  await page.locator("[data-spend-pill]").click();
  const popoverTotal = await page.locator("text=/^Total spend: up to \\$/").first().textContent();
  check(
    "(d) opened popover keeps 'up to' and equals the board total",
    popoverTotal === `Total spend: up to ${settled}`,
    `${popoverTotal} vs up to ${settled}`,
  );
  await page.screenshot({ path: join(shotDir, "popover-light.png") });
  await page.keyboard.press("Escape");

  // Dark scheme: settled pill + popover.
  await page.evaluate(() => document.documentElement.setAttribute("data-mantine-color-scheme", "dark"));
  await page.waitForTimeout(250);
  await header.screenshot({ path: join(shotDir, "pill-settled-dark.png") });
  await page.locator("[data-spend-pill]").click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shotDir, "popover-dark.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.documentElement.setAttribute("data-mantine-color-scheme", "light"));

  await context.close();
}

// A dark mid-roll screenshot from a fresh run (the light run already settled).
async function darkMidRoll(browser, url, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");
  await page.evaluate(() => document.documentElement.setAttribute("data-mantine-color-scheme", "dark"));
  await page.getByLabel("Variants per style").fill("6");
  await page.getByLabel("Subject prompt").fill("a calm robot at night");
  await page.getByRole("button", { name: "Generate" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-spend-pill][data-live="true"]') !== null &&
      (document.querySelector('[data-spend-pill] [class*="unknownBoard"] [class*="rolling"]') !==
        null ||
        [...document.querySelectorAll("[data-digit]")].some((c) => c.className.includes("rolling"))),
    undefined,
    { timeout: 6000 },
  );
  await page.locator("[data-workbench-toolbar]").screenshot({ path: join(shotDir, "pill-midroll-dark.png") });
  await context.close();
}

mkdirSync(shotDir, { recursive: true });
const { child, url } = await startPreview();
const chromium = loadChromium();
const browser = await chromium.launch();
const errors = [];
try {
  await run(browser, url, errors);
  await darkMidRoll(browser, url, errors);
} finally {
  await browser.close();
  child.kill();
}
check("zero console errors", errors.length === 0, errors.join(" | "));
console.log(failures === 0 ? "\nP32 verify: ALL PASS" : `\nP32 verify: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
