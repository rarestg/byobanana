// Ported from nano-banana-2 @ 54e0224 — src/workbench/recipes.ts
// Pure recipe schema + rendering. The Node filesystem loader is dropped: the twelve
// built-in recipes are bundled as ES JSON imports instead. `assertRecipe` is now
// exported so tests can validate arbitrary objects without a filesystem.

import { type ColorPalette, palettePrompt } from "./palettes";

import airyPastelModernist from "./recipes/airy-pastel-modernist.json";
import customIcon from "./recipes/custom-icon.json";
import custom from "./recipes/custom.json";
import cutPaperIcon from "./recipes/cut-paper-icon.json";
import geometricIsometricIcon from "./recipes/geometric-isometric-icon.json";
import glassIcon from "./recipes/glass-icon.json";
import hardEdgeGeometricScreenprint from "./recipes/hard-edge-geometric-screenprint.json";
import impactIcon from "./recipes/impact-icon.json";
import modernFlatIcon from "./recipes/modern-flat-icon.json";
import ornamentalMiniatureMaximalism from "./recipes/ornamental-miniature-maximalism.json";
import refinedPixelArt from "./recipes/refined-pixel-art.json";
import tenebristOilRealism from "./recipes/tenebrist-oil-realism.json";

export interface Recipe {
  schemaVersion: 1;
  id: string;
  version: number;
  name: string;
  description: string;
  kind: "project-icon" | "artwork" | "custom";
  comparable: boolean;
  promptTemplate: string;
  // "folio-icon" is a legacy name kept as-is: it is a persisted behavior discriminator
  // embedded in historical manifests' recipe snapshots. Never rename it.
  preview:
    | {
        type: "folio-icon";
        sizes: number[];
        backgrounds: { light: string; dark: string };
      }
    | { type: "generic" };
  // Export SIZES are an app/product concern (image.ts ICON_SIZE + the suite sizes), not
  // per-recipe data — the schema carries only the behavior discriminator. Historical
  // manifests embed recipe snapshots with the retired width/height keys; those stay
  // loadable (TS structural typing; assertRecipe never runs on stored manifests).
  export:
    | {
        type: "folio-icon";
        transparentOutsideCircle: true;
      }
    | { type: "raw-only" };
}

export function recipeFamily(recipe: Recipe): "image" | "icon" {
  return recipe.export.type === "folio-icon" ? "icon" : "image";
}

export const FULL_FRAME_ARTWORK_MODIFIER =
  "Render only the finished artwork itself as a clean, full-frame image. Do not show a physical canvas, manuscript, page, book, print, poster, frame, wall, studio, screen, monitor, photograph, or presentation mockup. Show no physical page edges, borders, cast shadows, or surrounding presentation context. Any ornamental border must be an intentional element inside the artwork itself, not the visible edge of a physical sheet.";

// The default icon background. Continuity: before {{backgroundColor}} existed, the icon
// recipes used the default folio-teal palette's first color (#FAFAFA) as the background.
export const DEFAULT_ICON_BACKGROUND = "#FAFAFA";

// Canonical background color form: uppercase #RRGGBB. Rendered prompts are hashed
// (promptSha256), so one canonical spelling keeps edit-and-regenerate deterministic.
const CANONICAL_BACKGROUND = /^#[0-9A-F]{6}$/;

// Canonicalize a user-supplied background color (trim + uppercase) or throw. Called once
// at the form/seed boundary; everything downstream stores and renders the canonical form.
export function canonicalBackgroundColor(value: string): string {
  const canonical = value.trim().toUpperCase();
  if (!CANONICAL_BACKGROUND.test(canonical)) {
    throw new Error(`Invalid icon background color: ${value}`);
  }
  return canonical;
}

