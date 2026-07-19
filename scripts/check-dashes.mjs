// Dash gate: the site bans em/en dashes in public copy (literal OR HTML-entity form).
// Scans every built STATIC HTML file under dist/ for literal em/en dashes and their entity
// spellings, and exits non-zero on any hit. Run after `npm run build` (which populates dist/):
//   npm run build && node scripts/check-dashes.mjs   (or: npm run check:dashes)
// Scope is the static landing + guide HTML (the em-dash ban is a public-copy rule). It does not
// parse React-rendered app copy, which is governed by its own component tests (e.g. verify-tabs.mjs).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");

// Literal em/en dash + every entity form: named (with or without the trailing `;`), decimal and
// hex numeric (leading zeros, upper/lowercase x and hex digits). U+2013 en, U+2014 em. Each entity
// form carries a termination guard so a longer token (e.g. &mdashword, &#82110;, &#x20130;) that
// merely starts with a dash spelling is NOT flagged.
const BANNED =
  /[–—]|&(?:mdash|ndash)(?![a-zA-Z])|&#0*(?:8211|8212)(?!\d)|&#[xX]0*201[34](?![0-9a-fA-F])/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".html")) out.push(p);
  }
  return out;
}

let hits = 0;
for (const file of walk(distDir)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const found = line.match(BANNED);
    if (found) {
      hits += found.length;
      console.error(`${relative(root, file)}:${i + 1}: ${found.join(" ")}  ${line.trim().slice(0, 100)}`);
    }
  });
}

if (hits > 0) {
  console.error(`\ncheck-dashes: ${hits} banned dash(es) in built HTML. Rewrite the copy without dashes.`);
  process.exit(1);
}
console.log("check-dashes: no em/en dashes (literal or entity) in built HTML.");
