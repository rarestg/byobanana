// P13 behavioral verification in a REAL headless Chromium (Playwright): the optimized
// (WASM-compressed) download. Exercises the ACTUAL Vite production output — worker code
// splitting, relative-base asset URLs, and the real public/_headers CSP (including
// 'wasm-unsafe-eval') are exactly the risky parts, so dist/ is served by a small static
// server that applies the parsed _headers rules, at "/" AND at a nested "/sub/" path.
//
// Stages:
//   1. UI flow (seeded IndexedDB session with a 2048² opaque PNG + an 8×8 tiny PNG):
//      split button with raw size; click → spinner on THAT button only → download named
//      *-web.jpeg → label backfills the real smaller size; tiny candidate → only-if-smaller
//      ("No smaller than raw", nothing downloads); mock (SVG) run → compressed button absent.
//   2. Codec matrix via the ?verify-compress=1 harness seam: JPEG→smaller JPEG; opaque
//      PNG(image)→JPEG; transparent PNG(image)→alpha guard→PNG (alpha preserved);
//      transparent PNG(icon)→PNG; icon quantizer (encodeIconPng): >256-color gradient →
//      indexed color-type-3 PNG with alpha intact and changed pixels (lossy proof), noise →
//      quality-floor abort → lossless fallback with identical pixels; worker poison →
//      pending rejects → retry succeeds; 4K smoke + 4K quant smoke (complete, main thread
//      stays responsive).
//   3. Nested /sub/ round-trip (base:"./" proof).
//   4. Negative CSP (no 'wasm-unsafe-eval') → compression rejects; raw path unaffected.
//   5. build-worker.mjs artifact embeds the .wasm assets as application/wasm and carries
//      the new CSP header.
//
// Run:  node scripts/verify-compress.mjs   (requires a prior `npm run build`)
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const distDir = join(root, "dist");
const shotDir = join(root, "scripts", "screenshots", "p13");

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

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// ---- static server: dist/ with the REAL parsed _headers rules (build-worker.mjs parser) ----
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("#") || raw.trim() === "") continue;
    if (raw.startsWith("/")) {
      current = { prefix: raw.trim().replace(/\*$/, ""), headers: {} };
      rules.push(current);
    } else if (current) {
      const idx = raw.indexOf(":");
      if (idx > 0) current.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    }
  }
  return rules;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

