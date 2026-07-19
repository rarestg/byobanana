// Browser Gemini image client — raw `fetch`, no @google/genai SDK.
//
// Wire contract adapted from nano-banana-2 @ 54e0224 src/generate.ts (the proven
// GenerateContent request/response shape the SDK effectively sends) and the network
// patterns (typed errors, RetryInfo backoff, AbortController timeout, chunked base64)
// from rarestg/pdf-split-parse src/core/gemini.ts + pipeline.ts — ported here for
// image generation. The key travels only in the `x-goog-api-key` header (never a URL),
// and CSP restricts fetch to this one host.

import {
  calculateGenerationCost,
  classifyUsage,
  type GenerationCost,
  type GenerationUsage,
  type UsageMetadata,
} from "./cost";
import { MODEL_CAPABILITIES } from "./models";
import {
  type GeneratedImage,
  type GenerationRequest,
  type GenerationResult,
  type GroundingMetadata,
  sha256Hex,
} from "./session";

// /v1beta serves the image models' :generateContent. VERIFIED LIVE (2026-07-16) against a
// real key: /v1 REJECTS the `tools` (googleSearch), `responseModalities`, and `imageConfig`
// fields with a 400 "Cannot find field" — those live only on /v1beta. /v1beta also exposes
// all three workbench models (Pro is not visible on /v1) and honors imageConfig (a 512 request
// returned a 512×512 JPEG). CORS-open to the browser with the key in x-goog-api-key.
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Typed error hierarchy (ported from pdf-split-parse).
// ---------------------------------------------------------------------------

/** A non-OK HTTP response from the Gemini API. */
export class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly apiStatus: string | undefined,
    message: string,
    /** Server-suggested back-off in ms, parsed from a 429/503 RetryInfo (when present). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GeminiHttpError";
  }
}

/** An error that should abort the whole job (bad/unauthorized key, model not available). */
export class GeminiFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiFatalError";
  }
}

// ---------------------------------------------------------------------------
// Friendly, user-facing error copy. Ported verbatim from nano-banana-2 @ 54e0224
// web/app.js `providerFailureMessage` so the browser port surfaces the same words.
// Exported for the key panel AND the P3 queue (candidate failure messaging).
// ---------------------------------------------------------------------------

export function providerFailureMessage(raw: unknown): string {
  const message = String(raw ?? "").toLowerCase();
  if (
    /(?:code|status|http)[^a-z0-9]{0,8}429|too many requests|rate limit exceeded|resource_exhausted/.test(
      message,
    )
  ) {
    return "The provider rate limit was reached. Edit the setup and regenerate in a moment.";
  }
  if (
    /(?:code|status|http)[^a-z0-9]{0,8}(?:401|403)|unauthenticated|invalid api key|api key not valid|permission_denied/.test(
      message,
    )
  ) {
    return "The provider rejected the credentials. Check your API key, then edit the setup and regenerate.";
  }
  if (/finish_reason.?safety|blocked_reason|prompt was blocked|safety settings/.test(message)) {
    return "The provider blocked this request. Edit the subject or references and regenerate.";
  }
  if (
    /fetch failed|network error|econn|etimedout|timed out|connection (?:refused|reset)/.test(message)
  ) {
    return "The provider could not be reached. Check the connection, then edit the setup and regenerate.";
  }
  if (message.includes("provider returned no image")) {
    return "The provider returned no image. Edit the setup and regenerate the run.";
  }
  return "This candidate could not be generated. Edit the setup and regenerate the run.";
}

// ---------------------------------------------------------------------------
// finishReason → human explanation (P15). A blocked/imageless 200 carries a candidate
// finishReason (or promptFeedback.blockReason) from Google's FinishReason/BlockReason
// enums; each gets specific, actionable copy instead of the one generic "provider
// blocked this request" line. `message` is stored as candidate.error (the inspector's
// "Failure detail"); `short` is the candidate card's compact non-color-only tag,
// recovered from the stored message via failureShortLabel (exact-match reverse lookup —
// GenerationResult.error stays a plain string, no schema change).
// ---------------------------------------------------------------------------

