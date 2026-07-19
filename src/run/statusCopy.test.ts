import { describe, expect, it } from "vitest";

import { finishReasonMessage } from "../core/gemini";
import { candidateShortFailureLabel, formatBytes, formatTimestamp } from "./statusCopy";

// P11 history-rail timestamps: month-abbreviation date + minutes-precision time, lowercase
// day period, no seconds. Inputs are timezone-less ISO strings so the expected LOCAL wall
// clock is deterministic; the exact strings assume the test runner's en-US default ICU locale
// (this repo's environment), matching how the app renders for its user.
describe("formatTimestamp", () => {
  it("humanizes to 'Mon D, YYYY · h:mm am/pm' with no seconds", () => {
    //  : modern ICU separates the time from the day period with a NARROW NO-BREAK SPACE.
    expect(formatTimestamp("2026-07-16T17:36:56")).toBe("Jul 16, 2026 · 5:36 pm");
    expect(formatTimestamp("2026-01-05T09:05:07")).toBe("Jan 5, 2026 · 9:05 am");
  });

  it("returns invalid input verbatim instead of throwing", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});

// P9 file-size facts formatter: KB = bytes/1024; one decimal under 100 KB, whole numbers
// from 100 KB, MB with one decimal from 1024 KB.
describe("formatBytes", () => {
  it("formats sub-100 KB sizes with one decimal", () => {
    expect(formatBytes(0)).toBe("0.0 KB");
    expect(formatBytes(10)).toBe("0.0 KB");
    expect(formatBytes(51_235)).toBe("50.0 KB");
    expect(formatBytes(100 * 1024 - 1)).toBe("100.0 KB");
  });

  it("formats 100 KB and above as whole kilobytes", () => {
    expect(formatBytes(100 * 1024)).toBe("100 KB");
    expect(formatBytes(219_136)).toBe("214 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("formats 1024 KB and above as MB with one decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(2_680_000)).toBe("2.6 MB");
  });
});

describe("candidateShortFailureLabel", () => {
  const base = {
    id: "c1",
    armId: "a1",
    variant: 1,
    images: [],
    text: [],
    cost: { status: "unavailable" as const, excludesGrounding: false },
  };

  it("tags a failed candidate whose error is a mapped finishReason message", () => {
    const candidate = {
      ...base,
      status: "failed" as const,
      error: finishReasonMessage("PROHIBITED_CONTENT"),
    };
    expect(candidateShortFailureLabel(candidate as never)).toBe("Blocked: content policy");
  });

  it("gives no tag for generic failure copy or non-failed statuses", () => {
    expect(
      candidateShortFailureLabel({
        ...base,
        status: "failed",
        error: "This candidate could not be generated. Edit the setup and regenerate the run.",
      } as never),
    ).toBeUndefined();
    expect(
      candidateShortFailureLabel({
        ...base,
        status: "interrupted",
        error: finishReasonMessage("PROHIBITED_CONTENT"),
      } as never),
    ).toBeUndefined();
  });
});
