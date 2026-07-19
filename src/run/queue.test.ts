import { describe, expect, test } from "vitest";

import { GeminiFatalError } from "../core/gemini";
import { loadRecipes, renderRecipe } from "../core/recipes";
import { COLOR_PALETTES } from "../core/palettes";
import {
  InMemorySessionRepository,
  sha256Hex,
  type CreateSessionInput,
  type GeneratedImage,
  type GenerationRequest,
  type GenerationResult,
  type SessionManifest,
} from "../core/session";
import { createMockRunner } from "./mockRunner";
import { orderedCandidates, RunQueue, summarizeProgress, type GenerationRunner } from "./queue";

const recipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;
const palette = COLOR_PALETTES[0];

// Build a session with `arms` arms × `variants` variants each.
async function seed(repo: InMemorySessionRepository, arms: number, variants: number) {
  const input: CreateSessionInput = {
    subject: "A local transcript search tool.",
    palette,
    settings: {
      modelId: "gemini-3.1-flash-image",
      size: "512",
      googleSearch: false,
      variantsPerRecipe: variants,
      callCount: arms * variants,
    },
    estimate: { status: "estimated", usd: 0.05, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [],
    arms: Array.from({ length: arms }, (_unused, index) => ({
      id: `arm-${index + 1}`,
      recipe,
      renderedPrompt: `${renderRecipe(recipe, "A local transcript search tool.", palette, "#FAFAFA")} [arm ${index + 1}]`,
      variants,
    })),
  };
  return repo.createSession(input);
}

async function okImage(): Promise<GeneratedImage> {
  const blob = new Blob(["<svg/>"], { type: "image/svg+xml" });
  return { blob, mimeType: "image/svg+xml", width: 512, height: 512, sha256: await sha256Hex(blob) };
}

async function okResult(): Promise<GenerationResult> {
  return {
    status: "succeeded",
    images: [await okImage()],
    text: ["ok"],
    cost: { status: "calculated", usd: 0.05, excludesGrounding: false },
  };
}

const allCandidates = (manifest: SessionManifest) => manifest.arms.flatMap((arm) => arm.candidates);
const noop = () => {};

describe("orderedCandidates — round-robin, variant-major across arms", () => {
  test("interleaves comparison arms: v1 of every arm, then v2 of every arm", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seed(repo, 3, 2); // arm-1..3, variants 1..2
    const ids = orderedCandidates(manifest).map((c) => c.id);
    expect(ids).toEqual([
      "candidate-arm-1-1",
      "candidate-arm-2-1",
      "candidate-arm-3-1",
      "candidate-arm-1-2",
      "candidate-arm-2-2",
      "candidate-arm-3-2",
    ]);
  });
});

describe("RunQueue — concurrency", () => {
  test("never runs more than 2 candidates at once", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seed(repo, 3, 3); // 9 candidates
    let inFlight = 0;
    let peak = 0;
    const runner: GenerationRunner = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 8));
      inFlight -= 1;
      return okResult();
    };
    const queue = new RunQueue({ repo, sessionId: manifest.id, runner, onUpdate: noop });
    await queue.start();
    await queue.waitForIdle();

    expect(peak).toBeLessThanOrEqual(2);
    const final = (await repo.getSession(manifest.id))!;
    expect(allCandidates(final).every((c) => c.status === "succeeded")).toBe(true);
  });

  test("respects a configured concurrency: mock drive-through saturates 4 in flight, never more (P16)", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seed(repo, 3, 4); // 12 candidates
    let inFlight = 0;
    let peak = 0;
    const inner = createMockRunner({ delayMs: 40 });
    const runner: GenerationRunner = async (request, signal) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await inner(request, signal);
      } finally {
        inFlight -= 1;
      }
    };
    const queue = new RunQueue({
      repo,
      sessionId: manifest.id,
      runner,
      onUpdate: noop,
      concurrency: 4,
    });
    await queue.start();
    expect(queue.snapshot().concurrency).toBe(4);
    await queue.waitForIdle();

    // Saturates the configured pool (genuinely >2 parallel) and never exceeds it.
    expect(peak).toBe(4);
    const final = (await repo.getSession(manifest.id))!;
    expect(allCandidates(final).every((c) => c.status === "succeeded")).toBe(true);
  });

  test("normalizes an invalid concurrency instead of stranding the run (P16)", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seed(repo, 1, 2); // 2 candidates
    // concurrency 0 would make pump() launch nothing forever — must clamp to ≥1.
    const queue = new RunQueue({
      repo,
      sessionId: manifest.id,
      runner: async () => okResult(),
      onUpdate: noop,
      concurrency: 0,
    });
    expect(queue.snapshot().concurrency).toBe(1);
    await queue.start();
    await queue.waitForIdle();
    const final = (await repo.getSession(manifest.id))!;
    expect(allCandidates(final).every((c) => c.status === "succeeded")).toBe(true);
    // NaN falls back to the default; oversize clamps to the 24-candidate ceiling.
    expect(
      new RunQueue({ repo, sessionId: manifest.id, runner: async () => okResult(), onUpdate: noop, concurrency: Number.NaN }).snapshot().concurrency,
    ).toBe(2);
    expect(
      new RunQueue({ repo, sessionId: manifest.id, runner: async () => okResult(), onUpdate: noop, concurrency: 100 }).snapshot().concurrency,
    ).toBe(24);
  });
});

