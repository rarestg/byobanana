// Headless-browser verification of the circular icon export pipeline.
//
// The Canvas pixel path cannot run under jsdom (its canvas is a stub), so the geometry
// contract — square target, circular, transparent corners — is verified here in a REAL
// headless Chromium, in two stages:
//
//   Stage 1 (bundled units): esbuild-bundles src/core/{image,exportBundle,session,recipes}.ts
//   (exposed as window.NB) and asserts, from real canvas sources with an INJECTED encoder
//   (the quantizing worker cannot exist in this iife page — the real codec path is stage 2's
//   and verify-compress's job):
//     • exportCircularIcon default = 512×512 PNG, corners alpha 0, center alpha 255;
//     • explicit 256 and full-resolution renders;
//     • the SVG-source decode fallback (Chromium's createImageBitmap rejects SVG blobs —
//       the ?mock=1 runner emits SVG, so this is the mock-mode regression guard);
//     • the raw degrade path: an encoder that DETACHES the ImageData buffer and throws must
//       still yield a valid circular PNG (encoding "raw") re-encoded from the live canvas;
//     • buildIconSuiteBundle composition (raw + circle-full/512/256 + manifest.txt, the
//       only-if-smaller optimized-source rule, notes, palette-quantized content lines) with
//       an injected passthrough compressor and every circle's decoded geometry re-verified.
//
//   Stage 2 (real app, ?mock=1): builds dist/ (by default; --no-build reuses an existing
//   one), serves it, drives a mock icon run, and verifies all three owner-mandated
//   consumers against the REAL worker + libimagequant/oxipng wasm (CSP-header coverage
//   stays with verify-compress.mjs):
//     • "Complete suite (ZIP)": entry names, PNG signature + IHDR dims AND color type 3
//       (indexed — the proof quantization actually ran on the flat mock content), an
//       in-page alpha probe of the quantized circles (corners stay alpha 0), the SVG raw
//       source, the no-codec + no-fallback notes in manifest.txt, palette-quantized content
//       lines, and the single export record in the UI;
//     • the single "Download circular icon · 512px": saved PNG is 512×512 color type 3;
//     • "Download candidate as ZIP" (classic bundle): production circle is 512×512 color
//       type 3 and its manifest names palette quantization.
//
// Run:  node scripts/verify-icon.mjs [--no-build]   (--no-build requires an existing dist/)
// Requires a Playwright Chromium (e.g. `npx playwright install chromium`). Not part of the
// vitest suite — canvas output is not assertable in the default node/jsdom environments.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");

// Resolve Playwright from the project, from a global install, or from an `npx playwright`
// fetch (~/.npm/_npx/<hash>/node_modules) — so `node scripts/verify-icon.mjs` runs wherever
// Playwright is available without adding it as a project dependency.
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
      // fall through to the discovered roots
    }
    for (const r of roots) {
      try {
        return createRequire(join(r, "index.js"))(specifier).chromium;
      } catch {
        // try the next root
      }
    }
  }
  console.error(
    "Playwright is not installed. Run `npx playwright install chromium` (or `npm i -D playwright`) first.",
  );
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// ---- shared: minimal stored-ZIP reader (names + bytes via the central directory) --------
function parseZip(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("Bad ZIP EOCD.");
  const count = view.getUint16(end + 8, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Bad central header.");
    const dosTime = view.getUint16(offset + 12, true);
    const dosDate = view.getUint16(offset + 14, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    const localDosMatches =
      view.getUint16(localOffset + 10, true) === dosTime &&
      view.getUint16(localOffset + 12, true) === dosDate;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtra;
    entries.push({ name, dosDate, localDosMatches, bytes: zip.subarray(dataStart, dataStart + size) });
    offset += 46 + nameLength;
  }
  return entries;
}

// PNG signature + IHDR fields, validated before reading fixed offsets: 8-byte signature,
// then the IHDR chunk (length 13, type "IHDR"), width/height big-endian, color type at 25
// (3 = indexed/palette — the quantization proof; 6 = RGBA).
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid =
    bytes.byteLength > 33 &&
    PNG_SIGNATURE.every((b, i) => bytes[i] === b) &&
    view.getUint32(8, false) === 13 &&
    new TextDecoder().decode(bytes.subarray(12, 16)) === "IHDR";
  if (!valid) return { valid: false, width: 0, height: 0, colorType: -1 };
  return {
    valid: true,
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
    colorType: bytes[25],
  };
}

