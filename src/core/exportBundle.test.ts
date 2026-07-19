import { describe, expect, test, vi } from "vitest";

import { COLOR_PALETTES } from "./palettes";
import { loadRecipes } from "./recipes";
import {
  buildExportBundle,
  buildIconSuiteBundle,
  buildManifestText,
  bundleExportInputs,
  candidateBaseName,
  createPayloadCap,
  extensionForMime,
  ICON_SUITE_SIZES,
  MAX_DOWNLOAD_CANDIDATES,
  sanitizeName,
  singleDownloadName,
  type IconRenderer,
  type IconSuiteDeps,
} from "./exportBundle";
import type { CircularIcon } from "./image";
import {
  InMemorySessionRepository,
  type CreateSessionInput,
  type GeneratedImage,
  type GenerationResult,
  sha256Hex,
} from "./session";

const decoder = new TextDecoder();

const iconRecipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;
const imageRecipe = loadRecipes().find((entry) => entry.id === "hard-edge-geometric-screenprint")!;

// Deterministic per-family bytes so tests can assert which bytes land in each ZIP entry.
const iconRawBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const imageRawBytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
const productionBytes = new Uint8Array([42, 42, 42, 42]);

function blob(bytes: Uint8Array<ArrayBuffer>, type: string): Blob {
  return new Blob([bytes], { type });
}

// A renderIcon stub: a 512×512 quantized PNG carrying `productionBytes`, so the icon path is
// exercised (ordering, ZIP entry, manifest labeling, recordExport) without a real browser
// canvas or the codec worker.
async function stubRenderIcon(_source: Blob): Promise<CircularIcon> {
  const b = blob(productionBytes, "image/png");
  return {
    blob: b,
    mimeType: "image/png",
    width: 512,
    height: 512,
    sha256: await sha256Hex(b),
    encoding: "quantized",
  };
}

// Same stub with a fallback encoding (quality floor unreachable / worker failure).
function stubRenderIconAs(
  encoding: CircularIcon["encoding"],
  encodeError?: string,
): IconRenderer {
  return async (_source) => ({
    ...(await stubRenderIcon(_source)),
    encoding,
    ...(encodeError === undefined ? {} : { encodeError }),
  });
}

const failingRenderIcon: IconRenderer = () => Promise.reject(new Error("should not be called"));

function succeeded(image: GeneratedImage): GenerationResult {
  return {
    status: "succeeded",
    images: [image],
    text: [],
    cost: { status: "calculated", usd: 0.0672, excludesGrounding: false },
    modelVersion: "gemini-3.1-flash-image-preview",
  };
}

const baseInput: Omit<CreateSessionInput, "arms"> = {
  subject: "A curious fox",
  palette: COLOR_PALETTES[0],
  settings: {
    modelId: "gemini-3.1-flash-image",
    size: "1K",
    googleSearch: false,
    variantsPerRecipe: 1,
    callCount: 2,
  },
  estimate: { status: "estimated", usd: 0.13, excludesGrounding: false },
  confirmation: { required: false, acknowledged: false, reasons: [] },
  references: [],
};

// A repo + manifest with one succeeded square icon candidate and one succeeded image candidate.
async function seed() {
  const repo = new InMemorySessionRepository();
  await repo.createSession({
    ...baseInput,
    arms: [
      { id: "arm-icon", recipe: iconRecipe, renderedPrompt: "Render an icon of a fox", variants: 1 },
      { id: "arm-image", recipe: imageRecipe, renderedPrompt: "Render a poster of a fox", variants: 1 },
    ],
  });
  const [manifest] = await repo.listSessions();
  const sessionId = manifest.id;

  const iconId = "candidate-arm-icon-1";
  const imageId = "candidate-arm-image-1";
  await repo.startCandidate(sessionId, iconId);
  await repo.writeCandidateResult(
    sessionId,
    iconId,
    succeeded({
      blob: blob(iconRawBytes, "image/png"),
      mimeType: "image/png",
      width: 512,
      height: 512,
      sha256: await sha256Hex(blob(iconRawBytes, "image/png")),
    }),
  );
  await repo.startCandidate(sessionId, imageId);
  await repo.writeCandidateResult(
    sessionId,
    imageId,
    succeeded({
      blob: blob(imageRawBytes, "image/jpeg"),
      mimeType: "image/jpeg",
      width: 1024,
      height: 640,
      sha256: await sha256Hex(blob(imageRawBytes, "image/jpeg")),
    }),
  );

  const final = (await repo.getSession(sessionId))!;
  return { repo, manifest: final, sessionId, iconId, imageId };
}

