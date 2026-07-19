// Ported from nano-banana-2 @ 54e0224 — src/models.ts
// Pure pricing/capabilities/validation. Copied verbatim.
//
// Pricing provenance: token rates below are USD per 1,000,000 tokens (paid tier, standard,
// non-batch); `estimatedImageUsd` is a pre-run per-image USD estimate by output size. These
// are a SNAPSHOT — re-verify against https://ai.google.dev/gemini-api/docs/pricing when
// Google changes models or prices. Cross-checked LIVE against real usageMetadata on
// 2026-07-16: a 512px gemini-3.1-flash-image generation billed 747 IMAGE output tokens →
// 747 × $60/1M = $0.0448, matching estimatedImageUsd["512"] = 0.045. The overlapping Flash-Lite
// (0.25/1.5) and Pro (2/12) input/text rates also agree with the sibling pdf-split-parse table
// (verified against Google docs 2026-06-29). Re-verified 2026-07-17 against the pricing page:
// every estimatedImageUsd here equals Google's published per-image OUTPUT price (Flash
// 0.045/0.067/0.101/0.151; Lite 0.0336 at 1K = 1120 tokens x $30/1M; Pro 0.134/0.24), and the
// 30/60/120-per-1M image-output rates match. Note: real Phase-23 Lite runs billed roughly
// $0.047/image at 1K, above this 0.0336 estimate. estimatedImageUsd is OUTPUT-image-only, so the
// gap is consistent with the excluded input/text/thinking tokens a real call also bills (not
// proven per-run). Keep estimatedImageUsd at the published output price; do not substitute
// observed all-in totals for published output-only prices.

export const FLASH_MODEL_ID = "gemini-3.1-flash-image";
export const LITE_MODEL_ID = "gemini-3.1-flash-lite-image";
export const PRO_MODEL_ID = "gemini-3-pro-image";

export const VALID_SIZES = ["512", "1K", "2K", "4K"] as const;
export type ImageSize = (typeof VALID_SIZES)[number];

export const VALID_ASPECTS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "4:5",
  "5:4",
  "21:9",
  "1:4",
  "1:8",
  "4:1",
  "8:1",
] as const;
export type AspectRatio = (typeof VALID_ASPECTS)[number];

const STANDARD_ASPECTS = VALID_ASPECTS.slice(0, 10);

export interface ModelCapability {
  id: string;
  label: string;
  aliases: string[];
  sizes: ImageSize[];
  aspects: readonly string[];
  searchGrounding: boolean;
  pricing: {
    inputPerMillion: number;
    textOutputPerMillion: number;
    imageOutputPerMillion: number;
    estimatedImageUsd: Partial<Record<ImageSize, number>>;
  };
}

export const MODEL_CAPABILITIES: ModelCapability[] = [
  {
    id: FLASH_MODEL_ID,
    label: "Nano Banana 2 · Gemini 3.1 Flash Image",
    aliases: ["flash", "nb2"],
    sizes: ["512", "1K", "2K", "4K"],
    aspects: VALID_ASPECTS,
    searchGrounding: true,
    pricing: {
      inputPerMillion: 0.5,
      textOutputPerMillion: 3,
      imageOutputPerMillion: 60,
      estimatedImageUsd: {
        "512": 0.045,
        "1K": 0.067,
        "2K": 0.101,
        "4K": 0.151,
      },
    },
  },
  {
    id: LITE_MODEL_ID,
    label: "Nano Banana 2 Lite · Gemini 3.1 Flash Lite Image",
    aliases: ["lite", "nb2-lite"],
    sizes: ["1K"],
    aspects: STANDARD_ASPECTS,
    searchGrounding: false,
    pricing: {
      inputPerMillion: 0.25,
      textOutputPerMillion: 1.5,
      imageOutputPerMillion: 30,
      estimatedImageUsd: { "1K": 0.0336 },
    },
  },
  {
    id: PRO_MODEL_ID,
    label: "Nano Banana Pro · Gemini 3 Pro Image",
    aliases: ["pro", "nb-pro"],
    sizes: ["1K", "2K", "4K"],
    aspects: STANDARD_ASPECTS,
    searchGrounding: true,
    pricing: {
      inputPerMillion: 2,
      textOutputPerMillion: 12,
      imageOutputPerMillion: 120,
      estimatedImageUsd: { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
    },
  },
];

const LEGACY_PRICING: Record<string, ModelCapability["pricing"]> = {
  "gemini-3.1-flash-image-preview": {
    inputPerMillion: 0.25,
    textOutputPerMillion: 3,
    imageOutputPerMillion: 60,
    estimatedImageUsd: {},
  },
  "gemini-3-pro-image-preview": {
    inputPerMillion: 2,
    textOutputPerMillion: 12,
    imageOutputPerMillion: 120,
    estimatedImageUsd: {},
  },
};

export function getModelCapability(modelId: string) {
  return MODEL_CAPABILITIES.find((model) => model.id === modelId);
}

export function resolveModel(input: string): string {
  const normalized = input.toLowerCase();
  return MODEL_CAPABILITIES.find((model) => model.aliases.includes(normalized))?.id ?? input;
}

export function getModelPricing(modelId: string) {
  return getModelCapability(modelId)?.pricing ?? LEGACY_PRICING[modelId];
}

export function validateKnownModelSettings(
  modelId: string,
  size: string,
  aspectRatio?: string,
): string | undefined {
  const model = getModelCapability(modelId);
  if (!model) return;
  if (!model.sizes.includes(size as ImageSize)) {
    return `${modelId} does not support ${size}. Supported: ${model.sizes.join(", ")}`;
  }
  if (aspectRatio && !model.aspects.includes(aspectRatio)) {
    return `${modelId} does not support ${aspectRatio}. Supported: ${model.aspects.join(", ")}`;
  }
}

export function estimateImageCost(modelId: string, size: ImageSize) {
  return getModelCapability(modelId)?.pricing.estimatedImageUsd[size];
}