const chromium = loadChromium();

// =========================================================================================
// Stage 1: bundled units in a blank page.
// =========================================================================================
async function stage1(browser) {
  const bundle = await build({
    stdin: {
      contents: `
        export * as image from "./src/core/image.ts";
        export * as exportBundle from "./src/core/exportBundle.ts";
        export * as session from "./src/core/session.ts";
        export * as recipes from "./src/core/recipes.ts";
      `,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "NB",
    write: false,
  });
  const code = bundle.outputFiles[0].text;

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${code}</script></body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    const result = await page.evaluate(async () => {
      const { image, exportBundle, session, recipes } = window.NB;

      const alphaProbe = async (blob) => {
        const bmp = await createImageBitmap(blob);
        const probe = document.createElement("canvas");
        probe.width = bmp.width;
        probe.height = bmp.height;
        const pctx = probe.getContext("2d");
        pctx.drawImage(bmp, 0, 0);
        const alphaAt = (x, y) => pctx.getImageData(x, y, 1, 1).data[3];
        const out = {
          width: bmp.width,
          height: bmp.height,
          corners: [
            alphaAt(0, 0),
            alphaAt(bmp.width - 1, 0),
            alphaAt(0, bmp.height - 1),
            alphaAt(bmp.width - 1, bmp.height - 1),
          ],
          center: alphaAt(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2)),
        };
        bmp.close();
        return out;
      };
      const circular = (probe) =>
        probe.corners.every((alpha) => alpha === 0) && probe.center === 255;

      const canvasPng = (size) => {
        const src = document.createElement("canvas");
        src.width = size;
        src.height = size;
        const sctx = src.getContext("2d");
        sctx.fillStyle = "#3366cc";
        sctx.fillRect(0, 0, size, size);
        return new Promise((resolve) => src.toBlob(resolve, "image/png"));
      };

      // Injected encoder (the worker cannot exist in this bundled page): re-encode the
      // ImageData losslessly via a canvas, claiming "quantized" so the honest-labeling
      // paths run. Geometry is what stage 1 proves; the real codec is stage 2's job.
      const stubEncode = async (data) => {
        const c = document.createElement("canvas");
        c.width = data.width;
        c.height = data.height;
        c.getContext("2d").putImageData(data, 0, 0);
        const blob = await new Promise((resolve, reject) =>
          c.toBlob((b) => (b ? resolve(b) : reject(new Error("stub toBlob failed"))), "image/png"),
        );
        return { blob, encoding: "quantized" };
      };

      const results = {};

      // 1. Default (primary) size.
      const source800 = await canvasPng(800);
      const primary = await image.exportCircularIcon(source800, undefined, stubEncode);
      const primaryProbe = await alphaProbe(primary.blob);
      results.primary = {
        iconSize: image.ICON_SIZE,
        reported: [primary.width, primary.height],
        decoded: [primaryProbe.width, primaryProbe.height],
        mimeType: primary.mimeType,
        sha256Len: primary.sha256.length,
        encoding: primary.encoding,
        circular: circular(primaryProbe),
      };

      // 2. Explicit sizes from ONE decode: full resolution + 512 + 256.
      const set = await image.exportCircularIcons(source800, [800, 512, 256], stubEncode);
      results.sizes = [];
      for (const rendered of set) {
        const probe = await alphaProbe(rendered.blob);
        results.sizes.push({
          reported: [rendered.width, rendered.height],
          decoded: [probe.width, probe.height],
          circular: circular(probe),
        });
      }

      // 3. SVG-source fallback (Chromium createImageBitmap rejects SVG blobs; the mock
      // runner emits SVG, so this guards the ?mock=1 export path).
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#cc6633"/></svg>`;
      const svgIcon = await image.exportCircularIcon(
        new Blob([svg], { type: "image/svg+xml" }),
        undefined,
        stubEncode,
      );
      const svgProbe = await alphaProbe(svgIcon.blob);
      results.svgFallback = {
        decoded: [svgProbe.width, svgProbe.height],
        circular: circular(svgProbe),
      };

      // 3b. Raw degrade: the encoder DETACHES the ImageData's buffer (as the real worker
      // transfer does) and then fails — the export must re-encode from the live canvas and
      // report encoding "raw" with the failure message. The detachment is ASSERTED so this
      // test can never silently degrade into a plain-throw test.
      let detachedLength = -1;
      const rawFallback = await image.exportCircularIcon(source800, 512, async (data) => {
        structuredClone(data.data.buffer, { transfer: [data.data.buffer] });
        detachedLength = data.data.buffer.byteLength; // 0 once genuinely detached
        throw new Error("encoder exploded");
      });
      const rawProbe = await alphaProbe(rawFallback.blob);
      results.rawFallback = {
        encoding: rawFallback.encoding,
        encodeError: rawFallback.encodeError,
        detachedLength,
        decoded: [rawProbe.width, rawProbe.height],
        circular: circular(rawProbe),
      };

      // 3c. 4K render + readback smoke: the REAL exporter path at the largest model output
      // size (4096² source → full-resolution circle) — canvas render, synchronous
      // getImageData readback, and the fallback toBlob all at 4K. The injected encoder is
      // lightweight; worker throughput at 4K is verify-compress's quant smoke.
      const source4k = await canvasPng(4096);
      const started4k = performance.now();
      const icon4k = await image.exportCircularIcon(source4k, 4096, stubEncode);
      results.fourK = {
        elapsed: Math.round(performance.now() - started4k),
        reported: [icon4k.width, icon4k.height],
        encoding: icon4k.encoding,
      };

      // 4. Suite composition with an injected passthrough compressor (never smaller, so the
      // optimized source is skipped by the only-if-smaller rule and circles ship canvas bytes).
      const iconRecipe = recipes.loadRecipes().find((r) => r.id === "glass-icon");
      const repo = new session.InMemorySessionRepository();
      await repo.createSession({
        subject: "verify icon suite",
        settings: {
          modelId: "gemini-3.1-flash-image",
          size: "1K",
          googleSearch: false,
          variantsPerRecipe: 1,
          callCount: 1,
        },
        estimate: { status: "unavailable", excludesGrounding: false },
        confirmation: { required: false, acknowledged: false, reasons: [] },
        references: [],
        arms: [{ id: "arm-1", recipe: iconRecipe, renderedPrompt: "p", variants: 1 }],
      });
      const [summary] = await repo.listSessions();
      await repo.startCandidate(summary.id, "candidate-arm-1-1");
      await repo.writeCandidateResult(summary.id, "candidate-arm-1-1", {
        status: "succeeded",
        images: [
          {
            blob: source800,
            mimeType: "image/png",
            width: 800,
            height: 800,
            sha256: await session.sha256Hex(source800),
          },
        ],
        text: [],
        cost: { status: "unavailable", excludesGrounding: false },
      });
      const manifest = await repo.getSession(summary.id);
      const suite = await exportBundle.buildIconSuiteBundle(repo, manifest, "candidate-arm-1-1", {
        // Real geometry through the injected encoder; passthrough compressor for the
        // optimized-source entry (never smaller, so the only-if-smaller rule skips it).
        renderIcons: (source, sizes) => image.exportCircularIcons(source, sizes, stubEncode),
        compress: async (blob, mimeType, _family, source) => ({
          blob,
          mimeType,
          width: source.width,
          height: source.height,
          sha256: await session.sha256Hex(blob),
        }),
      });
      const circleProbes = [];
      for (const asset of suite.assets) {
        if (!asset.name.includes("circle")) continue;
        const probe = await alphaProbe(new Blob([asset.bytes], { type: "image/png" }));
        circleProbes.push({
          name: asset.name.replace(/^.*variant-1-/, ""),
          decoded: [probe.width, probe.height],
          circular: circular(probe),
        });
      }
      results.suite = {
        assetNames: suite.assets.map((a) => a.name.replace(/^.*variant-1-/, "")),
        notes: suite.notes,
        filename: suite.filename,
        circleProbes,
        manifestHasNotes: suite.manifestText.includes("== Notes =="),
        manifestQuantized: suite.manifestText.includes("palette-quantized PNG, corners transparent"),
        recordProduction: [suite.recordInput.production.width, suite.recordInput.production.height],
      };
      return results;
    });

    console.log(JSON.stringify(result, null, 2));

    const p = result.primary;
    check(
      "primary export is a circular ICON_SIZE=512 PNG carrying the encoder's encoding",
      p.iconSize === 512 &&
        p.reported[0] === 512 &&
        p.reported[1] === 512 &&
        p.decoded[0] === 512 &&
        p.decoded[1] === 512 &&
        p.mimeType === "image/png" &&
        p.sha256Len === 64 &&
        p.encoding === "quantized" &&
        p.circular,
    );
    check(
      "full-resolution + 512 + 256 render circular from one decode",
      result.sizes.length === 3 &&
        [800, 512, 256].every(
          (size, i) =>
            result.sizes[i].reported[0] === size &&
            result.sizes[i].decoded[0] === size &&
            result.sizes[i].decoded[1] === size &&
            result.sizes[i].circular,
        ),
    );
    check(
      "SVG source falls back to <img> decode and exports circular 512",
      result.svgFallback.decoded[0] === 512 &&
        result.svgFallback.decoded[1] === 512 &&
        result.svgFallback.circular,
    );
    check(
      "detach-then-throw encoder degrades to a valid circular canvas PNG (encoding raw)",
      result.rawFallback.encoding === "raw" &&
        String(result.rawFallback.encodeError).includes("encoder exploded") &&
        result.rawFallback.detachedLength === 0 &&
        result.rawFallback.decoded[0] === 512 &&
        result.rawFallback.circular,
      JSON.stringify(result.rawFallback),
    );
    check(
      "4K exporter smoke: render + readback + encode completes at 4096",
      result.fourK.reported[0] === 4096 &&
        result.fourK.encoding === "quantized" &&
        result.fourK.elapsed < 60_000,
      JSON.stringify(result.fourK),
    );
    const s = result.suite;
    check(
      "suite composition: raw + circle-full/512/256, optimized skipped by only-if-smaller",
      JSON.stringify(s.assetNames) ===
        JSON.stringify(["raw.png", "circle-full.png", "circle-512.png", "circle-256.png"]) &&
        s.notes.some((n) => n.includes("could not beat")) &&
        s.manifestHasNotes &&
        s.manifestQuantized &&
        s.filename.endsWith("-glass-icon-variant-1-icon-suite.zip"),
    );
    check(
      "suite circles decode circular at 800/512/256",
      s.circleProbes.length === 3 &&
        s.circleProbes[0].decoded[0] === 800 &&
        s.circleProbes[1].decoded[0] === 512 &&
        s.circleProbes[2].decoded[0] === 256 &&
        s.circleProbes.every((probe) => probe.circular),
    );
    check(
      "suite provenance records the shipped 512 circle",
      s.recordProduction[0] === 512 && s.recordProduction[1] === 512,
    );
    await page.close();
  } finally {
    server.close();
  }
}

