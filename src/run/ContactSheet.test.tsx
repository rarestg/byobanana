// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

import { render, screen, userEvent, within } from "../../test-utils";
import { finishReasonMessage } from "../core/gemini";
import { loadRecipes, renderRecipe } from "../core/recipes";
import { COLOR_PALETTES } from "../core/palettes";
import type {
  ArmRecord,
  CandidateRecord,
  CandidateStatus,
  SessionManifest,
  SessionRepository,
} from "../core/session";
import { ContactSheet } from "./ContactSheet";

// jsdom lacks object-URL APIs; the succeeded card creates one via useBlobUrl.
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

const recipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;
const palette = COLOR_PALETTES[0];

// A repo stub: ContactSheet/CandidateCard only ever call getBlob.
const repo = {
  getBlob: async () => new Blob(["x"], { type: "image/svg+xml" }),
} as unknown as SessionRepository;

function candidate(id: string, variant: number, status: CandidateStatus, extra: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    id,
    armId: extra.armId ?? "arm-1",
    variant,
    status,
    queuedAt: "2026-01-01T00:00:00.000Z",
    images: [],
    ...extra,
  };
}

function arm(id: string, name: string, candidates: CandidateRecord[]): ArmRecord {
  return {
    id,
    recipe: { ...recipe, name },
    recipeSha256: "sha",
    renderedPrompt: renderRecipe(recipe, "A subject", palette, "#FAFAFA"),
    promptSha256: "psha",
    candidates,
  };
}

function manifest(): SessionManifest {
  return {
    format: "nano-banana-web/session",
    schemaVersion: 1,
    id: "session-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "partial",
    subject: "A subject",
    settings: {
      modelId: "gemini-3.1-flash-image",
      size: "512",
      googleSearch: false,
      variantsPerRecipe: 2,
      callCount: 4,
    },
    estimate: { status: "estimated", usd: 0.05, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [],
    exports: [],
    arms: [
      arm("arm-1", "Geometric isometric icon", [
        candidate("candidate-arm-1-1", 1, "succeeded", {
          armId: "arm-1",
          images: [
            {
              id: "im",
              blobId: "blob-1",
              mimeType: "image/svg+xml",
              bytes: 10,
              width: 512,
              height: 512,
              sha256: "s",
            },
          ],
        }),
        candidate("candidate-arm-1-2", 2, "failed", {
          armId: "arm-1",
          // A mapped finishReason failure (P15): the card shows the short tag under the headline.
          error: finishReasonMessage("PROHIBITED_CONTENT"),
        }),
      ]),
      arm("arm-2", "Hard-edge geometric screenprint", [
        candidate("candidate-arm-2-1", 1, "interrupted", {
          armId: "arm-2",
          cancellation: { requestedAt: "2026-01-01T00:00:00.000Z", billing: "unknown-may-be-charged" },
        }),
        candidate("candidate-arm-2-2", 2, "queued", { armId: "arm-2" }),
      ]),
    ],
  };
}

describe("ContactSheet", () => {
  it("groups candidates by arm/recipe with the prompt disclosure", () => {
    render(<ContactSheet repo={repo} manifest={manifest()} focusedCandidateId={undefined} exportSelectedIds={new Set()} onToggleExport={() => {}} onFocus={() => {}} />);
    expect(screen.getByRole("heading", { name: "Geometric isometric icon" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hard-edge geometric screenprint" })).toBeInTheDocument();
    // Two groups, each with a "Style recipe and full prompt" disclosure.
    expect(screen.getAllByText("Style recipe and full prompt")).toHaveLength(2);
  });

  it("copies the full rendered prompt from the expanded prompt block (P16)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom has no clipboard; Mantine CopyButton rides navigator.clipboard.writeText.
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(
      <ContactSheet repo={repo} manifest={manifest()} focusedCandidateId={undefined} exportSelectedIds={new Set()} onToggleExport={() => {}} onFocus={() => {}} />,
    );
    // Open the disclosures (jsdom doesn't toggle <details> from a summary click).
    for (const details of document.querySelectorAll("details")) details.open = true;
    const copyButtons = screen.getAllByRole("button", { name: "Copy full prompt" });
    expect(copyButtons).toHaveLength(2); // one per arm group
    await userEvent.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith(renderRecipe(recipe, "A subject", palette, "#FAFAFA"));
    // The icon-only control flips to its transient "Copied" confirmation state.
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows distinct terminal placeholders for failed and interrupted candidates", () => {
    render(<ContactSheet repo={repo} manifest={manifest()} focusedCandidateId={undefined} exportSelectedIds={new Set()} onToggleExport={() => {}} onFocus={() => {}} />);
    expect(screen.getByText("Generation failed")).toBeInTheDocument();
    // A mapped finishReason failure carries its short non-color-only tag on the card (P15).
    expect(screen.getByText("Blocked: content policy")).toBeInTheDocument();
    expect(screen.getByText("Generation interrupted")).toBeInTheDocument();
    // The cancellation billing note rides along on the interrupted card.
    expect(screen.getByText(/billing may still occur/i)).toBeInTheDocument();
  });

  it("labels every candidate with its variant and non-succeeded status", () => {
    render(<ContactSheet repo={repo} manifest={manifest()} focusedCandidateId={undefined} exportSelectedIds={new Set()} onToggleExport={() => {}} onFocus={() => {}} />);
    // Variant 1 appears once per arm (2 arms); variant 2 likewise.
    expect(screen.getAllByText("Variant 1 of 2")).toHaveLength(2);
    expect(screen.getAllByText("Variant 2 of 2")).toHaveLength(2);
    // Queued and interrupted expose a quiet status label; succeeded does not.
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Interrupted")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("marks the focused candidate's inspect button pressed", async () => {
    render(
      <ContactSheet repo={repo} manifest={manifest()} focusedCandidateId="candidate-arm-1-1" exportSelectedIds={new Set()} onToggleExport={() => {}} onFocus={() => {}} />,
    );
    const pressed = screen.getByRole("button", {
      name: "Inspect Geometric isometric icon → A subject → Variant 1 of 2",
    });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    // The succeeded, focused candidate renders its generated image once the object URL
    // (mocked) resolves via useBlobUrl.
    await within(pressed).findByRole("img");
    // The other cards are not pressed.
    const other = screen.getByRole("button", {
      name: "Inspect Hard-edge geometric screenprint → A subject → Variant 2 of 2",
    });
    expect(other).toHaveAttribute("aria-pressed", "false");
  });
});
