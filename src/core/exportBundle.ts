// Browser export bundle — the ZIPs the user downloads. Ports nano-banana-2's
// store.ts `prepareDownloadAssets` + server.ts download handler, but assembled fully in the
// browser (no server, no disk). Per selected candidate: the RAW generated image is included
// byte-identical, and for the icon family a PRODUCTION circular PNG at the primary ICON_SIZE
// (image.ts; quantized per the owner policy, see image.ts) is generated and included instead
// of the raw as the primary asset. A `manifest.txt` carries the run lineage.
// `buildIconSuiteBundle` assembles the richer single-candidate icon suite (raw + optimized
// source + circular renders at several sizes). Every ZIP is built with the ported
// dependency-free `createStoredZip`.

import { compressImage, compressionPlan, JPEG_QUALITY } from "./compress";
import {
  type CircularIcon,
  exportCircularIcon,
  exportCircularIcons,
  ICON_SIZE,
} from "./image";
import { recipeFamily } from "./recipes";
import {
  type ArmRecord,
  type CandidateRecord,
  type ExportInput,
  type GeneratedImage,
  type ImageMeta,
  type SessionManifest,
  type SessionRepository,
  sha256Hex,
} from "./session";
import { createStoredZip } from "./zip";

// Source parity: store.ts MAX_DOWNLOAD_CANDIDATES / MAX_DOWNLOAD_ASSET_BYTES.
export const MAX_DOWNLOAD_CANDIDATES = 24;
export const MAX_DOWNLOAD_ASSET_BYTES = 256 * 1024 * 1024;

// Ported from store.ts extensionForMime.
export function extensionForMime(mimeType: string): string {
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpeg",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/svg+xml": ".svg",
    }[mimeType] ?? ".bin"
  );
}

// Ported from store.ts sanitizeName (basename() dropped — recipe ids/variants have no path
// separators, and any that appear are collapsed to "-" anyway).
export function sanitizeName(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || "candidate";
}

// A ZIP entry base name matching source prepareDownloadAssets: a 1-based, zero-padded index
// keeps entries ordered + collision-free even when two candidates share recipe+variant.
export function candidateBaseName(index: number, recipeId: string, variant: number): string {
  const prefix = String(index + 1).padStart(2, "0");
  return `${prefix}-${sanitizeName(recipeId)}-variant-${sanitizeName(String(variant))}`;
}

// A readable single-file download name (subject + style + variant), for the inspector's
// per-candidate raw / production downloads where there is no index to order by.
export function singleDownloadName(
  subject: string,
  recipeId: string,
  variant: number,
  suffix: string,
  extension: string,
): string {
  const subjectPart = sanitizeName(subject).slice(0, 60) || "subject";
  return `${subjectPart}-${sanitizeName(recipeId)}-variant-${sanitizeName(String(variant))}${suffix}${extension}`;
}

export interface ExportAsset {
  candidateId: string;
  recipeId: string;
  recipeName: string;
  variant: number;
  family: "image" | "icon";
  // The ZIP entry name + its bytes: the production PNG for icons, the raw image otherwise.
  name: string;
  bytes: Uint8Array;
  sha256: string;
  // The raw image (+ optional production) as GeneratedImages, so the caller can persist the
  // export through repo.recordExport after the download is triggered. `production` always
  // carries the EXACT shipped bytes of the entry when it is a derivative.
  raw: GeneratedImage;
  production?: GeneratedImage;
  // Suite entries self-describe (raw / optimized / circular render); absent for the classic
  // bundle, whose label derives from the family.
  content?: string;
  // Suite derivatives share the raw source's single generation cost — the manifest must not
  // read as if each file was billed. Absent, the candidate's own cost line renders.
  costLabel?: string;
}

export interface ExportBundle {
  filename: string;
  // Backed by its own ArrayBuffer (createStoredZip allocates a fresh one) so it drops straight
  // into a Blob without a copy.
  zip: Uint8Array<ArrayBuffer>;
  manifestText: string;
  assets: ExportAsset[];
}

// Injectable so node tests exercise ordering/limits/zip/manifest without a real canvas.
export type IconRenderer = (source: Blob) => Promise<CircularIcon>;

// Content-line honesty for a circular render: name palette quantization only when it
// actually happened. Fallback renders keep the plain (still truthful) wording — the suite's
// Notes register carries the why; the owner spec adds no note to other manifests.
function circleContentLabel(icon: CircularIcon): string {
  return icon.encoding === "quantized" ? "palette-quantized PNG" : "PNG";
}