const FINISH_REASON_COPY: Record<string, { short: string; message: string }> = (() => {
  const safety = {
    short: "Blocked: safety filter",
    message:
      "Google's safety filters stopped this request. Soften or rephrase the subject and regenerate.",
  };
  const prohibited = {
    short: "Blocked: content policy",
    message:
      "Google refused to generate this image — the subject likely hits a content policy (for example trademarked characters, real people, or unsafe themes). Rephrase the subject and try again.",
  };
  const recitation = {
    short: "Blocked: copyrighted material",
    message:
      "Google withheld the result because it came too close to existing copyrighted work. Describe what you want in your own words rather than naming a specific work or character.",
  };
  const securityFilter = {
    short: "Blocked: security filter",
    message: "A security screen (Model Armor) stopped this request. Rephrase the subject and try again.",
  };
  const jailbreak = {
    short: "Blocked: jailbreak filter",
    message:
      "Google flagged this prompt as an attempt to bypass its safety rules. Rephrase the subject plainly and try again.",
  };
  const providerError = {
    short: "Provider error",
    message:
      "The provider stopped this request without a usable result. Regenerate; if it keeps failing, adjust the subject.",
  };
  return {
    SAFETY: safety,
    IMAGE_SAFETY: safety,
    PROHIBITED_CONTENT: prohibited,
    IMAGE_PROHIBITED_CONTENT: prohibited,
    RECITATION: recitation,
    IMAGE_RECITATION: recitation,
    SPII: {
      short: "Blocked: personal info",
      message:
        "Google declined this request because it appears to involve sensitive personal information. Remove names or personal details and try again.",
    },
    BLOCKLIST: {
      short: "Blocked: banned terms",
      message: "The request matched a term Google blocklists. Reword the subject and regenerate.",
    },
    MODEL_ARMOR: securityFilter,
    JAILBREAK: jailbreak,
    LANGUAGE: {
      short: "Unsupported language",
      message:
        "The model stopped because it encountered an unsupported language. Rephrase the subject in a supported language and try again.",
    },
    NO_IMAGE: {
      short: "No image returned",
      message:
        "The model answered without producing an image. Try regenerating; if it keeps happening, simplify the subject.",
    },
    MAX_TOKENS: {
      short: "Hit output limit",
      message:
        "Generation hit the model's output limit before an image was finished. Regenerate, or simplify the subject.",
    },
    OTHER: providerError,
    IMAGE_OTHER: providerError,
    MALFORMED_FUNCTION_CALL: providerError,
    UNEXPECTED_TOOL_CALL: providerError,
    TOO_MANY_TOOL_CALLS: providerError,
    MISSING_THOUGHT_SIGNATURE: providerError,
    MALFORMED_RESPONSE: providerError,
  };
})();

// Reasons that mean Google refused the request outright — fail the candidate even if the
// response somehow carried content. Everything else in the map (NO_IMAGE, MAX_TOKENS,
// OTHER…) only fails when the response is actually imageless.
const BLOCKING_FINISH_REASONS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_PROHIBITED_CONTENT",
  "RECITATION",
  "IMAGE_RECITATION",
  "SPII",
  "BLOCKLIST",
  "MODEL_ARMOR",
]);

// promptFeedback.blockReason is a DIFFERENT enum from finishReason with overlapping names;
// only the values whose meaning matches our copy are mapped (notably NOT "OTHER", which as
// a blockReason means "prompt blocked, reason unspecified" — that keeps the generic copy).
const BLOCK_REASON_KEYS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "JAILBREAK",
  "MODEL_ARMOR", // Vertex-style responses report Model Armor screens as a blockReason too
]);

/** The human explanation for a candidate finishReason, or undefined for STOP/unknown. */
export function finishReasonMessage(reason: string | undefined): string | undefined {
  return reason ? FINISH_REASON_COPY[reason.toUpperCase()]?.message : undefined;
}

/** The human explanation for a promptFeedback.blockReason, or undefined when not mapped. */
export function blockReasonMessage(reason: string | undefined): string | undefined {
  const key = reason?.toUpperCase();
  return key && BLOCK_REASON_KEYS.has(key) ? FINISH_REASON_COPY[key]?.message : undefined;
}

