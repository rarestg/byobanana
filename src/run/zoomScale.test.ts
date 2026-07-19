import { describe, expect, it } from "vitest";

import { computeZoomBackgroundSize } from "./zoomScale";

describe("computeZoomBackgroundSize", () => {
  it("scales a typical (large-relative-to-panel) source at the constant target ratio, regardless of panel size", () => {
    // The bug being fixed: the OLD formula multiplied the DISPLAYED preview size, so the same
    // source zoomed differently depending on how big the preview happened to render. The new
    // formula takes no displayed-size input at all — this test proves the natural:panel RATIO
    // (bgW/naturalW) is identical across very different panel sizes (small = narrow-viewport
    // panel, big = wide-viewport panel), for a natural size well above the panel floor.
    const small = computeZoomBackgroundSize(2048, 2048, 200); // small panel (narrow viewport)
    const big = computeZoomBackgroundSize(2048, 2048, 420); // big panel (wide viewport)
    expect(small.bgW / 2048).toBeCloseTo(big.bgW / 2048, 10);
    expect(small.bgW).toBe(big.bgW); // scale is fully panel-independent here
  });

  it("preserves aspect ratio for a non-square source", () => {
    const { bgW, bgH } = computeZoomBackgroundSize(1600, 900, 350);
    expect(bgW / 1600).toBeCloseTo(bgH / 900, 10);
  });

  it("never leaves the panel under-filled for a source smaller than the panel at the target scale (small natural)", () => {
    // A 384px icon preview inside a 420px panel: the target-ratio scale alone (~0.8x) would
    // render an under-sized background (~307px) leaving gaps — the cover floor must kick in.
    const { bgW, bgH } = computeZoomBackgroundSize(384, 384, 420);
    expect(bgW).toBeGreaterThanOrEqual(420);
    expect(bgH).toBeGreaterThanOrEqual(420);
  });

  it("fully covers a real extreme-aspect-ratio source (512-tier 21:9, per Google's documented output dimensions)", () => {
    // Codex review (T2): the app's actual minimum dimension is NOT a comfortable ~384px (that
    // figure is only the fixed EXPORT icon size, not a generation size) — the "21:9"/"1:8"/"8:1"
    // aspect ratios (core/models.ts VALID_ASPECTS) are real, selectable options, and Google's
    // smallest "512" size tier reports dimensions as extreme as 792x168 for 21:9. Against the
    // largest (420px) panel that needs scale=420/168=2.5 to fully cover — exactly the cap.
    const { bgW, bgH } = computeZoomBackgroundSize(792, 168, 420);
    expect(bgW).toBeGreaterThanOrEqual(420);
    expect(bgH).toBeGreaterThanOrEqual(420);
  });

  it("caps the scale for a pathologically tiny source, even at the cost of under-filling the panel", () => {
    const { bgW, bgH } = computeZoomBackgroundSize(16, 16, 420);
    // Cover-floor alone would demand scale=26.25x (420/16); the cap must clamp it to 2.5x — a
    // source this tiny never occurs in this app (see the extreme-aspect-ratio test above for the
    // real worst case), so under-filling the panel (background smaller than the panel, backdrop
    // showing at the edges) is an acceptable trade-off against blowing a genuinely tiny source up
    // past recognizability.
    expect(bgW).toBe(40);
    expect(bgH).toBe(40);
    expect(bgW).toBeLessThan(420);
  });

  it("scales up for a large natural source (big natural), staying below the source's own resolution", () => {
    const { bgW, bgH } = computeZoomBackgroundSize(4096, 4096, 350);
    expect(bgW).toBeLessThan(4096);
    expect(bgH).toBeLessThan(4096);
    expect(bgW).toBeGreaterThan(350); // still zoomed in relative to the panel
  });
});
