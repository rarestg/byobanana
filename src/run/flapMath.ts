// Pure split-flap strip math for the SpendPill departure board (P12). DOM-free so it
// unit-tests under node; SpendPill.tsx applies these numbers imperatively.
//
// The strip: a leading "0" glyph + 3 DESCENDING decades "9…0" — 31 glyphs, indices
// 0..30. Descending order makes downward visual motion equal counting up (the
// split-flap direction). Index j shows digit d when j ≡ (10 − d) (mod 10). Home is
// the BOTTOM decade (j ∈ [20,29]) so every roll travels forward (downward, j
// decreasing) into the decades above and can never underflow the strip.

import type { SpendAccumulator } from "./spendAggregate";

export const STRIP_DECADES = 3;
// Cell height in px — the single source of truth: SpendPill.tsx writes it onto the board
// container as --ch, which every CSS transform/keyframe consumes (P14). Integer:
// fractional transforms blur tiny glyphs, especially in Safari. P16: 24 (the R3 1.3×
// board — 16×24 cells with 16px glyphs).
export const CELL_HEIGHT = 24;
// Minimum digits of forward travel before a grand-settle landing.
export const MIN_TRAVEL = 2.5;
// Stagger rhythms: grand settle sweeps left → right (slot-machine convention, big
// digits lock first); quick corrective rolls sweep right → left and stay snappy.
export const GRAND_STAGGER_MS = 95;
export const QUICK_STAGGER_MS = 40;

export const STRIP_GLYPHS: readonly string[] = (() => {
  const glyphs = ["0"];
  for (let decade = 0; decade < STRIP_DECADES; decade += 1) {
    for (let digit = 9; digit >= 0; digit -= 1) glyphs.push(String(digit));
  }
  return glyphs;
})();

// Strip indices holding digit d satisfy j ≡ residue(d) (mod 10).
export function residue(digit: number): number {
  return (10 - digit) % 10;
}

// The at-rest index for a digit: its slot in the bottom decade.
export function homeJ(digit: number): number {
  return residue(digit) + 20;
}

// Where to start the continuous roll so the loop's first frame sits exactly on the
// strip's current (possibly fractional) position — no jump-cut, even when a new run
// catches a cell mid-settle. The loop keyframes sweep j from 30 down to 20 (both
// endpoints show "0", seamless wrap); ja is the in-loop position congruent to j
// (mod 10, fraction preserved), and phaseFraction is how far through one period that
// position appears — applied as a negative animation-delay of phaseFraction × duration.
export function loopStart(j: number): { ja: number; phaseFraction: number } {
  const ja = 20 + ((((j - 20) % 10) + 10) % 10);
  return { ja, phaseFraction: (30 - ja) / 10 };
}

export interface RollTarget {
  jT: number;
  travel: number;
  durationMs: number;
}

// Grand-settle landing: from the frozen position jCur (∈ [20,30] when caught
// mid-loop, or a home position ∈ [20,29] for fresh cells), roll forward (j
// decreasing) to the nearest index showing `digit` that is at least MIN_TRAVEL away.
// jT ∈ [8,27] over the whole domain — always on-strip, on-digit, ≥2.5 digits of
// travel. Duration is travel-proportional with a hard cap. No repair branch: an
// out-of-domain jCur should fail tests, not silently shorten travel.
export function grandTarget(jCur: number, digit: number): RollTarget {
  const maxJ = Math.floor(jCur - MIN_TRAVEL);
  const jT = maxJ - ((((maxJ - residue(digit)) % 10) + 10) % 10);
  const travel = jCur - jT;
  return { jT, travel, durationMs: Math.min(1050, Math.round(340 + travel * 62)) };
}

// Quick corrective roll: forward to the nearest index showing `digit` strictly below
// the current position (≤10 digits of travel) — used for idle value changes
// (history deletion, post-settle corrections), never for the grand settle.
export function quickTarget(jCur: number, digit: number): RollTarget {
  const maxJ = Math.ceil(jCur - 0.5);
  const jT = maxJ - ((((maxJ - residue(digit)) % 10) + 10) % 10);
  const travel = jCur - jT;
  return { jT, travel, durationMs: Math.round(300 + travel * 18) };
}

// Board eligibility: committed digit cells render only when the cross-session total
// reduces to a single plain $X.XX — known dollars folded like totalSpendHeadline
// (calculated + upper bound; the "up to" qualifier stays in the popover + a11y labels,
// not on the pill face). Every non-live non-dollar outcome (unavailable, may-have-charges,
// genuinely-empty $0.00) is a plain-text fallback; at rest with no stored dollars the
// pill is a static dash board ("$ -.--"). While a run is LIVE with no known dollars the
// board rolls as motion texture instead (UnknownBoard) — never committed cells, never a
// resting fake $0 (honesty rule).
export function spendBoardValue(total: SpendAccumulator): string | null {
  return total.hasCalculatedUsd || total.hasUpperBoundUsd
    ? (total.calculatedUsd + total.upperBoundUsd).toFixed(2)
    : null;
}

// "12.34" → [1, 2, 3, 4]. The formatter is always toFixed(2) (no thousands
// separators), so cells are keyed by place-from-right: index i in this array has
// place (length − 1 − i); growth inserts new cells at the LEFT and the cents cells
// keep their identity.
export function boardDigits(value: string): number[] {
  return value.replace(".", "").split("").map(Number);
}