interface ParsedEntry {
  name: string;
  bytes: Uint8Array;
}

// Minimal stored-ZIP reader: walks central directory to map name → local data.
function parseZip(zip: Uint8Array): ParsedEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 8, true);
  const centralOffset = view.getUint32(end + 16, true);
  const entries: ParsedEntry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    // Local header: 30 bytes fixed + name + extra, then data.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtra;
    entries.push({ name, bytes: zip.subarray(dataStart, dataStart + size) });
    offset += 46 + nameLength;
  }
  return entries;
}

describe("filename helpers", () => {
  test("sanitizeName collapses unsafe chars, trims, falls back", () => {
    expect(sanitizeName("geometric isometric/icon")).toBe("geometric-isometric-icon");
    expect(sanitizeName("  ***  ")).toBe("candidate");
    expect(sanitizeName("a".repeat(200)).length).toBe(120);
  });

  test("extensionForMime maps known types, defaults to .bin (jpeg not jpg)", () => {
    expect(extensionForMime("image/jpeg")).toBe(".jpeg");
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("application/x-thing")).toBe(".bin");
  });

  test("candidateBaseName is 1-based, zero-padded, sanitized", () => {
    expect(candidateBaseName(0, "my recipe", 3)).toBe("01-my-recipe-variant-3");
    expect(candidateBaseName(9, "r", 1)).toBe("10-r-variant-1");
  });

  test("singleDownloadName includes subject, style, variant, suffix", () => {
    expect(singleDownloadName("A curious fox!", "style-x", 2, "-raw", ".png")).toBe(
      "A-curious-fox-style-x-variant-2-raw.png",
    );
  });
});

