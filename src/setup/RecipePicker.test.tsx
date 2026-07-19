// @vitest-environment jsdom
import { describe, expect, test } from "vitest";

import { loadRecipes } from "../core/recipes";
import { familyRecipes } from "./RecipePicker";

describe("familyRecipes display order", () => {
  test("icon family follows the ratified gallery order, Custom last", () => {
    expect(familyRecipes(loadRecipes(), "icon").map((recipe) => recipe.id)).toEqual([
      "cut-paper-icon",
      "geometric-isometric-icon",
      "impact-icon",
      "modern-flat-icon",
      "glass-icon",
      "custom-icon",
    ]);
  });

  test("image family keeps catalog order, Custom last", () => {
    expect(familyRecipes(loadRecipes(), "image").map((recipe) => recipe.id)).toEqual([
      "airy-pastel-modernist",
      "hard-edge-geometric-screenprint",
      "ornamental-miniature-maximalism",
      "refined-pixel-art",
      "tenebrist-oil-realism",
      "custom",
    ]);
  });
});
