// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import { act, render, screen, within } from "../../test-utils";
import type { SpendSummary } from "../core/cost";
import type { SessionSummary } from "../core/session";
import { SpendPill } from "./SpendPill";

function summary(modelId: string, spend: SpendSummary, generatedImageCount: number): SessionSummary {
  return {
    id: `s-${Math.random()}`,
    createdAt: "2026-02-03T10:00:00.000Z",
    updatedAt: "2026-02-03T10:00:00.000Z",
    status: "completed",
    subject: "x",
    recipes: ["r"],
    settings: { modelId, size: "1K", googleSearch: false, variantsPerRecipe: 1, callCount: 1 },
    estimate: { status: "estimated", usd: 0.1, excludesGrounding: false },
    spend,
    generatedImageCount,
  };
}

const complete = (usd: number, count: number): SpendSummary => ({
  status: "complete",
  calculatedUsd: usd,
  calculatedCount: count,
  upperBoundCount: 0,
  unavailableCount: 0,
  unknownMayBeChargedCount: 0,
  unknownGroundingChargeCount: 0,
});

// P12 board helpers: the pill's dollars are per-digit flap cells (imperative DOM), each
// mirroring its committed digit to data-digit; the visible dollar string is not one text
// node any more.
function boardDigitString(): string {
  return [...document.querySelectorAll<HTMLElement>("[data-digit]")]
    .map((cell) => cell.dataset.digit)
    .join("");
}

function cellCount(): number {
  return document.querySelectorAll("[data-digit]").length;
}

function rollingCellCount(): number {
  return [...document.querySelectorAll<HTMLElement>("[data-digit]")].filter((cell) =>
    cell.className.includes("rolling"),
  ).length;
}

// The unknown board's rolling cells: motion texture with NO data-digit (never a committed
// value), so they prove the live-unknown state animates even while rollingCellCount() is 0.
function unknownRollingCells(): number {
  return document.querySelectorAll('[class*="unknownBoard"] [class*="rolling"]').length;
}

function liveRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>('[aria-live="polite"]');
  expect(region).not.toBeNull();
  return region!;
}

// Force the reduced-motion media query on (vitest.setup's default mock reports false).
// The original mock is restored in afterEach so the preference can't leak across tests.
const originalMatchMedia = window.matchMedia;
function mockReducedMotion() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

