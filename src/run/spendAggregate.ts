// Cross-session spend aggregation for the header spend popover. Ported verbatim from
// nano-banana-2 @ 54e0224 web/app.js (emptySpendSummary / addSpend / spendCaveats /
// formatSpend / renderSpend, modelNameParts). Pure and DOM-free so it unit-tests under
// node. Sums each stored session's per-session SpendSummary (core/cost summarizeSpend)
// into a cross-session total plus a per-model breakdown.
//
// The cardinal rule the source enforces and we keep: an unavailable/unknown cost is NEVER
// shown as "$0"; only a genuinely-empty run (no cost, no caveats) reads "$0.00".

import { getModelCapability } from "../core/models";
import type { SpendSummary } from "../core/cost";
import type { SessionSummary } from "../core/session";

// The running accumulator (source emptySpendSummary): sums usd + counts across sessions and
// tracks whether any known cost exists and whether anything is partial/unavailable.
export interface SpendAccumulator {
  calculatedUsd: number;
  upperBoundUsd: number;
  calculatedCount: number;
  upperBoundCount: number;
  unavailableCount: number;
  unknownMayBeChargedCount: number;
  unknownGroundingChargeCount: number;
  hasCalculatedUsd: boolean;
  hasUpperBoundUsd: boolean;
  partial: boolean;
  unavailable: boolean;
}

export function emptyAccumulator(): SpendAccumulator {
  return {
    calculatedUsd: 0,
    upperBoundUsd: 0,
    calculatedCount: 0,
    upperBoundCount: 0,
    unavailableCount: 0,
    unknownMayBeChargedCount: 0,
    unknownGroundingChargeCount: 0,
    hasCalculatedUsd: false,
    hasUpperBoundUsd: false,
    partial: false,
    unavailable: false,
  };
}

// Fold one session's SpendSummary into an accumulator (source addSpend).
export function addSpend(acc: SpendAccumulator, spend: SpendSummary | undefined): void {
  if (!spend) {
    acc.unavailable = true;
    return;
  }
  if (typeof spend.calculatedUsd === "number") {
    acc.calculatedUsd += spend.calculatedUsd;
    acc.hasCalculatedUsd = true;
  }
  if (typeof spend.upperBoundUsd === "number") {
    acc.upperBoundUsd += spend.upperBoundUsd;
    acc.hasUpperBoundUsd = true;
  }
  acc.calculatedCount += spend.calculatedCount;
  acc.upperBoundCount += spend.upperBoundCount;
  acc.unavailableCount += spend.unavailableCount;
  acc.unknownMayBeChargedCount += spend.unknownMayBeChargedCount;
  acc.unknownGroundingChargeCount += spend.unknownGroundingChargeCount ?? 0;
  if (spend.status === "partial") acc.partial = true;
  if (spend.status === "unavailable" && spend.unavailableCount > 0) acc.unavailable = true;
}

// Human caveats (source spendCaveats): unavailable image costs, may-have-been-charged
// cancellations, and grounding charges excluded from the estimate.
export function spendCaveats(acc: SpendAccumulator): string[] {
  const caveats: string[] = [];
  if (acc.unavailable || acc.unavailableCount > 0) {
    caveats.push("Some image costs are unavailable.");
  }
  if (acc.unknownMayBeChargedCount > 0) {
    caveats.push(
      `${acc.unknownMayBeChargedCount} canceled request${acc.unknownMayBeChargedCount === 1 ? " may" : "s may"} have been charged.`,
    );
  }
  if (acc.unknownGroundingChargeCount > 0) {
    caveats.push(
      `Grounding charges are not included for ${acc.unknownGroundingChargeCount} candidate request${acc.unknownGroundingChargeCount === 1 ? "" : "s"}.`,
    );
  }
  return caveats;
}

// A one-line money string (source formatSpend, adapted). Any known spend renders as ONE
// ceiling, "up to $TOTAL" where TOTAL folds actual + estimated remainder — a single shape
// forever (an exact-only cost is still a ceiling). Never emits "$0" for an unavailable/unknown
// cost — only a truly empty accumulator returns "$0.00". Caveats surface separately.
export function formatSpend(acc: SpendAccumulator): string {
  if (acc.hasCalculatedUsd || acc.hasUpperBoundUsd) {
    return `up to $${(acc.calculatedUsd + acc.upperBoundUsd).toFixed(2)}`;
  }
  if (spendCaveats(acc).length) {
    if (acc.unknownMayBeChargedCount > 0) return "May have charges";
    return "Cost unavailable";
  }
  return "$0.00";
}

// The model's display name split into {name, detail} at " · " (source modelNameParts): e.g.
// "Nano Banana 2 · Gemini 3.1 Flash Image" -> name "Nano Banana 2", detail "Gemini 3.1 …".
export function modelNameParts(modelId: string): { name: string; detail: string } {
  const label = getModelCapability(modelId)?.label ?? modelId;
  const index = label.indexOf(" · ");
  if (index === -1) return { name: label, detail: "" };
  return { name: label.slice(0, index), detail: label.slice(index + 3) };
}

export interface ModelSpendRow {
  modelId: string;
  name: string;
  detail: string;
  images: number;
  imageCountKnown: boolean;
  spend: SpendAccumulator;
  caveats: string[];
  label: string;
}

export interface SpendReport {
  sessionCount: number;
  total: SpendAccumulator;
  totalLabel: string; // one-line total: "up to $X", "May have charges", "Cost unavailable", or "$0.00"
  rows: ModelSpendRow[];
}

// The full cross-session spend report (source renderSpend, minus DOM). Rows are sorted by
// known spend (calculated + upper-bound) descending, matching the source ordering.
export function aggregateSpend(sessions: readonly SessionSummary[]): SpendReport {
  const total = emptyAccumulator();
  const byModel = new Map<string, { images: number; imageCountKnown: boolean; spend: SpendAccumulator }>();

  for (const session of sessions) {
    addSpend(total, session.spend);
    const entry =
      byModel.get(session.settings.modelId) ??
      { images: 0, imageCountKnown: true, spend: emptyAccumulator() };
    if (Number.isInteger(session.generatedImageCount)) entry.images += session.generatedImageCount;
    else entry.imageCountKnown = false;
    addSpend(entry.spend, session.spend);
    byModel.set(session.settings.modelId, entry);
  }

  const rows: ModelSpendRow[] = [...byModel.entries()]
    .sort(
      (a, b) =>
        b[1].spend.calculatedUsd +
        b[1].spend.upperBoundUsd -
        (a[1].spend.calculatedUsd + a[1].spend.upperBoundUsd),
    )
    .map(([modelId, entry]) => {
      const { name, detail } = modelNameParts(modelId);
      return {
        modelId,
        name,
        detail,
        images: entry.images,
        imageCountKnown: entry.imageCountKnown,
        spend: entry.spend,
        caveats: spendCaveats(entry.spend),
        label: formatSpend(entry.spend),
      };
    });

  return {
    sessionCount: sessions.length,
    total,
    totalLabel: formatSpend(total),
    rows,
  };
}
