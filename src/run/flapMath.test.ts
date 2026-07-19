// Exhaustive strip-math verification (plan §strip-math): the grand-settle target must
// be on-strip, on-digit, and ≥ MIN_TRAVEL forward for every fractional position the
// loop can be frozen at — the math has no repair branch, so an out-of-bounds target
// here is a real bug, not something the component silently fixes.
import { describe, expect, it } from "vitest";

import {
  boardDigits,
  grandTarget,
  homeJ,
  loopStart,
  MIN_TRAVEL,
  quickTarget,
  residue,
  spendBoardValue,
  STRIP_GLYPHS,
} from "./flapMath";
import { emptyAccumulator } from "./spendAggregate";

describe("strip layout", () => {
  it("has a leading 0 plus 3 descending decades (31 glyphs)", () => {
    expect(STRIP_GLYPHS).toHaveLength(31);
    expect(STRIP_GLYPHS[0]).toBe("0");
    expect(STRIP_GLYPHS.slice(1, 11)).toEqual(["9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]);
    expect(STRIP_GLYPHS[20]).toBe("0");
    expect(STRIP_GLYPHS[30]).toBe("0"); // loop endpoints coincide — seamless wrap
  });

  it("index j shows digit d exactly when j ≡ residue(d) (mod 10)", () => {
    for (let j = 1; j <= 30; j += 1) {
      const digit = Number(STRIP_GLYPHS[j]);
      expect(j % 10).toBe(residue(digit) % 10);
    }
  });

  it("homes every digit in the bottom decade, showing that digit", () => {
    for (let digit = 0; digit <= 9; digit += 1) {
      const j = homeJ(digit);
      expect(j).toBeGreaterThanOrEqual(20);
      expect(j).toBeLessThanOrEqual(29);
      expect(STRIP_GLYPHS[j]).toBe(String(digit));
    }
  });
});

describe("grandTarget", () => {
  it("lands on-digit, on-strip [8,27], ≥2.5 forward for every fractional loop position", () => {
    // The loop sweeps j ∈ [20,30]; fresh cells settle from home ∈ [20,29]. Cover the
    // whole domain at fine fractional steps × every target digit.
    for (let jTimes100 = 2000; jTimes100 <= 3000; jTimes100 += 3) {
      const jCur = jTimes100 / 100;
      for (let digit = 0; digit <= 9; digit += 1) {
        const { jT, travel, durationMs } = grandTarget(jCur, digit);
        expect(Number.isInteger(jT)).toBe(true);
        expect(jT).toBeGreaterThanOrEqual(8);
        expect(jT).toBeLessThanOrEqual(27);
        expect(STRIP_GLYPHS[jT]).toBe(String(digit));
        expect(travel).toBeGreaterThanOrEqual(MIN_TRAVEL);
        expect(travel).toBeLessThan(MIN_TRAVEL + 10.01); // nearest occurrence past min travel
        expect(durationMs).toBeGreaterThanOrEqual(340);
        expect(durationMs).toBeLessThanOrEqual(1050);
      }
    }
  });

  it("covers the exact integer home positions of fresh-inserted cells", () => {
    for (let start = 0; start <= 9; start += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        const { jT, travel } = grandTarget(homeJ(start), digit);
        expect(jT).toBeGreaterThanOrEqual(8);
        expect(STRIP_GLYPHS[jT]).toBe(String(digit));
        expect(travel).toBeGreaterThanOrEqual(MIN_TRAVEL);
      }
    }
  });
});

describe("quickTarget", () => {
  it("rolls forward ≤10 digits onto the digit from any home position", () => {
    for (let start = 0; start <= 9; start += 1) {
      for (let digit = 0; digit <= 9; digit += 1) {
        const { jT, travel } = quickTarget(homeJ(start), digit);
        expect(STRIP_GLYPHS[jT]).toBe(String(digit));
        expect(jT).toBeGreaterThanOrEqual(10);
        expect(travel).toBeGreaterThanOrEqual(0);
        expect(travel).toBeLessThanOrEqual(10);
        if (start === digit) expect(travel).toBe(0); // unchanged digit: no motion
      }
    }
  });
});

describe("loopStart", () => {
  it("starts the loop exactly on the current strip position (fraction preserved)", () => {
    for (let j = 20; j <= 29; j += 1) {
      const { ja, phaseFraction } = loopStart(j);
      expect(ja).toBe(j); // integer home positions map to themselves — zero jump
      expect(STRIP_GLYPHS[ja]).toBe(STRIP_GLYPHS[j]);
      expect(phaseFraction).toBeGreaterThan(0);
      expect(phaseFraction).toBeLessThanOrEqual(1);
    }
    // Mid-settle interruption: fractional/out-of-decade positions land on the congruent
    // in-loop position with the fraction preserved (no visible jump-cut).
    for (const j of [13.4, 8.75, 27.31, 30, 20.001]) {
      const { ja, phaseFraction } = loopStart(j);
      expect(ja).toBeGreaterThanOrEqual(20);
      expect(ja).toBeLessThan(30);
      expect(Math.abs(((ja - j) % 10) + 10) % 10).toBeCloseTo(0, 10);
      expect(phaseFraction).toBeGreaterThan(0);
      expect(phaseFraction).toBeLessThanOrEqual(1);
    }
    expect(loopStart(13.4).ja).toBeCloseTo(23.4, 10);
    expect(loopStart(30).ja).toBe(20);
  });
});

describe("boardDigits", () => {
  it("tokenizes with cents alignment; growth inserts at the left", () => {
    expect(boardDigits("9.99")).toEqual([9, 9, 9]);
    expect(boardDigits("10.00")).toEqual([1, 0, 0, 0]);
    expect(boardDigits("0.60")).toEqual([0, 6, 0]);
    // Same tail places: $9.99 → $10.00 keeps the rightmost 3 cells' identity.
    expect(boardDigits("10.00").slice(1)).toHaveLength(boardDigits("9.99").length);
  });
});

describe("spendBoardValue", () => {
  it("folds known dollars like the headline", () => {
    const total = emptyAccumulator();
    total.calculatedUsd = 0.1;
    total.hasCalculatedUsd = true;
    total.upperBoundUsd = 0.28;
    total.hasUpperBoundUsd = true;
    expect(spendBoardValue(total)).toBe("0.38");
  });

  it("refuses cells for every no-known-dollar outcome (never fake $0)", () => {
    const empty = emptyAccumulator();
    expect(spendBoardValue(empty)).toBeNull(); // genuinely-empty ledger: text "$0.00", no cells

    const unavailable = emptyAccumulator();
    unavailable.unavailableCount = 2;
    unavailable.unavailable = true;
    expect(spendBoardValue(unavailable)).toBeNull();

    const mayCharge = emptyAccumulator();
    mayCharge.unknownMayBeChargedCount = 1;
    expect(spendBoardValue(mayCharge)).toBeNull();

    const groundingOnly = emptyAccumulator();
    groundingOnly.unknownGroundingChargeCount = 1;
    expect(spendBoardValue(groundingOnly)).toBeNull();
  });

  it("keeps a caveated known-dollar headline on the board (caveats stay in the popover)", () => {
    const total = emptyAccumulator();
    total.calculatedUsd = 1.5;
    total.hasCalculatedUsd = true;
    total.unavailableCount = 1;
    total.partial = true;
    expect(spendBoardValue(total)).toBe("1.50");
  });
});
