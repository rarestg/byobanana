// Mock generation runner — the whole flow must be exercisable with NO API key.
//
// Ported from nano-banana-2 @ 54e0224 src/workbench/jobs.ts `mockGenerationRunner`: per
// candidate wait a short, abortable delay, then return a valid GenerationResult carrying a
// small SVG placeholder image plus synthesized usage/cost (run through the real
// classifyUsage/calculateGenerationCost so spend reporting stays exercised). The default
// runner always succeeds; `createMockRunner` accepts a `shouldFail` hook so tests can
// force a failed/fatal outcome.

import { classifyUsage, calculateGenerationCost } from "../core/cost";
import { finishReasonMessage, GeminiFatalError } from "../core/gemini";
import { sha256Hex, type GeneratedImage, type GenerationRequest } from "../core/session";
import type { GenerationRunner } from "./queue";

export type MockOutcome = "succeeded" | "failed" | "fatal";

export interface MockRunnerOptions {
  // Base delay in ms; the actual wait jitters ±40%. Kept short so a full run feels live.
  delayMs?: number;
  // Force an outcome per candidate (tests). Default: always "succeeded".
  shouldFail?: (request: GenerationRequest) => MockOutcome | undefined;
}

function escapeXml(value: string): string {
  const replacements: Record<string, string> = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  };
  return value.replace(/[<>&'"]/g, (character) => replacements[character] ?? "");
}

// Nominal pixel dimensions the placeholder claims (matches the requested output size).
function sizeToPixels(size: string): number {
  if (/^\d+$/.test(size)) return Number(size);
  const match = /^(\d+)K$/i.exec(size);
  return match ? Number(match[1]) * 1024 : 1024;
}

// A tiny, deterministic hue from the prompt so different arms read as different swatches.
function hueFromPrompt(prompt: string): number {
  let hash = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    hash = (hash * 31 + prompt.charCodeAt(index)) % 360;
  }
  return hash;
}

function placeholderSvg(request: GenerationRequest): string {
  const pixels = sizeToPixels(request.size);
  const label = escapeXml(request.prompt.replace(/\s+/g, " ").trim().slice(0, 48));
  const hue = hueFromPrompt(request.prompt);
  const fg = `hsl(${hue} 62% 46%)`;
  const bg = `hsl(${hue} 60% 94%)`;
  const s = pixels;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">` +
    `<rect width="${s}" height="${s}" fill="${bg}"/>` +
    `<circle cx="${s / 2}" cy="${s * 0.42}" r="${s * 0.26}" fill="${fg}" opacity="0.9"/>` +
    `<rect x="${s * 0.4}" y="${s * 0.36}" width="${s * 0.2}" height="${s * 0.2}" rx="${s * 0.02}" fill="#18181b"/>` +
    `<text x="${s / 2}" y="${s * 0.86}" text-anchor="middle" font-family="sans-serif" font-size="${s * 0.03}" fill="#3f3f46">${label}</text>` +
    `<text x="${s / 2}" y="${s * 0.92}" text-anchor="middle" font-family="sans-serif" font-size="${s * 0.024}" fill="#71717a">Mock ${escapeXml(request.size)}</text>` +
    `</svg>`
  );
}

async function mockImage(request: GenerationRequest): Promise<GeneratedImage> {
  const svg = placeholderSvg(request);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const pixels = sizeToPixels(request.size);
  return {
    blob,
    mimeType: "image/svg+xml",
    width: pixels,
    height: pixels,
    sha256: await sha256Hex(blob),
  };
}

// Plausible token usage for a 1024px image generation, run through the real cost math.
function mockUsageMetadata() {
  return {
    promptTokenCount: 48,
    candidatesTokenCount: 1290,
    thoughtsTokenCount: 0,
    totalTokenCount: 1338,
    candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }],
  };
}

// Abortable delay: rejects with an AbortError so the queue's run() folds it into an
// interrupted (unknown-may-be-charged) result — same shape jobs.ts relies on.
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockRunner(options: MockRunnerOptions = {}): GenerationRunner {
  const base = options.delayMs ?? 90;
  return async (request, signal) => {
    // Outcome is decided at INVOCATION time (submission order is deterministic; completion
    // order after the jittered delay is not) so counter-based shouldFail hooks like
    // mockFailRunner's fail a stable ordinal.
    const outcome = options.shouldFail?.(request) ?? "succeeded";
    const jitter = base * (0.6 + Math.random() * 0.8);
    await abortableDelay(Math.round(jitter), signal);
    if (outcome === "fatal") {
      throw new GeminiFatalError(
        "Invalid or unauthorized API key. Create a new key at aistudio.google.com/apikey.",
      );
    }

    const usage = classifyUsage(mockUsageMetadata());
    const cost = calculateGenerationCost(request.modelId, usage, request.googleSearch);

    if (outcome === "failed") {
      return {
        status: "failed",
        images: [],
        text: ["Mock failure for testing."],
        usage,
        cost,
        modelVersion: "mock",
        responseId: `mock-${Math.random().toString(36).slice(2, 10)}`,
        // P15: simulate a Gemini content-policy block with the SAME mapped copy the real
        // client stores (candidate.error is final human text), so the failure UI — the
        // card's short tag + the inspector's Failure detail — is exercisable with no key.
        error: finishReasonMessage("PROHIBITED_CONTENT")!,
      };
    }

    return {
      status: "succeeded",
      images: [await mockImage(request)],
      text: ["Mock workbench result"],
      usage,
      cost,
      modelVersion: "mock",
      responseId: `mock-${Math.random().toString(36).slice(2, 10)}`,
    };
  };
}

// Default all-succeed runner for the app's mock mode.
export const mockRunner: GenerationRunner = createMockRunner();

// Harness runner (?mock=fail): every second candidate fails as a mock content-policy
// block, so Playwright can screenshot the failed-card tag and inspector Failure detail.
let mockFailFlip = false;
export const mockFailRunner: GenerationRunner = createMockRunner({
  shouldFail: () => ((mockFailFlip = !mockFailFlip) ? undefined : "failed"),
});
