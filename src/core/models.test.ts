import { describe, expect, test } from "vitest";

import {
  estimateImageCost,
  FLASH_MODEL_ID,
  LITE_MODEL_ID,
  MODEL_CAPABILITIES,
  PRO_MODEL_ID,
  resolveModel,
  validateKnownModelSettings,
} from "./models";

describe("honest model capabilities", () => {
  test("uses exact GA IDs and restricts unsupported combinations", () => {
    expect(MODEL_CAPABILITIES.map((model) => model.id)).toEqual([
      FLASH_MODEL_ID,
      LITE_MODEL_ID,
      PRO_MODEL_ID,
    ]);
    expect(MODEL_CAPABILITIES.find((model) => model.id === FLASH_MODEL_ID)?.sizes).toContain("512");
    expect(MODEL_CAPABILITIES.find((model) => model.id === LITE_MODEL_ID)?.sizes).toEqual(["1K"]);
    expect(MODEL_CAPABILITIES.find((model) => model.id === LITE_MODEL_ID)?.searchGrounding).toBe(
      false,
    );
    expect(MODEL_CAPABILITIES.find((model) => model.id === PRO_MODEL_ID)?.sizes).not.toContain(
      "512",
    );
  });

  test("resolves aliases and validates size/aspect against each model", () => {
    expect(resolveModel("flash")).toBe(FLASH_MODEL_ID);
    expect(resolveModel("pro")).toBe(PRO_MODEL_ID);
    expect(resolveModel("unknown")).toBe("unknown");

    expect(validateKnownModelSettings(FLASH_MODEL_ID, "512", "1:1")).toBeUndefined();
    expect(validateKnownModelSettings(LITE_MODEL_ID, "512")).toContain("does not support 512");
    // Pro only supports the 10 standard aspects; 1:8 is an extended (Flash-only) one.
    expect(validateKnownModelSettings(PRO_MODEL_ID, "1K", "1:8")).toContain(
      "does not support 1:8",
    );
  });

  test("exposes per-size image estimates only where the model supports them", () => {
    expect(estimateImageCost(FLASH_MODEL_ID, "512")).toBeCloseTo(0.045, 6);
    expect(estimateImageCost(LITE_MODEL_ID, "1K")).toBeCloseTo(0.0336, 6);
    expect(estimateImageCost(PRO_MODEL_ID, "512")).toBeUndefined();
  });
});