describe("RunQueue — full mock run drives the lifecycle", () => {
  test("every candidate goes queued -> running -> succeeded, results land in the repo", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seed(repo, 2, 2); // 4 candidates
    const sawRunning = new Set<string>();
    const queue = new RunQueue({
      repo,
      sessionId: manifest.id,
      runner: createMockRunner({ delayMs: 4 }),
      onUpdate: (update) => {
        for (const candidate of allCandidates(update.manifest)) {
          if (candidate.status === "running") sawRunning.add(candidate.id);
        }
      },
    });
    // Before start: all queued.
    expect(allCandidates(manifest).every((c) => c.status === "queued")).toBe(true);

    await queue.start();
    await queue.waitForIdle();

    const final = (await repo.getSession(manifest.id))!;
    const candidates = allCandidates(final);
    expect(candidates).toHaveLength(4);
    expect(candidates.every((c) => c.status === "succeeded")).toBe(true);
    expect(sawRunning.size).toBe(4); // each observed running at some update
    for (const candidate of candidates) {
      expect(candidate.images).toHaveLength(1);
      const blob = await repo.getBlob(candidate.images[0].blobId);
      expect(blob).toBeInstanceOf(Blob);
    }
    expect(final.status).toBe("completed");
    expect(summarizeProgress(final).active).toBe(false);
  });
});

describe("RunQueue — reference/request failures terminalize the candidate", () => {
  test("a rejected getBlob fails the candidate instead of leaving it running", async () => {
    const repo = new InMemorySessionRepository();
    // Seed a session that references a blob, then make getBlob reject so buildRequest throws.
    const input: CreateSessionInput = {
      subject: "S",
      palette,
      settings: {
        modelId: "gemini-3.1-flash-image",
        size: "512",
        googleSearch: false,
        variantsPerRecipe: 1,
        callCount: 1,
      },
      estimate: { status: "estimated", usd: 0.05, excludesGrounding: false },
      confirmation: { required: false, acknowledged: false, reasons: [] },
      references: [{ name: "ref.png", mimeType: "image/png", blob: new Blob(["x"]) }],
      arms: [{ id: "arm-1", recipe, renderedPrompt: "p", variants: 1 }],
    };
    const manifest = await repo.createSession(input);
    repo.getBlob = async () => undefined; // reference blob vanishes -> buildRequest throws

    const queue = new RunQueue({
      repo,
      sessionId: manifest.id,
      runner: async () => okResult(),
      onUpdate: noop,
    });
    await queue.start();
    await queue.waitForIdle();

    const [candidate] = allCandidates((await repo.getSession(manifest.id))!);
    expect(candidate.status).toBe("failed"); // not stuck "running"
    expect(candidate.error).toBeTruthy();
  });
});

describe("RunQueue — cancellation", () => {
  test("queued -> not-submitted, in-flight -> unknown-may-be-charged", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seed(repo, 3, 2); // 6 candidates, concurrency 2
    // Long delay so nothing completes before we cancel; mock throws AbortError on abort.
    const queue = new RunQueue({
      repo,
      sessionId: manifest.id,
      runner: createMockRunner({ delayMs: 5000 }),
      onUpdate: noop,
    });
    await queue.start();
    // Let the first two reach the (parked) runner.
    await new Promise((resolve) => setTimeout(resolve, 40));
    await queue.cancel();
    await queue.waitForIdle();

    const final = (await repo.getSession(manifest.id))!;
    const candidates = allCandidates(final);
    expect(candidates.every((c) => c.status === "interrupted")).toBe(true);
    const billings = candidates.map((c) => c.cancellation?.billing);
    expect(billings.filter((b) => b === "unknown-may-be-charged")).toHaveLength(2);
    expect(billings.filter((b) => b === "not-submitted")).toHaveLength(4);
  });
});

describe("RunQueue — fatal abort", () => {
  test("a GeminiFatalError stops the whole run and surfaces a redacted run-level error", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seed(repo, 3, 2); // 6 candidates
    const apiKey = "AIzaSECRETKEY";
    let calls = 0;
    const runner: GenerationRunner = async (_request: GenerationRequest, signal) => {
      calls += 1;
      if (calls === 1) throw new GeminiFatalError(`bad key ${apiKey} rejected`);
      // The concurrent job blocks until aborted by the fatal handler.
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
      return okResult();
    };
    let lastFatal: string | undefined;
    const queue = new RunQueue({
      repo,
      sessionId: manifest.id,
      runner,
      apiKey,
      onUpdate: (update) => {
        if (update.fatalError) lastFatal = update.fatalError;
      },
    });
    await queue.start();
    await queue.waitForIdle();

    expect(lastFatal).toBeTruthy();
    expect(lastFatal).toContain("[redacted]");
    expect(lastFatal).not.toContain(apiKey);

    const candidates = allCandidates((await repo.getSession(manifest.id))!);
    // No candidate remains queued/running; the run is fully terminal.
    expect(candidates.some((c) => c.status === "queued" || c.status === "running")).toBe(false);
    expect(candidates.filter((c) => c.status === "failed")).toHaveLength(1);
    // Remaining queued candidates were interrupted without submission.
    const notSubmitted = candidates.filter((c) => c.cancellation?.billing === "not-submitted");
    expect(notSubmitted.length).toBeGreaterThanOrEqual(4);
    // The redacted key never reaches the failed candidate's stored error either.
    for (const candidate of candidates) {
      if (candidate.error) expect(candidate.error).not.toContain(apiKey);
    }
  });
});
