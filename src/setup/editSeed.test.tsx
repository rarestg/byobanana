// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

import { COLOR_PALETTES } from "../core/palettes";
import { loadRecipes, renderRecipe } from "../core/recipes";
import {
  InMemorySessionRepository,
  type SessionManifest,
  type SessionRepository,
} from "../core/session";
import { buildSetupSeed } from "./editSeed";

beforeAll(() => {
  // jsdom does not implement object URLs; the seed only needs a stable string.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

const palette = COLOR_PALETTES[0];
const recipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;

async function seedableSession(repo: InMemorySessionRepository): Promise<SessionManifest> {
  return repo.createSession({
    subject: "A local transcript search tool.",
    palette,
    backgroundColor: "#1C1917",
    settings: {
      modelId: "gemini-3.1-flash-image",
      size: "1K",
      aspectRatio: "1:1",
      googleSearch: false,
      variantsPerRecipe: 3,
      callCount: 3,
    },
    estimate: { status: "estimated", usd: 0.2, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [
      { name: "first.png", mimeType: "image/png", blob: new Blob([new Uint8Array([1, 1])], { type: "image/png" }) },
      { name: "second.png", mimeType: "image/png", blob: new Blob([new Uint8Array([2, 2, 2])], { type: "image/png" }) },
    ],
    arms: [
      {
        id: "arm-1",
        recipe,
        renderedPrompt: renderRecipe(recipe, "A local transcript search tool.", palette, "#1C1917"),
        variants: 3,
      },
    ],
  });
}

describe("buildSetupSeed (edit-and-regenerate)", () => {
  it("reconstructs settings, recipes, palette, and references in order + sets derivedFromSessionId", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seedableSession(repo);
    const seed = await buildSetupSeed(manifest, repo);

    expect(seed.subject).toBe("A local transcript search tool.");
    expect(seed.modelId).toBe("gemini-3.1-flash-image");
    expect(seed.variants).toBe(3);
    // The seeded manifest predates parallelRequests — the seed backfills the default.
    expect(seed.parallel).toBe(4);
    expect(seed.paletteId).toBe(palette.id);
    expect(seed.backgroundColor).toBe("#1C1917");
    expect(seed.family).toBe("icon");
    expect(seed.recipeIds).toEqual(["geometric-isometric-icon"]);
    // References inherited in their stored order, as staged File-backed references.
    expect(seed.references.map((reference) => reference.name)).toEqual(["first.png", "second.png"]);
    expect(seed.references[0].file).toBeInstanceOf(File);
    expect(new Uint8Array(await seed.references[0].file.arrayBuffer())).toEqual(new Uint8Array([1, 1]));
    expect(new Uint8Array(await seed.references[1].file.arrayBuffer())).toEqual(new Uint8Array([2, 2, 2]));
    expect(seed.derivedFromSessionId).toBe(manifest.id);
  });

  it("falls back to the default background for a legacy manifest without the field", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seedableSession(repo);
    // Simulate a manifest stored before backgroundColor existed.
    const legacy = structuredClone(manifest);
    delete legacy.backgroundColor;
    const seed = await buildSetupSeed(legacy, repo);
    expect(seed.backgroundColor).toBe("#FAFAFA");
  });

  it("seeds from a legacy manifest whose recipe snapshot carries the retired export width/height", async () => {
    // Manifests stored before the export-size fields left the recipe schema embed snapshots
    // like { type: "folio-icon", width: 384, height: 384, ... }. They are never re-validated
    // (assertRecipe only runs on bundled recipes) and must keep seeding edit-and-regenerate.
    const repo = new InMemorySessionRepository();
    const manifest = await seedableSession(repo);
    const legacy = structuredClone(manifest);
    Object.assign(legacy.arms[0].recipe.export, { width: 384, height: 384 });
    const seed = await buildSetupSeed(legacy, repo);
    expect(seed.family).toBe("icon");
    expect(seed.recipeIds).toEqual(["geometric-isometric-icon"]);
  });

  it("fails cleanly (no object URLs created) when an inherited blob is missing", async () => {
    const manifest = {
      id: "session-x",
      subject: "s",
      palette,
      settings: { modelId: "gemini-3.1-flash-image", size: "1K", aspectRatio: "1:1", googleSearch: false, variantsPerRecipe: 1, callCount: 1 },
      arms: [{ recipe }],
      references: [{ order: 1, originalName: "gone.png", blobId: "missing", mimeType: "image/png", bytes: 3, sha256: "x" }],
    } as unknown as SessionManifest;
    const repo: Pick<SessionRepository, "getBlob"> = { getBlob: async () => undefined };
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    await expect(buildSetupSeed(manifest, repo as SessionRepository)).rejects.toThrow(/no longer available/);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
