// @vitest-environment jsdom
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { render, screen, userEvent } from "../../test-utils";
import { loadRecipes, renderRecipe } from "../core/recipes";
import { COLOR_PALETTES } from "../core/palettes";
import type {
  ArmRecord,
  CandidateRecord,
  CandidateStatus,
  SessionManifest,
  SessionRepository,
} from "../core/session";
import { SessionView } from "./SessionView";

// The end-to-end ZIP-build + recordExport flow (clicking "Download ZIP") is covered in
// core/exportBundle.test.ts under the node environment — the browser ZIP builder in
// core/zip.ts rejects jsdom's foreign-realm TextEncoder output (`instanceof Uint8Array`
// fails across realms), so the assembly step can't run under jsdom. These jsdom tests cover
// the selection state + tray wiring; the canvas icon is verified in scripts/verify-icon.mjs.

// jsdom lacks object-URL APIs; succeeded cards create one via useBlobUrl.
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

const imageRecipe = loadRecipes().find((entry) => entry.id === "hard-edge-geometric-screenprint")!;
const iconRecipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;
const palette = COLOR_PALETTES[0];

function candidate(
  id: string,
  variant: number,
  status: CandidateStatus,
  extra: Partial<CandidateRecord> = {},
): CandidateRecord {
  return {
    id,
    armId: "arm-1",
    variant,
    status,
    queuedAt: "2026-01-01T00:00:00.000Z",
    images: status === "succeeded" ? [image(id)] : [],
    ...extra,
  };
}

function image(id: string) {
  return {
    id: `im-${id}`,
    blobId: `blob-${id}`,
    mimeType: "image/png",
    bytes: 10,
    width: 512,
    height: 512,
    sha256: `sha-${id}`,
  };
}

function arm(candidates: CandidateRecord[], recipe = imageRecipe): ArmRecord {
  return {
    id: "arm-1",
    recipe,
    recipeSha256: "sha",
    renderedPrompt: renderRecipe(recipe, "A subject", palette, "#FAFAFA"),
    promptSha256: "psha",
    candidates,
  };
}

function manifest(candidates: CandidateRecord[], recipe = imageRecipe): SessionManifest {
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
      variantsPerRecipe: 3,
      callCount: 3,
    },
    estimate: { status: "estimated", usd: 0.05, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [],
    exports: [],
    arms: [arm(candidates, recipe)],
  };
}

const stubRepo = { getBlob: async () => new Blob(["x"], { type: "image/png" }) } as unknown as SessionRepository;

function Harness({ initial, repo = stubRepo }: { initial: SessionManifest; repo?: SessionRepository }) {
  const [current, setCurrent] = useState(initial);
  return (
    <SessionView
      repo={repo}
      manifest={current}
      onCancel={() => {}}
      onManifestChange={setCurrent}
      onEditSetup={() => {}}
    />
  );
}

describe("SessionView export selection", () => {
  it("only succeeded candidates get an export checkbox", () => {
    render(
      <Harness
        initial={manifest([
          candidate("c1", 1, "succeeded"),
          candidate("c2", 2, "failed"),
          candidate("c3", 3, "queued"),
        ])}
      />,
    );
    // One succeeded candidate -> exactly one export checkbox.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(
      screen.getByRole("checkbox", { name: /Variant 1 of 3.*for export/i }),
    ).toBeInTheDocument();
  });

  it("excludes a non-square succeeded icon from export selection", () => {
    // A succeeded icon whose generated image is NOT square can't be masked into a circle, so
    // its ZIP would always fail — source disables the checkbox and so do we.
    const nonSquare = candidate("c1", 1, "succeeded");
    nonSquare.images = [{ ...image("c1"), width: 1024, height: 640 }];
    render(<Harness initial={manifest([nonSquare], iconRecipe)} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("tray appears only with a selection and counts selected candidates", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={manifest([
          candidate("c1", 1, "succeeded"),
          candidate("c2", 2, "succeeded"),
        ])}
      />,
    );
    // No selection -> no tray.
    expect(screen.queryByRole("button", { name: /Download ZIP/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Variant 1 of 2.*for export/i }));
    expect(screen.getByRole("button", { name: "Download ZIP (1)" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Variant 2 of 2.*for export/i }));
    expect(screen.getByRole("button", { name: "Download ZIP (2)" })).toBeInTheDocument();

    // Clear resets the tray.
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("button", { name: /Download ZIP/ })).not.toBeInTheDocument();
  });

  it("export selection is independent of Primary (no Primary badge appears)", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={manifest([candidate("c1", 1, "succeeded"), candidate("c2", 2, "succeeded")])}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: /Variant 1 of 2.*for export/i }));
    // Selecting for export must not promote the candidate to Primary.
    expect(screen.queryByText("Primary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download ZIP (1)" })).toBeInTheDocument();
  });
});
