// Deploy-time site-origin substitution. The source HTML/xml/txt bakes the author's origin
// (https://byobanana.com) into canonical/OG/JSON-LD URLs, the sitemap <loc>s, and the robots
// Sitemap: line. A fork that deploys elsewhere must ship those pointing at ITS own origin, or it
// self-noindexes (see build-worker.mjs) and leaks canonicals back to the author's site.
//
// This module rewrites the baked origin across dist/ to SITE_URL (env var). It is a pure
// dist-level transform — the source stays byobanana.com. When SITE_URL is unset (or equals the
// baked origin) the replacement is byte-for-byte identical: a guaranteed no-op, so the author's
// build is unchanged and CI's `npm run build` never mutates dist.
//
// Used two ways:
//   - run as a build step (`node scripts/site-url.mjs`, wired into `npm run build`) to rewrite dist, and
//   - imported by scripts/build-worker.mjs, which reads only the URL derivation (resolveSiteUrl +
//     prodHost) to embed the deployer's production host in the generated Worker.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The origin literally present in the committed source (index.html, guides, sitemap, robots).
export const BAKED_ORIGIN = "https://byobanana.com";

// Only these text types carry the origin; binaries (og.png) and hashed /assets/* bundles never do.
const TEXT_EXT = new Set([".html", ".xml", ".txt"]);

// Resolve the target origin from SITE_URL. Returns a bare origin (scheme + host [+ port], no path),
// so it maps 1:1 onto the baked origin and forkers cannot ship a broken canonical. Rejects anything
// that is not a clean http(s) origin (path, query, fragment, or credentials) with a clear message
// rather than silently dropping it. Defaults to the baked origin ⇒ byte-identical no-op.
export function resolveSiteUrl(env = process.env) {
  const raw = (env.SITE_URL ?? BAKED_ORIGIN).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SITE_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`SITE_URL must be http(s): ${JSON.stringify(raw)}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error(
      `SITE_URL must be a bare origin (no path/query/fragment/credentials): ${JSON.stringify(raw)}`,
    );
  }
  return url.origin;
}

// PROD_HOST for the generated Worker's host-aware noindex + www→apex + preview-redirect target.
// The Worker compares request `url.hostname` (no port), so derive the hostname to match it.
export function prodHost(origin) {
  return new URL(origin).hostname;
}

// Replace the baked origin with `origin` in one text string. Origin-only (no trailing slash on
// either side) so every "https://byobanana.com/<path>" and the bare "https://byobanana.com"
// rewrite correctly while keeping their paths/fragments intact.
export function rewriteText(text, origin) {
  return origin === BAKED_ORIGIN ? text : text.split(BAKED_ORIGIN).join(origin);
}

// Rewrite every text asset under distDir in place. Returns the list of changed relative paths
// (empty ⇒ true no-op). Idempotent: a second pass finds no baked origin and changes nothing.
export function rewriteDist(distDir, origin) {
  const changed = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const dot = entry.lastIndexOf(".");
      if (dot < 0 || !TEXT_EXT.has(entry.slice(dot))) continue;
      const before = readFileSync(full, "utf8");
      const after = rewriteText(before, origin);
      if (after !== before) {
        writeFileSync(full, after);
        changed.push("/" + relative(distDir, full).split("\\").join("/"));
      }
    }
  };
  walk(distDir);
  return changed;
}

// CLI entry (the `node scripts/site-url.mjs` step in `npm run build`): rewrite ./dist to SITE_URL.
// pathToFileURL handles checkout paths with spaces or other characters that percent-encode in a
// file: URL (a naive `file://${argv[1]}` compare silently skips the rewrite → a fork ships the
// author's canonicals).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const origin = resolveSiteUrl();
  const changed = rewriteDist(join(root, "dist"), origin);
  if (origin === BAKED_ORIGIN) {
    console.log(`site-url: SITE_URL=${origin} (default) — no rewrite needed`);
  } else {
    console.log(`site-url: rewrote origin → ${origin} in ${changed.length} file(s)`);
    for (const p of changed) console.log("  " + p);
  }
}
