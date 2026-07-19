// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import { render, screen, within } from "../../test-utils";
import type { SessionSummary } from "../core/session";
import { HistoryRail } from "./HistoryRail";

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    createdAt: "2026-02-03T10:00:00.000Z",
    updatedAt: "2026-02-03T10:00:00.000Z",
    status: "completed",
    subject: `subject ${id}`,
    recipes: ["Geometric isometric icon", "Airy pastel modernist"],
    settings: { modelId: "gemini-3.1-flash-image", size: "1K", googleSearch: false, variantsPerRecipe: 2, callCount: 4 },
    estimate: { status: "estimated", usd: 0.2, excludesGrounding: false },
    spend: {
      status: "complete",
      calculatedUsd: 0.1,
      calculatedCount: 2,
      upperBoundCount: 0,
      unavailableCount: 0,
      unknownMayBeChargedCount: 0,
      unknownGroundingChargeCount: 0,
    },
    generatedImageCount: 2,
    ...over,
  };
}

const noop = () => {};

describe("HistoryRail", () => {
  it("renders each session's recipe line, style-count badge, subject, status, and date", () => {
    render(
      <HistoryRail sessions={[summary("a")]} busy={false} onSelect={noop} onClear={noop} />,
    );
    expect(screen.getByText("Geometric isometric icon + Airy pastel modernist")).toBeInTheDocument();
    // Style-count badge (2 styles) with an accessible label.
    expect(screen.getByLabelText("2 styles generated")).toHaveTextContent("2");
    expect(screen.getByText("subject a")).toBeInTheDocument();
    expect(screen.getByText(/Completed ·/)).toBeInTheDocument();
  });

  it("marks the current session aria-current", () => {
    render(
      <HistoryRail
        sessions={[summary("a"), summary("b")]}
        currentId="b"
        busy={false}
        onSelect={noop}
        onClear={noop}
      />,
    );
    const current = screen.getByText("subject b").closest("[aria-current]");
    expect(current).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("subject a").closest("[aria-current]")).toBeNull();
  });

  it("calls onSelect when an item is clicked", async () => {
    const onSelect = vi.fn();
    render(<HistoryRail sessions={[summary("a")]} busy={false} onSelect={onSelect} onClear={noop} />);
    await userEvent.click(screen.getByText("subject a"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("disables Clear history when empty and shows the empty hint", () => {
    render(<HistoryRail sessions={[]} busy={false} onSelect={noop} onClear={noop} />);
    expect(screen.getByText("No workbench sessions yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear history" })).toBeDisabled();
  });

  it("confirms Clear history in a modal and calls onClear", async () => {
    const onClear = vi.fn();
    render(<HistoryRail sessions={[summary("a")]} busy={false} onSelect={noop} onClear={onClear} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/permanently deletes/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("blocks Clear history while a run is generating", async () => {
    const onClear = vi.fn();
    render(<HistoryRail sessions={[summary("a")]} busy onSelect={noop} onClear={onClear} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear history" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Wait for it to finish/)).toBeInTheDocument();
    // No destructive confirm is offered while busy.
    expect(within(dialog).queryByRole("button", { name: "Clear history" })).toBeNull();
    expect(onClear).not.toHaveBeenCalled();
  });
});
