/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Absolute base: the site is always served at a domain root (byobanana.com /
// *.workers.dev), and the static landing document references /theme-init.js and
// /landing.css by absolute path.
export default defineConfig({
  base: "/",
  plugins: [react()],
  // Multi-page build: the crawlable landing (index.html, no React) and the standalone
  // workbench document (app/index.html → dist/app/index.html, which loads the React bundle).
  // Both share the same hashed /assets/* chunks (absolute URLs, base "/").
  build: {
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        app: new URL("./app/index.html", import.meta.url).pathname,
      },
    },
  },
  // The compression worker (src/core/compressWorker.ts) code-splits its codecs via dynamic
  // import(); Vite's default worker format ("iife") rejects code-splitting builds outright.
  worker: { format: "es" },
  // Dev-only: esbuild pre-bundling breaks the jSquash packages' `new URL(..., import.meta.url)`
  // wasm references; excluding them serves the packages (and their wasm) as-is.
  // libimagequant-wasm is excluded for the same worker-loaded-wasm reason (its glue is
  // imported with an explicit ?url wasm asset).
  optimizeDeps: { exclude: ["@jsquash/jpeg", "@jsquash/oxipng", "libimagequant-wasm"] },
  test: {
    globals: true,
    // Pure core modules run under node (native Blob/Uint8Array/WebCrypto — no jsdom
    // realm quirks). Component tests opt into jsdom per-file with a
    // `// @vitest-environment jsdom` header; the setup file's DOM shims are guarded
    // so they no-op under node.
    environment: "node",
    setupFiles: "./vitest.setup.ts",
    // The Workbench drive-throughs run a whole mock session (generate, queue drain, coalesced
    // history refresh, drawer) and allow a 4s `waitFor` for "2 succeeded" alone — most of
    // vitest's 5s default budget, leaving no room for the assertions that follow. Measured
    // under CPU saturation, a correct run of the heaviest one still takes ~5.5s, so the
    // default budget was too small for legitimate work. (It also masked a real bug: that
    // test bound to the wrong role="status" region — fixed at the call site.)
    testTimeout: 20_000,
  },
});
