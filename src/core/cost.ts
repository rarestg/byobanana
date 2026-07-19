// Ported from nano-banana-2 @ 54e0224 — src/generate.ts (pure cost/usage logic)
// and src/workbench/store.ts (pre-run estimate + confirmation thresholds).
// The provider call itself (@google/genai, Buffer) is NOT ported — only the pure
// token-classification and pricing math, which must stay byte-faithful to the
// source so cost reporting does not drift.

import { estimateImageCost, getModelPricing, type ImageSize } from "./models";

export interface GenerationUsage {
  promptTokens: number;
  candidateTokens: number;
  thoughtTokens: number;
  imageOutputTokens: number;
  textOutputTokens: number;
  unclassifiedOutputTokens: number;
  totalTokens: number;
}

export interface GenerationCost {
  status: "calculated" | "upper-bound" | "unavailable";
  usd?: number;
  excludesGrounding: boolean;
}

interface TokenDetail {
  modality?: string;
  tokenCount?: number;
}

// Raw Gemini usage metadata (the subset the workbench reads).
export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  candidatesTokensDetails?: TokenDetail[];
}

function tokenCountByModality(details: TokenDetail[] | undefined, modality: string) {
  return (details ?? [])
    .filter((detail) => detail.modality === modality)
    .reduce((sum, detail) => sum + (detail.tokenCount ?? 0), 0);
}

// Classify a raw Gemini usageMetadata block into structured token buckets. Output
// tokens without a per-modality breakdown are counted as `unclassifiedOutputTokens`
// so cost can be reported as a conservative upper bound rather than guessed.
export function classifyUsage(metadata: UsageMetadata): GenerationUsage {
  const candidateTokens = metadata.candidatesTokenCount ?? 0;
  const detailedImageTokens = tokenCountByModality(metadata.candidatesTokensDetails, "IMAGE");
  const detailedTextTokens = tokenCountByModality(metadata.candidatesTokensDetails, "TEXT");
  const hasDetailedOutput = detailedImageTokens > 0 || detailedTextTokens > 0;
  return {
    promptTokens: metadata.promptTokenCount ?? 0,
    candidateTokens,
    thoughtTokens: metadata.thoughtsTokenCount ?? 0,
    imageOutputTokens: hasDetailedOutput ? detailedImageTokens : 0,
    textOutputTokens: hasDetailedOutput ? detailedTextTokens : 0,
    unclassifiedOutputTokens: hasDetailedOutput
      ? Math.max(0, candidateTokens - detailedImageTokens - detailedTextTokens)
      : candidateTokens,
    totalTokens: metadata.totalTokenCount ?? 0,
  };
}

export function calculateGenerationCost(
  modelId: string,
  usage: GenerationUsage,
  googleSearch = false,
): GenerationCost {
  const pricing = getModelPricing(modelId);
  if (!pricing) {
    return { status: "unavailable", excludesGrounding: googleSearch };
  }

  const input = (usage.promptTokens / 1_000_000) * pricing.inputPerMillion;
  const image = (usage.imageOutputTokens / 1_000_000) * pricing.imageOutputPerMillion;
  const text =
    ((usage.textOutputTokens + usage.thoughtTokens) / 1_000_000) * pricing.textOutputPerMillion;
  const unknown =
    (usage.unclassifiedOutputTokens / 1_000_000) *
    Math.max(pricing.textOutputPerMillion, pricing.imageOutputPerMillion);

  return {
    status: usage.unclassifiedOutputTokens ? "upper-bound" : "calculated",
    usd: input + image + text + unknown,
    excludesGrounding: googleSearch,
  };
}

export interface SessionEstimate {
  status: "estimated" | "unavailable";
  usd?: number;
  excludesGrounding: boolean;
}

// Pre-run spend estimate for a session (store.ts createSession). callCount =
// recipes * variantsPerRecipe.
export function estimateSessionCost(
  modelId: string,
  size: ImageSize,
  callCount: number,
  googleSearch = false,
): SessionEstimate {
  const perImageEstimate = estimateImageCost(modelId, size);
  const usd = perImageEstimate === undefined ? undefined : perImageEstimate * callCount;
  return {
    status: usd === undefined ? "unavailable" : "estimated",
    usd,
    excludesGrounding: googleSearch,
  };
}

// The confirmation thresholds a run must clear before it may proceed unattended
// (store.ts createSession): more than 8 calls, or an estimate over $1.
export function confirmationReasons(callCount: number, estimatedUsd: number | undefined): string[] {
  return [
    ...(callCount > 8 ? [`${callCount} calls exceeds the 8-call threshold`] : []),
    ...(estimatedUsd !== undefined && estimatedUsd > 1
      ? [`$${estimatedUsd.toFixed(2)} exceeds the $1 estimate threshold`]
      : []),
  ];
}

export interface SpendSummary {
  status: "complete" | "upper-bound" | "partial" | "unavailable";
  calculatedUsd?: number;
  upperBoundUsd?: number;
  calculatedCount: number;
  upperBoundCount: number;
  unavailableCount: number;
  unknownMayBeChargedCount: number;
  unknownGroundingChargeCount: number;
}

// One candidate's realized cost, as far as spend aggregation cares about it.
export interface SpendCandidate {
  cost?: GenerationCost;
  cancellation?: { billing: "not-submitted" | "unknown-may-be-charged" | "reported-usage" };
}

// Pure realized-spend projection over a session's candidates (store.ts listHistory).
// Ported now so SessionSummary's contract does not change when P5 renders spend.
export function summarizeSpend(candidates: readonly SpendCandidate[]): SpendSummary {
  let calculatedUsd = 0;
  let upperBoundUsd = 0;
  let calculatedCount = 0;
  let upperBoundCount = 0;
  let unavailableCount = 0;
  let unknownMayBeChargedCount = 0;
  let unknownGroundingChargeCount = 0;
  for (const candidate of candidates) {
    if (candidate.cost?.excludesGrounding) unknownGroundingChargeCount++;
    if (candidate.cost?.status === "calculated" && candidate.cost.usd !== undefined) {
      calculatedUsd += candidate.cost.usd;
      calculatedCount++;
    } else if (candidate.cost?.status === "upper-bound" && candidate.cost.usd !== undefined) {
      upperBoundUsd += candidate.cost.usd;
      upperBoundCount++;
    } else if (candidate.cancellation?.billing === "unknown-may-be-charged") {
      unknownMayBeChargedCount++;
    } else if (candidate.cancellation?.billing !== "not-submitted") {
      unavailableCount++;
    }
  }
  const hasKnownCost = calculatedCount + upperBoundCount > 0;
  const hasUnknownCost =
    unavailableCount + unknownMayBeChargedCount + unknownGroundingChargeCount > 0;
  return {
    status: hasUnknownCost
      ? hasKnownCost
        ? "partial"
        : "unavailable"
      : upperBoundCount
        ? "upper-bound"
        : "complete",
    calculatedUsd: calculatedCount ? calculatedUsd : undefined,
    upperBoundUsd: upperBoundCount ? upperBoundUsd : undefined,
    calculatedCount,
    upperBoundCount,
    unavailableCount,
    unknownMayBeChargedCount,
    unknownGroundingChargeCount,
  };
}
