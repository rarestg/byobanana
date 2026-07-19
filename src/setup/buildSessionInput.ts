// Pure assembly of a CreateSessionInput from the form's resolved values. Kept free of
// React/DOM so the payload shape — the contract P3's queue consumes — is unit-tested
// under node. Mirrors nano-banana-2 store.ts createSession: callCount = recipes ×
// variants, the estimate + confirmation thresholds come from core/cost.ts, and each
// arm's prompt is pre-rendered via renderRecipe (the caller renders; session.ts does
// not). Candidate records are NOT built here — InMemorySessionRepository derives them
// from arm.id + variants, so we hand it only { id, recipe, renderedPrompt, variants }.

import { estimateSessionCost, confirmationReasons } from "../core/cost";
import type { ImageSize, AspectRatio } from "../core/models";
import { getColorPalette } from "../core/palettes";
import {
  canonicalBackgroundColor,
  loadRecipes,
  renderRecipe,
  recipeFamily,
  type Recipe,
} from "../core/recipes";
import type { CreateSessionInput } from "../core/session";

export interface SetupSettings {
  modelId: string;
  size: ImageSize;
  aspectRatio: AspectRatio;
  googleSearch: boolean;
  variants: number;
  // Parallel in-flight requests (P16). The form validates 1–24; clamped again here so a
  // programmatic caller can't smuggle an out-of-range concurrency into the manifest.
  parallel: number;
}

export interface BuildSessionParams {
  subject: string;
  recipeIds: string[]; // in display order; arms follow this order
  paletteId: string;
  // Icon background (any #rrggbb spelling; canonicalized here). Consumed only when a
  // selected recipe's template takes {{backgroundColor}}; ignored otherwise.
  backgroundColor?: string;
  settings: SetupSettings;
  references: CreateSessionInput["references"];
  acknowledged: boolean;
  // A pre-loaded catalog can be injected in tests; defaults to the bundled recipes.
  catalog?: Recipe[];
  // Set on "Edit and regenerate": the immediate parent session this run was derived from.
  derivedFromSessionId?: string;
}

export interface BuiltSession {
  input: CreateSessionInput;
  callCount: number;
  family: "image" | "icon";
}

// Resolve recipeIds against the catalog, preserving order. Throws on an unknown id or
// a mixed image/icon family (guarded upstream, but kept honest here).
export function resolveRecipes(recipeIds: string[], catalog: Recipe[]): Recipe[] {
  const recipes = recipeIds.map((id) => {
    const recipe = catalog.find((candidate) => candidate.id === id);
    if (!recipe) throw new Error(`Unknown recipe: ${id}`);
    return recipe;
  });
  if (recipes.length && new Set(recipes.map(recipeFamily)).size !== 1) {
    throw new Error("Image and icon recipes cannot be combined in one run.");
  }
  return recipes;
}

export function buildSessionInput(params: BuildSessionParams): BuiltSession {
  const catalog = params.catalog ?? loadRecipes();
  const recipes = resolveRecipes(params.recipeIds, catalog);
  if (!recipes.length) throw new Error("At least one style recipe is required.");

  const subject = params.subject.trim();
  const palette = getColorPalette(params.paletteId);
  if (!palette) throw new Error(`Unknown color palette: ${params.paletteId}`);

  // The background matters only when a selected template consumes it. Canonicalize (and
  // store) only then, so a stale value can't fail an unrelated (e.g. Custom-icon) run.
  const usesBackgroundColor = recipes.some((recipe) =>
    recipe.promptTemplate.includes("{{backgroundColor}}"),
  );
  const backgroundColor =
    usesBackgroundColor && params.backgroundColor !== undefined
      ? canonicalBackgroundColor(params.backgroundColor)
      : undefined;

  const { modelId, size, aspectRatio, googleSearch, variants, parallel } = params.settings;
  const callCount = recipes.length * variants;
  const parallelRequests = Number.isFinite(parallel)
    ? Math.min(24, Math.max(1, Math.round(parallel)))
    : 4;
  const estimate = estimateSessionCost(modelId, size, callCount, googleSearch);
  const reasons = confirmationReasons(callCount, estimate.usd);

  const input: CreateSessionInput = {
    subject,
    // The source always stores the selected palette (renderRecipe ignores it for
    // Custom, whose template has no {{colorPalette}}), so we pass it unconditionally.
    palette,
    // The background is stored only when an arm actually rendered it (honest provenance:
    // a Custom-icon-only run records none). renderRecipe throws when a styled icon
    // template needs a color and none was supplied.
    ...(backgroundColor !== undefined ? { backgroundColor } : {}),
    settings: {
      modelId,
      size,
      aspectRatio,
      googleSearch,
      variantsPerRecipe: variants,
      callCount,
      parallelRequests,
    },
    estimate,
    confirmation: {
      required: reasons.length > 0,
      acknowledged: reasons.length > 0 ? params.acknowledged : false,
      reasons,
    },
    references: params.references,
    derivedFromSessionId: params.derivedFromSessionId,
    arms: recipes.map((recipe, index) => ({
      id: `arm-${index + 1}`,
      recipe,
      renderedPrompt: renderRecipe(recipe, subject, palette, backgroundColor),
      variants,
    })),
  };

  return { input, callCount, family: recipeFamily(recipes[0]) };
}
