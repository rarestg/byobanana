// Node-testable parts of the optimized-download path (P13): the codec matrix, the label/hint
// copy, the per-blobId single-flight cache (incl. rejected-entry eviction → retry), and the
// "-web" filename composition. The worker/wasm pixel path is exercised by
// scripts/verify-compress.mjs in a real headless Chromium against the production build.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  JPEG_QUALITY,
  cachedCompression,
  clearCompressionCache,
  compressedFor,
  compressionHint,
  compressionLabel,
  compressionPlan,
  encodeIconPng,
} from "./compress";
import { extensionForMime, singleDownloadName } from "./exportBundle";
import type { GeneratedImage } from "./session";

function result(size: number, mimeType = "image/jpeg"): GeneratedImage {
  return {
    blob: new Blob([new Uint8Array(size)], { type: mimeType }),
    mimeType,
    width: 64,
    height: 64,
    sha256: "x".repeat(64),
  };
}

describe("compressionPlan (codec matrix)", () => {
  it("re-encodes any JPEG with mozjpeg, staying JPEG", () => {
    expect(compressionPlan("image/jpeg", "image")).toEqual({ codec: "mozjpeg", outputMime: "image/jpeg" });
    expect(compressionPlan("image/jpeg", "icon")).toEqual({ codec: "mozjpeg", outputMime: "image/jpeg" });
  });

  it("plans image-family PNG as lossy JPEG (the alpha guard may still flip it at runtime)", () => {
    expect(compressionPlan("image/png", "image")).toEqual({ codec: "mozjpeg", outputMime: "image/jpeg" });
  });

  it("keeps icon-family PNG lossless PNG (oxipng)", () => {
    expect(compressionPlan("image/png", "icon")).toEqual({ codec: "oxipng", outputMime: "image/png" });
  });

  it("offers no compressed option for webp/svg/unknown mimes", () => {
    expect(compressionPlan("image/webp", "image")).toBeUndefined();
    expect(compressionPlan("image/svg+xml", "image")).toBeUndefined();
    expect(compressionPlan("image/gif", "icon")).toBeUndefined();
    expect(compressionPlan("", "image")).toBeUndefined();
  });
});

describe("compression copy", () => {
  it("labels by output mime (self-describing, honest)", () => {
    expect(compressionLabel("image/jpeg")).toBe("Smaller JPEG");
    expect(compressionLabel("image/png")).toBe("Optimized PNG");
  });

  it("hints lossy (with the quality) vs lossless", () => {
    expect(compressionHint("image/jpeg")).toBe(`The compressed JPEG is a lossy re-encode (quality ${JPEG_QUALITY}).`);
    expect(compressionHint("image/png")).toBe("The optimized PNG is lossless.");
  });
});

describe("compressedFor cache", () => {
  beforeEach(() => clearCompressionCache());

  it("is single-flight per blobId and caches the settled result", async () => {
    const produce = vi.fn(async () => result(10));
    const [a, b] = await Promise.all([
      compressedFor("blob-1", produce),
      compressedFor("blob-1", produce),
    ]);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(await compressedFor("blob-1", produce)).toBe(a);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("keys by blobId (different candidates never share results)", async () => {
    const one = vi.fn(async () => result(10));
    const two = vi.fn(async () => result(20));
    await compressedFor("blob-1", one);
    await compressedFor("blob-2", two);
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
    expect(cachedCompression("blob-1")?.size).toBe(10);
    expect(cachedCompression("blob-2")?.size).toBe(20);
  });

  it("evicts a rejected entry so a retry produces again and succeeds", async () => {
    const produce = vi
      .fn<() => Promise<GeneratedImage>>()
      .mockRejectedValueOnce(new Error("worker died"))
      .mockResolvedValueOnce(result(10));
    await expect(compressedFor("blob-1", produce)).rejects.toThrow("worker died");
    expect(cachedCompression("blob-1")).toBeUndefined();
    await expect(compressedFor("blob-1", produce)).resolves.toMatchObject({ mimeType: "image/jpeg" });
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("exposes the settled size + mime synchronously (label backfill / only-if-smaller)", async () => {
    expect(cachedCompression("blob-1")).toBeUndefined();
    await compressedFor("blob-1", async () => result(321, "image/png"));
    expect(cachedCompression("blob-1")).toEqual({ size: 321, mimeType: "image/png" });
  });
});

describe("encodeIconPng (node-side contract)", () => {
  it("rejects cleanly when no Worker exists (the sync post-failure path), so image.ts can degrade to the canvas PNG", async () => {
    // Node has no Worker: getWorker() throws synchronously inside postJob, which must
    // reject (never hang or strand a pending entry). The worker/wasm pixel path itself is
    // exercised by scripts/verify-compress.mjs in a real Chromium.
    const data = { data: { buffer: new ArrayBuffer(4) }, width: 1, height: 1 } as ImageData;
    await expect(encodeIconPng(data)).rejects.toThrow();
  });
});

describe("compressed download filename", () => {
  it("composes subject-style-variant with the -web suffix and the RESULT's extension", () => {
    expect(singleDownloadName("A friendly robot", "hard-edge", 2, "-web", extensionForMime("image/jpeg"))).toBe(
      "A-friendly-robot-hard-edge-variant-2-web.jpeg",
    );
    // Alpha-guarded result stays PNG — the extension follows the actual output mime.
    expect(singleDownloadName("A friendly robot", "hard-edge", 2, "-web", extensionForMime("image/png"))).toBe(
      "A-friendly-robot-hard-edge-variant-2-web.png",
    );
  });
});