// =========================================================================================
// Stage 2: the real production bundle under ?mock=1 — download the suite ZIP.
// The dist server here is deliberately headerless: proving the wasm worker under the REAL
// public/_headers CSP is verify-compress.mjs's job; this stage proves the export pipeline.
// =========================================================================================
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

function serveDist() {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = join(distDir, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function stage2(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const server = await serveDist();
  const { port } = server.address();
  try {
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log(`  [console.error] ${msg.text()}`);
    });
    await page.goto(`http://127.0.0.1:${port}/app/?mock=1`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Set up a run");

    // Icon-family mock run (SVG placeholders at the default 1K size → 1024px sources).
    await page.getByText("Icons", { exact: true }).click();
    await page.waitForSelector("text=Icon background");
    await page.getByLabel("Subject prompt").fill("a circular suite verification icon");
    await page.getByRole("button", { name: "Generate" }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="status"]')].some((el) => {
          const t = el.textContent ?? "";
          return t.includes("succeeded") && !t.includes("running") && !t.includes("queued");
        }),
      undefined,
      { timeout: 30_000 },
    );

    // Focus the first candidate; open the split button's size menu; download the suite.
    await page.locator("[data-candidate] button").first().click();
    await page.waitForSelector("text=Status and cost");
    check(
      "split button (primary 512) is visible in the real app",
      await page.getByRole("button", { name: "Download circular icon · 512px" }).isVisible(),
    );
    await page.getByRole("button", { name: "More circular icon sizes" }).click();
    // The dropdown mounts with a transition — wait for an item before probing visibility.
    await page.getByRole("menuitem", { name: "Complete suite (ZIP)" }).waitFor({ timeout: 5_000 });
    check(
      "size menu offers full resolution, 256px, and the complete suite",
      (await page.getByRole("menuitem", { name: "Full resolution · 1024px" }).isVisible()) &&
        (await page.getByRole("menuitem", { name: "256px" }).isVisible()) &&
        (await page.getByRole("menuitem", { name: "Complete suite (ZIP)" }).isVisible()),
    );
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("menuitem", { name: "Complete suite (ZIP)" }).click();
    const download = await downloadPromise;
    const zipPath = await download.path();
    const zip = new Uint8Array(readFileSync(zipPath));

    check(
      "suite ZIP filename carries session + recipe + variant + icon-suite",
      /^byobanana-session-.+-variant-1-icon-suite\.zip$/.test(download.suggestedFilename()),
      download.suggestedFilename(),
    );

    const entries = parseZip(zip);
    const names = entries.map((e) => e.name.replace(/^01-.*-variant-1-/, ""));
    console.log(
      "suite entries:",
      entries.map((e) => `${e.name} (${e.bytes.byteLength} bytes)`).join(", "),
    );
    check(
      "suite ZIP entries: raw.svg + circle-full/512/256 + manifest.txt (no optimized for svg)",
      JSON.stringify(names) ===
        JSON.stringify(["raw.svg", "circle-full.png", "circle-512.png", "circle-256.png", "manifest.txt"]),
    );
    // Every entry carries a real modified date (the export moment), not the 1980 DOS epoch
    // the ported writer used to stamp: local and central header fields agree, and the decoded
    // year sits in a plausible window around today (not the epoch, not the 2107 clamp).
    const thisYear = new Date().getFullYear();
    const entryYears = entries.map((e) => 1980 + (e.dosDate >> 9));
    check(
      "suite ZIP entries carry a real modified date (not the 1980 DOS epoch)",
      entries.every((e) => e.dosDate > 0x21 && e.localDosMatches) &&
        entryYears.every((year) => year >= thisYear - 1 && year <= thisYear + 1),
      `years ${[...new Set(entryYears)].join(", ")}`,
    );
    const byName = new Map(entries.map((e) => [e.name.replace(/^01-.*-variant-1-/, ""), e.bytes]));
    check(
      "raw entry is the SVG source",
      new TextDecoder().decode(byName.get("raw.svg").subarray(0, 4)) === "<svg",
    );
    const full = pngInfo(byName.get("circle-full.png"));
    const mid = pngInfo(byName.get("circle-512.png"));
    const small = pngInfo(byName.get("circle-256.png"));
    check(
      "circle PNGs are valid, 1024 (full) / 512 / 256",
      full.valid &&
        mid.valid &&
        small.valid &&
        full.width === 1024 &&
        full.height === 1024 &&
        mid.width === 512 &&
        mid.height === 512 &&
        small.width === 256 &&
        small.height === 256,
      `full ${full.width}, mid ${mid.width}, small ${small.width}`,
    );
    // The quantization proof: the flat mock content MUST quantize, and a quantized circle
    // is an indexed (color type 3) PNG. A raw canvas render would be color type 6 (RGBA).
    check(
      "every suite circle is an indexed (color type 3) PNG — quantization ran end to end",
      full.colorType === 3 && mid.colorType === 3 && small.colorType === 3,
      `color types full ${full.colorType}, mid ${mid.colorType}, small ${small.colorType}`,
    );
    // Alpha survives quantization: decode the QUANTIZED bytes in the live page and probe
    // the corners (alpha 0) and center (alpha 255) of every circle.
    const alphaProbes = await page.evaluate(async (payload) => {
      const out = [];
      for (const b64 of payload) {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const alphaAt = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
        out.push({
          corners: [
            alphaAt(0, 0),
            alphaAt(bmp.width - 1, 0),
            alphaAt(0, bmp.height - 1),
            alphaAt(bmp.width - 1, bmp.height - 1),
          ],
          center: alphaAt(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2)),
        });
        bmp.close();
      }
      return out;
    }, [byName.get("circle-full.png"), byName.get("circle-512.png"), byName.get("circle-256.png")].map((b) => Buffer.from(b).toString("base64")));
    check(
      "quantized circles keep transparent corners and an opaque center",
      alphaProbes.every((probe) => probe.corners.every((a) => a === 0) && probe.center === 255),
      JSON.stringify(alphaProbes),
    );
    const manifestText = new TextDecoder().decode(byName.get("manifest.txt"));
    check(
      "manifest.txt notes the skipped optimized source (no codec for svg)",
      manifestText.includes("optimized source skipped: no codec for image/svg+xml."),
    );
    // The circles fall back (with a note) if the quantizer/oxipng worker fails or refuses —
    // a valid suite, but then this stage would prove nothing about the real wasm path.
    // Absence of BOTH fallback notes proves quantization genuinely ran for every circle.
    check(
      "no fallback notes: every circle quantized through the real worker",
      !manifestText.includes("shipped unoptimized") && !manifestText.includes("quantization skipped"),
    );
    check(
      "manifest.txt labels the quantized circular derivatives and the shared generation cost",
      manifestText.includes(
        "circular icon (full resolution, 1024×1024 palette-quantized PNG, corners transparent)",
      ) &&
        manifestText.includes("circular icon (512×512 palette-quantized PNG, corners transparent)") &&
        manifestText.includes("shares the raw source's generation cost"),
    );

    // The suite records ONE export event.
    await page.waitForSelector("text=Exported 1 time.", { timeout: 10_000 });
    check("suite recorded exactly one export event", true);

    // Consumer 2: the single "Download circular icon · 512px" — previously a raw canvas
    // PNG (color type 6), now the quantized palette PNG.
    const singlePromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "Download circular icon · 512px" }).click();
    const single = await singlePromise;
    const singleBytes = new Uint8Array(readFileSync(await single.path()));
    const singleInfo = pngInfo(singleBytes);
    check(
      "single 512 download is a 512×512 indexed (color type 3) PNG",
      /-icon-512\.png$/.test(single.suggestedFilename()) &&
        singleInfo.valid &&
        singleInfo.width === 512 &&
        singleInfo.height === 512 &&
        singleInfo.colorType === 3,
      `${single.suggestedFilename()} colorType ${singleInfo.colorType}`,
    );
    await page.waitForSelector("text=Exported 2 times.", { timeout: 10_000 });

    // Consumer 3: the classic per-candidate ZIP — the production 512 circle quantizes too.
    const zipPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "Download candidate as ZIP" }).click();
    const classicZip = parseZip(new Uint8Array(readFileSync(await (await zipPromise).path())));
    const classicCircle = classicZip.find((e) => /^01-.*-variant-1\.png$/.test(e.name));
    const classicInfo = classicCircle ? pngInfo(classicCircle.bytes) : { valid: false, colorType: -1 };
    check(
      "classic bundle's production circle is a 512×512 indexed (color type 3) PNG",
      classicInfo.valid && classicInfo.width === 512 && classicInfo.height === 512 && classicInfo.colorType === 3,
      `colorType ${classicInfo.colorType}`,
    );
    const classicManifest = classicZip.find((e) => e.name === "manifest.txt");
    check(
      "classic manifest names palette quantization on the production icon",
      classicManifest !== undefined &&
        new TextDecoder()
          .decode(classicManifest.bytes)
          .includes("production icon (512×512 circular palette-quantized PNG, corners transparent)"),
    );
    await page.waitForSelector("text=Exported 3 times.", { timeout: 10_000 });
    await page.close();
  } finally {
    server.close();
    await context.close();
  }
}

async function main() {
  // Build by default so stage 2 never tests a stale dist/; --no-build reuses an existing one
  // (same convention as screenshot.mjs).
  if (process.argv.includes("--no-build")) {
    if (!existsSync(join(distDir, "app", "index.html"))) {
      console.error("dist/ is missing; run `npm run build` first or drop --no-build.");
      process.exit(2);
    }
  } else {
    await new Promise((resolve, reject) => {
      const child = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
    });
  }

  const browser = await chromium.launch({ headless: true });
  try {
    await stage1(browser);
    await stage2(browser);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