// Serves dist/ at "/" and at "/sub/", plus /seed.js (same-origin external script — an
// inline seed bundle would be blocked by the CSP). `stripWasmToken` builds the negative-
// CSP variant. Every response carries the _headers rules, exactly like the deploy worker.
function startServer(seedCode, { stripWasmToken = false } = {}) {
  const rules = parseHeaders(readFileSync(join(root, "public", "_headers"), "utf8"));
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.startsWith("/sub/")) path = path.slice(4);
    if (path === "/" || path === "/sub") path = "/index.html";
    // The workbench is a standalone document at /app/ (was embedded in / before the split).
    if (path === "/app/" || path === "/app") path = "/app/index.html";
    const headers = {};
    for (const rule of rules) {
      if (path.startsWith(rule.prefix)) Object.assign(headers, rule.headers);
    }
    if (stripWasmToken && headers["Content-Security-Policy"]) {
      headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace(" 'wasm-unsafe-eval'", "");
    }
    if (path === "/seed.js") {
      res.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
      res.end(seedCode);
      return;
    }
    const file = join(distDir, path);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, headers);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { ...headers, "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---- seed bundle: the app's own IdbSessionRepository + recipes, exposed as window.NBSeed ----
const seedBundle = await build({
  stdin: {
    contents: `
      export { IdbSessionRepository } from "./idbRepository";
      export { loadRecipes, renderRecipe } from "./recipes";
      export { COLOR_PALETTES } from "./palettes";
    `,
    resolveDir: join(root, "src", "core"),
    loader: "ts",
    sourcefile: "seed-entry.ts",
  },
  bundle: true,
  format: "iife",
  globalName: "NBSeed",
  write: false,
});
const seedCode = seedBundle.outputFiles[0].text;

// Runs inside the app page: seed one image-family session (2 succeeded candidates:
// 2048² photo-like opaque PNG, 8×8 tiny solid PNG) through the real repository.
async function seedSession() {
  const { IdbSessionRepository, loadRecipes, renderRecipe, COLOR_PALETTES } = window.NBSeed;
  const recipe = loadRecipes().find((r) => r.id === "hard-edge-geometric-screenprint");
  const palette = COLOR_PALETTES[0];

  async function pngBlob(draw, size) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    draw(ctx, size);
    return canvas.convertToBlob({ type: "image/png" });
  }
  function photoLike(ctx, size) {
    const g = ctx.createRadialGradient(size * 0.4, size * 0.35, 40, size * 0.5, size * 0.5, size * 0.8);
    g.addColorStop(0, "#ffd9a0");
    g.addColorStop(0.5, "#b06f4a");
    g.addColorStop(1, "#0c1420");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 12;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }
  const big = await pngBlob(photoLike, 2048);
  const tiny = await pngBlob((ctx, s) => {
    ctx.fillStyle = "#334455";
    ctx.fillRect(0, 0, s, s);
  }, 8);

  const sha = async (blob) => {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  const repo = await IdbSessionRepository.open();
  const created = await repo.createSession({
    subject: "P13 compress verification subject",
    palette,
    settings: { modelId: "gemini-3.1-flash-image", size: "2K", googleSearch: false, variantsPerRecipe: 2, callCount: 2 },
    estimate: { status: "estimated", usd: 0.2, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [],
    arms: [{ id: "arm-1", recipe, renderedPrompt: renderRecipe(recipe, "P13 compress verification subject", palette), variants: 2 }],
  });
  const [c1, c2] = created.arms[0].candidates.map((c) => c.id);
  const result = (blob, px) => ({
    status: "succeeded",
    images: [{ blob, mimeType: "image/png", width: px, height: px, sha256: "ignored-rehashed" }],
    text: [],
    cost: { status: "calculated", usd: 0.1, excludesGrounding: false },
    modelVersion: "seeded",
  });
  await repo.startCandidate(created.id, c1);
  await repo.writeCandidateResult(created.id, c1, { ...result(big, 2048), images: [{ ...result(big, 2048).images[0], sha256: await sha(big) }] });
  await repo.startCandidate(created.id, c2);
  await repo.writeCandidateResult(created.id, c2, { ...result(tiny, 8), images: [{ ...result(tiny, 8).images[0], sha256: await sha(tiny) }] });
  repo.close();
  return { sessionId: created.id, c1, c2, bigBytes: big.size, tinyBytes: tiny.size };
}

// ---- stage 1: UI flow on the seeded session --------------------------------------------
async function uiStage(browser, base, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`ui: ${m.text()}`);
  });
  const url = `${base}/app/?mock=1&verify-compress=1`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");

  // CSP header sanity on the positive server.
  const csp = (await page.request.get(url)).headers()["content-security-policy"] ?? "";
  check("served CSP includes 'wasm-unsafe-eval'", csp.includes("'wasm-unsafe-eval'"), csp);

  await page.addScriptTag({ url: "/seed.js" });
  const seeded = await page.evaluate(seedSession);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");

  // A mock (SVG) run first — the setup form hides once a session is open. SVG is outside
  // the codec matrix → compressed button absent, raw still offered.
  await page.getByLabel("Subject prompt").fill("a compressed svg has no codec");
  await page.getByRole("button", { name: "Generate" }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-candidate]").length > 0, undefined, { timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-spend-pill][data-live="true"]') === null,
    undefined,
    { timeout: 30_000 },
  );
  await page.locator("[data-candidate] button").first().click();
  await page.waitForSelector("text=Status and cost");
  check("svg (no codec): raw button present", (await page.getByRole("button", { name: /^Raw · / }).count()) === 1);
  check(
    "svg (no codec): compressed button absent",
    (await page.getByRole("button", { name: /Smaller JPEG|Optimized PNG|No smaller/ }).count()) === 0,
  );

  // Open the seeded session from the history rail (burger-toggled navbar), focus the big
  // candidate; close the rail again so it never overlaps the inspector.
  await page.getByRole("button", { name: /^History/ }).click();
  // Scope to the drawer: the bare text also matches main-document nodes BEHIND the drawer
  // overlay (the subject textarea matches by VALUE, and the session view shows the open
  // run's subject), and getByText().first() picks those in DOM order — the click then
  // retries forever against the overlay. The drawer item is the only in-drawer match.
  await page.locator("#history-navbar").getByText("P13 compress verification subject").first().click();
  // P17 made selection close the Drawer itself (loadSession → closeNav) — wait for it to
  // unmount rather than clicking the toggle again (which would REOPEN it over the sheet).
  await page.waitForSelector("#history-navbar", { state: "detached" });
  await page.waitForSelector("[data-candidate]");
  await page.locator(`[data-candidate="${seeded.c1}"] button`).first().click();
  await page.waitForSelector("text=Status and cost");

  const rawButton = page.getByRole("button", { name: /^Raw · / });
  const compressButton = page.getByRole("button", { name: "Smaller JPEG" });
  check("split button shows raw size", (await rawButton.count()) === 1, await rawButton.textContent().catch(() => "?"));
  check("split button offers Smaller JPEG", (await compressButton.count()) === 1);
  check("lossy hint present", (await page.getByText("The compressed JPEG is a lossy re-encode (quality 80).").count()) === 1);
  mkdirSync(shotDir, { recursive: true });
  await rawButton.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shotDir, "ui-split-button.png"), fullPage: false });

  // Click → spinner on the compressed button ONLY, siblings disabled but not spinning.
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await compressButton.click();
  const spinner = await page
    .waitForFunction(
      () => {
        const loading = [...document.querySelectorAll("button[data-loading]")];
        return loading.length > 0 ? loading.map((b) => b.textContent) : false;
      },
      undefined,
      { timeout: 15_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check("spinner appears on the compressed button only", Array.isArray(spinner) && spinner.length === 1 && /Smaller JPEG/.test(spinner[0]), JSON.stringify(spinner));
  const siblings = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const raw = buttons.find((b) => /^Raw · /.test(b.textContent));
    const zip = buttons.find((b) => b.textContent === "Download candidate as ZIP");
    return { rawDisabled: raw?.disabled ?? null, rawSpinning: raw?.hasAttribute("data-loading") ?? null, zipDisabled: zip?.disabled ?? null };
  });
  check(
    "siblings disabled (not spinning) during compression",
    siblings.rawDisabled === true && siblings.rawSpinning === false && siblings.zipDisabled === true,
    JSON.stringify(siblings),
  );
  // The split control must never overflow the narrow inspector column (worst case: the
  // loading state / a long backfilled size).
  const overflow = await page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Download the image"]');
    const paper = group?.closest('[class*="Paper-root"]');
    if (!group || !paper) return null;
    const g = group.getBoundingClientRect();
    const p = paper.getBoundingClientRect();
    return { fits: g.right <= p.right + 1 && g.left >= p.left - 1, group: Math.round(g.width), paper: Math.round(p.width) };
  });
  check("split control stays inside the inspector column", overflow?.fits === true, JSON.stringify(overflow));
  await page.screenshot({ path: join(shotDir, "ui-compressing.png") }).catch(() => {});

  const download = await downloadPromise;
  check("download filename carries -web + the JPEG extension", /-web\.jpeg$/.test(download.suggestedFilename()), download.suggestedFilename());

  // Label backfills the REAL smaller size in the SHORT post-compute form (P15:
  // "Raw · N KB | Small · M KB" — the format wording moved to the hint).
  const backfilled = await page
    .waitForFunction(
      () => {
        const button = [...document.querySelectorAll("button")].find((b) => /^Small · /.test(b.textContent));
        return button ? button.textContent : false;
      },
      undefined,
      { timeout: 15_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check("label backfills a real size as 'Small · N KB'", typeof backfilled === "string", String(backfilled));
  // Let Mantine's loading→idle label transition settle before measuring/screenshotting —
  // mid-transition the label rides a transform that reads as vertical clipping.
  await page.waitForTimeout(400);
  check("lossy hint survives the backfill", (await page.getByText("The compressed JPEG is a lossy re-encode (quality 80).").count()) === 1);
  // P15: neither segment's LABEL may truncate at the 336px inspector width post-compute
  // (the old long labels clipped "KB" on both sides).
  const truncation = await page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Download the image"]');
    if (!group) return null;
    return [...group.querySelectorAll("button")].map((b) => {
      const label = b.querySelector('[class*="Button-label"], .mantine-Button-label') ?? b;
      return { text: b.textContent, fits: label.scrollWidth <= label.clientWidth + 1 };
    });
  });
  check(
    "post-compute: no truncation in either split segment",
    Array.isArray(truncation) && truncation.length === 2 && truncation.every((t) => t.fits),
    JSON.stringify(truncation),
  );
  check("exported counter appears", (await page.getByText(/Exported \d+ time/).count()) >= 1);
  await page.screenshot({ path: join(shotDir, "ui-backfilled.png") });

  // Only-if-smaller on the tiny candidate: no download, disabled label.
  await page.locator(`[data-candidate="${seeded.c2}"] button`).first().click();
  await page.waitForSelector("text=Status and cost");
  const tinyCompress = page.getByRole("button", { name: "Smaller JPEG" });
  check("tiny candidate offers Smaller JPEG before the attempt", (await tinyCompress.count()) === 1);
  let unexpectedDownload = false;
  const onDownload = () => {
    unexpectedDownload = true;
  };
  page.on("download", onDownload);
  await tinyCompress.click();
  const noSmaller = page.getByRole("button", { name: "No smaller than raw" });
  await noSmaller.waitFor({ state: "visible", timeout: 30_000 });
  check("only-if-smaller: button reports 'No smaller than raw' and is disabled", await noSmaller.isDisabled());
  await page.waitForTimeout(300);
  check("only-if-smaller: nothing downloads", !unexpectedDownload);
  page.off("download", onDownload);
  await page.screenshot({ path: join(shotDir, "ui-no-smaller.png") });

  await context.close();
}

