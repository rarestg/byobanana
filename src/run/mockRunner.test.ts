import { describe, expect, test } from "vitest";

import { finishReasonMessage } from "../core/gemini";
import type { GenerationRequest } from "../core/session";
import { createMockRunner } from "./mockRunner";

const request: GenerationRequest = {
  modelId: "gemini-3.1-flash-image",
  size: "512",
  prompt: "A local transcript search tool.",
  references: [],
  googleSearch: false,
};

describe("createMockRunner", () => {
  test("returns a valid succeeded result with an SVG image + computed cost", async () => {
    const runner = createMockRunner({ delayMs: 1 });
    const result = await runner(request, new AbortController().signal);
    expect(result.status).toBe("succeeded");
    expect(result.images).toHaveLength(1);
    expect(result.images[0].blob).toBeInstanceOf(Blob);
    expect(result.images[0].width).toBe(512);
    expect(result.cost.status).toBe("calculated");
    expect(result.usage).toBeDefined();
  });

  test("aborts with an AbortError when the signal fires mid-delay", async () => {
    const runner = createMockRunner({ delayMs: 5000 });
    const controller = new AbortController();
    const promise = runner(request, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("shouldFail can force a failed or fatal outcome for tests", async () => {
    const failing = createMockRunner({ delayMs: 1, shouldFail: () => "failed" });
    const failed = await failing(request, new AbortController().signal);
    expect(failed.status).toBe("failed");
    expect(failed.images).toHaveLength(0);
    // The mock block stores the SAME mapped human copy the real client would (P15), so the
    // failure UI (card short tag + inspector detail) renders realistically in mock mode.
    expect(failed.error).toBe(finishReasonMessage("PROHIBITED_CONTENT"));

    const fatal = createMockRunner({ delayMs: 1, shouldFail: () => "fatal" });
    await expect(fatal(request, new AbortController().signal)).rejects.toMatchObject({
      name: "GeminiFatalError",
    });
  });
});
