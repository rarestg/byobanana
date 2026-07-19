import { describe, expect, it } from "vitest";

import {
  MAX_REFERENCE_COUNT,
  addReferences,
  detectImageMimeType,
  moveReference,
  type IncomingReference,
  type StagedReference,
} from "./references";

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const GIF_MAGIC = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
const WEBP_MAGIC = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]); // RIFF....WEBP

function bytesOf(prefix: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(Math.max(prefix.length, size));
  out.set(prefix);
  return out;
}

// A minimal File stand-in: node 20+ has global File, but we control size directly.
function fakeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name);
}

function incoming(name: string, magic: Uint8Array, size = 1024): IncomingReference {
  return { name, file: fakeFile(name, size), bytes: bytesOf(magic, magic.length) };
}

let idCounter = 0;
const makeId = () => `ref-${++idCounter}`;
const makeUrl = () => "blob:mock";

describe("detectImageMimeType", () => {
  it("recognizes png/jpeg/webp/gif by magic bytes", () => {
    expect(detectImageMimeType(PNG_MAGIC)).toBe("image/png");
    expect(detectImageMimeType(JPEG_MAGIC)).toBe("image/jpeg");
    expect(detectImageMimeType(WEBP_MAGIC)).toBe("image/webp");
    expect(detectImageMimeType(GIF_MAGIC)).toBe("image/gif");
  });

  it("rejects non-image bytes and truncated headers", () => {
    expect(detectImageMimeType(new Uint8Array([0x00, 0x01, 0x02]))).toBeUndefined();
    expect(detectImageMimeType(new Uint8Array([0x89, 0x50]))).toBeUndefined();
    // RIFF without WEBP (e.g. a WAV) is not accepted.
    const riffWav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectImageMimeType(riffWav)).toBeUndefined();
  });
});

describe("addReferences", () => {
  it("accepts a valid image and stages it with sniffed mime + fresh id/url", () => {
    const { accepted, rejected } = addReferences([], [incoming("a.png", PNG_MAGIC)], makeId, makeUrl);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ name: "a.png", mimeType: "image/png", url: "blob:mock" });
  });

  it("rejects a file whose bytes are not an allowed image (MIME sniff, not extension)", () => {
    const fake: IncomingReference = {
      name: "evil.png",
      file: fakeFile("evil.png", 1024),
      bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
    };
    const { accepted, rejected } = addReferences([], [fake], makeId, makeUrl);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/PNG, JPEG, WebP, or GIF/);
  });

  it("rejects a reference over the 20 MB per-file limit", () => {
    const big: IncomingReference = {
      name: "big.png",
      file: fakeFile("big.png", 21 * 1024 * 1024),
      bytes: PNG_MAGIC,
    };
    const { accepted, rejected } = addReferences([], [big], makeId, makeUrl);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/20 MB/);
  });

  it("rejects additions past the 14-reference count cap", () => {
    const existing: StagedReference[] = Array.from({ length: MAX_REFERENCE_COUNT }, (_v, i) => ({
      id: `e-${i}`,
      name: `e-${i}.png`,
      mimeType: "image/png" as const,
      file: fakeFile(`e-${i}.png`, 1024),
      url: "blob:x",
    }));
    const { accepted, rejected } = addReferences(existing, [incoming("more.png", PNG_MAGIC)], makeId, makeUrl);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/At most 14/);
  });

  it("rejects an addition that would exceed the 100 MB total", () => {
    const existing: StagedReference[] = [
      {
        id: "e0",
        name: "e0.png",
        mimeType: "image/png",
        file: fakeFile("e0.png", 90 * 1024 * 1024),
        url: "blob:x",
      },
    ];
    const big: IncomingReference = {
      name: "b.png",
      file: fakeFile("b.png", 15 * 1024 * 1024),
      bytes: PNG_MAGIC,
    };
    const { accepted, rejected } = addReferences(existing, [big], makeId, makeUrl);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/100 MB total/);
  });
});

describe("moveReference", () => {
  it("moves up and down, and no-ops at the boundaries", () => {
    const list = ["a", "b", "c"];
    expect(moveReference(list, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveReference(list, 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveReference(list, 0, -1)).toBe(list); // boundary no-op returns same ref
    expect(moveReference(list, 2, 1)).toBe(list);
  });
});