describe("buildExportBundle", () => {
  test("icons ship a production PNG, images ship byte-identical raw; ordered + named", async () => {
    const { repo, manifest, iconId, imageId } = await seed();
    const bundle = await buildExportBundle(repo, manifest, [imageId, iconId], stubRenderIcon);

    // Variant-major, then manifest arm order: icon arm precedes image arm at variant 1.
    expect(bundle.assets.map((a) => a.candidateId)).toEqual([iconId, imageId]);
    expect(bundle.assets.map((a) => a.name)).toEqual([
      "01-geometric-isometric-icon-variant-1.png",
      "02-hard-edge-geometric-screenprint-variant-1.jpeg",
    ]);

    const [icon, image] = bundle.assets;
    expect(icon.family).toBe("icon");
    expect(icon.bytes).toEqual(productionBytes); // production, not raw
    expect(icon.production).toBeDefined();
    expect(image.family).toBe("image");
    expect(image.bytes).toEqual(imageRawBytes); // byte-identical raw
    expect(image.production).toBeUndefined();

    const entries = parseZip(bundle.zip);
    expect(entries.map((e) => e.name)).toEqual([
      "01-geometric-isometric-icon-variant-1.png",
      "02-hard-edge-geometric-screenprint-variant-1.jpeg",
      "manifest.txt",
    ]);
    expect(entries[0].bytes).toEqual(productionBytes);
    expect(entries[1].bytes).toEqual(imageRawBytes);
    expect(bundle.filename).toBe(`byobanana-${manifest.id}.zip`);
  });

  test("manifest.txt carries source TSV lines + lineage with hashes", async () => {
    const { repo, manifest, iconId, imageId } = await seed();
    const bundle = await buildExportBundle(repo, manifest, [iconId, imageId], stubRenderIcon);
    const text = bundle.manifestText;

    expect(text.startsWith(`BYOBanana download: ${manifest.id}`)).toBe(true);
    // Source-compatible TSV line, hash = file (production) hash for the icon.
    const prodSha = bundle.assets[0].sha256;
    expect(text).toContain(
      `01-geometric-isometric-icon-variant-1.png\t${iconRecipe.name}\tvariant 1\tsha256 ${prodSha}`,
    );
    // Lineage: recipe + prompt hashes + rendered prompt.
    const iconArm = manifest.arms.find((a) => a.id === "arm-icon")!;
    expect(text).toContain(`recipe sha256: ${iconArm.recipeSha256}`);
    expect(text).toContain(`prompt sha256: ${iconArm.promptSha256}`);
    expect(text).toContain("Render an icon of a fox");
    // Production vs raw clearly labeled; quantization named because the renderer quantized.
    expect(text).toContain(
      "production icon (512×512 circular palette-quantized PNG, corners transparent)",
    );
    expect(text).toContain("raw image (byte-identical to the generated image)");
    // Cost + subject + model.
    expect(text).toContain("$0.0672");
    expect(text).toContain("Subject: A curious fox");
    expect(text).toContain("Model: gemini-3.1-flash-image");
    // Both raw + production hashes present for the icon.
    expect(text).toContain(`raw image sha256: ${bundle.assets[0].raw.sha256}`);
    expect(text).toContain(`production sha256: ${bundle.assets[0].production!.sha256}`);
  });

  test("a fallback (non-quantized) production icon never claims palette quantization", async () => {
    const { repo, manifest, iconId } = await seed();
    const bundle = await buildExportBundle(repo, manifest, [iconId], stubRenderIconAs("lossless"));
    expect(bundle.manifestText).toContain(
      "production icon (512×512 circular PNG, corners transparent)",
    );
    expect(bundle.manifestText).not.toContain("palette-quantized");
    // The owner spec reserves the Notes register for the suite manifest.
    expect(bundle.manifestText).not.toContain("== Notes ==");
  });

  test("only succeeded candidates are exportable", async () => {
    const { repo, sessionId } = await seed();
    // Add a failed candidate by folding a failed result into a fresh session arm.
    await repo.createSession({
      ...baseInput,
      arms: [{ id: "arm-x", recipe: imageRecipe, renderedPrompt: "p", variants: 1 }],
    });
    const failed = (await repo.listSessions()).find((s) => s.id !== sessionId)!;
    await repo.startCandidate(failed.id, "candidate-arm-x-1");
    await repo.writeCandidateResult(failed.id, "candidate-arm-x-1", {
      status: "failed",
      images: [],
      text: [],
      cost: { status: "unavailable", excludesGrounding: false },
      error: "boom",
    });
    const failedManifest = (await repo.getSession(failed.id))!;
    await expect(
      buildExportBundle(repo, failedManifest, ["candidate-arm-x-1"], stubRenderIcon),
    ).rejects.toThrow(/succeeded/i);
  });

  test("rejects >24, duplicate, and unknown selections without touching the canvas", async () => {
    const { repo, manifest, iconId } = await seed();
    const many = Array.from({ length: MAX_DOWNLOAD_CANDIDATES + 1 }, (_v, i) => `c-${i}`);
    await expect(buildExportBundle(repo, manifest, many, failingRenderIcon)).rejects.toThrow(/1–24/);
    await expect(
      buildExportBundle(repo, manifest, [iconId, iconId], failingRenderIcon),
    ).rejects.toThrow(/unique/i);
    await expect(
      buildExportBundle(repo, manifest, ["nope"], failingRenderIcon),
    ).rejects.toThrow(/Unknown candidate/);
  });

  test("enforces the 256 MiB payload cap on declared bytes (fail-fast)", async () => {
    // Hand-crafted manifest whose declared image bytes exceed the cap; the pre-check throws
    // before any Blob is read, so the fake repo's getBlob is never reached.
    const huge = 300 * 1024 * 1024;
    const fakeManifest = {
      ...(await seed()).manifest,
    };
    fakeManifest.arms[0].candidates[0].images = [
      {
        id: "im",
        blobId: "b",
        mimeType: "image/png",
        bytes: huge,
        width: 512,
        height: 512,
        sha256: "x",
      },
    ];
    const fakeRepo = {
      getBlob: () => Promise.reject(new Error("must not read blob")),
    } as unknown as InMemorySessionRepository;
    await expect(
      buildExportBundle(fakeRepo, fakeManifest, ["candidate-arm-icon-1"], failingRenderIcon),
    ).rejects.toThrow(/256 MiB/);
  });

  test("re-verifies stored bytes against the manifest sha256", async () => {
    const { repo, manifest, iconId, imageId } = await seed();
    // Corrupt the recorded sha for the image candidate; the export must refuse it.
    const tampered = structuredClone(manifest);
    const arm = tampered.arms.find((a) => a.id === "arm-image")!;
    arm.candidates[0].images[0].sha256 = "deadbeef";
    await expect(
      buildExportBundle(repo, tampered, [iconId, imageId], stubRenderIcon),
    ).rejects.toThrow(/no longer matches/i);
  });

  test("recordExport folds every exported candidate into manifest.exports", async () => {
    const { repo, manifest, iconId, imageId } = await seed();
    const bundle = await buildExportBundle(repo, manifest, [iconId, imageId], stubRenderIcon);
    let latest = manifest;
    for (const input of bundleExportInputs(bundle)) {
      latest = await repo.recordExport(manifest.id, input);
    }
    expect(latest.exports).toHaveLength(2);
    expect(latest.exports.filter((e) => e.candidateId === iconId)).toHaveLength(1);
    // The icon export persisted both raw and production; the image export raw only.
    const iconExport = latest.exports.find((e) => e.candidateId === iconId)!;
    expect(iconExport.production).toBeDefined();
    const imageExport = latest.exports.find((e) => e.candidateId === imageId)!;
    expect(imageExport.production).toBeUndefined();
  });
});

