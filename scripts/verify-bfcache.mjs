// bfcache single-tab regression (P37) in a REAL Chromium. The single-tab guard (useSingleTab.ts)
// holds a Web Lock for the document's lifetime via an unresolved promise, relying on document
// teardown to free it. But a same-tab navigation AWAY from /app/ (e.g. clicking the navbar logo
// back to the landing page) does NOT tear the document down — Chromium can freeze it in the
// back/forward cache with the lock STILL HELD. A later /app/ load in the same tab then probes a
// lock its own frozen predecessor holds (ifAvailable -> null) and falsely reports "another tab".
// The fix releases the lock on `pagehide` and re-arbitrates on `pageshow` when restored
// (`persisted`). This script drives the exact same-tab round trip and asserts step 4 stays
// PRIMARY (no banner). Pre-fix it showed the banner 3/3.
//
// Two things make bfcache hard to exercise under automation, both handled here:
//   1. bfcache needs a HEADED browser — Playwright's default headless attaches CDP in a way that
//      keeps bfcache disabled. So this script relaunches itself under `xvfb-run` if there is no
//      DISPLAY, and launches Chromium headed with bfcache re-enabled.
//   2. Touching navigator.locks (or opening a second same-origin page) EVICTS the frozen entry
//      and releases the lock, masking the bug. So the trials do NO lock queries between steps.
// A POSITIVE CONTROL runs first: a lock-free page must actually freeze+restore (pageshow
// persisted=true) on a history back-nav. If it does not, this environment can't exercise bfcache
// and the script exits 2 (INCONCLUSIVE) rather than passing trivially (no false green).
//
// Run:  npm run verify:bfcache   (requires a prior `npm run build`; auto-uses xvfb if headless)
import { existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
    const child = spawn("npx", ["vite", "preview", "--port", "4323"], { cwd: root });
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

const BANNER = "BYOBanana is open in another tab";
async function bannerPresent(page) {
  return (await page.locator(`text=${BANNER}`).count()) > 0;
}

async function main() {
  const chromium = loadChromium();
  const { child: preview, url } = await startPreview();
  // Headed + bfcache re-enabled (Playwright otherwise disables it via --disable-back-forward-cache).
  const browser = await chromium.launch({
    headless: false,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    args: ["--enable-features=BackForwardCache,BackForwardCacheNoTimeEviction"],
  });
  let exitCode = 1;
  try {
    const ctx = await browser.newContext();

    // POSITIVE CONTROL: a lock-free page must freeze+restore, else bfcache isn't working here.
    const ctl = await ctx.newPage();
    let restored = false;
    await ctl.addInitScript(`window.addEventListener("pageshow", (e) => { if (e.persisted) window.__persisted = true; });`);
    await ctl.goto(url, { waitUntil: "load" });
    await ctl.goto(`${url}app/?mock=1`, { waitUntil: "load" });
    await ctl.waitForTimeout(300);
    await ctl.goBack({ waitUntil: "commit" });
    await ctl.waitForTimeout(300);
    restored = await ctl.evaluate(() => window.__persisted === true);
    await ctl.close();
    if (!restored) {
      console.error("INCONCLUSIVE: bfcache did not engage (a lock-free page was not restored from cache).");
      console.error("Cannot verify the fix in this environment; not treating as pass or fail.");
      await ctx.close();
      exitCode = 2;
      return;
    }
    console.log("control: bfcache engaged (lock-free page froze and restored).");

    // THE TRIALS: pure same-tab flow, no lock queries between steps (querying evicts the freeze).
    // /app/ has no ?mock here so it matches the real landing->app link; the guard runs regardless.
    let allPrimary = true;
    for (let i = 1; i <= 3; i++) {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "load" }); // landing
      await page.locator("a.byo-nav-cta").first().click(); // Open BYOBanana -> /app/
      await page.waitForURL("**/app/**");
      await page.waitForSelector("text=Set up a run", { timeout: 15_000 }).catch(() => {});
      if (i === 3) await page.waitForTimeout(1500); // one trial with a human-paced pause
      await page.locator('a[aria-label="BYOBanana home"]').click(); // logo -> /
      await page.waitForURL((u) => new URL(u).pathname === "/");
      await page.locator("a.byo-nav-cta").first().click(); // Open BYOBanana again -> /app/
      await page.waitForURL("**/app/**");
      await page.waitForSelector("text=Set up a run", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(400);
      const bug = await bannerPresent(page);
      allPrimary &&= !bug;
      console.log(`trial ${i}: step4 ${bug ? "SECONDARY banner PRESENT (bug!)" : "primary, no banner (ok)"}`);
      await page.close();
    }
    console.log(allPrimary ? "PASS: same-tab return to /app/ stays primary across 3 trials" : "FAIL: bfcache single-tab bug present");
    exitCode = allPrimary ? 0 : 1;
    await ctx.close();
  } finally {
    await browser.close();
    preview.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

// bfcache needs a headed browser; relaunch under xvfb if we have no DISPLAY, else run.
if (!process.env.DISPLAY) {
  const xvfb = spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" }).stdout.trim();
  if (!xvfb) {
    console.error("INCONCLUSIVE: bfcache needs a headed browser; no DISPLAY and no xvfb-run found.");
    process.exit(2);
  }
  const self = fileURLToPath(import.meta.url);
  const child = spawn("xvfb-run", ["-a", process.execPath, self], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  await main();
}
