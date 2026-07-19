import { describe, expect, expectTypeOf, test } from "vitest";

import { type ColorPalette, COLOR_PALETTES, getColorPalette, palettePrompt } from "./palettes";

describe("color palettes", () => {
  test("exposes deeply readonly palettes", () => {
    expectTypeOf<ColorPalette>().toEqualTypeOf<{
      readonly id: string;
      readonly name: string;
      readonly description: string;
      readonly colors: readonly string[];
    }>();
  });

  test("ships unique palette IDs and renders the selected colors", () => {
    const ids = COLOR_PALETTES.map((palette) => palette.id);
    expect(new Set(ids).size).toBe(ids.length);
    const palette = getColorPalette("folio-teal");
    if (!palette) throw new Error("Expected built-in palette.");
    expect(palettePrompt(palette)).toBe(palette.colors.join(", "));
  });
});
