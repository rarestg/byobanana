import "fake-indexeddb/auto";
import { afterEach, describe, expect, test, vi } from "vitest";

import { loadRecipes, renderRecipe } from "./recipes";
import { COLOR_PALETTES } from "./palettes";
import { IdbSessionRepository, StorageError } from "./idbRepository";
import { sha256Hex, type CreateSessionInput, type GeneratedImage, type GenerationResult } from "./session";

// Each repo gets its own database so tests never share state through the global fake IDB.
function openRepo(onWriteError?: (error: StorageError) => void) {
  return IdbSessionRepository.open({ dbName: `test-${crypto.randomUUID()}`, onWriteError });
}

// Count entries in the "blobs" store via a raw connection (to assert no orphaned blobs).
function blobCount(dbName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("blobs", "readonly");
      const req = tx.objectStore("blobs").count();
      req.onsuccess = () => {
        resolve(req.result);
        db.close();
      };
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

const recipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;

function sessionInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  const palette = COLOR_PALETTES[0];
  return {
    subject: "A local transcript search tool.",
    palette,
    settings: {
      modelId: "gemini-3.1-flash-image",
      size: "1K",
      googleSearch: false,
      variantsPerRecipe: 2,
      callCount: 2,
    },
    estimate: { status: "estimated", usd: 0.134, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [],
    arms: [
      {
        id: "arm-1",
        recipe,
        renderedPrompt: renderRecipe(recipe, "A local transcript search tool.", palette, "#FAFAFA"),
        variants: 2,
      },
    ],
    ...overrides,
  };
}

function pngImage(bytes: Uint8Array): Promise<GeneratedImage> {
  const blob = new Blob([bytes.slice()], { type: "image/png" });
  return sha256Hex(bytes).then((sha256) => ({ blob, mimeType: "image/png", width: 1024, height: 1024, sha256 }));
}

async function succeededResult(bytes: Uint8Array): Promise<GenerationResult> {
  return {
    status: "succeeded",
    images: [await pngImage(bytes)],
    text: ["ok"],
    usage: {
      promptTokens: 10,
      candidateTokens: 752,
      thoughtTokens: 0,
      imageOutputTokens: 752,
      textOutputTokens: 0,
      unclassifiedOutputTokens: 0,
      totalTokens: 762,
    },
    cost: { status: "calculated", usd: 0.0448, excludesGrounding: false },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IdbSessionRepository", () => {
  test("round-trips a manifest, reference blobs, and result blobs", async () => {
    const repo = await openRepo();
    const refBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const created = await repo.createSession(
      sessionInput({
        references: [{ name: "ref.png", mimeType: "image/png", blob: new Blob([refBytes.slice()], { type: "image/png" }) }],
      }),
    );
    expect(created.status).toBe("queued");
    expect(created.references).toHaveLength(1);
    expect(created.references[0].sha256).toBe(await sha256Hex(refBytes));

    // Reference blob survives the round-trip.
    const refBlob = await repo.getBlob(created.references[0].blobId);
    expect(new Uint8Array(await refBlob!.arrayBuffer())).toEqual(refBytes);

    const c1 = created.arms[0].candidates[0].id;
    await repo.startCandidate(created.id, c1);
    const bytes = new Uint8Array([9, 8, 7]);
    const updated = await repo.writeCandidateResult(created.id, c1, await succeededResult(bytes));
    const candidate = updated.arms[0].candidates[0];
    expect(candidate.status).toBe("succeeded");
    // The repository re-hashes the ACTUAL stored bytes rather than trusting the caller.
    expect(candidate.images[0].sha256).toBe(await sha256Hex(bytes));
    const stored = await repo.getBlob(candidate.images[0].blobId);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
    repo.close();
  });

  test("concurrent writeCandidateResult to two candidates of one session — no lost update", async () => {
    const repo = await openRepo();
    const created = await repo.createSession(sessionInput());
    const [c1, c2] = created.arms[0].candidates.map((candidate) => candidate.id);
    await repo.startCandidate(created.id, c1);
    await repo.startCandidate(created.id, c2);

    // Two overlapping read-modify-write transactions on the same session. IndexedDB serializes
    // them by creation order, so the second reads the first's committed manifest — both survive.
    const a = new Uint8Array([10, 11]);
    const b = new Uint8Array([20, 21, 22]);
    await Promise.all([
      repo.writeCandidateResult(created.id, c1, await succeededResult(a)),
      repo.writeCandidateResult(created.id, c2, await succeededResult(b)),
    ]);

    const final = await repo.getSession(created.id);
    const candidates = final!.arms[0].candidates;
    expect(candidates.every((candidate) => candidate.status === "succeeded")).toBe(true);
    expect(candidates.every((candidate) => candidate.images.length === 1)).toBe(true);
    expect(final!.status).toBe("completed");
    // Both blobs are addressable — neither write clobbered the other's image.
    const shas = await Promise.all(
      candidates.map(async (candidate) => new Uint8Array(await (await repo.getBlob(candidate.images[0].blobId))!.arrayBuffer())),
    );
    expect(shas.map((s) => [...s]).sort()).toEqual([[...a], [...b]].sort());
    repo.close();
  });

  test("recordExport persists a compressed production derivative and repeated exports append", async () => {
    const dbName = `test-${crypto.randomUUID()}`;
    const repo = await IdbSessionRepository.open({ dbName });
    const created = await repo.createSession(sessionInput());
    const c1 = created.arms[0].candidates[0].id;
    await repo.startCandidate(created.id, c1);
    const rawBytes = new Uint8Array([9, 8, 7, 6, 5, 4]);
    await repo.writeCandidateResult(created.id, c1, await succeededResult(rawBytes));

    // A compressed download records the derivative in the optional `production` slot
    // (same slot the icon path uses — no schema change).
    const raw = await pngImage(rawBytes);
    const compressedBytes = new Uint8Array([1, 2]);
    const compressed: GeneratedImage = {
      blob: new Blob([compressedBytes.slice()], { type: "image/jpeg" }),
      mimeType: "image/jpeg",
      width: 1024,
      height: 1024,
      sha256: await sha256Hex(compressedBytes),
    };
    const once = await repo.recordExport(created.id, { candidateId: c1, raw, production: compressed });
    expect(once.exports).toHaveLength(1);
    expect(once.exports[0].production?.mimeType).toBe("image/jpeg");
    expect(once.exports[0].production?.sha256).toBe(await sha256Hex(compressedBytes));
    const storedProduction = await repo.getBlob(once.exports[0].production!.blobId);
    expect(new Uint8Array(await storedProduction!.arrayBuffer())).toEqual(compressedBytes);

    // Repeated exports append records (and persist fresh blobs — quota grows per export;
    // the compression cache saves CPU, not storage — documented v1 behavior).
    const twice = await repo.recordExport(created.id, { candidateId: c1, raw, production: compressed });
    expect(twice.exports).toHaveLength(2);
    // candidate image + 2×(raw + production) export blobs
    expect(await blobCount(dbName)).toBe(5);
    repo.close();
  });

  test("a terminal candidate is not clobbered by a late provider result", async () => {
    const dbName = `test-${crypto.randomUUID()}`;
    const repo = await IdbSessionRepository.open({ dbName });
    const created = await repo.createSession(sessionInput());
    const c1 = created.arms[0].candidates[0].id;
    await repo.startCandidate(created.id, c1);
    // First write wins terminal.
    await repo.writeCandidateResult(created.id, c1, {
      status: "interrupted",
      images: [],
      text: [],
      cost: { status: "unavailable", excludesGrounding: false },
      cancellation: { requestedAt: new Date().toISOString(), billing: "unknown-may-be-charged" },
    });
    // A late "succeeded" must NOT overwrite the interrupted terminal state.
    const after = await repo.writeCandidateResult(created.id, c1, await succeededResult(new Uint8Array([1])));
    expect(after.arms[0].candidates[0].status).toBe("interrupted");
    expect(after.arms[0].candidates[0].images).toHaveLength(0);
    // And the discarded result's image blob is NOT persisted (no orphaned blob leak).
    expect(await blobCount(dbName)).toBe(0);
    repo.close();
  });

  test("recover() flips running -> interrupted and queued -> interrupted on re-open", async () => {
    const dbName = `test-${crypto.randomUUID()}`;
    const first = await IdbSessionRepository.open({ dbName });
    const created = await first.createSession(sessionInput());
    const [c1] = created.arms[0].candidates.map((candidate) => candidate.id);
    await first.startCandidate(created.id, c1); // c1 running, c2 still queued
    first.close();

    // A fresh process/tab: reopen the same DB and recover.
    const second = await IdbSessionRepository.open({ dbName });
    await second.recover();
    const recovered = await second.getSession(created.id);
    const [rc1, rc2] = recovered!.arms[0].candidates;
    expect(rc1.status).toBe("interrupted");
    expect(rc1.cancellation?.billing).toBe("unknown-may-be-charged"); // was running: may have been charged
    expect(rc1.error).toMatch(/before this call completed/);
    expect(rc2.status).toBe("interrupted");
    expect(rc2.cancellation).toBeUndefined(); // was queued: never submitted, no charge
    expect(rc2.error).toMatch(/before this call was submitted/);
    expect(recovered!.status).toBe("interrupted");
    second.close();
  });

  test("listSessions is newest-first with realized spend + generated image count", async () => {
    const repo = await openRepo();
    const older = await repo.createSession(sessionInput({ subject: "older" }));
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt
    const newer = await repo.createSession(sessionInput({ subject: "newer" }));
    const c1 = newer.arms[0].candidates[0].id;
    await repo.startCandidate(newer.id, c1);
    await repo.writeCandidateResult(newer.id, c1, await succeededResult(new Uint8Array([2])));

    const summaries = await repo.listSessions();
    expect(summaries.map((summary) => summary.id)).toEqual([newer.id, older.id]);
    const newest = summaries[0];
    expect(newest.recipes).toEqual(["Geometric isometric icon"]);
    expect(newest.spend.status).toBe("partial"); // one succeeded, one still queued -> unavailable
    expect(newest.spend.calculatedUsd).toBeCloseTo(0.0448, 6);
    expect(newest.generatedImageCount).toBe(1);
    expect(summaries[1].generatedImageCount).toBe(0);
    repo.close();
  });

  test("clear() empties both stores", async () => {
    const repo = await openRepo();
    const created = await repo.createSession(
      sessionInput({
        references: [{ name: "r.png", mimeType: "image/png", blob: new Blob([new Uint8Array([1])], { type: "image/png" }) }],
      }),
    );
    const refBlobId = created.references[0].blobId;
    await repo.clear();
    expect(await repo.listSessions()).toHaveLength(0);
    expect(await repo.getSession(created.id)).toBeUndefined();
    expect(await repo.getBlob(refBlobId)).toBeUndefined();
    repo.close();
  });

  test("rejects duplicate arm ids and non-positive variant counts before touching the store", async () => {
    const repo = await openRepo();
    await expect(
      repo.createSession(
        sessionInput({
          arms: [
            { id: "arm-1", recipe, renderedPrompt: "p", variants: 1 },
            { id: "arm-1", recipe, renderedPrompt: "p", variants: 1 },
          ],
        }),
      ),
    ).rejects.toThrow(/Duplicate arm id/);
    await expect(
      repo.createSession(sessionInput({ arms: [{ id: "arm-1", recipe, renderedPrompt: "p", variants: 0 }] })),
    ).rejects.toThrow(/at least one variant/);
    expect(await repo.listSessions()).toHaveLength(0); // nothing persisted on validation failure
    repo.close();
  });

  test("only a succeeded candidate can become Primary", async () => {
    const repo = await openRepo();
    const created = await repo.createSession(sessionInput());
    const c1 = created.arms[0].candidates[0].id;
    await expect(repo.selectPrimary(created.id, c1)).rejects.toThrow(/succeeded/);
    await repo.startCandidate(created.id, c1);
    await repo.writeCandidateResult(created.id, c1, await succeededResult(new Uint8Array([3])));
    const selected = await repo.selectPrimary(created.id, c1);
    expect(selected.selectedCandidateId).toBe(c1);
    const cleared = await repo.selectPrimary(created.id, null);
    expect(cleared.selectedCandidateId).toBeUndefined();
    repo.close();
  });

  test("surfaces a quota error (does not swallow) and rolls the write back", async () => {
    const onWriteError = vi.fn();
    const repo = await openRepo(onWriteError);
    const created = await repo.createSession(sessionInput());
    const c1 = created.arms[0].candidates[0].id;
    await repo.startCandidate(created.id, c1);

    // Simulate storage exhaustion on the next write.
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    try {
      await expect(
        repo.writeCandidateResult(created.id, c1, await succeededResult(new Uint8Array([4]))),
      ).rejects.toBeInstanceOf(StorageError);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(onWriteError).toHaveBeenCalledTimes(1);
    expect(onWriteError.mock.calls[0][0]).toMatchObject({ quotaExceeded: true });
    // Rollback: the candidate is still running (the aborted write committed nothing).
    const after = await repo.getSession(created.id);
    expect(after!.arms[0].candidates[0].status).toBe("running");
    expect(after!.arms[0].candidates[0].images).toHaveLength(0);
    repo.close();
  });

  test("createSession persists derivedFromSessionId and ordered references", async () => {
    const repo = await openRepo();
    const a = new Uint8Array([1, 1]);
    const b = new Uint8Array([2, 2, 2]);
    const created = await repo.createSession(
      sessionInput({
        derivedFromSessionId: "session-parent",
        references: [
          { name: "first.png", mimeType: "image/png", blob: new Blob([a.slice()], { type: "image/png" }) },
          { name: "second.png", mimeType: "image/png", blob: new Blob([b.slice()], { type: "image/png" }) },
        ],
      }),
    );
    expect(created.derivedFromSessionId).toBe("session-parent");
    expect(created.references.map((r) => [r.order, r.originalName])).toEqual([
      [1, "first.png"],
      [2, "second.png"],
    ]);
    const fetched = await repo.getSession(created.id);
    expect(fetched!.derivedFromSessionId).toBe("session-parent");
    repo.close();
  });
});
