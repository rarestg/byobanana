// Optimized-download compression (P13) and circular-icon quantization — the main-thread
// client for the lazy WASM codec worker (compressWorker.ts). The codec matrix is pure and
// node-testable; the actual pixel work (mozjpeg / oxipng via jSquash, libimagequant for
// icon quantization) happens in a module Web Worker created on the FIRST job, so nothing
// wasm-related touches the critical path or the main bundle. Compressed-download results
// are cached per blobId (content-addressed, so no invalidation needed);
// rejected entries are evicted so a transient failure is retryable, and a worker-level error
// rejects every pending request and resets the singleton (the next call spawns a fresh one).

import { type GeneratedImage, sha256Hex } from "./session";

// mozjpeg quality for the lossy rows. Benchmarked (P13 gate) against q75/q85 on synthetic
// flat-color/pixel-art and photo-like 1024² images: q80 is visually transparent on photo
// content (mean abs error 3.1, max 17, ~3% of PNG size) and q85 buys almost nothing
// (mean 2.95) for ~40% more bytes. Flat/pixel-art content encodes LARGER than its PNG at
// every quality, so the only-if-smaller rule keeps JPEG artifacts out of that class entirely.
export const JPEG_QUALITY = 80;

export interface CompressionPlan {
  codec: "mozjpeg" | "oxipng";
  // The PLANNED output mime. The worker's alpha guard can still flip a mozjpeg row to
  // lossless PNG at compression time (any transparent pixel), so the label/hint for a
  // COMPLETED compression must come from the result's mimeType, not the plan.
  outputMime: "image/jpeg" | "image/png";
}

// The codec matrix (plan §1) for SOURCE downloads: JPEG (any family) → mozjpeg re-encode;
// image-family PNG → mozjpeg JPEG (worker alpha-guards to oxipng); icon-family PNG →
// lossless oxipng so the archival source keeps its transparency untouched; anything else
// (webp/svg/unknown) → no compressed option, raw only. The circular production icons do
// NOT go through this matrix — they are quantized via encodeIconPng below.
export function compressionPlan(
  mimeType: string,
  family: "image" | "icon",
): CompressionPlan | undefined {
  if (mimeType === "image/jpeg") return { codec: "mozjpeg", outputMime: "image/jpeg" };
  if (mimeType === "image/png") {
    return family === "icon"
      ? { codec: "oxipng", outputMime: "image/png" }
      : { codec: "mozjpeg", outputMime: "image/jpeg" };
  }
  return undefined;
}

// Self-describing button copy, keyed on the (planned or actual) output mime. Pre-compute
// only: once a compression completes, the label shortens to "Small · N KB" (InspectorSlot)
// so the size fits the 336px inspector without truncating — the format honesty moves to
// the hint below.
export function compressionLabel(outputMime: string): string {
  return outputMime === "image/jpeg" ? "Smaller JPEG" : "Optimized PNG";
}

// The one honesty hint under the buttons: lossy vs lossless, nothing more. Worded to pair
// with BOTH button states ("Smaller JPEG" / "Small · N KB").
export function compressionHint(outputMime: string): string {
  return outputMime === "image/jpeg"
    ? `The compressed JPEG is a lossy re-encode (quality ${JPEG_QUALITY}).`
    : "The optimized PNG is lossless.";
}

// ---- Worker RPC -------------------------------------------------------------------------

interface WorkerResult {
  buffer: ArrayBuffer;
  mimeType: string;
  width?: number;
  height?: number;
  // quant-icon jobs only: how the PNG was encoded (see encodeIconPng).
  encoding?: "quantized" | "lossless";
}

let worker: Worker | undefined;
let nextRequestId = 0;
const pendingRequests = new Map<
  number,
  { resolve: (result: WorkerResult) => void; reject: (error: Error) => void }
>();

// Retire an idle worker: a grown WebAssembly.Memory never shrinks, so after a 4K encode the
// high-water heap (potentially hundreds of MB) would otherwise stay resident for the page
// lifetime. The next compression simply spawns a fresh worker (cheap; the wasm is cached).
const WORKER_IDLE_MS = 30_000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdleRetirement(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pendingRequests.size === 0 && worker) {
      worker.terminate();
      worker = undefined;
    }
  }, WORKER_IDLE_MS);
}

// A worker-level failure (script error / unreadable message) poisons every in-flight job:
// reject them all and drop the singleton so the next call spawns a fresh worker. Guarded
// against stale events — a delayed error from an already-replaced worker must not
// terminate its successor.
function resetWorker(failed: Worker, error: Error): void {
  if (worker !== failed) return;
  failed.terminate();
  worker = undefined;
  const waiting = [...pendingRequests.values()];
  pendingRequests.clear();
  for (const request of waiting) request.reject(error);
}

function getWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL("./compressWorker.ts", import.meta.url), {
    type: "module",
  });
  created.onmessage = (event: MessageEvent) => {
    const data = event.data as { id: number; error?: string } & Partial<WorkerResult>;
    const request = pendingRequests.get(data.id);
    if (!request) return; // a job that was already rejected by a worker reset
    pendingRequests.delete(data.id);
    if (pendingRequests.size === 0) scheduleIdleRetirement();
    if (data.error !== undefined || !data.buffer || !data.mimeType) {
      request.reject(new Error(data.error ?? "Compression produced no output."));
    } else {
      request.resolve({
        buffer: data.buffer,
        mimeType: data.mimeType,
        width: data.width,
        height: data.height,
        encoding: data.encoding,
      });
    }
  };
  created.onerror = () => resetWorker(created, new Error("The compression worker failed."));
  created.onmessageerror = () =>
    resetWorker(created, new Error("The compression worker sent an unreadable message."));
  worker = created;
  return created;
}

