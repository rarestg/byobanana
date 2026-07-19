// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import { render, screen, within } from "../../test-utils";
import { loadRecipes } from "../core/recipes";
import type { SessionManifest } from "../core/session";
import { RunSummary } from "./RunSummary";

const recipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;

// A strict, fully-typed manifest carrying what RunSummary reads: subject, settings, arm
// recipe names (same fixture shape as SessionView.test.tsx, minus candidates).
function manifest(): SessionManifest {
  return {
    format: "nano-banana-web/session",
    schemaVersion: 1,
    id: "session-1",
    createdAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T10:00:00.000Z",
    status: "completed",
    subject: "a friendly robot mascot",
    settings: {
      modelId: "gemini-3.1-flash-lite-image",
      size: "1K",
      aspectRatio: "16:9",
      googleSearch: false,
      variantsPerRecipe: 2,
      callCount: 2,
    },
    estimate: { status: "estimated", usd: 0.1, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [],
    exports: [],
    arms: [
      {
        id: "arm-1",
        recipe,
        recipeSha256: "sha",
        renderedPrompt: "prompt",
        promptSha256: "psha",
        candidates: [],
      },
    ],
  };
}

describe("RunSummary", () => {
  it("renders the quoted subject, the styles line, and the settings as chips", async () => {
    const onEdit = vi.fn();
    render(<RunSummary manifest={manifest()} onEdit={onEdit} />);

    // Subject leads as the run's identity, quoted.
    expect(screen.getByText("“a friendly robot mascot”")).toBeInTheDocument();
    expect(screen.getByText(recipe.name)).toBeInTheDocument();

    // Settings chips reuse the SetupForm chip vocabulary (short model name, size, aspect,
    // variants-per-style) instead of the old bare settings sentence.
    const chips = within(screen.getByTestId("run-summary-chips"));
    expect(chips.getByText("NB 2 Lite")).toBeInTheDocument();
    expect(chips.getByText("1K")).toBeInTheDocument();
    expect(chips.getByText("16:9")).toBeInTheDocument();
    expect(chips.getByText("2 per style")).toBeInTheDocument();
    expect(screen.queryByText(/Gemini 3.1 Flash Lite Image ·/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit setup" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