// ---- stage 2: codec matrix + worker reset + 4K smoke through the harness seam -----------
async function matrixStage(browser, base, errors, path = "/app/") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`matrix(${path}): ${m.text()}`);
  });
  await page.goto(`${base}${path}?mock=1&verify-compress=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");

  const results = await page.evaluate(async () => {
    const { compressImage, encodeIconPng } = window.__nbCompress;
    const out = {};

    // PNG signature + IHDR color type (3 = indexed/palette, the quantization proof).
    const pngColorType = (bytes) => {
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (bytes.byteLength < 34 || !sig.every((b, i) => bytes[i] === b)) return -1;
      return bytes[25];
    };
    // Deterministic LCG so the floor fixture aborts identically on every run.
    const lcg = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    function canvasOf(size, draw) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      draw(ctx, size);
      return canvas;
    }
    function photo(ctx, size) {
      const g = ctx.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, "#ffd9a0");
      g.addColorStop(1, "#0c1420");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 12;
        img.data[i] += n;
        img.data[i + 1] += n;
        img.data[i + 2] += n;
      }
      ctx.putImageData(img, 0, 0);
    }
    async function blobOf(canvas, type, quality) {
      return canvas.convertToBlob(quality !== undefined ? { type, quality } : { type });
    }
    async function decoded(blob) {
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const dims = { width: bmp.width, height: bmp.height };
      bmp.close();
      return { dims, alphaAt: (x, y) => px.data[(y * dims.width + x) * 4 + 3] };
    }

    // Row 1: photo-ish JPEG → mozjpeg re-encode, smaller, dims unchanged.
    {
      const source = await blobOf(canvasOf(768, photo), "image/jpeg", 0.95);
      const result = await compressImage(source, "image/jpeg", "image", { width: 768, height: 768 });
      const dec = await decoded(result.blob);
      out.jpegRow = {
        mime: result.mimeType,
        inBytes: source.size,
        outBytes: result.blob.size,
        smaller: result.blob.size < source.size * 0.9,
        dimsOk: dec.dims.width === 768 && dec.dims.height === 768 && result.width === 768,
        sha: result.sha256.length === 64,
      };
    }
    // Row 2: opaque photo-like PNG, image family → JPEG, < 60% of input.
    {
      const source = await blobOf(canvasOf(768, photo), "image/png");
      const result = await compressImage(source, "image/png", "image", { width: 768, height: 768 });
      const dec = await decoded(result.blob);
      out.pngImageRow = {
        mime: result.mimeType,
        inBytes: source.size,
        outBytes: result.blob.size,
        smaller: result.blob.size < source.size * 0.6,
        dimsOk: dec.dims.width === 768 && dec.dims.height === 768,
      };
    }
    // Row 3: TRANSPARENT PNG, image family → the alpha guard → PNG, alpha preserved.
    {
      const canvas = canvasOf(256, (ctx, s) => {
        ctx.fillStyle = "#2a9d8f";
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s / 3, 0, Math.PI * 2);
        ctx.fill();
      });
      const source = await blobOf(canvas, "image/png");
      const result = await compressImage(source, "image/png", "image", { width: 256, height: 256 });
      const dec = await decoded(result.blob);
      out.alphaGuardRow = {
        mime: result.mimeType,
        cornerAlpha: dec.alphaAt(0, 0),
        centerAlpha: dec.alphaAt(128, 128),
        dimsOk: dec.dims.width === 256,
        notLarger: result.blob.size <= source.size,
      };
    }
    // Row 4: transparent PNG, icon family → oxipng, PNG, alpha preserved, ≤ input.
    {
      const canvas = canvasOf(384, (ctx, s) => {
        ctx.fillStyle = "#e63946";
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
        ctx.fill();
      });
      const source = await blobOf(canvas, "image/png");
      const result = await compressImage(source, "image/png", "icon", { width: 384, height: 384 });
      const dec = await decoded(result.blob);
      out.iconRow = {
        mime: result.mimeType,
        cornerAlpha: dec.alphaAt(0, 0),
        centerAlpha: dec.alphaAt(192, 192),
        notLarger: result.blob.size <= source.size,
        dimsFromSource: result.width === 384 && result.height === 384,
      };
    }
    // Row 5: circular-icon quantizer, quantizable input — a deterministic SMOOTH gradient
    // (65k+ distinct colors, the class libimagequant handles well within the 65-90 window)
    // with a transparent corner. Must come back "quantized" as an indexed PNG with alpha
    // intact and CHANGED opaque pixels (the lossy proof: an indexed re-encode of >256
    // colors cannot be pixel-identical; transparent pixels are excluded from the diff —
    // the canvas's premultiplied storage zeroes their RGB on both sides).
    {
      const size = 512;
      const data = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          data[i] = x >> 1;
          data[i + 1] = y >> 1;
          data[i + 2] = (x + y) >> 2;
          data[i + 3] = x < 32 && y < 32 ? 0 : 255;
        }
      }
      const sourceCopy = data.slice(); // the transfer detaches `data`'s buffer
      const result = await encodeIconPng(new ImageData(data, size, size));
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      const dec = await decoded(result.blob);
      let maxDiff = 0;
      const px = await (async () => {
        const bmp = await createImageBitmap(result.blob);
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        return ctx.getImageData(0, 0, size, size).data;
      })();
      for (let i = 0; i < px.length; i += 4) {
        if (sourceCopy[i + 3] !== 255) continue; // opaque pixels only
        for (let c = 0; c < 3; c++) {
          maxDiff = Math.max(maxDiff, Math.abs(px[i + c] - sourceCopy[i + c]));
        }
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      out.quantRow = {
        encoding: result.encoding,
        colorType: pngColorType(bytes),
        bytes: bytes.byteLength,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        dims: [dec.dims.width, dec.dims.height],
        cornerAlpha: dec.alphaAt(0, 0),
        centerAlpha: dec.alphaAt(256, 256),
        maxDiff,
      };
    }
    // Row 6: circular-icon quantizer, quality-floor abort — deterministic opaque noise
    // cannot meet the floor with 256 colors, so the worker must ship the LOSSLESS fallback:
    // encoding "lossless", not indexed, pixels EXACTLY equal to the input.
    {
      const size = 128;
      const rnd = lcg(7);
      const data = new Uint8ClampedArray(size * size * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.floor(rnd() * 256);
        data[i + 1] = Math.floor(rnd() * 256);
        data[i + 2] = Math.floor(rnd() * 256);
        data[i + 3] = 255;
      }
      const sourceCopy = data.slice();
      const result = await encodeIconPng(new ImageData(data, size, size));
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      const bmp = await createImageBitmap(result.blob);
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const px = ctx.getImageData(0, 0, size, size).data;
      let identical = px.length === sourceCopy.length;
      for (let i = 0; identical && i < px.length; i++) {
        if (px[i] !== sourceCopy[i]) identical = false;
      }
      out.floorRow = {
        encoding: result.encoding,
        colorType: pngColorType(bytes),
        identical,
      };
    }
    return out;
  });

  check(`[${path}] JPEG row → smaller JPEG`, results.jpegRow.mime === "image/jpeg" && results.jpegRow.smaller && results.jpegRow.dimsOk && results.jpegRow.sha, JSON.stringify(results.jpegRow));
  check(`[${path}] opaque PNG (image) row → JPEG < 60%`, results.pngImageRow.mime === "image/jpeg" && results.pngImageRow.smaller && results.pngImageRow.dimsOk, JSON.stringify(results.pngImageRow));
  check(
    `[${path}] transparent PNG (image) row → alpha guard keeps PNG + alpha`,
    results.alphaGuardRow.mime === "image/png" && results.alphaGuardRow.cornerAlpha === 0 && results.alphaGuardRow.centerAlpha === 255 && results.alphaGuardRow.dimsOk,
    JSON.stringify(results.alphaGuardRow),
  );
  check(
    `[${path}] transparent PNG (icon) row → lossless PNG, alpha preserved, not larger`,
    results.iconRow.mime === "image/png" && results.iconRow.cornerAlpha === 0 && results.iconRow.centerAlpha === 255 && results.iconRow.notLarger && results.iconRow.dimsFromSource,
    JSON.stringify(results.iconRow),
  );
  check(
    `[${path}] quant row → indexed (color type 3) PNG, alpha preserved, pixels changed (lossy)`,
    results.quantRow.encoding === "quantized" &&
      results.quantRow.colorType === 3 &&
      results.quantRow.dims[0] === 512 &&
      results.quantRow.dims[1] === 512 &&
      results.quantRow.cornerAlpha === 0 &&
      results.quantRow.centerAlpha === 255 &&
      results.quantRow.maxDiff > 0,
    JSON.stringify(results.quantRow),
  );
  // Policy pin: the fixture is synthetic (no canvas rasterization) and the whole
  // quantize+oxipng pipeline is deterministic wasm, so the output bytes are identical on
  // every machine FOR THIS settled policy (quality 65-90, dithering 0, automatic palette,
  // oxipng level 2) and these pinned dependency versions. A quality/dithering/palette knob
  // change, or a libimagequant-wasm / @jsquash/oxipng version bump, changes this hash —
  // update it only as a CONSCIOUS policy/dependency decision.
  check(
    `[${path}] quant row bytes match the pinned policy hash`,
    results.quantRow.sha256 === "628024919d06609750a80b3fe6509519b98ba3f670e8bdaf63e1f3bb96c4c3ab",
    results.quantRow.sha256,
  );
  check(
    `[${path}] quality-floor row → lossless fallback, not indexed, pixels identical`,
    results.floorRow.encoding === "lossless" &&
      results.floorRow.colorType !== 3 &&
      results.floorRow.identical,
    JSON.stringify(results.floorRow),
  );

  if (path === "/app/") {
    // Worker reset: poison the live worker mid-job (drives the registered onerror handler —
    // reject-all-pending + singleton reset), then retry on a fresh worker.
    const reset = await page.evaluate(async () => {
      const { compressImage, worker } = window.__nbCompress;
      const canvas = new OffscreenCanvas(2048, 2048);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#123456";
      ctx.fillRect(0, 0, 2048, 2048);
      const img = ctx.getImageData(0, 0, 2048, 2048);
      for (let i = 0; i < img.data.length; i += 4) img.data[i] = Math.random() * 255;
      ctx.putImageData(img, 0, 0);
      const source = await canvas.convertToBlob({ type: "image/png" });
      const job = compressImage(source, "image/png", "image", { width: 2048, height: 2048 });
      // Poison only once the job is genuinely in flight (compressImage awaits arrayBuffer
      // before posting; the encode itself takes ~1s, so 300ms lands mid-job).
      await new Promise((resolve) => setTimeout(resolve, 300));
      const victim = worker();
      victim.dispatchEvent(new ErrorEvent("error", { message: "poisoned by harness" }));
      let rejected = false;
      try {
        await job;
      } catch (error) {
        rejected = String(error?.message ?? error).includes("compression worker failed");
      }
      const workerReplaced = worker() === undefined; // singleton dropped until the next call
      // Retry: a fresh worker must succeed.
      const small = new OffscreenCanvas(64, 64);
      small.getContext("2d").fillRect(0, 0, 64, 64);
      const retryBlob = await small.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      const retry = await compressImage(retryBlob, "image/jpeg", "image", { width: 64, height: 64 });
      return { rejected, workerReplaced, retryMime: retry.mimeType, freshWorker: worker() !== undefined };
    });
    check("worker poison: pending job rejects", reset.rejected, JSON.stringify(reset));
    check("worker poison: singleton reset, retry succeeds on a fresh worker", reset.workerReplaced && reset.retryMime === "image/jpeg" && reset.freshWorker);

    // 4K smoke: completes < 60s and the MAIN thread stays responsive while the worker grinds.
    const smoke = await page.evaluate(async () => {
      const { compressImage } = window.__nbCompress;
      const size = 4096;
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      const g = ctx.createLinearGradient(0, 0, size, size);
      g.addColorStop(0, "#ffd9a0");
      g.addColorStop(1, "#0c1420");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size);
      for (let i = 0; i < img.data.length; i += 8) img.data[i] += (Math.random() - 0.5) * 10;
      ctx.putImageData(img, 0, 0);
      const source = await canvas.convertToBlob({ type: "image/png" });

      let maxGap = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 25);
      const started = performance.now();
      const result = await compressImage(source, "image/png", "image", { width: size, height: size });
      const elapsed = performance.now() - started;
      clearInterval(ticker);
      return { elapsed: Math.round(elapsed), maxGap: Math.round(maxGap), inBytes: source.size, outBytes: result.blob.size, mime: result.mimeType };
    });
    check("4K smoke: completes within 60s", smoke.elapsed < 60_000, JSON.stringify(smoke));
    check("4K smoke: main thread stays responsive (max tick gap < 500ms)", smoke.maxGap < 500, `maxGap=${smoke.maxGap}ms`);

    // 4K quantizer smoke: full-resolution circles can reach 4096² (the largest model output
    // size), so quantize+dither+PNG+oxipng must complete at that size with the main thread
    // responsive. Content is a smooth deterministic gradient with mild noise (quantizable),
    // but the check accepts either encoding — this probes performance, not quality.
    const quantSmoke = await page.evaluate(async () => {
      const { encodeIconPng } = window.__nbCompress;
      const size = 4096;
      const data = new Uint8ClampedArray(size * size * 4);
      let seed = 11;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const n = (rnd() - 0.5) * 8;
          data[i] = Math.max(0, Math.min(255, (x >> 4) + n));
          data[i + 1] = Math.max(0, Math.min(255, (y >> 4) + n));
          data[i + 2] = 128;
          data[i + 3] = 255;
        }
      }
      let maxGap = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 25);
      const started = performance.now();
      const result = await encodeIconPng(new ImageData(data, size, size));
      const elapsed = performance.now() - started;
      clearInterval(ticker);
      return {
        elapsed: Math.round(elapsed),
        maxGap: Math.round(maxGap),
        encoding: result.encoding,
        outBytes: result.blob.size,
      };
    });
    check("4K quant smoke: completes within 60s", quantSmoke.elapsed < 60_000, JSON.stringify(quantSmoke));
    check(
      "4K quant smoke: main thread stays responsive (max tick gap < 500ms)",
      quantSmoke.maxGap < 500,
      `maxGap=${quantSmoke.maxGap}ms`,
    );
  }

  await context.close();
}

// ---- stage 4: negative CSP (no 'wasm-unsafe-eval') → compression fails, raw unaffected --
async function negativeCspStage(browser, base) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Console errors are EXPECTED here (CSP CompileError) — this context is not error-counted.
  await page.goto(`${base}/app/?mock=1&verify-compress=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");
  const outcome = await page.evaluate(async () => {
    const { compressImage, encodeIconPng } = window.__nbCompress;
    const canvas = new OffscreenCanvas(64, 64);
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    const source = await canvas.convertToBlob({ type: "image/png" });
    let compressRejected = false;
    let compressMessage = "";
    try {
      await compressImage(source, "image/png", "image", { width: 64, height: 64 });
    } catch (error) {
      compressRejected = true;
      compressMessage = String(error?.message ?? error);
    }
    // The quantizer must also reject (image.ts then degrades to the raw canvas PNG).
    let quantRejected = false;
    try {
      await encodeIconPng(new ImageData(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64));
    } catch {
      quantRejected = true;
    }
    return { compressRejected, compressMessage, quantRejected };
  });
  check(
    "without 'wasm-unsafe-eval' the compression path rejects (raw untouched)",
    outcome.compressRejected,
    outcome.compressMessage ?? "",
  );
  check(
    "without 'wasm-unsafe-eval' the icon quantizer rejects (canvas-PNG degrade upstream)",
    outcome.quantRejected,
  );
  await context.close();
}