// Post one job to the worker and await its result. The transfer list moves the payload
// (never cloned); a synchronous construction/post failure never leaves the entry stranded
// in the map, and re-arms idle retirement when it emptied the map (the pre-post
// clearTimeout would otherwise leave a workerless timer or an undying worker).
function postJob(message: object, transfer: Transferable[]): Promise<WorkerResult> {
  return new Promise<WorkerResult>((resolve, reject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });
    clearTimeout(idleTimer);
    try {
      getWorker().postMessage({ id, ...message }, transfer);
    } catch (error) {
      pendingRequests.delete(id);
      if (pendingRequests.size === 0) scheduleIdleRetirement();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// Compress one image per the matrix. Returns a COMPLETE GeneratedImage (blob, mimeType,
// width, height, sha256): width/height come from the worker's decode on the mozjpeg rows,
// or from the source metadata on the oxipng row (which never resizes).
export async function compressImage(
  blob: Blob,
  mimeType: string,
  family: "image" | "icon",
  source: { width: number; height: number },
): Promise<GeneratedImage> {
  const plan = compressionPlan(mimeType, family);
  if (!plan) throw new Error(`No compressed format is available for ${mimeType}.`);
  const buffer = await blob.arrayBuffer();
  const result = await postJob(
    { buffer, mimeType, codec: plan.codec, quality: JPEG_QUALITY },
    [buffer],
  );
  const compressed = new Blob([result.buffer], { type: result.mimeType });
  return {
    blob: compressed,
    mimeType: result.mimeType,
    width: result.width ?? source.width,
    height: result.height ?? source.height,
    sha256: await sha256Hex(compressed),
  };
}

// ---- Circular-icon quantization (owner policy: every circular PNG is lossy-quantized) ---

// How the worker encoded a circular render: "quantized" is the libimagequant palette PNG
// (the policy default); "lossless" means the quantizer could not reach the quality floor
// and the SAME pixels shipped as a lossless PNG instead (oxipng-optimized best-effort —
// quality never degrades, only size).
export interface EncodedIconPng {
  blob: Blob;
  encoding: "quantized" | "lossless";
}

// Quantize one circular icon render. The ImageData's backing buffer is TRANSFERRED to the
// worker (detached on return) — callers must fall back via their render canvas, never by
// re-reading this ImageData. Rejects on worker/codec failure; the caller decides how to
// degrade (image.ts ships the plain canvas PNG so exports always work).
export async function encodeIconPng(data: ImageData): Promise<EncodedIconPng> {
  const buffer = data.data.buffer as ArrayBuffer;
  const result = await postJob(
    { codec: "quant-icon", buffer, width: data.width, height: data.height },
    [buffer],
  );
  if (result.encoding !== "quantized" && result.encoding !== "lossless") {
    throw new Error("The icon quantizer returned an invalid result.");
  }
  return { blob: new Blob([result.buffer], { type: "image/png" }), encoding: result.encoding };
}

// ---- Per-blobId cache -------------------------------------------------------------------

const inflight = new Map<string, Promise<GeneratedImage>>();
const settled = new Map<string, { size: number; mimeType: string }>();

// Single-flight compression per blobId. Blobs are content-addressed (sha-verified before
// export), so a settled result is valid for the whole session; a REJECTED entry is evicted
// so the next click retries instead of replaying the failure.
export function compressedFor(
  blobId: string,
  produce: () => Promise<GeneratedImage>,
): Promise<GeneratedImage> {
  let entry = inflight.get(blobId);
  if (!entry) {
    entry = produce().then((result) => {
      settled.set(blobId, { size: result.blob.size, mimeType: result.mimeType });
      return result;
    });
    entry.catch(() => {
      if (inflight.get(blobId) === entry) inflight.delete(blobId);
    });
    inflight.set(blobId, entry);
  }
  return entry;
}

// Synchronous view of a COMPLETED compression, for render-time label backfill
// ("Small · 320 KB") and the only-if-smaller state (callers compare size against
// the raw image.bytes). Keyed by blobId, so reading it for the CURRENTLY focused candidate
// is itself the focus-change guard — a slow job for candidate A can never label candidate B.
export function cachedCompression(
  blobId: string,
): { size: number; mimeType: string } | undefined {
  return settled.get(blobId);
}

// Test/isolation hook: clears the cache maps (unit tests share module state).
export function clearCompressionCache(): void {
  inflight.clear();
  settled.clear();
}

// Harness seam (scripts/verify-compress.mjs + the live deploy smoke): exercises every matrix
// row and drives the worker-reset path in the REAL production build. Exposed only under
// ?verify-compress=1 so it is never part of the app's normal surface.
if (
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("verify-compress")
) {
  (globalThis as { __nbCompress?: unknown }).__nbCompress = {
    compressImage,
    encodeIconPng,
    worker: () => worker,
  };
}
