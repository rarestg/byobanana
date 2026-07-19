import { describe, expect, test } from "vitest";

import {
  calculateGenerationCost,
  classifyUsage,
  confirmationReasons,
  estimateSessionCost,
  summarizeSpend,
} from "./cost";
import { FLASH_MODEL_ID } from "./models";

describe("usage classification", () => {
  test("splits detailed image/text output tokens", () => {
    expect(
      classifyUsage({
        promptTokenCount: 10,
        candidatesTokenCount: 752,
        thoughtsTokenCount: 2,
        totalTokenCount: 764,
        candidatesTokensDetails: [
          { modality: "IMAGE", tokenCount: 747 },
          { modality: "TEXT", tokenCount: 5 },
        ],
      }),
    ).toEqual({
      promptTokens: 10,
      candidateTokens: 752,
      thoughtTokens: 2,
      imageOutputTokens: 747,
      textOutputTokens: 5,
      unclassifiedOutputTokens: 0,
      totalTokens: 764,
    });
  });

  test("treats candidate tokens without modality detail as unknown output", () => {
    const usage = classifyUsage({
      promptTokenCount: 2,
      candidatesTokenCount: 17,
      totalTokenCount: 19,
    });
    expect(usage.imageOutputTokens).toBe(0);
    expect(usage.unclassifiedOutputTokens).toBe(17);
  });
});

describe("generation cost", () => {
  test("prices a fully classified generation exactly", () => {
    const usage = classifyUsage({
      promptTokenCount: 10,
      candidatesTokenCount: 752,
      thoughtsTokenCount: 2,
      totalTokenCount: 764,
      candidatesTokensDetails: [
        { modality: "IMAGE", tokenCount: 747 },
        { modality: "TEXT", tokenCount: 5 },
      ],
    });
    const cost = calculateGenerationCost(FLASH_MODEL_ID, usage);
    expect(cost.status).toBe("calculated");
    expect(cost.usd).toBeCloseTo(0.044846, 6);
  });

  test("prices unknown output as a conservative image-rate upper bound", () => {
    const cost = calculateGenerationCost(FLASH_MODEL_ID, {
      promptTokens: 246,
      candidateTokens: 1_084,
      thoughtTokens: 0,
      imageOutputTokens: 747,
      textOutputTokens: 0,
      unclassifiedOutputTokens: 337,
      totalTokens: 1_330,
    });
    expect(cost.status).toBe("upper-bound");
    expect(cost.usd).toBeCloseTo(0.065163, 6);
  });

  // Documents a deliberately faithful port of a source quirk: empty usage metadata
  // classifies as all-zero and prices as a "calculated" $0 (not "unavailable").
  // Real generations always carry token counts; kept as-is for fidelity to 54e0224.
  test("prices empty usage metadata as a calculated $0 (source-faithful quirk)", () => {
    const cost = calculateGenerationCost(FLASH_MODEL_ID, classifyUsage({}));
    expect(cost.status).toBe("calculated");
    expect(cost.usd).toBe(0);
  });

  test("returns unavailable cost for an unknown exact model instead of guessing", () => {
    expect(
      calculateGenerationCost("unknown-model", {
        promptTokens: 1,
        candidateTokens: 1,
        thoughtTokens: 0,
        imageOutputTokens: 1,
        textOutputTokens: 0,
        unclassifiedOutputTokens: 0,
        totalTokens: 2,
      }),
    ).toEqual({ status: "unavailable", excludesGrounding: false });
  });
});

describe("pre-run estimate + confirmation thresholds", () => {
  test("estimates per-image cost times the call count", () => {
    const estimate = estimateSessionCost(FLASH_MODEL_ID, "512", 4);
    expect(estimate.status).toBe("estimated");
    expect(estimate.usd).toBeCloseTo(0.18, 6);
    expect(estimateSessionCost("unknown-model", "1K", 4).status).toBe("unavailable");
  });

  test("flags runs over the 8-call or $1 thresholds", () => {
    expect(confirmationReasons(4, 0.5)).toEqual([]);
    expect(confirmationReasons(12, 0.5)).toEqual(["12 calls exceeds the 8-call threshold"]);
    expect(confirmationReasons(4, 2)).toEqual(["$2.00 exceeds the $1 estimate threshold"]);
    expect(confirmationReasons(12, 2)).toHaveLength(2);
  });
});

describe("realized spend projection", () => {
  const calc = (usd: number) => ({ status: "calculated" as const, usd, excludesGrounding: false });
  const upper = (usd: number) => ({ status: "upper-bound" as const, usd, excludesGrounding: false });

  test("sums calculated spend as complete", () => {
    const spend = summarizeSpend([{ cost: calc(0.04) }, { cost: calc(0.06) }]);
    expect(spend.status).toBe("complete");
    expect(spend.calculatedUsd).toBeCloseTo(0.1, 6);
    expect(spend.calculatedCount).toBe(2);
  });

  test("reports upper-bound when any candidate is an upper bound", () => {
    const spend = summarizeSpend([{ cost: calc(0.04) }, { cost: upper(0.06) }]);
    expect(spend.status).toBe("upper-bound");
    expect(spend.upperBoundUsd).toBeCloseTo(0.06, 6);
  });

  test("reports partial when known and unknown costs mix", () => {
    const spend = summarizeSpend([{ cost: calc(0.04) }, {}]);
    expect(spend.status).toBe("partial");
    expect(spend.unavailableCount).toBe(1);
  });

  test("counts cancellation billing and grounding uncertainty", () => {
    const spend = summarizeSpend([
      { cancellation: { billing: "unknown-may-be-charged" } },
      { cost: { status: "calculated", usd: 0.04, excludesGrounding: true } },
    ]);
    expect(spend.status).toBe("partial");
    expect(spend.unknownMayBeChargedCount).toBe(1);
    expect(spend.unknownGroundingChargeCount).toBe(1);
  });
});
