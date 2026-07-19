// LIVE end-to-end verification against the real Gemini API (REAL CHARGES — one grounded image).
// Not part of the standing suite: it needs a key and bills your Google account. Gated on
// GEMINI_KEY in the environment. Drives the built app through vite preview: seeds + validates
// the key, turns OFF mock mode, runs ONE grounded 512px generation, and screenshots the result
// with grounding attribution rendered. Confirms the /v1beta wire contract end-to-end through the
// real UI (base64 decode → createImageBitmap sizing → IndexedDB → blob-URL display → grounding).
//
// Run:  GEMINI_KEY=... node scripts/verify-live.mjs   (requires a prior `npm run build`)
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = process.env.GEMINI_KEY;
if (!KEY) {
  console.error("Set GEMINI_KEY to run the live verification (this makes a real, billed call).");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outDir = join(root, "scripts", "screenshots", "live");

function loadChromium() {
  const roots = [];
  const npxCache = join(homedir(), ".npm", "_npx");
  if (existsSync(npxCache)) for (const e of readdirSync(npxCache)) roots.push(join(npxCache, e, "node_modules"));
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      return require(spec).chromium;
    } catch {
      /* fall through */
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
    const child = spawn("npx", ["vite", "preview", "--port", "4320", "--strictPort"], { cwd: root });
    let url = "";
    const onData = (buf) => {
      const t = buf.toString();
      const m = /http:\/\/localhost:(\d+)\//.exec(t);
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
  mkdirSync(outDir, { recursive: true });
  const chromium = loadChromium();
  const { child: preview, url } = await startPreview();
  const browser = await chromium.launch({ headless: true });
  let ok = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    // Seed the key so the modal restores it as "unvalidated"; the app never auto-validates.
    await context.addInitScript((key) => {
      try {
        window.localStorage.setItem("nano-banana-web:gemini-key", key);
      } catch {
        /* ignore */
      }
    }, KEY);
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`${url}app/`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Set up a run");

    // 1. The seeded (remembered) key auto-validates on boot (zero-cost GET /v1beta/models) —
    // wait for the header pill to flip to configured. No mock toggle exists anymore; a valid
    // key IS the real-call path.
    await page.waitForSelector("text=API key configured", { timeout: 30_000 });
    console.log("Remembered key auto-validated against live /v1beta/models.");

    // 2. Minimal grounded run: the default model is now Lite (no grounding), so select Flash
    //    explicitly at its cheapest size, 1 variant, grounding ON, a live-search subject.
    await page.getByRole("combobox", { name: "Model" }).click();
    await page.getByRole("option", { name: /Flash Image$/ }).click();
    await page.getByRole("combobox", { name: "Resolution" }).click();
    await page.getByRole("option", { name: "512px" }).click();
    await page.getByLabel("Variants per style").fill("1");
    await page.getByLabel("Google Search grounding").check();
    await page
      .getByLabel("Subject prompt")
      .fill("A simple flat minimalist icon representing the CURRENT weather in London right now. Search live conditions first, then design the icon to match today's actual weather.");

    // 4. Generate one real image. Wait for the generated <img> in a candidate card (success) or
    //    a run-stopped Alert (failure) — an unambiguous signal, unlike the shared role="status".
    await page.getByRole("button", { name: "Generate" }).click();
    let succeeded = false;
    try {
      await page.waitForSelector("[data-candidate] img", { timeout: 120_000 });
      succeeded = true;
    } catch {
      succeeded = false;
    }
    console.log("Real image rendered in a candidate card:", succeeded ? "YES" : "NO");
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, "01-live-run.png"), fullPage: true });

    // 5. Inspect the candidate → grounding attribution should render.
    await page.locator("[data-candidate] button").first().click();
    await page.waitForSelector("text=Status and cost", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
    const grounded = (await page.locator("text=Grounded with Google Search").count()) > 0;
    const sources = (await page.locator("text=Sources").count()) > 0;
    console.log("Grounding attribution rendered:", grounded ? "YES" : "no", "| Sources section:", sources ? "YES" : "no");
    await page.screenshot({ path: join(outDir, "02-live-inspector.png"), fullPage: true });

    console.log("console errors:", errors.length ? errors : "none");
    // The whole point is to verify grounding renders on live data, so require it (the subject is
    // written to force a live search). If the model ever declines to ground, this reports a CHECK.
    ok = succeeded && grounded && errors.length === 0;
    console.log(ok ? "PASS: live generation succeeded, UI clean" : "CHECK: see output above");
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
