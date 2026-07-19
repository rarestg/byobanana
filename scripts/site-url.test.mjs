// Tests for the deploy-time site-origin substitution (scripts/site-url.mjs). The no-op property
// is load-bearing: the author's build must stay byte-for-byte identical when SITE_URL is unset.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BAKED_ORIGIN,
  resolveSiteUrl,
  prodHost,
  rewriteText,
  rewriteDist,
} from "./site-url.mjs";

describe("resolveSiteUrl", () => {
  it("defaults to the baked origin when SITE_URL is unset", () => {
    expect(resolveSiteUrl({})).toBe(BAKED_ORIGIN);
  });
  it("strips a trailing slash so paths never double up", () => {
    expect(resolveSiteUrl({ SITE_URL: "https://example.com/" })).toBe("https://example.com");
  });
  it("passes a clean origin through unchanged", () => {
    expect(resolveSiteUrl({ SITE_URL: "https://example.com" })).toBe("https://example.com");
  });
  it("throws on a non-URL value", () => {
    expect(() => resolveSiteUrl({ SITE_URL: "not a url" })).toThrow();
  });
  it("rejects a non-http(s) scheme", () => {
    expect(() => resolveSiteUrl({ SITE_URL: "ftp://example.com" })).toThrow();
  });
  it("rejects a path (must be a bare origin)", () => {
    expect(() => resolveSiteUrl({ SITE_URL: "https://example.com/app" })).toThrow();
  });
  it("rejects query, fragment, and credentials", () => {
    expect(() => resolveSiteUrl({ SITE_URL: "https://example.com?a=1" })).toThrow();
    expect(() => resolveSiteUrl({ SITE_URL: "https://example.com#x" })).toThrow();
    expect(() => resolveSiteUrl({ SITE_URL: "https://user:pass@example.com" })).toThrow();
  });
});

describe("prodHost", () => {
  it("returns the hostname the Worker compares against", () => {
    expect(prodHost("https://example.com")).toBe("example.com");
  });
  it("drops a port (the Worker compares url.hostname, which has none)", () => {
    expect(prodHost("http://localhost:8787")).toBe("localhost");
  });
});

describe("rewriteText", () => {
  const sample = `<link rel="canonical" href="${BAKED_ORIGIN}/" />
<meta property="og:image" content="${BAKED_ORIGIN}/og.png" />
<loc>${BAKED_ORIGIN}/guides/x/</loc>
Sitemap: ${BAKED_ORIGIN}/sitemap.xml`;

  it("is byte-identical when the origin equals the baked origin (no-op)", () => {
    expect(rewriteText(sample, BAKED_ORIGIN)).toBe(sample);
  });
  it("swaps every occurrence, preserving each path and fragment", () => {
    const out = rewriteText(sample, "https://example.com");
    expect(out).not.toContain("byobanana.com");
    expect(out).toContain('href="https://example.com/"');
    expect(out).toContain('content="https://example.com/og.png"');
    expect(out).toContain("<loc>https://example.com/guides/x/</loc>");
    expect(out).toContain("Sitemap: https://example.com/sitemap.xml");
  });
});

describe("rewriteDist", () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "site-url-"));
    mkdirSync(join(dir, "guides", "g"), { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), `<link href="${BAKED_ORIGIN}/" />`);
    writeFileSync(join(dir, "guides", "g", "index.html"), `<loc>${BAKED_ORIGIN}/guides/g/</loc>`);
    writeFileSync(join(dir, "robots.txt"), `Sitemap: ${BAKED_ORIGIN}/sitemap.xml`);
    writeFileSync(join(dir, "sitemap.xml"), `<loc>${BAKED_ORIGIN}/</loc>`);
    // A binary/hashed asset that happens to name the brand must never be touched.
    writeFileSync(join(dir, "assets", "app-abc123.js"), `filename=\`byobanana-1.zip\``);
    return dir;
  }

  it("changes nothing under the default origin (no-op)", () => {
    const dir = fixture();
    try {
      expect(rewriteDist(dir, BAKED_ORIGIN)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites only html/xml/txt and leaves js/assets alone", () => {
    const dir = fixture();
    try {
      const changed = rewriteDist(dir, "https://example.com").sort();
      expect(changed).toEqual([
        "/guides/g/index.html",
        "/index.html",
        "/robots.txt",
        "/sitemap.xml",
      ]);
      // The js bundle is untouched.
      expect(readFileSync(join(dir, "assets", "app-abc123.js"), "utf8")).toContain("byobanana-1.zip");
      // A second pass is a no-op (idempotent).
      expect(rewriteDist(dir, "https://example.com")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
