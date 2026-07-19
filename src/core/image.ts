// Browser Canvas circular icon — replaces nano-banana-2's ImageMagick
// `exportCircularProjectIcon` (src/image-tools.ts). The source masked a full-bleed circle
// (DstIn composite) so the corners are transparent and wrote PNG32. Here the same shape is
// produced natively: decode once → square canvas at the TARGET size with high-quality
// smoothing → circular clip. This is NOT byte-identical to the ImageMagick output — the
// browser's resampler is not Lanczos — which is expected and fine; only the geometry
// (square target, circular, transparent corners) is contractual.
//
// Encoding (owner policy): every circular PNG is lossy-quantized. The render's ImageData
// goes to the codec worker (compress.ts encodeIconPng: libimagequant palette PNG + oxipng;
// lossless when the quality floor is unreachable), and if the worker itself fails the
// render canvas's own toBlob PNG ships instead — exports always work. The encoder is
// injectable so node tests and the geometry harness run without the worker.
//
// The exporter is parametrized (the export suite ships several sizes): every target renders
// DIRECTLY from the decoded source bitmap — never from an already-resized output — so each
// size gets one clean downsample from the source pixels. ICON_SIZE is the app-level primary
// export size.

import { type EncodedIconPng, encodeIconPng } from "./compress";
import { type GeneratedImage, sha256Hex } from "./session";

export const ICON_SIZE = 512;

// How a circular render's shipped bytes were encoded: "quantized" (lossy palette PNG, the
// policy default), "lossless" (the quantizer refused: quality floor unreachable; lossless-
// optimized PNG instead), or "raw" (the codec worker failed entirely; the plain canvas PNG
// ships so the export still works — encodeError carries why, for the suite's Notes).
export type IconEncoding = "quantized" | "lossless" | "raw";

export interface CircularIcon extends GeneratedImage {
  encoding: IconEncoding;
  encodeError?: string;
}

export type IconPngEncoder = (data: ImageData) => Promise<EncodedIconPng>;

// Icons generate at 1:1; a non-square source can't be masked into a centered circle without
// distortion, so the source rejected it (WorkbenchError "project_icon_requires_square") and
// the inspector warns on it. Pure + node-testable — the pixel work below can't run in jsdom.
export function assertSquareSource(width: number, height: number): void {
  if (width !== height) {
    throw new Error(
      `Project-icon export requires a square source image (got ${width}×${height}).`,
    );
  }
}

// A square canvas 2D context at `size`, transparent to start (so anything outside the clip
// stays alpha 0). OffscreenCanvas isn't required — export runs on the main thread from a click.
function createIconContext(size: number): {
  context: CanvasRenderingContext2D;
  toBlob: () => Promise<Blob>;
} {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  // Every render is read back once (the quantizing encoder consumes ImageData).
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D context is unavailable in this browser.");
  return {
    context,
    toBlob: () =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob produced no PNG."))),
          "image/png",
        ),
      ),
  };
}

// A decoded source ready to draw: an ImageBitmap where the browser supports decoding the
// blob (PNG/JPEG — everything Google returns), or an HTMLImageElement fallback for sources
// createImageBitmap cannot decode (Chromium rejects SVG blobs; the ?mock=1 runner emits
// SVG placeholders, and the exporter must stay exercisable without an API key).
interface DecodedSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function decodeSource(blob: Blob): Promise<DecodedSource> {
  try {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    // <img> decode fallback. The object URL must stay alive until every draw from this
    // source has happened — the caller frees it via close() in its finally.
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) {
        throw new Error("The source image reports no intrinsic size.");
      }
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error instanceof Error && error.message.includes("intrinsic")
        ? error
        : new Error("The source image could not be decoded for icon export.");
    }
  }
}

// Render the circle and hand back BOTH the pixels (for the quantizing encoder) and the
// canvas's own PNG encoder (the raw fallback). The pair matters: the encoder TRANSFERS the
// ImageData's buffer, so after a failed encode the canvas closure is the only valid source.
function renderCircularIcon(
  decoded: DecodedSource,
  size: number,
): { imageData: ImageData; toBlob: () => Promise<Blob> } {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`Invalid icon export size: ${size}`);
  }
  const { context, toBlob } = createIconContext(size);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  // Circle centered on the canvas, radius = half the side, so it spans corner-to-corner
  // edge midpoints and clips the corners to transparent (source: circle at center, r = side/2).
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  context.closePath();
  context.clip();
  context.drawImage(decoded.source, 0, 0, size, size);
  return { imageData: context.getImageData(0, 0, size, size), toBlob };
}

// Draw `source` under a full-bleed circular clip at each target size, encode each render
// through `encode` (default: the worker quantizer), and return the PNGs as CircularIcons
// (hash over the ACTUAL shipped bytes, like the repository does). The clip leaves the four
// corners at alpha 0; the inscribed circle touches each edge's midpoint. One decode serves
// every size; targets render sequentially. An encoder failure degrades to the plain canvas
// PNG (encoding "raw") — geometry, decode, and fallback-encode failures stay fatal.
export async function exportCircularIcons(
  source: Blob,
  sizes: number[],
  encode: IconPngEncoder = encodeIconPng,
): Promise<CircularIcon[]> {
  const decoded = await decodeSource(source);
  try {
    assertSquareSource(decoded.width, decoded.height);
    const icons: CircularIcon[] = [];
    for (const size of sizes) {
      const { imageData, toBlob } = renderCircularIcon(decoded, size);
      let blob: Blob;
      let encoding: IconEncoding;
      let encodeError: string | undefined;
      try {
        ({ blob, encoding } = await encode(imageData));
      } catch (error) {
        // The encoder detached imageData's buffer; re-encode from the live canvas.
        blob = await toBlob();
        encoding = "raw";
        encodeError = error instanceof Error ? error.message : String(error);
      }
      icons.push({
        blob,
        mimeType: "image/png",
        width: size,
        height: size,
        sha256: await sha256Hex(blob),
        encoding,
        ...(encodeError === undefined ? {} : { encodeError }),
      });
    }
    return icons;
  } finally {
    decoded.close();
  }
}

// Single-size convenience wrapper (the inspector's per-size downloads and the multi-candidate
// export ZIP both use the primary ICON_SIZE by default).
export async function exportCircularIcon(
  source: Blob,
  size: number = ICON_SIZE,
  encode?: IconPngEncoder,
): Promise<CircularIcon> {
  const [image] = await exportCircularIcons(source, [size], encode);
  return image;
}
