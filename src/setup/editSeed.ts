// "Edit and regenerate" seed: reconstruct a SetupForm starting state from a stored session's
// manifest, INCLUDING its reference images (reference inheritance) — the blobs are re-loaded
// from the repository and rebuilt into staged references in their original order. The new run
// records `derivedFromSessionId` pointing at the immediate parent.
//
// Faithfulness notes:
//   • The confirmation acknowledgement is NOT inherited — a derived run re-clears the safety
//     gate so the user must re-acknowledge if it still trips.
//   • Every inherited Blob is fetched and validated BEFORE any object URL is created, so a
//     missing blob fails the whole seed cleanly with zero leaked URLs.

import { DEFAULT_PALETTE_ID } from "../core/palettes";
import { DEFAULT_ICON_BACKGROUND, recipeFamily } from "../core/recipes";
import type { AspectRatio } from "../core/models";
import type { SessionManifest, SessionRepository } from "../core/session";
import type { SupportedImageMime } from "./references";
import type { StagedReference } from "./references";

export interface SetupFormSeed {
  // A stable token so the form applies each distinct seed exactly once.
  token: string;
  subject: string;
  modelId: string;
  size: string;
  aspectRatio: AspectRatio;
  variants: number;
  parallel: number;
  googleSearch: boolean;
  paletteId: string;
  backgroundColor: string;
  family: "image" | "icon";
  recipeIds: string[];
  references: StagedReference[];
  derivedFromSessionId: string;
}

// Rebuild the seed from a manifest. Async because references are re-hydrated from stored Blobs.
export async function buildSetupSeed(
  manifest: SessionManifest,
  repo: SessionRepository,
): Promise<SetupFormSeed> {
  // Load ALL reference blobs first; a missing one throws before any object URL exists.
  const ordered = [...manifest.references].sort((a, b) => a.order - b.order);
  const loaded: Array<{ record: (typeof ordered)[number]; blob: Blob }> = [];
  for (const record of ordered) {
    const blob = await repo.getBlob(record.blobId);
    if (!blob) throw new Error(`A reference image for this run is no longer available (${record.originalName}).`);
    loaded.push({ record, blob });
  }

  // Create object URLs only after every blob is in hand; if URL creation throws partway,
  // revoke the ones already created so none leak.
  const references: StagedReference[] = [];
  try {
    for (const { record, blob } of loaded) {
      const file = new File([blob], record.originalName, { type: record.mimeType });
      references.push({
        id: crypto.randomUUID(),
        name: record.originalName,
        mimeType: record.mimeType as SupportedImageMime,
        file,
        url: URL.createObjectURL(file),
      });
    }
  } catch (error) {
    for (const reference of references) URL.revokeObjectURL(reference.url);
    throw error;
  }

  const family = manifest.arms.length > 0 ? recipeFamily(manifest.arms[0].recipe) : "icon";

  return {
    token: crypto.randomUUID(),
    subject: manifest.subject,
    modelId: manifest.settings.modelId,
    size: manifest.settings.size,
    aspectRatio: (manifest.settings.aspectRatio ?? "1:1") as AspectRatio,
    variants: manifest.settings.variantsPerRecipe,
    // Pre-P16 manifests carry no parallelRequests — seed those at the current default.
    parallel: manifest.settings.parallelRequests ?? 4,
    googleSearch: manifest.settings.googleSearch,
    paletteId: manifest.palette?.id ?? DEFAULT_PALETTE_ID,
    // Manifests from before the field existed (or runs that never rendered it) seed the
    // default; icon runs that stored a color restore it canonically.
    backgroundColor: manifest.backgroundColor ?? DEFAULT_ICON_BACKGROUND,
    family,
    recipeIds: manifest.arms.map((arm) => arm.recipe.id),
    references,
    derivedFromSessionId: manifest.id,
  };
}