describe("buildIconSuiteBundle", () => {
  // Seed one succeeded icon candidate with the given source dims/mime/bytes.
  async function seedIcon(
    width: number,
    mimeType = "image/png",
    bytes: Uint8Array<ArrayBuffer> = iconRawBytes as Uint8Array<ArrayBuffer>,
  ) {
    const repo = new InMemorySessionRepository();
    await repo.createSession({
      ...baseInput,
      arms: [{ id: "arm-icon", recipe: iconRecipe, renderedPrompt: "Render an icon", variants: 1 }],
    });
    const [summary] = await repo.listSessions();
    const candidateId = "candidate-arm-icon-1";
    await repo.startCandidate(summary.id, candidateId);
    const b = blob(bytes, mimeType);
    await repo.writeCandidateResult(
      summary.id,
      candidateId,
      succeeded({ blob: b, mimeType, width, height: width, sha256: await sha256Hex(b) }),
    );
    const manifest = (await repo.getSession(summary.id))!;
    return { repo, manifest, candidateId };
  }

  // Deterministic circle stub: a PNG whose byte length equals size/8 (distinct per target),
  // finished by the (stubbed) encoder — quantized by default, or any fallback encoding.
  function stubRenderIconsAs(
    encoding: CircularIcon["encoding"],
    encodeError?: string,
  ): NonNullable<IconSuiteDeps["renderIcons"]> {
    return (_source, sizes) =>
      Promise.all(
        sizes.map(async (size) => {
          const b = blob(new Uint8Array(size / 8).fill(7), "image/png");
          return {
            blob: b,
            mimeType: "image/png",
            width: size,
            height: size,
            sha256: await sha256Hex(b),
            encoding,
            ...(encodeError === undefined ? {} : { encodeError }),
          };
        }),
      );
  }
  const stubRenderIcons = stubRenderIconsAs("quantized");

  // A compressor stub returning `size` bytes for every call (smaller/bigger than the inputs
  // above by choice), or throwing when size is "fail".
  function stubCompress(size: number | "fail"): NonNullable<IconSuiteDeps["compress"]> {
    return async (_blob, _mime, _family, source) => {
      if (size === "fail") throw new Error("worker down");
      const b = blob(new Uint8Array(size).fill(9), "image/png");
      return {
        blob: b,
        mimeType: "image/png",
        width: source.width,
        height: source.height,
        sha256: await sha256Hex(b),
      };
    };
  }

  test("fixed suite targets are the primary size plus 256", () => {
    expect(ICON_SUITE_SIZES).toEqual([512, 256]);
  });

  test("full composition for a 1024 PNG source: raw, optimized, three circles, manifest", async () => {
    const { repo, manifest, candidateId } = await seedIcon(1024);
    const bundle = await buildIconSuiteBundle(repo, manifest, candidateId, {
      renderIcons: stubRenderIcons,
      compress: stubCompress(2), // 2 bytes: beats raw AND every stubbed circle
    });

    expect(bundle.assets.map((a) => a.name)).toEqual([
      "01-geometric-isometric-icon-variant-1-raw.png",
      "01-geometric-isometric-icon-variant-1-optimized.png",
      "01-geometric-isometric-icon-variant-1-circle-full.png",
      "01-geometric-isometric-icon-variant-1-circle-512.png",
      "01-geometric-isometric-icon-variant-1-circle-256.png",
    ]);
    expect(bundle.notes).toEqual([]);
    expect(bundle.filename).toBe(
      `byobanana-${manifest.id}-geometric-isometric-icon-variant-1-icon-suite.zip`,
    );

    // Raw is byte-identical; the optimized source ships the codec's (smaller) bytes; the
    // circles ship the renderer's FINISHED (quantized) bytes. Every derivative's
    // asset.production carries EXACTLY the shipped bytes.
    const [raw, optimized, ...circles] = bundle.assets;
    expect(raw.bytes).toEqual(iconRawBytes);
    expect(raw.production).toBeUndefined();
    expect(optimized.bytes.byteLength).toBe(2);
    expect(circles.map((c) => c.bytes.byteLength)).toEqual([1024 / 8, 512 / 8, 256 / 8]);
    for (const asset of [optimized, ...circles]) {
      expect(asset.production!.sha256).toBe(asset.sha256);
      expect(new Uint8Array(await asset.production!.blob.arrayBuffer())).toEqual(asset.bytes);
    }

    // The ZIP carries the assets plus manifest.txt.
    expect(parseZip(bundle.zip).map((e) => e.name)).toEqual([
      ...bundle.assets.map((a) => a.name),
      "manifest.txt",
    ]);

    // Manifest register: content labels (quantization named — the renderer quantized),
    // shared-cost honesty, real cost only on the raw line.
    expect(bundle.manifestText).toContain("raw source (byte-identical to the generated image)");
    expect(bundle.manifestText).toContain("optimized source (lossless oxipng; smaller than raw)");
    expect(bundle.manifestText).toContain(
      "circular icon (full resolution, 1024×1024 palette-quantized PNG, corners transparent)",
    );
    expect(bundle.manifestText).toContain(
      "circular icon (512×512 palette-quantized PNG, corners transparent)",
    );
    expect(bundle.manifestText).toContain(
      "circular icon (256×256 palette-quantized PNG, corners transparent)",
    );
    expect(bundle.manifestText).toContain("shares the raw source's generation cost");
    expect(bundle.manifestText.match(/\$0\.0672/g)).toHaveLength(1);
    expect(bundle.manifestText).not.toContain("== Notes ==");

    // Provenance: ONE record, raw + the shipped 512 circle.
    expect(bundle.recordInput.candidateId).toBe(candidateId);
    expect(bundle.recordInput.raw.sha256).toBe(raw.sha256);
    expect(bundle.recordInput.production!.width).toBe(512);
    expect(bundle.recordInput.production!.sha256).toBe(
      bundle.assets.find((a) => a.name.endsWith("circle-512.png"))!.sha256,
    );
  });

  test("a 512 source skips circle-full with a note (no duplicate of circle-512)", async () => {
    const { repo, manifest, candidateId } = await seedIcon(512);
    const bundle = await buildIconSuiteBundle(repo, manifest, candidateId, {
      renderIcons: stubRenderIcons,
      compress: stubCompress(10_000), // never smaller: optimized source skipped
    });
    expect(bundle.assets.map((a) => a.name.replace(/^.*variant-1-/, ""))).toEqual([
      "raw.png",
      "circle-512.png",
      "circle-256.png",
    ]);
    expect(bundle.notes).toContain(
      "circle-full skipped: the source is exactly 512px, identical to circle-512.",
    );
    expect(bundle.notes).toContain(
      "optimized source skipped: compression could not beat the raw bytes.",
    );
    expect(bundle.manifestText).toContain("== Notes ==");
    // Circles ship the renderer's finished bytes.
    const circle512 = bundle.assets.find((a) => a.name.endsWith("circle-512.png"))!;
    expect(circle512.bytes.byteLength).toBe(512 / 8);
    expect(bundle.recordInput.production!.sha256).toBe(circle512.sha256);
  });

  test("a quality-floor fallback ships lossless circles with the honest note", async () => {
    const { repo, manifest, candidateId } = await seedIcon(1024);
    const bundle = await buildIconSuiteBundle(repo, manifest, candidateId, {
      renderIcons: stubRenderIconsAs("lossless"),
      compress: stubCompress(2),
    });
    expect(bundle.assets.map((a) => a.name.replace(/^.*variant-1-/, ""))).toEqual([
      "raw.png",
      "optimized.png",
      "circle-full.png",
      "circle-512.png",
      "circle-256.png",
    ]);
    expect(bundle.notes).toContain(
      "circle-full quantization skipped: below quality floor; shipped lossless.",
    );
    expect(bundle.notes).toContain(
      "circle-512 quantization skipped: below quality floor; shipped lossless.",
    );
    expect(bundle.notes).toContain(
      "circle-256 quantization skipped: below quality floor; shipped lossless.",
    );
    // Content lines stay plain: no palette-quantization claim on fallback.
    expect(bundle.manifestText).toContain(
      "circular icon (512×512 PNG, corners transparent)",
    );
    expect(bundle.manifestText).not.toContain("palette-quantized");
  });

  test("codec-worker failures degrade best-effort: suite still builds, with notes", async () => {
    const { repo, manifest, candidateId } = await seedIcon(1024);
    const bundle = await buildIconSuiteBundle(repo, manifest, candidateId, {
      renderIcons: stubRenderIconsAs("raw", "worker down"),
      compress: stubCompress("fail"),
    });
    expect(bundle.assets.map((a) => a.name.replace(/^.*variant-1-/, ""))).toEqual([
      "raw.png",
      "circle-full.png",
      "circle-512.png",
      "circle-256.png",
    ]);
    expect(bundle.notes).toContain("optimized source skipped: compression failed (worker down).");
    expect(bundle.notes).toContain("circle-full shipped unoptimized: compression failed (worker down).");
    expect(bundle.notes).toContain("circle-512 shipped unoptimized: compression failed (worker down).");
    expect(bundle.notes).toContain("circle-256 shipped unoptimized: compression failed (worker down).");
    expect(bundle.manifestText).not.toContain("palette-quantized");
  });

  test("a source outside the codec matrix (svg) skips the optimized entry with a note", async () => {
    const { repo, manifest, candidateId } = await seedIcon(1024, "image/svg+xml");
    const compress = vi.fn(stubCompress(2));
    const bundle = await buildIconSuiteBundle(repo, manifest, candidateId, {
      renderIcons: stubRenderIcons,
      compress,
    });
    expect(bundle.assets.map((a) => a.name.replace(/^.*variant-1-/, ""))).toEqual([
      "raw.svg",
      "circle-full.png",
      "circle-512.png",
      "circle-256.png",
    ]);
    expect(bundle.notes).toContain("optimized source skipped: no codec for image/svg+xml.");
    // The optimized-source codec never runs for svg, and the circles are finished by the
    // renderer's encoder — the compress seam is untouched.
    expect(compress).not.toHaveBeenCalled();
  });

  test("rejects non-icon, non-succeeded, unknown, and non-square candidates", async () => {
    const { repo, manifest } = await seed();
    await expect(
      buildIconSuiteBundle(repo, manifest, "candidate-arm-image-1", { renderIcons: stubRenderIcons }),
    ).rejects.toThrow(/icon-family/);
    await expect(
      buildIconSuiteBundle(repo, manifest, "nope", { renderIcons: stubRenderIcons }),
    ).rejects.toThrow(/Unknown candidate/);

    const nonSquare = structuredClone(manifest);
    nonSquare.arms[0].candidates[0].images[0].height = 640;
    await expect(
      buildIconSuiteBundle(repo, nonSquare, "candidate-arm-icon-1", { renderIcons: stubRenderIcons }),
    ).rejects.toThrow(/square source image/);

    const queued = structuredClone(manifest);
    queued.arms[0].candidates[0].status = "queued";
    await expect(
      buildIconSuiteBundle(repo, queued, "candidate-arm-icon-1", { renderIcons: stubRenderIcons }),
    ).rejects.toThrow(/succeeded/);
  });

  test("refuses an oversized DECLARED source before reading any bytes (fail-fast)", async () => {
    const { manifest, candidateId } = await seedIcon(1024);
    const tampered = structuredClone(manifest);
    tampered.arms[0].candidates[0].images[0].bytes = 300 * 1024 * 1024;
    const fakeRepo = {
      getBlob: () => Promise.reject(new Error("must not read blob")),
    } as unknown as InMemorySessionRepository;
    await expect(
      buildIconSuiteBundle(fakeRepo, tampered, candidateId, {
        renderIcons: stubRenderIcons,
        compress: stubCompress("fail"),
      }),
    ).rejects.toThrow(/icon suite exceeds 256 MiB \(raw source\)/);
  });

  test("createPayloadCap enforces the cumulative shipped-payload limit with the entry label", () => {
    // The pure accounting seam the suite ships every payload through — unit-tested at a
    // tiny byte limit so the cap path needs no multi-hundred-MiB allocations.
    const ship = createPayloadCap(100);
    expect(ship(new Uint8Array(60), "raw source")).toBeInstanceOf(Uint8Array);
    expect(ship(new Uint8Array(39), "circle-full")).toBeInstanceOf(Uint8Array);
    expect(() => ship(new Uint8Array(2), "circle-512")).toThrow(
      /The icon suite exceeds .* MiB \(circle-512\)\./,
    );
  });
});

describe("buildManifestText", () => {
  test("omits the References section when there are none", async () => {
    const { manifest } = await seed();
    const text = buildManifestText(manifest, []);
    expect(text).not.toContain("== References ==");
    expect(text).toContain("Exported files: 0");
  });

  test("includes the Background line only for runs that rendered one", async () => {
    const { manifest } = await seed();
    // Historical / non-background sessions: no line at all.
    expect(buildManifestText(manifest, [])).not.toContain("Background:");
    const withBackground = structuredClone(manifest);
    withBackground.backgroundColor = "#18181B";
    expect(buildManifestText(withBackground, [])).toContain("Background: #18181B");
  });
});
