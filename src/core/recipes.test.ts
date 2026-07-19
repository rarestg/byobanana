import { describe, expect, test } from "vitest";

import { COLOR_PALETTES } from "./palettes";
import {
  assertRecipe,
  canonicalBackgroundColor,
  DEFAULT_ICON_BACKGROUND,
  FULL_FRAME_ARTWORK_MODIFIER,
  loadRecipes,
  recipeFamily,
  renderRecipe,
} from "./recipes";

describe("provider-neutral recipes", () => {
  test("ships twelve built-in image and icon recipes", () => {
    const recipes = loadRecipes();
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      "airy-pastel-modernist",
      "custom-icon",
      "custom",
      "cut-paper-icon",
      "geometric-isometric-icon",
      "glass-icon",
      "hard-edge-geometric-screenprint",
      "impact-icon",
      "modern-flat-icon",
      "ornamental-miniature-maximalism",
      "refined-pixel-art",
      "tenebrist-oil-realism",
    ]);
    expect(recipes.filter((recipe) => recipe.comparable)).toHaveLength(10);
    expect(recipes.filter((recipe) => recipe.kind === "custom")).toHaveLength(2);
    expect(
      recipes.filter((recipe) => recipe.kind === "custom").every((recipe) => !recipe.comparable),
    ).toBe(true);
    expect(Object.fromEntries(recipes.map((recipe) => [recipe.id, recipeFamily(recipe)]))).toEqual({
      "airy-pastel-modernist": "image",
      "custom-icon": "icon",
      custom: "image",
      "cut-paper-icon": "icon",
      "geometric-isometric-icon": "icon",
      "glass-icon": "icon",
      "hard-edge-geometric-screenprint": "image",
      "impact-icon": "icon",
      "modern-flat-icon": "icon",
      "ornamental-miniature-maximalism": "image",
      "refined-pixel-art": "image",
      "tenebrist-oil-realism": "image",
    });
  });

  test("hands back independent clones so callers can't corrupt the catalog", () => {
    const first = loadRecipes();
    first[0].name = "mutated";
    (first[0].promptTemplate as string) = "clobbered {{subject}}";
    const second = loadRecipes();
    expect(second[0].name).not.toBe("mutated");
    expect(second[0].promptTemplate).not.toBe("clobbered {{subject}}");
  });

  test("keeps the subject separate from each style contract", () => {
    const recipes = loadRecipes();
    const geometric = recipes.find((recipe) => recipe.id === "geometric-isometric-icon");
    const custom = recipes.find((recipe) => recipe.id === "custom");
    const customIcon = recipes.find((recipe) => recipe.id === "custom-icon");
    if (!geometric || !custom || !customIcon) throw new Error("Expected built-in recipes.");
    const palette = COLOR_PALETTES[0];
    const rendered = renderRecipe(geometric, "A local transcript search tool.", palette, "#FAFAFA");
    expect(rendered).toContain("Subject brief:\nA local transcript search tool.");
    expect(rendered).toContain("Flat geometric isometric icon");
    expect(rendered).toContain(palette.colors.join(", "));
    expect(rendered).not.toContain("{{subject}}");
    expect(rendered).not.toContain("{{colorPalette}}");
    expect(rendered).not.toContain("{{backgroundColor}}");
    expect(renderRecipe(custom, "Exact custom prompt", palette)).toBe("Exact custom prompt");
    expect(renderRecipe(customIcon, "Exact custom icon prompt", palette)).toBe(
      "Exact custom icon prompt",
    );
  });

  test("appends the shared full-frame modifier only to artwork recipes", () => {
    const recipes = loadRecipes();
    const palette = COLOR_PALETTES[0];
    for (const recipe of recipes) {
      const rendered = renderRecipe(recipe, "A subject.", palette, "#FAFAFA");
      const occurrences = rendered.split(FULL_FRAME_ARTWORK_MODIFIER).length - 1;
      expect(occurrences).toBe(recipe.kind === "artwork" ? 1 : 0);
    }
  });

  test("does not expand prompt variables inside custom or styled subjects", () => {
    const recipes = loadRecipes();
    const geometric = recipes.find((recipe) => recipe.id === "geometric-isometric-icon");
    const custom = recipes.find((recipe) => recipe.id === "custom");
    if (!geometric || !custom) throw new Error("Expected built-in recipes.");
    const palette = COLOR_PALETTES[0];
    const subject = "Keep {{colorPalette}} and {{backgroundColor}} literal.";

    expect(renderRecipe(custom, subject, palette)).toBe(subject);
    const rendered = renderRecipe(geometric, subject, palette, "#FAFAFA");
    expect(rendered).toContain(`Subject brief:\n${subject}`);
    expect(rendered).toContain(palette.colors.join(", "));
  });

  // The source drove these through temp JSON files + the fs loader; browser-side we
  // validate the same contract by calling the exported `assertRecipe` directly.
  test("rejects whitespace-bearing prompt variables", () => {
    const [recipe] = loadRecipes();
    expect(() =>
      assertRecipe({ ...recipe, promptTemplate: "{{subject}} {{ colorPalette }}" }, "invalid"),
    ).toThrow(/unknown prompt variable/);
  });

  test("rejects palette variables in custom recipes", () => {
    const custom = loadRecipes().find((recipe) => recipe.id === "custom");
    if (!custom) throw new Error("Expected built-in custom recipe.");
    expect(() =>
      assertRecipe({ ...custom, promptTemplate: "{{subject}} {{colorPalette}}" }, "invalid"),
    ).toThrow(/may only use the subject prompt variable/);
  });

  test("requires backgroundColor for project-icon templates and forbids it elsewhere", () => {
    const recipes = loadRecipes();
    const icon = recipes.find((recipe) => recipe.id === "cut-paper-icon")!;
    const artwork = recipes.find((recipe) => recipe.id === "airy-pastel-modernist")!;
    const customIcon = recipes.find((recipe) => recipe.id === "custom-icon")!;
    // A project-icon template without the variable is rejected.
    expect(() =>
      assertRecipe({ ...icon, promptTemplate: "{{subject}} {{colorPalette}}" }, "invalid"),
    ).toThrow(/must use the backgroundColor prompt variable/);
    // An artwork template with it is rejected.
    expect(() =>
      assertRecipe(
        { ...artwork, promptTemplate: `${artwork.promptTemplate} {{backgroundColor}}` },
        "invalid",
      ),
    ).toThrow(/may not use the backgroundColor prompt variable/);
    // Custom stays subject-only (transitively forbids backgroundColor).
    expect(() =>
      assertRecipe(
        { ...customIcon, promptTemplate: "{{subject}} {{backgroundColor}}" },
        "invalid",
      ),
    ).toThrow(/may only use the subject prompt variable/);
  });

  test("the five styled icon recipes carry the frozen ids, names, versions, and templates", async () => {
    // The sha256 values pin each promptTemplate to the frozen eval template file
    // (templates/final/*.txt) that generated the public evidence, trailing newline
    // included. A phrase check cannot prove byte identity; the hash can.
    const expected: Record<string, { name: string; version: number; sha256: string }> = {
      "cut-paper-icon": {
        name: "Cut-paper icon",
        version: 7,
        sha256: "bf865ac44f48c1a4e41225dea5efa44a03de3905a21a380f1114ec3dccdcba4c",
      },
      "geometric-isometric-icon": {
        name: "Geometric isometric icon",
        version: 7,
        sha256: "3582e18dd857c469b63f7389d7c19cc5d24afe0bad6455aee043292f483c0e76",
      },
      "impact-icon": {
        name: "Impact icon",
        version: 3,
        sha256: "e387ba279f5d9162373a2676552c1ba4392775ffcde0b14746266e66ff413030",
      },
      "modern-flat-icon": {
        name: "Modern flat icon",
        version: 3,
        sha256: "326e9e52e444256884f5f4734e7da2a0d6ba45aa151eb0de5d444768f4ae051a",
      },
      "glass-icon": {
        name: "Glass icon",
        version: 3,
        sha256: "a6d9845f7491712a6d7738843b7b35748fa64b6e855ea6dd0befe51c6a2c9988",
      },
    };
    const recipes = loadRecipes();
    for (const [id, want] of Object.entries(expected)) {
      const recipe = recipes.find((entry) => entry.id === id)!;
      expect(recipe.name).toBe(want.name);
      expect(recipe.version).toBe(want.version);
      expect(recipe.kind).toBe("project-icon");
      expect(recipe.comparable).toBe(true);
      expect(recipe.promptTemplate).toContain(
        "First create one continuous solid {{backgroundColor}} field",
      );
      expect(recipe.promptTemplate.endsWith("\n")).toBe(true);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(recipe.promptTemplate),
      );
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(`${id}:${hex}`).toBe(`${id}:${want.sha256}`);
    }
  });

  test("renderRecipe substitutes a canonical background color everywhere it appears", () => {
    const recipes = loadRecipes();
    const palette = COLOR_PALETTES[0];
    // A color no bundled palette contains, so the count isolates the substitutions.
    // Since v7/v3 every styled template consumes the variable exactly once (background
    // section only): the flat styles' second use lived in the removed "Use no colors
    // other than..." rule.
    for (const [id, occurrences] of [
      ["cut-paper-icon", 1],
      ["geometric-isometric-icon", 1],
      ["impact-icon", 1],
      ["modern-flat-icon", 1],
      ["glass-icon", 1],
    ] as const) {
      const recipe = recipes.find((entry) => entry.id === id)!;
      const rendered = renderRecipe(recipe, "A subject.", palette, "#123456");
      expect(`${id}:${rendered.split("#123456").length - 1}`).toBe(`${id}:${occurrences}`);
      expect(rendered).not.toContain("{{backgroundColor}}");
    }
  });

  test("renderRecipe rejects a missing or non-canonical background for icon templates", () => {
    const recipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;
    const palette = COLOR_PALETTES[0];
    expect(() => renderRecipe(recipe, "A subject.", palette)).toThrow(/requires a background color/);
    // Canonical form is uppercase #RRGGBB; the boundary canonicalizes, the renderer only accepts.
    expect(() => renderRecipe(recipe, "A subject.", palette, "#fafafa")).toThrow(/Invalid icon background color/);
    expect(() => renderRecipe(recipe, "A subject.", palette, "not-a-color")).toThrow(/Invalid icon background color/);
  });

  test("canonicalBackgroundColor uppercases, trims, and rejects non #RRGGBB input", () => {
    expect(canonicalBackgroundColor("#fafafa")).toBe("#FAFAFA");
    expect(canonicalBackgroundColor("  #18181b ")).toBe("#18181B");
    expect(canonicalBackgroundColor(DEFAULT_ICON_BACKGROUND)).toBe("#FAFAFA");
    for (const bad of ["FAFAFA", "#FAF", "#GGGGGG", "#FAFAFA00", ""]) {
      expect(() => canonicalBackgroundColor(bad)).toThrow(/Invalid icon background color/);
    }
  });

  test("strictly validates recipe preview and export discriminants", () => {
    const base = {
      schemaVersion: 1,
      id: "invalid",
      version: 1,
      name: "Invalid",
      description: "Invalid recipe",
      kind: "project-icon",
      comparable: true,
      promptTemplate: "{{subject}} {{colorPalette}}",
      preview: {
        type: "folio-icon",
        sizes: [80],
        backgrounds: { light: "#fff", dark: "#000" },
      },
      export: {
        type: "folio-icon",
        transparentOutsideCircle: true,
      },
    };
    for (const invalid of [
      { ...base, preview: { ...base.preview, sizes: ["80"] } },
      // Export sizes are an app concern now: the retired width/height keys are rejected
      // in BUNDLED recipes (historical stored snapshots are never re-validated).
      { ...base, export: { ...base.export, width: 384, height: 384 } },
      { ...base, export: { ...base.export, transparentOutsideCircle: false } },
    ]) {
      expect(() => assertRecipe(invalid, "invalid")).toThrow(/Invalid icon (preview|export)/);
    }
  });
});