function costLine(usd: number | undefined, status: string | undefined): string {
  if (typeof usd === "number") {
    const prefix = status === "upper-bound" ? "Up to " : "";
    return `${prefix}$${usd.toFixed(4)}`;
  }
  if (status === "unavailable") return "Unavailable";
  return "Not recorded";
}

// The bundle manifest.txt. Opens with the download manifest (header + a tab-separated line per
// asset, hash = the FILE hash) that mirrors the Node tool's shape — the header line now carries
// the BYOBanana product name (P17 rename), so it is no longer byte-identical to the old tool's
// output — then appends the richer lineage the brief calls for: subject, model/settings, per-arm
// recipe name + recipe/prompt sha256 + rendered prompt, reference inputs, and per-file
// status/cost/mime/dims/sha256 with production-vs-raw labeled. The icon suite passes `notes`
// (skipped/unoptimized entries), appended as their own block.
export function buildManifestText(
  manifest: SessionManifest,
  assets: ExportAsset[],
  options: { notes?: string[] } = {},
): string {
  const settings = manifest.settings;
  const armById = new Map(manifest.arms.map((arm) => [arm.id, arm]));
  const candidateArm = new Map<string, string>();
  for (const arm of manifest.arms) {
    for (const candidate of arm.candidates) candidateArm.set(candidate.id, arm.id);
  }
  const findCandidate = (id: string) =>
    manifest.arms.flatMap((arm) => arm.candidates).find((candidate) => candidate.id === id);

  const lines: string[] = [];

  // TSV block (shape mirrors the Node tool's server.ts download handler).
  lines.push(`BYOBanana download: ${manifest.id}`);
  lines.push("");
  for (const asset of assets) {
    lines.push(`${asset.name}\t${asset.recipeName}\tvariant ${asset.variant}\tsha256 ${asset.sha256}`);
  }
  lines.push("");

  lines.push("== Run ==");
  lines.push(`Subject: ${manifest.subject}`);
  lines.push(`Model: ${settings.modelId}`);
  lines.push(`Size: ${settings.size}   Aspect: ${settings.aspectRatio ?? "default"}`);
  lines.push(
    `Variants per style: ${settings.variantsPerRecipe}   Google Search grounding: ${settings.googleSearch ? "on" : "off"}`,
  );
  lines.push(`Palette: ${manifest.palette?.name ?? "none"}`);
  // Background provenance only for runs that rendered one; historical sessions omit it.
  if (manifest.backgroundColor) lines.push(`Background: ${manifest.backgroundColor}`);
  lines.push(`Exported files: ${assets.length}`);
  lines.push("");

  if (manifest.references.length) {
    lines.push("== References ==");
    for (const reference of manifest.references) {
      lines.push(
        `${reference.order}. ${reference.originalName}\t${reference.mimeType}\t${reference.bytes} bytes\tsha256 ${reference.sha256}`,
      );
    }
    lines.push("");
  }

  // Only the arms represented by the exported assets, in manifest order.
  const exportedArmIds = new Set(assets.map((asset) => candidateArm.get(asset.candidateId)));
  lines.push("== Recipes ==");
  for (const arm of manifest.arms) {
    if (!exportedArmIds.has(arm.id)) continue;
    lines.push(`[${arm.recipe.id}] ${arm.recipe.name}`);
    lines.push(`  recipe sha256: ${arm.recipeSha256}`);
    lines.push(`  prompt sha256: ${arm.promptSha256}`);
    lines.push("  rendered prompt:");
    for (const promptLine of arm.renderedPrompt.split("\n")) lines.push(`    ${promptLine}`);
    lines.push("");
  }

  lines.push("== Files ==");
  for (const asset of assets) {
    const candidate = findCandidate(asset.candidateId);
    const arm = armById.get(candidateArm.get(asset.candidateId) ?? "");
    const content =
      asset.content ??
      (asset.family === "icon"
        ? `production icon (${ICON_SIZE}×${ICON_SIZE} circular PNG, corners transparent)`
        : "raw image (byte-identical to the generated image)");
    const dims = asset.production
      ? `${asset.production.width}×${asset.production.height}`
      : `${asset.raw.width}×${asset.raw.height}`;
    const mime = asset.production ? asset.production.mimeType : asset.raw.mimeType;
    lines.push(asset.name);
    lines.push(`  candidate: ${asset.candidateId}`);
    lines.push(`  style: ${arm?.recipe.name ?? asset.recipeName} · variant ${asset.variant}`);
    lines.push(`  content: ${content}`);
    lines.push(`  status: ${candidate?.status ?? "unknown"}`);
    if (candidate?.modelVersion) lines.push(`  model version: ${candidate.modelVersion}`);
    lines.push(
      `  cost: ${asset.costLabel ?? costLine(candidate?.cost?.usd, candidate?.cost?.status)}`,
    );
    lines.push(`  file type: ${mime}   dimensions: ${dims}   bytes: ${asset.bytes.byteLength}`);
    lines.push(`  raw image sha256: ${asset.raw.sha256}`);
    if (asset.production) lines.push(`  production sha256: ${asset.production.sha256}`);
    lines.push(`  file sha256: ${asset.sha256}`);
    lines.push("");
  }

  if (options.notes?.length) {
    lines.push("== Notes ==");
    for (const note of options.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  return lines.join("\n");
}

function rawGeneratedImage(image: ImageMeta, blob: Blob): GeneratedImage {
  return {
    blob,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
  };
}

function assertSelection(candidateIds: string[]): void {
  if (candidateIds.length < 1 || candidateIds.length > MAX_DOWNLOAD_CANDIDATES) {
    throw new Error(`Choose 1–${MAX_DOWNLOAD_CANDIDATES} candidates to download.`);
  }
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("Download candidates must be unique.");
  }
}

// Variant-major, then manifest arm order — matching source store.ts orderedCandidates
// (outer loop over variants, inner over arms) so the ZIP's NN- prefixes are stable and
// interleave styles at each variant, not all of one style then the next.
function orderedSelection(
  manifest: SessionManifest,
  selected: Set<string>,
): Array<{ arm: ArmRecord; candidate: CandidateRecord }> {
  const all = manifest.arms.flatMap((arm) =>
    arm.candidates.map((candidate) => ({ arm, candidate })),
  );
  const maxVariant = Math.max(
    manifest.settings.variantsPerRecipe,
    0,
    ...all.map(({ candidate }) => candidate.variant),
  );
  const ordered: Array<{ arm: ArmRecord; candidate: CandidateRecord }> = [];
  for (let variant = 1; variant <= maxVariant; variant++) {
    for (const arm of manifest.arms) {
      const candidate = arm.candidates.find((entry) => entry.variant === variant);
      if (candidate && selected.has(candidate.id)) ordered.push({ arm, candidate });
    }
  }
  return ordered;
}

// Assemble the download bundle for `candidateIds`. Ordered by manifest arm/candidate order
// (deterministic, matching source orderedCandidates), succeeded-only, limit-checked. `renderIcon`
// is injected so tests can assemble a real ZIP without a browser canvas.
export async function buildExportBundle(
  repo: SessionRepository,
  manifest: SessionManifest,
  candidateIds: string[],
  renderIcon: IconRenderer = exportCircularIcon,
): Promise<ExportBundle> {
  assertSelection(candidateIds);

  const selected = new Set(candidateIds);
  const ordered = orderedSelection(manifest, selected);

  const foundIds = new Set(ordered.map(({ candidate }) => candidate.id));
  for (const id of candidateIds) {
    if (!foundIds.has(id)) throw new Error(`Unknown candidate: ${id}`);
  }

  const limitMiB = MAX_DOWNLOAD_ASSET_BYTES / 1024 / 1024;

  // Fail-fast pre-check on the declared metadata bytes (source declaredBytes loop) before
  // reading any Blob. `actual` and `prepared` payloads are capped separately below.
  let declaredBytes = 0;
  for (const { candidate } of ordered) {
    if (candidate.status !== "succeeded") {
      throw new Error(`Only a succeeded candidate can be downloaded: ${candidate.id}`);
    }
    const image = candidate.images[0];
    if (!image) throw new Error(`Candidate has no image: ${candidate.id}`);
    if (!Number.isSafeInteger(image.bytes) || image.bytes < 0) {
      throw new Error(`Candidate image size is invalid: ${candidate.id}`);
    }
    declaredBytes += image.bytes;
    if (declaredBytes > MAX_DOWNLOAD_ASSET_BYTES) {
      throw new Error(`Selected images exceed ${limitMiB} MiB.`);
    }
  }

  const assets: ExportAsset[] = [];
  let rawBytes = 0;
  let preparedBytes = 0;

  for (const [index, { arm, candidate }] of ordered.entries()) {
    const image = candidate.images[0]!; // validated in the pre-check above
    const blob = await repo.getBlob(image.blobId);
    if (!blob) throw new Error(`Image bytes are unavailable: ${candidate.id}`);

    // Re-verify the stored bytes against the manifest (source verifiedCandidateSource
    // re-hashes before export) so a corrupted/mismatched Blob can't ship silently.
    if (blob.size !== image.bytes || (await sha256Hex(blob)) !== image.sha256) {
      throw new Error(`Stored image no longer matches the manifest: ${candidate.id}`);
    }

    rawBytes += blob.size;
    if (rawBytes > MAX_DOWNLOAD_ASSET_BYTES) {
      throw new Error(`Selected images exceed ${limitMiB} MiB.`);
    }

    const family = recipeFamily(arm.recipe);
    const raw = rawGeneratedImage(image, blob);
    const base = candidateBaseName(index, arm.recipe.id, candidate.variant);

    let asset: ExportAsset;
    if (family === "icon") {
      // Icons: square-source enforced by the renderer; the production PNG (quantized when
      // the encoder reached the quality floor) is the ZIP asset. The content line is fixed
      // HERE, while the renderer's encoding is still visible — ExportAsset.production
      // widens back to GeneratedImage.
      const production = await renderIcon(blob);
      if (production.width !== ICON_SIZE || production.height !== ICON_SIZE) {
        throw new Error(`Production icon has unexpected dimensions: ${candidate.id}`);
      }
      const bytes = new Uint8Array(await production.blob.arrayBuffer());
      asset = {
        candidateId: candidate.id,
        recipeId: arm.recipe.id,
        recipeName: arm.recipe.name,
        variant: candidate.variant,
        family,
        name: `${base}.png`,
        bytes,
        sha256: production.sha256,
        raw,
        production,
        content: `production icon (${ICON_SIZE}×${ICON_SIZE} circular ${circleContentLabel(production)}, corners transparent)`,
      };
    } else {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      asset = {
        candidateId: candidate.id,
        recipeId: arm.recipe.id,
        recipeName: arm.recipe.name,
        variant: candidate.variant,
        family,
        name: `${base}${extensionForMime(image.mimeType)}`,
        bytes,
        sha256: image.sha256,
        raw,
      };
    }

    preparedBytes += asset.bytes.byteLength;
    if (preparedBytes > MAX_DOWNLOAD_ASSET_BYTES) {
      throw new Error(`Prepared assets exceed ${limitMiB} MiB.`);
    }
    assets.push(asset);
  }

  const manifestText = buildManifestText(manifest, assets);
  const zip = createStoredZip([
    ...assets.map((asset) => ({ name: asset.name, bytes: asset.bytes })),
    { name: "manifest.txt", bytes: new TextEncoder().encode(manifestText) },
  ]);

  return {
    filename: `byobanana-${manifest.id}.zip`,
    zip,
    manifestText,
    assets,
  };
}

// The recordExport inputs for a built bundle (raw + optional production per asset).
export function bundleExportInputs(bundle: ExportBundle): ExportInput[] {
  return bundle.assets.map((asset) => ({
    candidateId: asset.candidateId,
    raw: asset.raw,
    production: asset.production,
  }));
}

// ---- Icon suite (one candidate) --------------------------------------------------------

// The fixed circular targets besides the source's own resolution: the primary size plus a
// small size. "Full resolution" is the source's square size and is planned per candidate.
export const ICON_SUITE_SIZES = [ICON_SIZE, 256];

// Injectable pixel/codec seams so node tests exercise composition, limits, zip, and manifest
// without a browser canvas or the WASM worker. `renderIcons` delivers FINISHED circle bytes
// (quantize + oxipng live inside the default renderer's encoder); `compress` serves only the
// optimized-source entry.
export interface IconSuiteDeps {
  renderIcons?: (source: Blob, sizes: number[]) => Promise<CircularIcon[]>;
  compress?: (
    blob: Blob,
    mimeType: string,
    family: "image" | "icon",
    source: { width: number; height: number },
  ) => Promise<GeneratedImage>;
}

export interface IconSuiteBundle {
  filename: string;
  zip: Uint8Array<ArrayBuffer>;
  manifestText: string;
  assets: ExportAsset[];
  // Skipped/unoptimized entries, also rendered into manifest.txt's Notes block.
  notes: string[];
  // The single provenance record for repo.recordExport: the suite is ONE export event
  // (raw + the shipped primary circle), so the visible export count increments once.
  recordInput: ExportInput;
}

const SHARED_COST_LABEL =
  "shares the raw source's generation cost (one generation, no additional charge)";

// Cumulative shipped-payload cap for the icon suite. A tiny pure seam so the accounting is
// unit-testable without materializing hundreds of MiB; the suite uses the real limit.
export function createPayloadCap(
  limitBytes: number,
): (bytes: Uint8Array, label: string) => Uint8Array {
  const limitMiB = limitBytes / 1024 / 1024;
  let total = 0;
  return (bytes, label) => {
    total += bytes.byteLength;
    if (total > limitBytes) {
      throw new Error(`The icon suite exceeds ${limitMiB} MiB (${label}).`);
    }
    return bytes;
  };
}

// Assemble the single-candidate icon suite ZIP: raw source bytes, an optimized source (only
// if the codec beats raw), and circular renders (full resolution + the fixed targets, each
// rendered DIRECTLY from the decoded source and quantized by the renderer's encoder —
// palette PNG + oxipng, lossless when the quality floor is unreachable, plain canvas PNG
// when the codec worker fails; the two fallbacks land in the Notes register). Derivatives
// are produced sequentially and every shipped payload counts against
// MAX_DOWNLOAD_ASSET_BYTES. Optimized-source compression failures degrade best-effort with
// a note; decode, render, verification, cap, and ZIP failures are fatal.
export async function buildIconSuiteBundle(
  repo: SessionRepository,
  manifest: SessionManifest,
  candidateId: string,
  deps: IconSuiteDeps = {},
): Promise<IconSuiteBundle> {
  const renderIcons = deps.renderIcons ?? exportCircularIcons;
  const compress = deps.compress ?? compressImage;
  const limitMiB = MAX_DOWNLOAD_ASSET_BYTES / 1024 / 1024;

  const found = manifest.arms
    .flatMap((arm) => arm.candidates.map((candidate) => ({ arm, candidate })))
    .find((entry) => entry.candidate.id === candidateId);
  if (!found) throw new Error(`Unknown candidate: ${candidateId}`);
  const { arm, candidate } = found;

  if (recipeFamily(arm.recipe) !== "icon") {
    throw new Error(`The icon suite is only available for icon-family candidates: ${candidateId}`);
  }
  if (candidate.status !== "succeeded") {
    throw new Error(`Only a succeeded candidate can be downloaded: ${candidateId}`);
  }
  const image = candidate.images[0];
  if (!image) throw new Error(`Candidate has no image: ${candidateId}`);
  if (!Number.isSafeInteger(image.bytes) || image.bytes < 0) {
    throw new Error(`Candidate image size is invalid: ${candidateId}`);
  }
  // Declared-size fail-fast (mirrors buildExportBundle): an oversized source is refused
  // BEFORE its bytes are read or hashed.
  if (image.bytes > MAX_DOWNLOAD_ASSET_BYTES) {
    throw new Error(`The icon suite exceeds ${limitMiB} MiB (raw source).`);
  }
  if (image.width !== image.height) {
    throw new Error(
      `Project-icon export requires a square source image (got ${image.width}×${image.height}).`,
    );
  }

  const blob = await repo.getBlob(image.blobId);
  if (!blob) throw new Error(`Image bytes are unavailable: ${candidateId}`);
  if (blob.size !== image.bytes || (await sha256Hex(blob)) !== image.sha256) {
    throw new Error(`Stored image no longer matches the manifest: ${candidateId}`);
  }

  const raw = rawGeneratedImage(image, blob);
  const base = candidateBaseName(0, arm.recipe.id, candidate.variant);
  const shared = {
    candidateId: candidate.id,
    recipeId: arm.recipe.id,
    recipeName: arm.recipe.name,
    variant: candidate.variant,
    family: "icon" as const,
    raw,
  };

  const assets: ExportAsset[] = [];
  const notes: string[] = [];
  const ship = createPayloadCap(MAX_DOWNLOAD_ASSET_BYTES);

  // 1. Raw source, byte-identical.
  assets.push({
    ...shared,
    name: `${base}-raw${extensionForMime(image.mimeType)}`,
    bytes: ship(new Uint8Array(await blob.arrayBuffer()), "raw source"),
    sha256: image.sha256,
    content: "raw source (byte-identical to the generated image)",
  });

  // 2. Optimized source — only when a codec exists AND the result beats raw. A compression
  // failure degrades to a note; the raw bytes are already in the suite.
  const plan = compressionPlan(image.mimeType, "icon");
  if (!plan) {
    notes.push(`optimized source skipped: no codec for ${image.mimeType}.`);
  } else {
    // The catch wraps ONLY the codec call: a compression failure degrades to a note, but
    // the cap check on the shipped bytes below stays fatal.
    let optimized: GeneratedImage | undefined;
    try {
      const result = await compress(blob, image.mimeType, "icon", image);
      if (result.blob.size >= blob.size) {
        notes.push("optimized source skipped: compression could not beat the raw bytes.");
      } else {
        optimized = result;
      }
    } catch (error) {
      notes.push(
        `optimized source skipped: compression failed (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    if (optimized) {
      assets.push({
        ...shared,
        name: `${base}-optimized${extensionForMime(optimized.mimeType)}`,
        bytes: ship(new Uint8Array(await optimized.blob.arrayBuffer()), "optimized source"),
        sha256: optimized.sha256,
        production: optimized,
        content:
          optimized.mimeType === "image/jpeg"
            ? `optimized source (lossy mozjpeg re-encode, quality ${JPEG_QUALITY}; smaller than raw)`
            : "optimized source (lossless oxipng; smaller than raw)",
        costLabel: SHARED_COST_LABEL,
      });
    }
  }

  // 3. Circular renders. Full resolution is the source's own square size; it is skipped when
  // it coincides with an included fixed target (it would be byte-duplicate work), and a fixed
  // target larger than the source is skipped (icons are never upsampled).
  const sourceSize = image.width;
  const fixedTargets = ICON_SUITE_SIZES.filter((target) => {
    if (target <= sourceSize) return true;
    notes.push(
      `circle-${target} skipped: the ${sourceSize}px source is smaller than ${target}px (icons are never upsampled).`,
    );
    return false;
  });
  const includeFull = !fixedTargets.includes(sourceSize);
  if (!includeFull) {
    notes.push(
      `circle-full skipped: the source is exactly ${sourceSize}px, identical to circle-${sourceSize}.`,
    );
  }
  const circleSizes = [...(includeFull ? [sourceSize] : []), ...fixedTargets];

  const rendered = await renderIcons(blob, circleSizes);
  const circles: CircularIcon[] = [];
  for (const circle of rendered) {
    // The renderer's encoder already quantized (or fell back); here the fallbacks become
    // honest Notes entries and the content line names quantization only when it happened.
    const entryLabel =
      includeFull && circle.width === sourceSize ? "circle-full" : `circle-${circle.width}`;
    if (circle.encoding === "lossless") {
      notes.push(`${entryLabel} quantization skipped: below quality floor; shipped lossless.`);
    } else if (circle.encoding === "raw") {
      notes.push(
        `${entryLabel} shipped unoptimized: compression failed (${circle.encodeError ?? "unknown error"}).`,
      );
    }
    circles.push(circle);
    assets.push({
      ...shared,
      name: `${base}-${entryLabel}.png`,
      bytes: ship(new Uint8Array(await circle.blob.arrayBuffer()), entryLabel),
      sha256: circle.sha256,
      production: circle,
      content:
        entryLabel === "circle-full"
          ? `circular icon (full resolution, ${circle.width}×${circle.height} ${circleContentLabel(circle)}, corners transparent)`
          : `circular icon (${circle.width}×${circle.height} ${circleContentLabel(circle)}, corners transparent)`,
      costLabel: SHARED_COST_LABEL,
    });
  }

  const manifestText = buildManifestText(manifest, assets, { notes });
  const manifestBytes = ship(new TextEncoder().encode(manifestText), "manifest.txt");
  const zip = createStoredZip([
    ...assets.map((asset) => ({ name: asset.name, bytes: asset.bytes })),
    { name: "manifest.txt", bytes: manifestBytes },
  ]);

  // Provenance: the shipped primary circle (ICON_SIZE when emitted, else the largest circle —
  // the fixed targets can all be skipped for a sub-256 source, where full is the only render).
  const primaryCircle =
    circles.find((circle) => circle.width === ICON_SIZE) ??
    circles.reduce((a, b) => (b.width > a.width ? b : a));

  return {
    filename: `byobanana-${manifest.id}-${sanitizeName(arm.recipe.id)}-variant-${sanitizeName(String(candidate.variant))}-icon-suite.zip`,
    zip,
    manifestText,
    assets,
    notes,
    recordInput: { candidateId: candidate.id, raw, production: primaryCircle },
  };
}

// Trigger a browser download of a Blob via a temporary <a download>. The object URL is
// revoked on the next frame (after the click has been dispatched).
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