/** The candidate card's short tag for a stored failure message ("Blocked: content policy"). */
export function failureShortLabel(error: string | undefined): string | undefined {
  if (!error) return undefined;
  for (const copy of Object.values(FINISH_REASON_COPY)) {
    if (copy.message === error) return copy.short;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request-body builder (exported for unit tests — the exact wire shape matters).
// ---------------------------------------------------------------------------

interface GenerateContentBody {
  contents: Array<{ role: "user"; parts: Array<Record<string, unknown>> }>;
  tools?: Array<{ googleSearch: Record<string, never> }>;
  generationConfig: {
    responseModalities: string[];
    imageConfig: { imageSize: string; aspectRatio?: string };
  };
}

export function buildGenerateBody(
  request: GenerationRequest,
  referenceData: string[],
): GenerateContentBody {
  // References come FIRST (order preserved), then the text prompt — matches the source.
  const parts: Array<Record<string, unknown>> = request.references.map((reference, index) => ({
    inlineData: { mimeType: reference.mimeType, data: referenceData[index] },
  }));
  parts.push({ text: request.prompt });

  return {
    contents: [{ role: "user", parts }],
    ...(request.googleSearch ? { tools: [{ googleSearch: {} }] } : {}),
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
      imageConfig: {
        imageSize: request.size,
        ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Response shape (the subset we read).
// ---------------------------------------------------------------------------

interface ResponsePart {
  inlineData?: { data?: string; mimeType?: string };
  text?: string;
  thought?: boolean;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: ResponsePart[] };
    finishReason?: string;
    groundingMetadata?: unknown;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
  responseId?: string;
}

// ---------------------------------------------------------------------------
// Google Search grounding attribution (deferred from P2).
//
// When a response used grounding, Google requires displaying the Search Suggestions
// (`searchEntryPoint.renderedContent`) and source attribution. We parse the metadata
// DEFENSIVELY: this environment has no API key, so the exact live shape is unverified —
// every field is optional-guarded, and a missing/odd shape yields `undefined` rather than
// throwing. Field paths match Google's documented `groundingMetadata` for :generateContent
// (webSearchQueries, groundingChunks[].web.{uri,title}, searchEntryPoint.renderedContent).
// See docs/manual-smoke-test.md for the live-verification caveat.
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : undefined;
}

// Only http(s) URIs are safe to turn into links; anything else (javascript:, data:, malformed)
// is dropped so a source chip can never carry an unexpected scheme or throw at render time.
function safeHttpUri(value: unknown): string | undefined {
  const s = asString(value);
  if (!s) return undefined;
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function parseGroundingMetadata(raw: unknown): GroundingMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const meta = raw as Record<string, unknown>;

  const searchEntryPoint = meta.searchEntryPoint as Record<string, unknown> | undefined;
  const searchEntryPointHtml = asString(searchEntryPoint?.renderedContent);

  const webSearchQueries: string[] = [];
  const seenQuery = new Set<string>();
  if (Array.isArray(meta.webSearchQueries)) {
    for (const q of meta.webSearchQueries) {
      const trimmed = asString(q);
      if (trimmed && !seenQuery.has(trimmed)) {
        seenQuery.add(trimmed);
        webSearchQueries.push(trimmed);
      }
    }
  }

  const sources: { uri: string; title?: string }[] = [];
  const seen = new Set<string>();
  const chunks = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
  for (const chunk of chunks) {
    const web = (chunk as Record<string, unknown>)?.web as Record<string, unknown> | undefined;
    const uri = safeHttpUri(web?.uri);
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ uri, title: asString(web?.title) });
  }

  // Nothing usable → no attribution to render.
  if (!searchEntryPointHtml && webSearchQueries.length === 0 && sources.length === 0) {
    return undefined;
  }
  return { searchEntryPointHtml, webSearchQueries, sources };
}

// ---------------------------------------------------------------------------
// base64 <-> bytes, browser-native (source used node Buffer).
// ---------------------------------------------------------------------------

/** Base64-encode bytes in chunks (avoids String.fromCharCode arg-count limits). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Intrinsic pixel dimensions of an image Blob. Uses createImageBitmap when available
// (browsers), falling back to an <img>. Overridable in tests where neither exists.
export type ImageSizer = (blob: Blob) => Promise<{ width: number; height: number }>;

const defaultImageSizer: ImageSizer = async (blob) => {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close?.();
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image dimensions."));
    };
    image.src = url;
  });
};

// ---------------------------------------------------------------------------
// Low-level POST with timeout + external-signal chaining (ported from pipeline).
// ---------------------------------------------------------------------------

async function postGenerate(
  url: string,
  apiKey: string,
  body: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<GenerateContentResponse> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMs,
  );
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const { status, apiStatus, message, retryAfterMs } = await readHttpError(response);
      throw new GeminiHttpError(status, apiStatus, message, retryAfterMs);
    }
    return (await response.json()) as GenerateContentResponse;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function readHttpError(
  response: Response,
): Promise<{ status: number; apiStatus?: string; message: string; retryAfterMs?: number }> {
  let detail = "";
  let apiStatus: string | undefined;
  let retryAfterMs: number | undefined;
  try {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; status?: string; details?: Array<{ retryDelay?: string }> };
      };
      detail = parsed?.error?.message ?? raw;
      apiStatus = parsed?.error?.status;
      // A 429/503 carries a RetryInfo detail like { retryDelay: "27s" }. Only the JSON
      // body is reliable — the Retry-After header isn't exposed to browser fetch via CORS.
      const delay = parsed?.error?.details?.find((d) => typeof d?.retryDelay === "string")
        ?.retryDelay;
      const match = delay ? /([\d.]+)s/.exec(delay) : null;
      if (match) retryAfterMs = Math.round(parseFloat(match[1]) * 1000);
    } catch {
      detail = raw;
    }
  } catch {
    /* body unavailable */
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  const message =
    `HTTP ${response.status} ${response.statusText}`.trim() + (detail ? `: ${detail}` : "");
  return { status: response.status, apiStatus, message, retryAfterMs };
}

