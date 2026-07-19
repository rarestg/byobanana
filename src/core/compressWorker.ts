// Module Web Worker for optimized downloads (P13) and circular-icon quantization. Codecs are
// dynamically imported on first use so their wasm (mozjpeg ~250 KB / oxipng ~160 KB /
// libimagequant ~320 KB) is fetched only when actually requested. Decoding is native
// (createImageBitmap + OffscreenCanvas — no decoder wasm); requires 'wasm-unsafe-eval' in the
// CSP served on this worker's script response (public/_headers). Requests/results transfer
// their ArrayBuffers (never cloned); per-job failures post back { id, error } so one bad
// image never kills the worker.

interface CompressRequest {
  id: number;
  codec: "mozjpeg" | "oxipng";
  buffer: ArrayBuffer;
  mimeType: string;
  quality: number;
}

// Circular-icon quantization: raw RGBA in (straight from the render canvas's ImageData — no
// PNG round trip), palette PNG out.
interface QuantIconRequest {
  id: number;
  codec: "quant-icon";
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

type WorkerRequest = CompressRequest | QuantIconRequest;

interface CompressResult {
  buffer: ArrayBuffer;
  mimeType: string;
  width?: number;
  height?: number;
  // Present only on quant-icon results: "quantized" (lossy palette PNG) or "lossless"
  // (the quantizer refused: the quality floor was unreachable; lossless PNG instead).
  encoding?: "quantized" | "lossless";
}

// libimagequant quality window (owner-settled): floor 65 / target 90, roughly JPEG-like
// 0-100. Below the floor the quantizer aborts and the job falls back to lossless. Dithering
// is off: the icon styles are dominated by flat color, where dithering only scatters stipple
// noise into solid regions (larger files, not cleaner), and even the gradient-heavy glass
// style quantizes within the window without it. Automatic palette size completes the policy.
const QUANT_QUALITY_MIN = 65;
const QUANT_QUALITY_TARGET = 90;
const QUANT_DITHERING = 0.0;

// tsconfig uses the DOM lib (no WebWorker lib), where `self` types as Window — narrow to
// the two members a dedicated worker scope actually needs here.
const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

async function optimisePng(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const { default: optimise } = await import("@jsquash/oxipng/optimise");
  // Level 2 (package default): level 3+ costs multiples of CPU for low single-digit % more.
  return optimise(buffer, { level: 2 });
}

// A view's bytes as their own exact ArrayBuffer (no copy when the view already spans it).
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

// Best-effort oxipng over an already-valid PNG: ship the smaller of the two, and on ANY
// optimizer failure ship the input unchanged — the lossless pass is an optimization, never
// a reason to lose a correct (possibly quantized) PNG.
async function optimisePngIfSmaller(png: Uint8Array): Promise<Uint8Array> {
  try {
    const optimised = new Uint8Array(await optimisePng(exactBuffer(png)));
    return optimised.byteLength < png.byteLength ? optimised : png;
  } catch {
    return png;
  }
}

async function decodeImageData(buffer: ArrayBuffer, mimeType: string): Promise<ImageData> {
  const bitmap = await createImageBitmap(new Blob([buffer], { type: mimeType }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("OffscreenCanvas 2D context is unavailable.");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 255) return true;
  }
  return false;
}

async function compress(request: CompressRequest): Promise<CompressResult> {
  if (request.codec === "oxipng") {
    return { buffer: await optimisePng(request.buffer), mimeType: "image/png" };
  }

  // mozjpeg rows: decode natively, then re-encode as JPEG — EXCEPT a PNG source with any
  // transparent pixel, which falls back to lossless oxipng on the ORIGINAL bytes (the alpha
  // guard: JPEG would silently flatten transparency).
  const imageData = await decodeImageData(request.buffer, request.mimeType);
  const size = { width: imageData.width, height: imageData.height };
  if (request.mimeType === "image/png" && hasTransparency(imageData.data)) {
    return { buffer: await optimisePng(request.buffer), mimeType: "image/png", ...size };
  }
  const { default: encode } = await import("@jsquash/jpeg/encode");
  const buffer = await encode(imageData, { quality: request.quality });
  return { buffer, mimeType: "image/jpeg", ...size };
}

// ---- quant-icon: libimagequant palette quantization -------------------------------------

type QuantModule = typeof import("libimagequant-wasm/wasm/libimagequant_wasm.js");

// Lazy one-time init of the libimagequant wasm (glue chunk + wasm asset load on the FIRST
// icon encode). Jobs can overlap while awaiting, so the promise is shared; a FAILED init is
// evicted so the next job retries instead of replaying the failure.
let quantModule: Promise<QuantModule> | undefined;
function loadQuantizer(): Promise<QuantModule> {
  if (!quantModule) {
    const loading = (async () => {
      const [glue, wasmUrl] = await Promise.all([
        import("libimagequant-wasm/wasm/libimagequant_wasm.js"),
        import("libimagequant-wasm/wasm/libimagequant_wasm_bg.wasm?url"),
      ]);
      await glue.default({ module_or_path: wasmUrl.default });
      return glue;
    })();
    loading.catch(() => {
      if (quantModule === loading) quantModule = undefined;
    });
    quantModule = loading;
  }
  return quantModule;
}

// The wasm-bindgen binding throws a PLAIN STRING for libimagequant refusals; the quality
// floor abort reads "Failed to quantize image: QualityTooLow". Anything else (OOM, invalid
// input, a binding fault) is a hard failure, not a floor fallback — a "below quality floor"
// note must never paper over a crash. Contract pinned by the exact-versioned dependency and
// proven by the verify:compress floor fixture.
function isQualityFloorAbort(error: unknown): boolean {
  return typeof error === "string" && error.includes("QualityTooLow");
}

// Lossless PNG from raw RGBA via the native encoder (only reached on a floor fallback).
async function encodeLosslessPng(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("OffscreenCanvas 2D context is unavailable.");
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

// Quantize one circular render: RGBA -> libimagequant (quality window, dithering, automatic
// palette) -> palette PNG -> best-effort oxipng. When the floor is unreachable the SAME
// pixels ship as a lossless PNG (also best-effort optimized) with encoding "lossless".
// The quantize/remap calls are synchronous; the wasm objects are freed before any await.
async function quantizeIcon(request: QuantIconRequest): Promise<CompressResult> {
  const { width, height } = request;
  const rgba = new Uint8ClampedArray(request.buffer);
  const { ImageQuantizer, encode_palette_to_png } = await loadQuantizer();

  let palettePng: Uint8Array | undefined;
  const quantizer = new ImageQuantizer();
  try {
    quantizer.setQuality(QUANT_QUALITY_MIN, QUANT_QUALITY_TARGET);
    let result;
    try {
      result = quantizer.quantizeImage(rgba, width, height);
    } catch (error) {
      if (!isQualityFloorAbort(error)) throw error;
    }
    if (result) {
      try {
        result.setDithering(QUANT_DITHERING);
        const indices = result.getPaletteIndices(rgba, width, height);
        palettePng = encode_palette_to_png(indices, result.getPalette(), width, height);
      } finally {
        result.free();
      }
    }
  } finally {
    quantizer.free();
  }

  const shipped = await optimisePngIfSmaller(
    palettePng ?? (await encodeLosslessPng(rgba, width, height)),
  );
  return {
    buffer: exactBuffer(shipped),
    mimeType: "image/png",
    width,
    height,
    encoding: palettePng ? "quantized" : "lossless",
  };
}

scope.addEventListener("message", (event: MessageEvent) => {
  const request = event.data as WorkerRequest;
  const job = request.codec === "quant-icon" ? quantizeIcon(request) : compress(request);
  void job.then(
    (result) => scope.postMessage({ id: request.id, ...result }, [result.buffer]),
    (error: unknown) =>
      scope.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
