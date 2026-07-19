// DEPRECATED (Phase 23): no longer wired into the landing. The homepage now shows a REAL keyed
// session (public/img/byobanana-hero.mp4, a genuine screen recording of an actual Gemini run),
// so the mock-preview proof this script produced was retired and its output file
// (public/contact-sheet-preview.webp) deleted. Kept only as a reference mock-capture harness; do
// NOT re-wire its output into the landing without replacing it with a real run.
//
// Capture the BYOBanana workbench interface in PREVIEW mode (harness ?mock=1 — placeholder
// images, no provider call, no key), light scheme, with a completed contact sheet and the
// inspector open. Output: public/contact-sheet-preview.webp.
// Adapted from scripts/screenshot.mjs (same Chromium discovery + `vite preview` driver).
// WebP is encoded in-browser via canvas.toDataURL (no cwebp/native dependency), tuned to
// stay <= ~200 KB. Run:  node scripts/build-screenshot.mjs   (add --no-build to reuse dist/)
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const out = join(root, "public", "contact-sheet-preview.webp");
const MAX_BYTES = 200 * 1024;

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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function startPreview() {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["vite", "preview", "--port", "4320", "--strictPort"], { cwd: root });
    let url = "";
    const onData = (buf) => {
      const text = buf.toString();
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

// Re-encode a PNG buffer to WebP in a blank Chromium page (canvas.toDataURL). Steps quality
// down until the result fits MAX_BYTES; returns { buffer, width, height, quality }.
async function pngToWebp(browser, pngBuffer) {
  const page = await browser.newPage();
  const src = "data:image/png;base64," + pngBuffer.toString("base64");
  const dims = await page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  }, src);
  let picked = null;
  for (const q of [0.86, 0.82, 0.78, 0.72, 0.66, 0.6]) {
    const b64 = await page.evaluate(
      async ({ dataUrl, quality }) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.toDataURL("image/webp", quality).split(",")[1];
      },
      { dataUrl: src, quality: q },
    );
    const buffer = Buffer.from(b64, "base64");
    picked = { buffer, width: dims.w, height: dims.h, quality: q };
    if (buffer.length <= MAX_BYTES) break;
  }
  await page.close();
  return picked;
}

async function main() {
  if (!process.argv.includes("--no-build")) await run("npm", ["run", "build"]);
  const chromium = loadChromium();
  const { child: preview, url } = await startPreview();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    // Force LIGHT before any page script runs (theme-init.js reads this key).
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("mantine-color-scheme-value", "light");
      } catch {
        /* ignore */
      }
    });
    const page = await context.newPage();

    await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Set up a run");

    // Add a SECOND comparable style recipe (the default run has one) so the contact sheet reads
    // as a comparison, then raise variants to 4 -> 2 styles x 4 = 8 candidates.
    const recipeCards = page.locator('[role="checkbox"]');
    const total = await recipeCards.count();
    for (let i = 0; i < total; i += 1) {
      const card = recipeCards.nth(i);
      const checked = await card.getAttribute("aria-checked");
      const name = ((await card.getAttribute("aria-label")) || (await card.innerText())).toLowerCase();
      if (checked === "false" && !name.includes("custom")) {
        await card.click();
        break;
      }
    }
    await page.getByLabel("Variants per style").fill("4");

    await page.getByLabel("Subject prompt").fill("a friendly robot mascot holding a coffee cup");
    await page.getByRole("button", { name: "Generate" }).click();

    // Wait for the run to finish (a status region reports succeeded, none running/queued).
    // Fail hard on timeout — a half-captured sheet would be a dishonest proof.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="status"]')].some((el) => {
          const t = el.textContent ?? "";
          return t.includes("succeeded") && !t.includes("running") && !t.includes("queued");
        }),
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(500); // let placeholder images decode

    // Open the inspector on the first candidate so the shot shows slots + inspector + controls.
    await page.locator("[data-candidate] button").first().click();
    await page.waitForSelector("text=Status and cost");
    await page.waitForTimeout(300);

    // The workbench is a standalone document at /app/ (its sticky toolbar sits at the top of the
    // viewport), so no scroll is needed to frame the run controls + contact sheet + inspector.
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } });
    const webp = await pngToWebp(browser, png);
    writeFileSync(out, webp.buffer);
    console.log(
      `Wrote ${out}  ${webp.width}x${webp.height}  ${(webp.buffer.length / 1024).toFixed(1)} KiB  (q=${webp.quality})`,
    );
    if (webp.buffer.length > MAX_BYTES) throw new Error("WebP exceeds the 200 KB budget");
  } finally {
    await browser.close();
    preview.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