export function assertRecipe(value: unknown, path: string): asserts value is Recipe {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid recipe: ${path}`);
  }
  const recipe = value as Record<string, unknown>;
  const rootKeys = [
    "schemaVersion",
    "id",
    "version",
    "name",
    "description",
    "kind",
    "comparable",
    "promptTemplate",
    "preview",
    "export",
  ];
  if (
    recipe.schemaVersion !== 1 ||
    typeof recipe.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recipe.id) ||
    !Number.isInteger(recipe.version) ||
    (recipe.version as number) < 1 ||
    typeof recipe.name !== "string" ||
    typeof recipe.description !== "string" ||
    !["project-icon", "artwork", "custom"].includes(String(recipe.kind)) ||
    typeof recipe.comparable !== "boolean" ||
    typeof recipe.promptTemplate !== "string" ||
    !recipe.promptTemplate.includes("{{subject}}") ||
    Object.keys(recipe).some((key) => !rootKeys.includes(key))
  ) {
    throw new Error(`Invalid recipe: ${path}`);
  }
  if (
    typeof recipe.preview !== "object" ||
    recipe.preview === null ||
    Array.isArray(recipe.preview)
  ) {
    throw new Error(`Invalid recipe preview: ${path}`);
  }
  const preview = recipe.preview as Record<string, unknown>;
  if (preview.type === "folio-icon") {
    if (
      Object.keys(preview).some((key) => !["type", "sizes", "backgrounds"].includes(key)) ||
      !Array.isArray(preview.sizes) ||
      !preview.sizes.length ||
      preview.sizes.some((size) => !Number.isInteger(size) || (size as number) < 1) ||
      typeof preview.backgrounds !== "object" ||
      preview.backgrounds === null ||
      Array.isArray(preview.backgrounds)
    ) {
      throw new Error(`Invalid icon preview: ${path}`);
    }
    const backgrounds = preview.backgrounds as Record<string, unknown>;
    if (
      Object.keys(backgrounds).some((key) => !["light", "dark"].includes(key)) ||
      typeof backgrounds.light !== "string" ||
      typeof backgrounds.dark !== "string"
    ) {
      throw new Error(`Invalid icon preview backgrounds: ${path}`);
    }
  } else if (preview.type !== "generic" || Object.keys(preview).some((key) => key !== "type")) {
    throw new Error(`Invalid recipe preview type: ${path}`);
  }
  if (typeof recipe.export !== "object" || recipe.export === null || Array.isArray(recipe.export)) {
    throw new Error(`Invalid recipe export: ${path}`);
  }
  const exportSettings = recipe.export as Record<string, unknown>;
  if (exportSettings.type === "folio-icon") {
    if (
      Object.keys(exportSettings).some(
        (key) => !["type", "transparentOutsideCircle"].includes(key),
      ) ||
      exportSettings.transparentOutsideCircle !== true
    ) {
      throw new Error(`Invalid icon export: ${path}`);
    }
  } else if (
    exportSettings.type !== "raw-only" ||
    Object.keys(exportSettings).some((key) => key !== "type")
  ) {
    throw new Error(`Invalid recipe export type: ${path}`);
  }
  if (
    (recipe.kind === "project-icon" &&
      (preview.type !== "folio-icon" || exportSettings.type !== "folio-icon")) ||
    (recipe.kind === "artwork" &&
      (preview.type !== "generic" || exportSettings.type !== "raw-only")) ||
    (recipe.kind === "custom" &&
      (recipe.comparable ||
        !(
          (preview.type === "generic" && exportSettings.type === "raw-only") ||
          (preview.type === "folio-icon" && exportSettings.type === "folio-icon")
        )))
  ) {
    throw new Error(`Recipe kind does not match preview/export behavior: ${path}`);
  }
  const promptVariables = [...recipe.promptTemplate.matchAll(/{{[^{}]*}}/g)].map(
    (match) => match[0],
  );
  if (
    promptVariables.some(
      (variable) =>
        !["{{subject}}", "{{colorPalette}}", "{{backgroundColor}}"].includes(variable),
    )
  ) {
    throw new Error(`Recipe ${recipe.id} uses an unknown prompt variable.`);
  }
  if (recipe.kind === "custom" && promptVariables.some((variable) => variable !== "{{subject}}")) {
    throw new Error(`Custom recipe ${recipe.id} may only use the subject prompt variable.`);
  }
  if (recipe.kind !== "custom" && !promptVariables.includes("{{colorPalette}}")) {
    throw new Error(`Recipe ${recipe.id} must use the colorPalette prompt variable.`);
  }
  // The background is a project-icon concern: those templates must take it, artwork
  // templates must not (custom is already restricted to {{subject}} alone above).
  if (recipe.kind === "project-icon" && !promptVariables.includes("{{backgroundColor}}")) {
    throw new Error(`Recipe ${recipe.id} must use the backgroundColor prompt variable.`);
  }
  if (recipe.kind === "artwork" && promptVariables.includes("{{backgroundColor}}")) {
    throw new Error(`Recipe ${recipe.id} may not use the backgroundColor prompt variable.`);
  }
}

// The twelve built-in recipes, bundled at build time. Order-independent here: they
// are validated and sorted by id in `loadRecipes` to match the source contract.
const BUNDLED_RECIPES: unknown[] = [
  airyPastelModernist,
  customIcon,
  custom,
  cutPaperIcon,
  geometricIsometricIcon,
  glassIcon,
  hardEdgeGeometricScreenprint,
  impactIcon,
  modernFlatIcon,
  ornamentalMiniatureMaximalism,
  refinedPixelArt,
  tenebristOilRealism,
];

export function loadRecipes(): Recipe[] {
  const recipes: Recipe[] = [];
  for (const value of BUNDLED_RECIPES) {
    assertRecipe(value, (value as { id?: string }).id ?? "unknown");
    // Bundled JSON imports are module singletons; hand back a fresh clone per call
    // so a caller mutating a recipe can't corrupt the shared catalog (the source's
    // fs loader re-parsed fresh objects each time). structuredClone preserves key
    // order, which recipe hashing (plain JSON.stringify) depends on.
    recipes.push(structuredClone(value));
  }
  // Match the source's `readdir().sort()`, which sorted the ".json" FILENAMES by
  // code unit — so "custom-icon.json" precedes "custom.json" ('-' 0x2d < '.' 0x2e).
  // Sorting bare ids would invert that pair, so sort by the filename equivalent.
  recipes.sort((a, b) => {
    const an = `${a.id}.json`;
    const bn = `${b.id}.json`;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const ids = new Set(recipes.map((recipe) => recipe.id));
  if (ids.size !== recipes.length) throw new Error("Recipe IDs must be unique.");
  return recipes;
}

export function renderRecipe(
  recipe: Recipe,
  subject: string,
  palette: ColorPalette,
  backgroundColor?: string,
) {
  const template =
    recipe.kind === "artwork"
      ? `${recipe.promptTemplate}\n\n${FULL_FRAME_ARTWORK_MODIFIER}`
      : recipe.promptTemplate;
  // Only templates that consume the variable require (and validate) the color; passing
  // one to a recipe that ignores it (e.g. Custom icon) is harmless.
  if (template.includes("{{backgroundColor}}")) {
    if (backgroundColor === undefined) {
      throw new Error(`Recipe ${recipe.id} requires a background color.`);
    }
    if (!CANONICAL_BACKGROUND.test(backgroundColor)) {
      throw new Error(`Invalid icon background color: ${backgroundColor}`);
    }
  }
  return template.replace(/{{subject}}|{{colorPalette}}|{{backgroundColor}}/g, (variable) =>
    variable === "{{subject}}"
      ? subject.trim()
      : variable === "{{colorPalette}}"
        ? palettePrompt(palette)
        : (backgroundColor as string),
  );
}
