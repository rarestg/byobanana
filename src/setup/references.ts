// Reference-image validation, browser-native and framework-free so it unit-tests
// under node. The magic-byte sniff is ported from nano-banana-2 src/image-tools.ts
// (detectImageMimeType) — we trust the FILE BYTES, never the browser-supplied
// File.type, since a renamed .txt can claim image/png. Limits mirror the source
// store.ts contract: at most 14 refs, 20 MB each, 100 MB total.

export const MAX_REFERENCE_COUNT = 14;
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_REFERENCE_BYTES = 100 * 1024 * 1024;

export type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export const ACCEPTED_MIME_TYPES: SupportedImageMime[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

// A reference the user has staged, before it becomes a session ReferenceInput. The
// stable `id` keys React lists across reorders; `url` is an object URL for the
// thumbnail (owned by the UI, revoked on remove/unmount).
export interface StagedReference {
  id: string;
  name: string;
  mimeType: SupportedImageMime;
  file: File;
  url: string;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// Sniff the image type from the first bytes. Returns undefined for anything that is
// not a PNG/JPEG/WebP/GIF, which the caller treats as a rejection.
export function detectImageMimeType(bytes: Uint8Array): SupportedImageMime | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) {
    return "image/gif";
  }
  return undefined;
}

export interface RejectedReference {
  name: string;
  reason: string;
}

export interface ReferenceAddResult {
  accepted: StagedReference[];
  rejected: RejectedReference[];
}

// A candidate file the UI has read into bytes, ready to validate + stage.
export interface IncomingReference {
  name: string;
  file: File;
  bytes: Uint8Array;
}

function totalBytes(references: readonly StagedReference[]): number {
  return references.reduce((sum, reference) => sum + reference.file.size, 0);
}

// Validate a batch of incoming files against the current staged list and the limits,
// returning the accepted additions (with fresh object URLs) and per-file rejections.
// Pure except for `crypto.randomUUID` / `URL.createObjectURL`, both browser/node20+
// globals, so a caller can inject `makeId`/`makeUrl` in tests.
export function addReferences(
  existing: readonly StagedReference[],
  incoming: readonly IncomingReference[],
  makeId: () => string = () => crypto.randomUUID(),
  makeUrl: (file: File) => string = (file) => URL.createObjectURL(file),
): ReferenceAddResult {
  const accepted: StagedReference[] = [];
  const rejected: RejectedReference[] = [];
  let count = existing.length;
  let bytes = totalBytes(existing);

  for (const candidate of incoming) {
    if (count >= MAX_REFERENCE_COUNT) {
      rejected.push({
        name: candidate.name,
        reason: `At most ${MAX_REFERENCE_COUNT} reference images are allowed.`,
      });
      continue;
    }
    const mimeType = detectImageMimeType(candidate.bytes);
    if (!mimeType) {
      rejected.push({
        name: candidate.name,
        reason: "Not a PNG, JPEG, WebP, or GIF image.",
      });
      continue;
    }
    if (candidate.file.size === 0 || candidate.file.size > MAX_REFERENCE_BYTES) {
      rejected.push({
        name: candidate.name,
        reason: `Each reference must be 1 byte to ${MAX_REFERENCE_BYTES / 1024 / 1024} MB.`,
      });
      continue;
    }
    if (bytes + candidate.file.size > MAX_TOTAL_REFERENCE_BYTES) {
      rejected.push({
        name: candidate.name,
        reason: `References exceed the ${MAX_TOTAL_REFERENCE_BYTES / 1024 / 1024} MB total limit.`,
      });
      continue;
    }
    accepted.push({
      id: makeId(),
      name: candidate.name,
      mimeType,
      file: candidate.file,
      url: makeUrl(candidate.file),
    });
    count += 1;
    bytes += candidate.file.size;
  }

  return { accepted, rejected };
}

// Reorder helper: move the item at `index` by `offset` (-1 up / +1 down), returning a
// new array. Out-of-range moves are no-ops (returns the same array reference).
export function moveReference<T>(items: readonly T[], index: number, offset: number): T[] {
  const target = index + offset;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return items as T[];
  }
  const next = [...items];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}