// ---- stage 5: build-worker.mjs artifact embeds wasm as application/wasm + carries the CSP --
function workerEmbedStage() {
  execFileSync("node", [join(root, "scripts", "build-worker.mjs")], { stdio: "pipe" });
  const workerJs = readFileSync(join(root, "worker-dist", "index.js"), "utf8");
  const wasmEntries = [...workerJs.matchAll(/"(\/assets\/[^"]+\.wasm)":\{"ct":"([^"]+)","b64":"([A-Za-z0-9+/=]{100})/g)];
  check(
    "worker embed: .wasm assets present with application/wasm, including the quantizer",
    wasmEntries.length >= 3 &&
      wasmEntries.every((m) => m[2] === "application/wasm") &&
      wasmEntries.some((m) => m[1].includes("libimagequant")),
    wasmEntries.map((m) => `${m[1]}:${m[2]}`).join(", "),
  );
  check("worker embed: header rules carry 'wasm-unsafe-eval'", workerJs.includes("'wasm-unsafe-eval'"));
}

// ---- main --------------------------------------------------------------------------------
if (!existsSync(join(distDir, "index.html"))) {
  console.error("dist/ missing — run `npm run build` first.");
  process.exit(2);
}

const chromium = loadChromium();
const browser = await chromium.launch();
const errors = [];
const server = await startServer(seedCode);
const negativeServer = await startServer(seedCode, { stripWasmToken: true });
const base = `http://127.0.0.1:${server.address().port}`;
const negativeBase = `http://127.0.0.1:${negativeServer.address().port}`;
try {
  await uiStage(browser, base, errors);
  await matrixStage(browser, base, errors, "/app/");
  await matrixStage(browser, base, errors, "/sub/app/");
  await negativeCspStage(browser, negativeBase);
  workerEmbedStage();
} finally {
  await browser.close();
  server.close();
  negativeServer.close();
}
check("zero console errors (positive stages)", errors.length === 0, errors.join(" | "));
console.log(failures === 0 ? "\nP13 verify: ALL PASS" : `\nP13 verify: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
