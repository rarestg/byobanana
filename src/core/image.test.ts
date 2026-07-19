import { describe, expect, test } from "vitest";

import { assertSquareSource, ICON_SIZE } from "./image";

// The Canvas pixel work in image.ts cannot run under jsdom (its canvas is a stub) — it is
// verified in a real headless browser (see scripts/verify-icon.mjs). Only the pure square-
// source decision is unit-tested here.
describe("assertSquareSource", () => {
  test("accepts a square source", () => {
    expect(() => assertSquareSource(512, 512)).not.toThrow();
    expect(() => assertSquareSource(1, 1)).not.toThrow();
  });

  test("rejects a non-square source with the dimensions in the message", () => {
    expect(() => assertSquareSource(1024, 640)).toThrow(/1024×640/);
    expect(() => assertSquareSource(1024, 640)).toThrow(/square/i);
  });

  test("targets a 512px primary icon", () => {
    expect(ICON_SIZE).toBe(512);
  });
});
