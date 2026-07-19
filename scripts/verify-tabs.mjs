// Single-tab guard regression (P7, P10 truthful-copy fallback) in a REAL headless Chromium. The
// guard holds a Web Lock so only the PRIMARY tab recovers interrupted runs and generates; a
// SECONDARY tab opened while the first holds the lock becomes view-only (banner + disabled
// Generate) so it can't corrupt a live run. Two same-origin pages in one browser context share
// the Web Lock scope, so this reproduces the two-tab race deterministically.
//
// P10 considered a real "Use this tab instead" takeover button (navigator.locks steal) and
// rejected it after Codex review: Web Locks gives a stolen holder's JS no reliable, synchronous
// loss signal, so a takeover could race an in-flight billed call and let the terminal-wins guard
// silently discard a real (possibly billed) result — see the design thread for the full
// analysis. The shipped fix is copy-only: the secondary banner no longer claims a reload takes
// over while the primary is still open (it doesn't — only after the primary tab closes), and
// drops the em dash the user flagged. This script checks BOTH the unchanged guard behavior and
// the corrected banner copy.
//
// Run:  node scripts/verify-tabs.mjs   (requires a prior `npm run build`)
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
    const child = spawn("npx", ["vite", "preview", "--port", "4321", "--strictPort"], { cwd: root });
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

async function main() {
  const chromium = loadChromium();
  const { child: preview, url } = await startPreview();
  const browser = await chromium.launch({ headless: true });
  let ok = false;
  try {
    // Same context → same origin → shared Web Lock scope (mirrors two real tabs).
    const context = await browser.newContext();
    // ?mock=1 (harness gate): Generate must be possible with no key on the PRIMARY tab so the
    // guard's enabled/disabled contrast is observable (the user-facing mock toggle is gone).
    const tabA = await context.newPage();
    await tabA.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
    await tabA.waitForSelector("text=Set up a run");
    const bannerText = "BYOBanana is open in another tab";
    const aBanner = await tabA.locator(`text=${bannerText}`).count();
    const aGenerateEnabled = await tabA.getByRole("button", { name: "Generate" }).isEnabled();
    console.log(`tab A (primary): banner=${aBanner === 0 ? "absent (ok)" : "PRESENT (bad)"}, Generate enabled=${aGenerateEnabled}`);

    const tabB = await context.newPage();
    await tabB.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
    await tabB.waitForSelector("text=Set up a run");
    await tabB.waitForTimeout(500); // let the lock decision resolve
    const bBanner = await tabB.locator(`text=${bannerText}`).count();
    const bGenerateEnabled = await tabB.getByRole("button", { name: "Generate" }).isEnabled();
    console.log(`tab B (secondary): banner=${bBanner > 0 ? "present (ok)" : "ABSENT (bad)"}, Generate enabled=${bGenerateEnabled}`);

    // P10: the banner body must no longer claim a reload takes over WHILE tab A (primary) is
    // still open — that's false; the lock only frees when A actually closes. It must also drop
    // the em dash the user flagged. Both tab B's banner and its disabled-Generate reason carry
    // the corrected copy.
    const bannerBody = (await tabB.locator("text=Generation runs in one tab at a time").first().textContent()) ?? "";
    const disabledReason = (await tabB.locator('[role="status"]', { hasText: "view-only" }).first().textContent()) ?? "";
    const truthfulCopy =
      bannerBody.includes("close the other tab") &&
      !bannerBody.includes("—") && // em dash
      !/reload this one to take over/i.test(bannerBody) &&
      disabledReason.includes("Close the other tab") &&
      !disabledReason.includes("—");
    console.log(`tab B copy: banner="${bannerBody.trim()}"`);
    console.log(`tab B copy: disabled reason="${disabledReason.trim()}"`);
    console.log(`tab B copy truthful (no em dash, no reload-while-primary-open claim): ${truthfulCopy}`);
    await tabB.screenshot({ path: join(outDir, "secondary-tab-banner.png") });

    // Close A → its lock releases. B still needs a reload to take over (now honestly documented
    // in its own copy), so we only assert the core guard: A primary + able to generate, B
    // secondary + view-only, with corrected copy.
    ok = aBanner === 0 && aGenerateEnabled && bBanner > 0 && bGenerateEnabled === false && truthfulCopy;
    console.log(ok ? "PASS: primary generates, secondary is view-only with truthful copy" : "FAIL: guard or copy did not behave as expected");
    await context.close();
  } finally {
    await browser.close();
    preview.kill("SIGTERM");
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