// ---------------------------------------------------------------------------
// Error classification + backoff (ported from pdf-split-parse).
// ---------------------------------------------------------------------------

type ErrorKind = "fatal" | "backoff" | "fail";

/**
 * Bucket a thrown request error:
 *  - fatal:   bad/unauthorized key or unavailable model — abort the whole run (throw).
 *  - backoff: 429 / 503 / RESOURCE_EXHAUSTED / UNAVAILABLE — the only kinds we auto-retry.
 *  - fail:    everything else (timeout, network, 400, 500, safety block) — no blind retry.
 */
export function classify(error: unknown): ErrorKind {
  if (error instanceof GeminiHttpError) {
    if (httpIsFatal(error)) return "fatal";
    if (
      error.status === 429 ||
      error.status === 503 ||
      error.apiStatus === "RESOURCE_EXHAUSTED" ||
      error.apiStatus === "UNAVAILABLE"
    ) {
      return "backoff";
    }
    return "fail";
  }
  return "fail"; // network error, timeout, abort
}

/** Back-off before a retry: honor the server's RetryInfo when present, else exponential (hard cap 30s). */
export function backoffMs(error: unknown, attempt: number): number {
  const exponential = Math.min(2 ** (attempt - 1), 16) * 1000;
  const suggested = error instanceof GeminiHttpError ? error.retryAfterMs : undefined;
  return Math.min(suggested ?? exponential, 30_000);
}

function httpIsFatal(error: GeminiHttpError): boolean {
  if (error.status === 401 || error.status === 403 || error.status === 404) return true;
  if (error.apiStatus === "UNAUTHENTICATED" || error.apiStatus === "PERMISSION_DENIED") return true;
  if (
    error.status === 400 &&
    /api[_ ]?key[_ ]?(not valid|invalid)|api_key_invalid|unauthenticat|permission/i.test(
      error.message,
    )
  ) {
    return true;
  }
  return false;
}

function fatalMessage(error: unknown): string {
  if (error instanceof GeminiHttpError) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.apiStatus === "UNAUTHENTICATED" ||
      error.apiStatus === "PERMISSION_DENIED" ||
      /api[_ ]?key|api_key_invalid/i.test(error.message)
    ) {
      return "Invalid or unauthorized API key. Create a new key at aistudio.google.com/apikey and check it has Gemini API access.";
    }
    if (error.status === 404 || /\bmodel\b/i.test(error.message)) {
      return `Model not available for this key: ${error.message}.`;
    }
    return error.message;
  }
  return errorToString(error);
}

function errorToString(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: string }).name === "TimeoutError"
  ) {
    return "Request timed out";
  }
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** A timeout that rejects early if the signal aborts (keeps cancel responsive during backoff). */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// generateImage — the P3 queue's provider entrypoint.
// ---------------------------------------------------------------------------

export interface GenerateImageOptions {
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  // Test seam: how intrinsic image dimensions are read (default: createImageBitmap/<img>).
  imageSizer?: ImageSizer;
}

/**
 * Generate images for one request. Returns a terminal GenerationResult per call so
 * the P3 queue can fold it into a candidate:
 *  - success → status "succeeded" with images/text/usage/cost.
 *  - user abort via `opts.signal` → status "interrupted" (cancellation billing unknown).
 *  - transient (429/503) → auto-retried with backoff; exhausted retries → "failed".
 *  - any other provider/network/timeout error → "failed" with a friendly `error`.
 *  - FATAL (bad key, model unavailable) → THROWS GeminiFatalError so the whole run aborts.
 */
