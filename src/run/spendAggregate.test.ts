import { describe, expect, test } from "vitest";

import type { SpendSummary } from "../core/cost";
import type { SessionSummary } from "../core/session";
import { aggregateSpend, emptyAccumulator, formatSpend, addSpend, spendCaveats } from "./spendAggregate";

// A minimal SessionSummary carrying just the fields the aggregator reads.
function summary(modelId: string, spend: SpendSummary, generatedImageCount: number): SessionSummary {
  return {
    id: `s-${Math.random()}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    subject: "x",
    recipes: ["r"],
    settings: {
      modelId,
      size: "1K",
      googleSearch: false,
      variantsPerRecipe: 1,
      callCount: 1,
    },
    estimate: { status: "estimated", usd: 0.1, excludesGrounding: false },
    spend,
    generatedImageCount,
  };
}

const complete = (usd: number, count: number): SpendSummary => ({
  status: "complete",
  calculatedUsd: usd,
  calculatedCount: count,
  upperBoundCount: 0,
  unavailableCount: 0,
  unknownMayBeChargedCount: 0,
  unknownGroundingChargeCount: 0,
});

describe("aggregateSpend", () => {
  test("sums calculated spend and generated images per model across sessions", () => {
    const report = aggregateSpend([
      summary("gemini-3.1-flash-image", complete(0.1, 2), 2),
      summary("gemini-3.1-flash-image", complete(0.2, 3), 3),
      summary("gemini-3-pro-image", complete(0.5, 1), 1),
    ]);
    expect(report.sessionCount).toBe(3);
    expect(report.total.calculatedUsd).toBeCloseTo(0.8, 6);
    // Rows sorted by known spend desc: pro (0.5) then flash (0.3).
    expect(report.rows.map((r) => r.modelId)).toEqual([
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
    ]);
    const flash = report.rows.find((r) => r.modelId === "gemini-3.1-flash-image")!;
    expect(flash.images).toBe(5);
    expect(flash.spend.calculatedUsd).toBeCloseTo(0.3, 6);
    expect(flash.label).toBe("up to $0.30");
    expect(report.totalLabel).toBe("up to $0.80");
  });

  test("a genuinely-empty run reads $0.00", () => {
    const report = aggregateSpend([
      summary("gemini-3.1-flash-image", {
        status: "complete",
        calculatedCount: 0,
        upperBoundCount: 0,
        unavailableCount: 0,
        unknownMayBeChargedCount: 0,
        unknownGroundingChargeCount: 0,
      }, 0),
    ]);
    expect(report.totalLabel).toBe("$0.00");
  });

  test("NEVER renders an unavailable cost as $0 — surfaces a caveat instead", () => {
    const report = aggregateSpend([
      summary("gemini-3.1-flash-image", {
        status: "unavailable",
        calculatedCount: 0,
        upperBoundCount: 0,
        unavailableCount: 2,
        unknownMayBeChargedCount: 0,
        unknownGroundingChargeCount: 0,
      }, 0),
    ]);
    expect(report.totalLabel).not.toContain("$0");
    expect(report.totalLabel).toBe("Cost unavailable");
    expect(report.rows[0].caveats).toContain("Some image costs are unavailable.");
  });

  test("partial spend renders one ceiling, never the 'Known:' dual label", () => {
    const acc = emptyAccumulator();
    addSpend(acc, {
      status: "partial",
      calculatedUsd: 0.25,
      calculatedCount: 1,
      upperBoundCount: 0,
      unavailableCount: 1,
      unknownMayBeChargedCount: 0,
      unknownGroundingChargeCount: 0,
    });
    // One shape forever: the known amount reads as a ceiling; the unavailable-cost
    // caveat surfaces separately (spendCaveats), never folded into a "Known:" label.
    expect(formatSpend(acc)).toBe("up to $0.25");
    expect(formatSpend(acc)).not.toContain("Known");
    expect(spendCaveats(acc)).toContain("Some image costs are unavailable.");
  });

  test("folds a mixed calculated + upper-bound total into one 'up to' ceiling", () => {
    const acc = emptyAccumulator();
    addSpend(acc, complete(0.1, 1));
    addSpend(acc, {
      status: "upper-bound",
      upperBoundUsd: 0.28,
      calculatedCount: 0,
      upperBoundCount: 2,
      unavailableCount: 0,
      unknownMayBeChargedCount: 0,
      unknownGroundingChargeCount: 0,
    });
    expect(formatSpend(acc)).toBe("up to $0.38");
  });

  test("may-have-been-charged cancellations surface without a $0", () => {
    const acc = emptyAccumulator();
    addSpend(acc, {
      status: "unavailable",
      calculatedCount: 0,
      upperBoundCount: 0,
      unavailableCount: 0,
      unknownMayBeChargedCount: 2,
      unknownGroundingChargeCount: 0,
    });
    expect(formatSpend(acc)).toBe("May have charges");
  });

  test("no sessions yields an empty report", () => {
    const report = aggregateSpend([]);
    expect(report.sessionCount).toBe(0);
    expect(report.rows).toHaveLength(0);
    expect(report.totalLabel).toBe("$0.00");
  });
});
