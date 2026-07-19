// Real headless-Chromium verification of src/core/idbRepository.ts against a REAL browser
// IndexedDB — the durable path that fake-indexeddb (used by the vitest suite) only approximates.
//
// fake-indexeddb cannot round-trip jsdom Blobs and is not the real transaction engine, so this
// script exercises the actual contract in Chromium:
//   1. bundles idbRepository.ts (+ recipes/palettes helpers) with esbuild (window.NB),
//   2. serves it from http://127.0.0.1 (a secure context, so crypto.subtle / sha256Hex works),
//   3. Phase 1: open the DB, create a session with a reference blob, start two candidates,
//      write one candidate's SUCCEEDED result (with an image blob), leave the other RUNNING,
//      then close the connection — persisting {dbName, ids} in localStorage,
//   4. reloads the page (a genuine reload — IndexedDB must survive it),
//   5. Phase 2: reopen the DB, assert the manifest + both blobs persisted and the running
//      candidate is still running, then run recover() and assert it flips to interrupted.
//
// Run:  node scripts/verify-idb.mjs
// Requires a Playwright Chromium (e.g. `npx playwright install chromium`).
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const require = createRequire(import.meta.url);

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
      // fall through to discovered roots
    }
    for (const root of roots) {
      try {
        return createRequire(join(root, "index.js"))(specifier).chromium;
      } catch {
        // try the next root
      }
    }
  }
  console.error("Playwright is not installed. Run `npx playwright install chromium` first.");
  process.exit(2);
}

const chromium = loadChromium();
const coreDir = fileURLToPath(new URL("../src/core", import.meta.url));

const bundle = await build({
  stdin: {
    contents: `
      export { IdbSessionRepository } from "./idbRepository";
      export { loadRecipes, renderRecipe } from "./recipes";
      export { COLOR_PALETTES } from "./palettes";
    `,
    resolveDir: coreDir,
    loader: "ts",
    sourcefile: "idb-smoke-entry.ts",
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

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);

  // Phase 1: write, then close the connection.
  await page.evaluate(async () => {
    const { IdbSessionRepository, loadRecipes, renderRecipe, COLOR_PALETTES } = window.NB;
    const dbName = `smoke-${Math.random().toString(36).slice(2)}`;
    const palette = COLOR_PALETTES[0];
    const recipe = loadRecipes().find((r) => r.id === "geometric-isometric-icon");
    const subject = "Headless IDB smoke subject.";
    const refBytes = [1, 2, 3, 4, 5];
    const imgBytes = [9, 8, 7, 6];

    const repo = await IdbSessionRepository.open({ dbName });
    const created = await repo.createSession({
      subject,
      palette,
      backgroundColor: "#FAFAFA",
      settings: { modelId: "gemini-3.1-flash-image", size: "1K", aspectRatio: "1:1", googleSearch: false, variantsPerRecipe: 2, callCount: 2 },
      estimate: { status: "estimated", usd: 0.1, excludesGrounding: false },
      confirmation: { required: false, acknowledged: false, reasons: [] },
      references: [{ name: "ref.png", mimeType: "image/png", blob: new Blob([new Uint8Array(refBytes)], { type: "image/png" }) }],
      arms: [{ id: "arm-1", recipe, renderedPrompt: renderRecipe(recipe, subject, palette, "#FAFAFA"), variants: 2 }],
    });
    const c1 = created.arms[0].candidates[0].id;
    const c2 = created.arms[0].candidates[1].id;
    await repo.startCandidate(created.id, c1);
    await repo.startCandidate(created.id, c2);
    await repo.writeCandidateResult(created.id, c2, {
      status: "succeeded",
      images: [{ blob: new Blob([new Uint8Array(imgBytes)], { type: "image/png" }), mimeType: "image/png", width: 1024, height: 1024, sha256: "" }],
      text: ["ok"],
      cost: { status: "calculated", usd: 0.04, excludesGrounding: false },
    });
    repo.close();
    localStorage.setItem("smoke", JSON.stringify({ dbName, sessionId: created.id, c1, c2, refBytes, imgBytes }));
  });

  // A genuine reload — real IndexedDB must survive it.
  await page.reload();

  const result = await page.evaluate(async () => {
    const { IdbSessionRepository } = window.NB;
    const { dbName, sessionId, c1, c2, refBytes, imgBytes } = JSON.parse(localStorage.getItem("smoke"));
    const repo = await IdbSessionRepository.open({ dbName });

    const persisted = await repo.getSession(sessionId);
    const candidates = persisted.arms[0].candidates;
    const succeeded = candidates.find((c) => c.id === c2);
    const refRecord = persisted.references[0];
    const refBlob = await repo.getBlob(refRecord.blobId);
    const imgBlob = await repo.getBlob(succeeded.images[0].blobId);
    const refRound = [...new Uint8Array(await refBlob.arrayBuffer())];
    const imgRound = [...new Uint8Array(await imgBlob.arrayBuffer())];

    const beforeRecover = candidates.find((c) => c.id === c1).status;

    await repo.recover();
    const afterManifest = await repo.getSession(sessionId);
    const afterC1 = afterManifest.arms[0].candidates.find((c) => c.id === c1);
    repo.close();

    return {
      subjectPersisted: persisted.subject === "Headless IDB smoke subject.",
      backgroundPersisted: persisted.backgroundColor === "#FAFAFA",
      succeededStatus: succeeded.status,
      refRoundTrip: JSON.stringify(refRound) === JSON.stringify(refBytes),
      imgRoundTrip: JSON.stringify(imgRound) === JSON.stringify(imgBytes),
      runningBeforeRecover: beforeRecover,
      interruptedAfterRecover: afterC1.status,
      recoverBilling: afterC1.cancellation ? afterC1.cancellation.billing : null,
      sessionStatusAfter: afterManifest.status,
    };
  });

  console.log(JSON.stringify(result, null, 2));

  const ok =
    result.subjectPersisted &&
    result.backgroundPersisted &&
    result.succeededStatus === "succeeded" &&
    result.refRoundTrip &&
    result.imgRoundTrip &&
    result.runningBeforeRecover === "running" &&
    result.interruptedAfterRecover === "interrupted" &&
    result.recoverBilling === "unknown-may-be-charged" &&
    result.sessionStatusAfter === "partial";

  console.log(
    ok
      ? "PASS: real-browser IndexedDB round-trip survives reload; interrupted-run recovery works"
      : "FAIL",
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