export async function generateImage(
  request: GenerationRequest,
  opts: GenerateImageOptions,
): Promise<GenerationResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sizer = opts.imageSizer ?? defaultImageSizer;
  const url = `${API_BASE}/models/${encodeURIComponent(request.modelId)}:generateContent`;

  const referenceData = await Promise.all(
    request.references.map(async (reference) =>
      bytesToBase64(new Uint8Array(await reference.blob.arrayBuffer())),
    ),
  );
  const body = JSON.stringify(buildGenerateBody(request, referenceData));

  // Tracks whether any request has actually gone out, so a cancellation can report
  // honest billing: "not-submitted" (never charged) vs "unknown-may-be-charged".
  let submitted = false;
  let lastError: unknown = "unknown error";
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    if (opts.signal?.aborted) return interrupted(request, submitted);
    try {
      submitted = true;
      const response = await postGenerate(url, opts.apiKey, body, timeoutMs, opts.signal);
      return await interpretResponse(request, response, sizer);
    } catch (error) {
      if (opts.signal?.aborted) return interrupted(request, submitted);
      const kind = classify(error);
      if (kind === "fatal") throw new GeminiFatalError(fatalMessage(error));
      if (kind === "fail") return failed(request, error);
      // backoff: 429/503 — retry unless we're out of attempts.
      lastError = error;
      if (attempt > MAX_RETRIES) return failed(request, error);
      try {
        await delay(backoffMs(error, attempt), opts.signal);
      } catch {
        // delay only rejects on abort — a request already went out, so bill unknown.
        return interrupted(request, submitted);
      }
      if (opts.signal?.aborted) return interrupted(request, submitted);
    }
  }
  return failed(request, lastError);
}

async function interpretResponse(
  request: GenerationRequest,
  response: GenerateContentResponse,
  sizer: ImageSizer,
): Promise<GenerationResult> {
  const candidate = response.candidates?.[0];

  // Usage/cost/provenance are computed up front so EVERY terminal result (success,
  // block, or imageless) reports what Google billed — a blocked 200 is still charged.
  const usage = response.usageMetadata ? classifyUsage(response.usageMetadata) : undefined;
  const cost = usage
    ? calculateGenerationCost(request.modelId, usage, request.googleSearch)
    : { status: "unavailable" as const, excludesGrounding: request.googleSearch };
  // Grounding attribution: parse only when the run requested it (avoids surfacing stray
  // metadata) and the response actually carried it.
  const grounding = request.googleSearch
    ? parseGroundingMetadata(candidate?.groundingMetadata)
    : undefined;
  const meta = {
    usage,
    cost,
    modelVersion: response.modelVersion,
    responseId: response.responseId,
    grounding,
  };

  // A block usually arrives as a 200 with promptFeedback.blockReason OR a candidate
  // finishReason like SAFETY / PROHIBITED_CONTENT / IMAGE_SAFETY — not an HTTP 400.
  // P15: known reasons map to specific human copy (FINISH_REASON_COPY); unknown ones keep
  // the old phrasing, routed through providerFailureMessage's generic block copy.
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    const message =
      blockReasonMessage(blockReason) ??
      providerFailureMessage(`Request blocked by Gemini (blocked_reason ${blockReason}).`);
    return failedWith(meta, [], message);
  }
  const finishReason = candidate?.finishReason;
  if (finishReason && (BLOCKING_FINISH_REASONS.has(finishReason.toUpperCase()) || /SAFETY|PROHIBITED|BLOCK|RECITATION/i.test(finishReason))) {
    const message =
      finishReasonMessage(finishReason) ??
      providerFailureMessage(`The prompt was blocked by Gemini (finish_reason ${finishReason}).`);
    return failedWith(meta, [], message);
  }

  const images: GeneratedImage[] = [];
  const text: string[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    if (part.thought) continue; // thinking parts (image or text) are internal, never output
    if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || "image/png";
      const bytes = base64ToBytes(part.inlineData.data);
      const blob = new Blob([bytes], { type: mimeType });
      const { width, height } = await sizer(blob);
      images.push({ blob, mimeType, width, height, sha256: await sha256Hex(blob) });
    } else if (part.text) {
      text.push(part.text);
    }
  }

  if (images.length === 0) {
    // A billed-but-imageless response still carries usage/cost + any explanatory text.
    // P15: a mapped finishReason (NO_IMAGE, MAX_TOKENS, OTHER…) explains WHY there is no
    // image; without one, keep the generic no-image copy.
    const message =
      finishReasonMessage(finishReason) ?? providerFailureMessage("provider returned no image");
    return failedWith(meta, text, message);
  }

  return { status: "succeeded", images, text, ...meta };
}

