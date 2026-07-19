// Hover-zoom magnification math (P10 fix for a P8/P9 bug). The zoom panel's background is
// scaled from the image's NATURAL resolution, never the DISPLAYED preview size — the whole
// point is that the magnification FEEL (the bgW/naturalW ratio) never varies with viewport or
// layout, no matter how big the preview happens to render. The old `dispW * ZOOM_SCALE` formula
// baked the displayed size into the zoom, so the same 2.5x factor felt weak when the preview
// rendered small and much deeper when it rendered large.
// (Whether the panel can show AT ALL for a given displayed size/position is a separate, older
// P8/P9 concern — see the placement logic in InspectorSlot.tsx's compute(), untouched by P10.)
//
// NATURAL_RATIO is the "zoom feel", held constant everywhere: it's how many natural image
// pixels are shown per panel pixel. 1:1 means the panel renders the source near its native
// resolution (maximal, but not blown-up, magnification); higher ratios zoom out a bit further.
// The brief's target range is ~1:1 to 1.5:1 — pick one constant and never vary it by viewport.
const NATURAL_RATIO = 1.25;

// Guard for a source image much smaller than the panel: flooring the scale at panelSize/natural
// keeps the background covering the whole panel. This app's real generated dimensions are NOT
// bounded below by a comfortable margin — an extreme aspect ratio (e.g. "1:8"/"8:1"/"21:9" at the
// smallest "512" size tier) can report a short side under 200px, needing up to ~2.5x against the
// largest (420px) panel to fully cover it. The cap below bounds how far the floor could still
// blow up a hypothetically even-tinier source; set with real headroom above that worst case
// rather than the smallest value that merely covers today's known minimum.
const MAX_NATURAL_SCALE = 2.5;

export interface ZoomBackgroundSize {
  bgW: number;
  bgH: number;
}

// Pure function of (natural size, panel size) — deliberately NOT a function of the displayed
// preview size, which is what makes the zoom feel constant across every viewport/layout.
export function computeZoomBackgroundSize(
  naturalW: number,
  naturalH: number,
  panelSize: number,
): ZoomBackgroundSize {
  const targetScale = 1 / NATURAL_RATIO;
  const coverScale = Math.max(panelSize / naturalW, panelSize / naturalH);
  const scale = Math.min(Math.max(targetScale, coverScale), MAX_NATURAL_SCALE);
  return { bgW: naturalW * scale, bgH: naturalH * scale };
}
