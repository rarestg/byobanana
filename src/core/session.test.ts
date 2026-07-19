import { describe, expect, test } from "vitest";

import { loadRecipes, renderRecipe } from "./recipes";
import { COLOR_PALETTES } from "./palettes";
import {
  type GeneratedImage,
  type GenerationResult,
  InMemorySessionRepository,
  sha256Hex,
} from "./session";

async function seededSession(repo: InMemorySessionRepository) {
  const palette = COLOR_PALETTES[0];
  const recipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;
  return repo.createSession({
    subject: "A local transcript search tool.",
    palette,
    settings: {
      modelId: "gemini-3.1-flash-image",
      size: "1K",
      googleSearch: false,
      variantsPerRecipe: 1,
      callCount: 1,
    },
    estimate: { status: "estimated", usd: 0.067, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [],
    arms: [
      {
        id: "arm-1",
        recipe,
        renderedPrompt: renderRecipe(recipe, "A local transcript search tool.", palette, "#FAFAFA"),
        variants: 1,
      },
    ],
  });
}

function pngImage(bytes: Uint8Array): Promise<GeneratedImage> {
  const blob = new Blob([bytes.slice()], { type: "image/png" });
  return sha256Hex(bytes).then((sha256) => ({
    blob,
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    sha256,
  }));
}

async function succeededResult(bytes: Uint8Array): Promise<GenerationResult> {
  return {
    status: "succeeded",
    images: [await pngImage(bytes)],
    text: ["provider note"],
    usage: {
      promptTokens: 10,
      candidateTokens: 752,
      thoughtTokens: 2,
      imageOutputTokens: 747,
      textOutputTokens: 5,
      unclassifiedOutputTokens: 0,
      totalTokens: 764,
    },
    cost: { status: "calculated", usd: 0.0448, excludesGrounding: false },
  };
}

describe("InMemorySessionRepository", () => {
  test("creates a queued session with hashed arm lineage", async () => {
    const repo = new InMemorySessionRepository();
    const manifest = await seededSession(repo);
    expect(manifest.status).toBe("queued");
    expect(manifest.arms).toHaveLength(1);
    expect(manifest.arms[0].candidates).toHaveLength(1);
    expect(manifest.arms[0].candidates[0].status).toBe("queued");
    expect(manifest.arms[0].promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.arms[0].renderedPrompt).toContain("Subject brief:");
  });

  test("rejects duplicate arm ids and non-positive variant counts", async () => {
    const repo = new InMemorySessionRepository();
    const recipe = loadRecipes()[0];
    const base = {
      subject: "x",
      settings: {
        modelId: "gemini-3.1-flash-image",
        size: "1K" as const,
        googleSearch: false,
        variantsPerRecipe: 1,
        callCount: 1,
      },
      estimate: { status: "unavailable" as const, excludesGrounding: false },
      confirmation: { required: false, acknowledged: false, reasons: [] },
      references: [],
    };
    await expect(
      repo.createSession({
        ...base,
        arms: [
          { id: "arm-1", recipe, renderedPrompt: "p", variants: 1 },
          { id: "arm-1", recipe, renderedPrompt: "p", variants: 1 },
        ],
      }),
    ).rejects.toThrow(/Duplicate arm id/);
    await expect(
      repo.createSession({
        ...base,
        arms: [{ id: "arm-1", recipe, renderedPrompt: "p", variants: 0 }],
      }),
    ).rejects.toThrow(/at least one variant/);
  });

  test("runs the queued -> running -> succeeded lifecycle and stores hashed blobs", async () => {
    const repo = new InMemorySessionRepository();
    const created = await seededSession(repo);
    const candidateId = created.arms[0].candidates[0].id;

    const running = await repo.startCandidate(created.id, candidateId);
    expect(running.status).toBe("running");
    expect(running.arms[0].candidates[0].status).toBe("running");
    expect(running.arms[0].candidates[0].startedAt).toBeTypeOf("string");

    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const updated = await repo.writeCandidateResult(
      created.id,
      candidateId,
      await succeededResult(bytes),
    );
    expect(updated.status).toBe("completed");
    const candidate = updated.arms[0].candidates[0];
    expect(candidate.status).toBe("succeeded");
    expect(candidate.images).toHaveLength(1);
    // Repository re-hashes the actual bytes rather than trusting the caller.
    expect(candidate.images[0].sha256).toBe(await sha256Hex(bytes));

    const stored = await repo.getBlob(candidate.images[0].blobId);
    expect(stored).toBeInstanceOf(Blob);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });

  test("only lets a succeeded candidate become (or clear) Primary", async () => {
    const repo = new InMemorySessionRepository();
    const created = await seededSession(repo);
    const candidateId = created.arms[0].candidates[0].id;

    await expect(repo.selectPrimary(created.id, candidateId)).rejects.toThrow(/succeeded/);
    await repo.startCandidate(created.id, candidateId);
    await repo.writeCandidateResult(created.id, candidateId, await succeededResult(new Uint8Array([1])));

    const selected = await repo.selectPrimary(created.id, candidateId);
    expect(selected.selectedCandidateId).toBe(candidateId);
    const cleared = await repo.selectPrimary(created.id, null);
    expect(cleared.selectedCandidateId).toBeUndefined();
  });

  test("records an export by persisting its blob and appending a portable record", async () => {
    const repo = new InMemorySessionRepository();
    const created = await seededSession(repo);
    const candidateId = created.arms[0].candidates[0].id;
    await repo.startCandidate(created.id, candidateId);
    await repo.writeCandidateResult(created.id, candidateId, await succeededResult(new Uint8Array([9])));

    const rawBytes = new Uint8Array([1, 2, 3, 4]);
    const updated = await repo.recordExport(created.id, {
      candidateId,
      raw: await pngImage(rawBytes),
    });
    expect(updated.exports).toHaveLength(1);
    const stored = await repo.getBlob(updated.exports[0].raw.blobId);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(rawBytes);
  });

  test("summarizes sessions newest-first with realized spend", async () => {
    const repo = new InMemorySessionRepository();
    const created = await seededSession(repo);
    const candidateId = created.arms[0].candidates[0].id;
    await repo.startCandidate(created.id, candidateId);
    await repo.writeCandidateResult(created.id, candidateId, await succeededResult(new Uint8Array([2])));

    const summaries = await repo.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].recipes).toEqual(["Geometric isometric icon"]);
    expect(summaries[0].spend.status).toBe("complete");
    expect(summaries[0].spend.calculatedUsd).toBeCloseTo(0.0448, 6);
  });

  test("keeps stored manifests isolated from later input mutation", async () => {
    const repo = new InMemorySessionRepository();
    const palette = COLOR_PALETTES[0];
    const recipe = loadRecipes()[0];
    const settings = {
      modelId: "gemini-3.1-flash-image",
      size: "1K" as const,
      googleSearch: false,
      variantsPerRecipe: 1,
      callCount: 1,
    };
    const created = await repo.createSession({
      subject: "x",
      palette,
      settings,
      estimate: { status: "unavailable", excludesGrounding: false },
      confirmation: { required: false, acknowledged: false, reasons: [] },
      references: [],
      arms: [{ id: "arm-1", recipe, renderedPrompt: "p", variants: 1 }],
    });
    settings.callCount = 999; // mutate caller's object after creation
    const fetched = await repo.getSession(created.id);
    expect(fetched!.settings.callCount).toBe(1);
  });
});