interface ResultMeta {
  usage?: GenerationUsage;
  cost: GenerationCost;
  modelVersion?: string;
  responseId?: string;
  grounding?: GroundingMetadata;
}

// A terminal FAILED result that preserves the accounting metadata Google supplied.
// `error` is the FINAL human message (callers map through finishReasonMessage /
// providerFailureMessage first — mapping twice would collapse specific copy to generic).
function failedWith(meta: ResultMeta, text: string[], error: string): GenerationResult {
  return {
    status: "failed",
    images: [],
    text,
    usage: meta.usage,
    cost: meta.cost,
    modelVersion: meta.modelVersion,
    responseId: meta.responseId,
    grounding: meta.grounding,
    error,
  };
}

function failed(request: GenerationRequest, error: unknown): GenerationResult {
  return {
    status: "failed",
    images: [],
    text: [],
    cost: { status: "unavailable", excludesGrounding: request.googleSearch },
    error: providerFailureMessage(errorToString(error)),
  };
}

function interrupted(request: GenerationRequest, submitted: boolean): GenerationResult {
  return {
    status: "interrupted",
    images: [],
    text: [],
    cost: { status: "unavailable", excludesGrounding: request.googleSearch },
    error: submitted
      ? "Generation stopped after the request was submitted; billing may still occur."
      : "Generation stopped before the request was submitted.",
    cancellation: {
      requestedAt: new Date().toISOString(),
      // No request went out → definitely not charged; otherwise the response may have
      // been billed even though we abandoned it.
      billing: submitted ? "unknown-may-be-charged" : "not-submitted",
    },
  };
}

// ---------------------------------------------------------------------------
// validateApiKey — two-phase, NO paid image call.
//   (1) GET /models (proves the key at zero inference cost)
//   (2) intersect with the hard 3-model allowlist.
// ---------------------------------------------------------------------------

const ALLOWLISTED_MODEL_IDS = new Set(MODEL_CAPABILITIES.map((model) => model.id));

export interface ValidateApiKeyResult {
  availableModels: string[];
}

export interface ValidateApiKeyOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function validateApiKey(
  apiKey: string,
  opts: ValidateApiKeyOptions = {},
): Promise<ValidateApiKeyResult> {
  const ids = await listModelIds(apiKey, opts);
  const availableModels = MODEL_CAPABILITIES.map((model) => model.id).filter((id) => ids.has(id));
  return { availableModels };
}

/** All model ids the key can see (paginated), normalized (no `models/` prefix). */
async function listModelIds(apiKey: string, opts: ValidateApiKeyOptions): Promise<Set<string>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API_BASE}/models`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let data: { models?: Array<{ name?: string }>; nextPageToken?: string };
    try {
      data = await getJson(url.toString(), apiKey, timeoutMs, opts.signal);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      // Only a credential/permission failure means the KEY is bad (fatal). A 429 / 5xx /
      // timeout / network error is transient — rethrow it so the UI says "try again"
      // rather than falsely branding a valid key as invalid.
      if (error instanceof GeminiHttpError && httpIsFatal(error)) {
        throw new GeminiFatalError(fatalMessage(error));
      }
      throw error;
    }
    for (const model of data.models ?? []) {
      if (model.name) ids.add(model.name.replace(/^models\//, ""));
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

async function getJson(
  url: string,
  apiKey: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ models?: Array<{ name?: string }>; nextPageToken?: string }> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMs,
  );
  try {
    const response = await fetch(url, {
      headers: { "x-goog-api-key": apiKey },
      signal: controller.signal,
    });
    if (!response.ok) {
      const { status, apiStatus, message, retryAfterMs } = await readHttpError(response);
      throw new GeminiHttpError(status, apiStatus, message, retryAfterMs);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

// Re-export so the UI can name the allowlist without reaching into models.ts internals.
export { ALLOWLISTED_MODEL_IDS };
