import { describe, expect, it } from "vitest";

import { loadRecipes, renderRecipe } from "../core/recipes";
import { getColorPalette } from "../core/palettes";
import { buildSessionInput } from "./buildSessionInput";

const baseSettings = {
  modelId: "gemini-3.1-flash-image",
  size: "1K" as const,
  aspectRatio: "1:1" as const,
  googleSearch: false,
  variants: 4,
  parallel: 4,
};

describe("buildSessionInput", () => {
  it("pre-renders each arm's prompt and matches CreateSessionInput shape", () => {
    const { input, callCount, family } = buildSessionInput({
      subject: "  a friendly robot  ",
      recipeIds: ["airy-pastel-modernist", "refined-pixel-art"],
      paletteId: "folio-teal",
      settings: baseSettings,
      references: [],
      acknowledged: false,
    });

    expect(family).toBe("image");
    expect(callCount).toBe(8); // 2 recipes × 4 variants
    expect(input.subject).toBe("a friendly robot"); // trimmed
    expect(input.settings.callCount).toBe(8);
    expect(input.settings.variantsPerRecipe).toBe(4);
    expect(input.settings.parallelRequests).toBe(4);
    expect(input.arms).toHaveLength(2);
    expect(input.arms.map((arm) => arm.id)).toEqual(["arm-1", "arm-2"]);

    // The arm prompt equals renderRecipe output (subject trimmed, palette applied).
    const catalog = loadRecipes();
    const airy = catalog.find((r) => r.id === "airy-pastel-modernist")!;
    const palette = getColorPalette("folio-teal")!;
    expect(input.arms[0].renderedPrompt).toBe(renderRecipe(airy, "a friendly robot", palette));
    // Comparison-style prompt carries the palette colors.
    expect(input.arms[0].renderedPrompt).toContain("#00BBA7");
  });

  it("computes an estimate and a confirmation gate for a large run (>8 calls)", () => {
    const { input, callCount } = buildSessionInput({
      subject: "x",
      recipeIds: ["airy-pastel-modernist", "refined-pixel-art", "tenebrist-oil-realism"],
      paletteId: "folio-teal",
      settings: { ...baseSettings, size: "4K", variants: 4 },
      references: [],
      acknowledged: true,
    });
    expect(callCount).toBe(12);
    expect(input.estimate.status).toBe("estimated");
    // 12 calls > 8 → confirmation required; acknowledged carried through.
    expect(input.confirmation.required).toBe(true);
    expect(input.confirmation.acknowledged).toBe(true);
    expect(input.confirmation.reasons.some((r) => /8-call threshold/.test(r))).toBe(true);
  });

  it("does not mark confirmation acknowledged when no gate is required", () => {
    const { input } = buildSessionInput({
      subject: "x",
      recipeIds: ["airy-pastel-modernist"],
      paletteId: "folio-teal",
      settings: { ...baseSettings, size: "512", variants: 1 },
      references: [],
      acknowledged: true, // caller left it checked, but no gate → stored false
    });
    expect(input.confirmation.required).toBe(false);
    expect(input.confirmation.acknowledged).toBe(false);
    expect(input.confirmation.reasons).toEqual([]);
  });

  it("Custom uses the subject as the whole prompt (palette stored but unused)", () => {
    const { input } = buildSessionInput({
      subject: "just this exact prompt",
      recipeIds: ["custom"],
      paletteId: "folio-teal",
      settings: baseSettings,
      references: [],
      acknowledged: false,
    });
    expect(input.arms).toHaveLength(1);
    expect(input.arms[0].renderedPrompt).toBe("just this exact prompt");
    expect(input.palette?.id).toBe("folio-teal"); // stored even for custom
  });

  it("clamps parallelRequests to 1–24 and defaults a non-finite value to 4 (P16)", () => {
    const build = (parallel: number) =>
      buildSessionInput({
        subject: "x",
        recipeIds: ["airy-pastel-modernist"],
        paletteId: "folio-teal",
        settings: { ...baseSettings, parallel },
        references: [],
        acknowledged: false,
      }).input.settings.parallelRequests;
    expect(build(1)).toBe(1);
    expect(build(24)).toBe(24);
    expect(build(100)).toBe(24); // above the 24-candidate run ceiling: pointless, clamp
    expect(build(0)).toBe(1);
    expect(build(-5)).toBe(1);
    expect(build(6.4)).toBe(6);
    expect(build(Number.NaN)).toBe(4); // invalid input: current default, never NaN
  });

  it("canonicalizes the background color into the prompt and the session input", () => {
    const build = (backgroundColor: string) =>
      buildSessionInput({
        subject: "a compass",
        recipeIds: ["geometric-isometric-icon"],
        paletteId: "folio-teal",
        backgroundColor,
        settings: baseSettings,
        references: [],
        acknowledged: false,
      }).input;

    const input = build("#18181B");
    expect(input.backgroundColor).toBe("#18181B");
    expect(input.arms[0].renderedPrompt).toContain(
      "First create one continuous solid #18181B field",
    );
    // Lowercase input canonicalizes to the SAME rendered prompt (promptSha256 determinism).
    expect(build("#18181b").arms[0].renderedPrompt).toBe(input.arms[0].renderedPrompt);
    expect(build("#18181b").backgroundColor).toBe("#18181B");
  });

  it("throws on a missing or invalid background for a styled icon run", () => {
    const build = (backgroundColor?: string) =>
      buildSessionInput({
        subject: "a compass",
        recipeIds: ["geometric-isometric-icon"],
        paletteId: "folio-teal",
        backgroundColor,
        settings: baseSettings,
        references: [],
        acknowledged: false,
      });
    expect(() => build(undefined)).toThrow(/requires a background color/);
    expect(() => build("nope")).toThrow(/Invalid icon background color/);
  });

  it("Custom icon ignores the background entirely (prompt untouched, nothing stored)", () => {
    const { input } = buildSessionInput({
      subject: "just this exact icon prompt",
      recipeIds: ["custom-icon"],
      paletteId: "folio-teal",
      // A stale invalid value must not break a Custom-only run: no recipe consumes it.
      backgroundColor: "garbage",
      settings: baseSettings,
      references: [],
      acknowledged: false,
    });
    expect(input.arms[0].renderedPrompt).toBe("just this exact icon prompt");
    expect(input).not.toHaveProperty("backgroundColor");
  });

  it("image runs store no background", () => {
    const { input } = buildSessionInput({
      subject: "x",
      recipeIds: ["airy-pastel-modernist"],
      paletteId: "folio-teal",
      settings: baseSettings,
      references: [],
      acknowledged: false,
    });
    expect(input).not.toHaveProperty("backgroundColor");
  });

  it("throws on a mixed image/icon family", () => {
    expect(() =>
      buildSessionInput({
        subject: "x",
        recipeIds: ["airy-pastel-modernist", "geometric-isometric-icon"],
        paletteId: "folio-teal",
        settings: baseSettings,
        references: [],
        acknowledged: false,
      }),
    ).toThrow(/cannot be combined/);
  });
});