describe("SpendPill", () => {
  it("shows the unknown-state dash board with no sessions — '$ -.--', no digit cells, no button", () => {
    render(<SpendPill sessions={[]} />);
    expect(screen.getByText("Total spend")).toBeInTheDocument();
    // Explicit unknown state: the real flap frame with a $ and dash placeholders. The
    // accessible name says spend is unrecorded (never zero dollars); the dash cells are
    // aria-hidden. role="img" so the name is actually exposed (a bare span's generic role
    // would drop the author label).
    expect(
      screen.getByRole("img", { name: "Total spend: none recorded yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText("$")).toBeInTheDocument();
    const dashGlyphs = [...document.querySelectorAll<HTMLElement>('[class*="glyph"]')].filter(
      (g) => g.textContent === "-",
    );
    expect(dashGlyphs).toHaveLength(3); // "-.--" digit-shape: three dash cells + a dot card
    expect(cellCount()).toBe(0); // static cells only — no animated digit cells (no data-digit)
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/\$0/)).toBeNull(); // honesty rule: never a fake $0
  });

  it("shows the aggregated total on the board and a per-model breakdown with image counts", async () => {
    render(
      <SpendPill
        sessions={[
          summary("gemini-3.1-flash-image", complete(0.1, 2), 2),
          summary("gemini-3-pro-image", complete(0.5, 1), 1),
        ]}
      />,
    );
    // The pill: accessible name carries the folded figure (bare, exact-only); the board
    // cells carry the digits.
    const button = screen.getByRole("button", {
      name: "Total spend: $0.60. Open breakdown for all stored runs.",
    });
    expect(boardDigitString()).toBe("060");
    await userEvent.click(button);
    // The popover total line keeps the "up to" ceiling qualifier (formatSpend labels even
    // exact-only known spend as a ceiling); run count in its own badge.
    expect(await screen.findByText("Total spend: up to $0.60")).toBeInTheDocument();
    // Scope the run-count badge: the flap strips now hold every digit glyph, so a bare
    // getByText("2") would match strip glyphs too.
    const runCount = screen.getByText("Stored runs:").parentElement as HTMLElement;
    expect(within(runCount).getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Nano Banana 2")).toBeInTheDocument();
    expect(screen.getByText("Nano Banana Pro")).toBeInTheDocument();
    expect(screen.getByText("2 generated images")).toBeInTheDocument();
    expect(screen.getByText("1 generated image")).toBeInTheDocument();
  });

  it("never renders an unavailable cost as $0 — text fallback, no cells, popover caveat", async () => {
    render(
      <SpendPill
        sessions={[
          summary(
            "gemini-3.1-flash-image",
            {
              status: "unavailable",
              calculatedCount: 0,
              upperBoundCount: 0,
              unavailableCount: 2,
              unknownMayBeChargedCount: 0,
              unknownGroundingChargeCount: 0,
            },
            0,
          ),
        ]}
      />,
    );
    expect(screen.getByText("Cost unavailable")).toBeInTheDocument();
    expect(cellCount()).toBe(0);
    expect(screen.queryByText(/\$0/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Open breakdown/ }));
    expect(await screen.findByText("Some image costs are unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Total spend: Cost unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("keeps 'up to' off the pill face but in the aria label, popover total, and rows", async () => {
    render(
      <SpendPill
        sessions={[
          summary(
            "gemini-3.1-flash-image",
            {
              status: "upper-bound",
              upperBoundUsd: 0.28,
              calculatedCount: 0,
              upperBoundCount: 2,
              unavailableCount: 0,
              unknownMayBeChargedCount: 0,
              unknownGroundingChargeCount: 0,
            },
            2,
          ),
        ]}
      />,
    );
    expect(boardDigitString()).toBe("028");
    // The pill face shows only the bare folded number — no visible "up to" micro-label.
    expect(screen.queryByText("up to")).toBeNull();
    // The accessible label carries the ceiling qualifier so a focused control never reads
    // a ceiling as exact.
    await userEvent.click(screen.getByRole("button", { name: /Total spend: up to \$0\.28/ }));
    // The popover total line + the per-model row both keep "up to".
    expect(await screen.findByText("Total spend: up to $0.28")).toBeInTheDocument();
    expect(screen.getByText("up to $0.28")).toBeInTheDocument();
  });

  it("folds calculated + upper-bound into one board figure, keeping the split in the rows", async () => {
    render(
      <SpendPill
        sessions={[
          summary("gemini-3.1-flash-image", complete(0.1, 1), 1),
          summary(
            "gemini-3-pro-image",
            {
              status: "upper-bound",
              upperBoundUsd: 0.28,
              calculatedCount: 0,
              upperBoundCount: 2,
              unavailableCount: 0,
              unknownMayBeChargedCount: 0,
              unknownGroundingChargeCount: 0,
            },
            2,
          ),
        ]}
      />,
    );
    expect(boardDigitString()).toBe("038");
    // A calculated + estimated fold is still a ceiling: "up to" rides the aria label +
    // popover, never the bare pill face.
    expect(screen.queryByText("up to")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Total spend: up to \$0\.38/ }));
    // The popover total line keeps the ceiling; the rows carry the split.
    expect(await screen.findByText("Total spend: up to $0.38")).toBeInTheDocument();
    expect(screen.getByText("up to $0.28")).toBeInTheDocument();
  });

  it("never renders grounding-caveat-only spend as $0", async () => {
    // A grounded request cancelled before costing: no dollars, only the grounding caveat.
    render(
      <SpendPill
        sessions={[
          summary(
            "gemini-3.1-flash-image",
            {
              status: "complete",
              calculatedCount: 0,
              upperBoundCount: 0,
              unavailableCount: 0,
              unknownMayBeChargedCount: 0,
              unknownGroundingChargeCount: 1,
            },
            0,
          ),
        ]}
      />,
    );
    expect(screen.getByText("Cost unavailable")).toBeInTheDocument();
    expect(cellCount()).toBe(0);
    expect(screen.queryByText(/\$0/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Open breakdown/ }));
    expect(
      await screen.findByText("Grounding charges are not included for 1 candidate request."),
    ).toBeInTheDocument();
    expect(screen.getByText("Total spend: Cost unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("carries the live-run treatment only while active (even with zero sessions)", () => {
    const { unmount } = render(<SpendPill sessions={[]} active />);
    expect(document.querySelector('[data-spend-pill][data-live="true"]')).not.toBeNull();
    expect(document.querySelector('[class*="active"]')).not.toBeNull();
    unmount();
    render(<SpendPill sessions={[]} />);
    expect(document.querySelector("[data-live]")).toBeNull();
    expect(document.querySelector('[class*="active"]')).toBeNull();
  });

  it("keeps a stable 'calculating' button label while active, dollars or not — never $0", () => {
    // A live run over stored history with known dollars: the board rolls; the label is
    // the STABLE calculating sentence (a focused control must not re-announce partials).
    const midRun: SpendSummary = {
      status: "partial",
      calculatedUsd: 0.1,
      calculatedCount: 1,
      upperBoundCount: 0,
      unavailableCount: 1,
      unknownMayBeChargedCount: 0,
      unknownGroundingChargeCount: 0,
    };
    const { unmount } = render(
      <SpendPill
        sessions={[
          summary("gemini-3.1-flash-image", midRun, 1),
          summary("gemini-3-pro-image", complete(0.5, 1), 1),
        ]}
        active
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Total spend: calculating. Open breakdown for all stored runs.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Partial/)).toBeNull();
    unmount();

    // Active with no known dollars yet: the unknown board ROLLS (motion texture, no
    // committed cells) instead of a text "Calculating…" — and never a resting "$0".
    render(
      <SpendPill
        sessions={[
          summary(
            "gemini-3.1-flash-image",
            {
              status: "unavailable",
              calculatedCount: 0,
              upperBoundCount: 0,
              unavailableCount: 2,
              unknownMayBeChargedCount: 0,
              unknownGroundingChargeCount: 0,
            },
            0,
          ),
        ]}
        active
      />,
    );
    expect(screen.queryByText("Calculating…")).toBeNull();
    expect(unknownRollingCells()).toBe(3);
    expect(cellCount()).toBe(0);
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("rolls the unknown board while active with zero stored sessions, and settles when idle", () => {
    const { unmount } = render(<SpendPill sessions={[]} active />);
    // No text "Calculating…" — the unknown board rolls as motion texture instead.
    expect(screen.queryByText("Calculating…")).toBeNull();
    expect(unknownRollingCells()).toBe(3);
    expect(cellCount()).toBe(0);
    unmount();
    render(<SpendPill sessions={[summary("gemini-3.1-flash-image", complete(0.1, 2), 2)]} />);
    // Idle: the board shows the stored spend, no rolling.
    expect(boardDigitString()).toBe("010");
    expect(unknownRollingCells()).toBe(0);
    expect(screen.queryByText(/Calculating/)).toBeNull();
  });

  it("rolls while active and grand-settles on the falling edge onto the final aggregate", () => {
    vi.useFakeTimers();
    const idle = [summary("gemini-3.1-flash-image", complete(4.37, 2), 2)];
    const { rerender, unmount } = render(<SpendPill sessions={idle} />);
    expect(boardDigitString()).toBe("437");
    expect(rollingCellCount()).toBe(0);

    // Rising edge: every cell starts the CSS loop; the live region is cleared.
    rerender(<SpendPill sessions={idle} active />);
    expect(rollingCellCount()).toBe(3);
    expect(liveRegion().textContent).toBe("");

    // Falling edge with the refreshed final total: staggered settle commits the digits.
    const finished = [summary("gemini-3.1-flash-image", complete(6.62, 4), 4)];
    rerender(<SpendPill sessions={finished} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(boardDigitString()).toBe("662");
    expect(rollingCellCount()).toBe(0);
    expect(liveRegion().textContent).toBe("Total spend $6.62");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces the settled total with 'up to' when the fold includes an estimate", () => {
    vi.useFakeTimers();
    const upperBound = {
      status: "upper-bound" as const,
      upperBoundUsd: 0.28,
      calculatedCount: 0,
      upperBoundCount: 2,
      unavailableCount: 0,
      unknownMayBeChargedCount: 0,
      unknownGroundingChargeCount: 0,
    };
    const idle = [summary("gemini-3.1-flash-image", upperBound, 2)];
    const { rerender, unmount } = render(<SpendPill sessions={idle} active />);
    // No visible "up to" micro-label at any point — the pill face is always bare.
    expect(screen.queryByText("up to")).toBeNull();
    rerender(<SpendPill sessions={idle} />);
    act(() => {
      vi.runAllTimers();
    });
    // Still no visible "up to"; the once-per-settle announcement carries the ceiling qualifier.
    expect(screen.queryByText("up to")).toBeNull();
    expect(liveRegion().textContent).toBe("Total spend up to $0.28");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces once per settle and re-announces identical totals (region cleared on start)", () => {
    vi.useFakeTimers();
    const sessions = [summary("gemini-3.1-flash-image", complete(1.0, 1), 1)];
    const { rerender } = render(<SpendPill sessions={sessions} />);

    rerender(<SpendPill sessions={sessions} active />);
    rerender(<SpendPill sessions={sessions} />); // run 1 settles on the SAME total
    act(() => {
      vi.runAllTimers();
    });
    expect(liveRegion().textContent).toBe("Total spend $1.00");

    rerender(<SpendPill sessions={sessions} active />); // run 2 starts: region cleared
    expect(liveRegion().textContent).toBe("");
    rerender(<SpendPill sessions={sessions} />); // run 2 settles on the identical total
    act(() => {
      vi.runAllTimers();
    });
    expect(liveRegion().textContent).toBe("Total spend $1.00"); // re-announced
  });

  it("stays silent on mount and StrictMode double-mount (no announcement, no timers)", () => {
    vi.useFakeTimers();
    render(
      <StrictMode>
        <SpendPill sessions={[summary("gemini-3.1-flash-image", complete(2.5, 1), 1)]} />
      </StrictMode>,
    );
    expect(boardDigitString()).toBe("250");
    expect(liveRegion().textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("grows the board at the left for digit-count changes ($9.99 → $10.00)", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <SpendPill sessions={[summary("gemini-3.1-flash-image", complete(9.99, 1), 1)]} />,
    );
    expect(cellCount()).toBe(3);
    // Idle corrective update (e.g. a late refresh): quick roll onto the new true value.
    rerender(<SpendPill sessions={[summary("gemini-3.1-flash-image", complete(10.0, 2), 2)]} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(cellCount()).toBe(4);
    expect(boardDigitString()).toBe("1000");
    // Corrective rolls never announce (no spam) — the region stays as it was.
    expect(liveRegion().textContent).toBe("");
  });

  it("builds the board mid-run when the first session appears (0 → 1 without hook-order failure)", () => {
    vi.useFakeTimers();
    const { rerender } = render(<SpendPill sessions={[]} active />);
    expect(cellCount()).toBe(0);
    // Unknown/active: the unknown board rolls as motion texture — motion exists even with
    // zero committed (data-digit) cells, and never a text "Calculating…".
    expect(rollingCellCount()).toBe(0);
    expect(unknownRollingCells()).toBe(3);
    expect(screen.queryByText("Calculating…")).toBeNull();
    rerender(
      <SpendPill sessions={[summary("gemini-3.1-flash-image", complete(0.42, 1), 1)]} active />,
    );
    // The first genuine dollars mid-run: the real board takes over — cells exist and are
    // rolling (Mode A), and the unknown board is gone.
    expect(cellCount()).toBe(3);
    expect(rollingCellCount()).toBe(3);
    expect(unknownRollingCells()).toBe(0);
    // Settle still lands on the confirmed total.
    rerender(<SpendPill sessions={[summary("gemini-3.1-flash-image", complete(0.42, 1), 1)]} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(boardDigitString()).toBe("042");
    expect(liveRegion().textContent).toBe("Total spend $0.42");
  });

  it("survives a new run starting before the prior settle completes (generation guard)", () => {
    vi.useFakeTimers();
    const s1 = [summary("gemini-3.1-flash-image", complete(1.11, 1), 1)];
    const s2 = [summary("gemini-3.1-flash-image", complete(2.22, 2), 2)];
    const { rerender } = render(<SpendPill sessions={s1} />);
    rerender(<SpendPill sessions={s1} active />);
    rerender(<SpendPill sessions={s2} />); // run 1 settles toward $2.22…
    act(() => {
      vi.advanceTimersByTime(500); // …first columns frozen; a clack window may be open
    });
    rerender(<SpendPill sessions={s2} active />); // run 2 starts mid-settle
    expect(rollingCellCount()).toBe(3);
    expect(liveRegion().textContent).toBe(""); // run 1's announcement was superseded
    // Interrupting the settle cancelled the cosmetic cleanups too — no cell may stay
    // stuck in the entering (invisible) or clack state.
    const stuck = [...document.querySelectorAll<HTMLElement>("[data-digit]")].filter(
      (cell) => cell.className.includes("pre") || cell.className.includes("clack"),
    );
    expect(stuck).toHaveLength(0);
    const s3 = [summary("gemini-3.1-flash-image", complete(3.33, 3), 3)];
    rerender(<SpendPill sessions={s3} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(boardDigitString()).toBe("333");
    expect(liveRegion().textContent).toBe("Total spend $3.33");
  });

  it("never strands an invisible entering cell when a new run interrupts its fade-in", () => {
    vi.useFakeTimers();
    const s1 = [summary("gemini-3.1-flash-image", complete(9.99, 1), 1)];
    const s2 = [summary("gemini-3.1-flash-image", complete(10.0, 2), 2)];
    const { rerender } = render(<SpendPill sessions={s1} />);
    rerender(<SpendPill sessions={s1} active />);
    // Falling edge with digit growth: the new left cell enters via `pre` + two rAFs…
    rerender(<SpendPill sessions={s2} />);
    // …but a new run starts before those rAFs fire (they are cancelled).
    rerender(<SpendPill sessions={s2} active />);
    const preCells = [...document.querySelectorAll<HTMLElement>("[data-digit]")].filter((cell) =>
      cell.className.includes("pre"),
    );
    expect(preCells).toHaveLength(0); // opacity-0 cells must not survive the cancellation
    rerender(<SpendPill sessions={s2} />);
    act(() => {
      vi.runAllTimers();
    });
    expect(boardDigitString()).toBe("1000");
  });

  it("announces the FRESH total once when the value changes during the grand settle", () => {
    vi.useFakeTimers();
    const s1 = [summary("gemini-3.1-flash-image", complete(1.0, 1), 1)];
    const s2 = [summary("gemini-3.1-flash-image", complete(2.0, 2), 2)];
    const s3 = [summary("gemini-3.1-flash-image", complete(2.5, 3), 3)];
    const { rerender } = render(<SpendPill sessions={s1} />);
    rerender(<SpendPill sessions={s1} active />);
    rerender(<SpendPill sessions={s2} />); // settle begins toward $2.00
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(<SpendPill sessions={s3} />); // a late refresh lands mid-settle
    act(() => {
      vi.runAllTimers();
    });
    // The corrective quick roll runs first; the single announcement carries the truth.
    expect(boardDigitString()).toBe("250");
    expect(liveRegion().textContent).toBe("Total spend $2.50");
  });

  it("reduced motion: no timers, instant values, immediate announcement, static live state", () => {
    mockReducedMotion();
    vi.useFakeTimers();
    const idle = [summary("gemini-3.1-flash-image", complete(4.37, 2), 2)];
    const { rerender } = render(<SpendPill sessions={idle} />);
    expect(boardDigitString()).toBe("437");

    rerender(<SpendPill sessions={idle} active />);
    // Live state visible (ring via .active) but nothing rolls and no timers exist.
    expect(document.querySelector('[data-live="true"]')).not.toBeNull();
    expect(rollingCellCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const finished = [summary("gemini-3.1-flash-image", complete(6.62, 4), 4)];
    rerender(<SpendPill sessions={finished} />);
    // Instant settle: digits and announcement land without advancing any timers.
    expect(boardDigitString()).toBe("662");
    expect(liveRegion().textContent).toBe("Total spend $6.62");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reduced-motion active run: bare static board, no visible 'up to' (ceiling in the aria label at rest)", () => {
    mockReducedMotion();
    const sessions = [
      summary(
        "gemini-3.1-flash-image",
        {
          status: "upper-bound" as const,
          upperBoundUsd: 0.28,
          calculatedCount: 0,
          upperBoundCount: 2,
          unavailableCount: 0,
          unknownMayBeChargedCount: 0,
          unknownGroundingChargeCount: 0,
        },
        2,
      ),
    ];
    const { rerender } = render(<SpendPill sessions={sessions} active />);
    // Reduced motion holds the board static; the face shows only the bare figure — no
    // visible "up to" micro-label. While active the accessible label is the stable
    // "calculating" (never a figure), so there is no exact-reading risk.
    expect(boardDigitString()).toBe("028");
    expect(screen.queryByText("up to")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Total spend: calculating/ }),
    ).toBeInTheDocument();
    // At rest the accessible label carries the ceiling qualifier so a focused control
    // never reads a ceiling as exact.
    rerender(<SpendPill sessions={sessions} />);
    expect(screen.queryByText("up to")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Total spend: up to \$0\.28/ }),
    ).toBeInTheDocument();
  });

  it("rolling unknown strips rest on a dash (glyph '-', --j 31) so a halted loop never flashes '0'", () => {
    render(<SpendPill sessions={[]} active />);
    const strips = [
      ...document.querySelectorAll<HTMLElement>(
        '[class*="unknownBoard"] [class*="rolling"] [class*="strip"]',
      ),
    ];
    expect(strips).toHaveLength(3);
    for (const strip of strips) {
      // Base position sits on the appended "-" glyph (index 31); the CSS loop overrides
      // this while animating and only rests here if the animation is ever suppressed.
      expect(strip.style.getPropertyValue("--j")).toBe("31");
      const glyphs = strip.querySelectorAll('[class*="glyph"]');
      expect(glyphs[glyphs.length - 1].textContent).toBe("-");
    }
  });

  it("reduced motion + zero sessions + active: static dash board, nothing rolls, never $0", () => {
    mockReducedMotion();
    render(<SpendPill sessions={[]} active />);
    // No rolling under reduced motion — the live-unknown state is the static dash board.
    expect(unknownRollingCells()).toBe(0);
    const dashGlyphs = [...document.querySelectorAll<HTMLElement>('[class*="glyph"]')].filter(
      (g) => g.textContent === "-",
    );
    expect(dashGlyphs).toHaveLength(3); // "$ -.--"
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("unmounting mid-settle leaves no timers behind", () => {
    vi.useFakeTimers();
    const s1 = [summary("gemini-3.1-flash-image", complete(1.11, 1), 1)];
    const { rerender, unmount } = render(<SpendPill sessions={s1} />);
    rerender(<SpendPill sessions={s1} active />);
    rerender(<SpendPill sessions={s1} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // settle staggers are pending
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens the popover from the keyboard with a focusable pill button", async () => {
    const user = userEvent.setup();
    render(<SpendPill sessions={[summary("gemini-3.1-flash-image", complete(0.6, 2), 2)]} />);
    const button = screen.getByRole("button", { name: /Total spend: \$0\.60/ });
    await user.tab();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Stored runs:")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });
});
