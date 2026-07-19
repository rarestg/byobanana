// IndexedDB adapter for the SessionRepository interface — the durable counterpart to
// InMemorySessionRepository (session.ts). Same surface, same validation/cloning semantics;
// only the backing store changes from two in-memory Maps to two IndexedDB object stores:
//   • "manifests" — the JSON-serializable SessionManifest, keyPath "id".
//   • "blobs"     — the Blob payloads (images + references), keyed out-of-line by blobId.
// Metadata is kept SEPARATE from binary: a Blob is never base64'd into the manifest.
//
// ATOMIC WRITES (the P0-flagged hazard: the concurrency-2 queue does read-modify-write).
// Every manifest RMW runs in ONE readwrite transaction that reads the current manifest,
// applies the update synchronously, and writes the manifest + any new Blob(s) together.
// The discipline that makes this safe:
//   1. All Blob hashing (sha256Hex / arrayBuffer — NOT IDB work) happens BEFORE the
//      transaction opens. You cannot await a non-IDB promise inside a live transaction: it
//      auto-commits the moment control returns to the event loop with no pending request.
//   2. Inside the transaction we await ONLY IDB requests (the manifest `get`). An IDB
//      request's completion keeps the transaction active across the awaiting microtask, so
//      the subsequent `put`s land in the same commit.
// Two concurrent RMW transactions over the same store scope are SERIALIZED by IndexedDB
// (by creation order), so the second reads the first's committed manifest — no lost update.
// This replaces the source's per-session `withLock` mutex with IDB's native serialization;
// the SessionRepository interface and the queue are untouched.

import {
  compareManifestsNewestFirst,
  deriveSessionStatus,
  sha256Hex,
  toSessionSummary,
  type CandidateRecord,
  type CreateSessionInput,
  type ExportInput,
  type ExportRecord,
  type GeneratedImage,
  type GenerationResult,
  type ImageMeta,
  type ReferenceRecord,
  type SessionManifest,
  type SessionRepository,
  type SessionSummary,
  SESSION_FORMAT,
} from "./session";
import { postSessionsChanged } from "./sessionsChannel";

const DB_NAME = "nano-banana-web";
const DB_VERSION = 1;
const MANIFESTS = "manifests";
const BLOBS = "blobs";

// A durable-storage failure the UI must SEE (quota exhausted, DB open/version failure) — the
// browser is less reliable than the source's filesystem, so a swallowed write would silently
// lose a user's run. `quotaExceeded` lets callers tailor the message.
export class StorageError extends Error {
  readonly quotaExceeded: boolean;
  constructor(message: string, options?: { cause?: unknown; quotaExceeded?: boolean }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "StorageError";
    this.quotaExceeded = options?.quotaExceeded ?? false;
  }
}

export interface IdbRepositoryOptions {
  // Overridable for isolated tests (each test opens its own DB name).
  dbName?: string;
  // Surfaced (not swallowed) when a write transaction fails — the adapter still rethrows.
  onWriteError?: (error: StorageError) => void;
}

// ---------------------------------------------------------------------------
// Native promise wrappers (no Dexie — a thin helper is the right size).
// ---------------------------------------------------------------------------

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    // A failed request bubbles to `error` (where the originating request error is available on
    // the event), then aborts the whole transaction. Capture the error on `error` but settle
    // only on the terminal events (`complete`/`abort`) so we reject AFTER the rollback and with
    // the most specific error we saw — `tx.error` alone can still be null when `error` fires.
    let captured: unknown;
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => {
      captured = (event.target as IDBRequest | null)?.error ?? tx.error ?? captured;
    };
    tx.onabort = () =>
      reject(captured ?? tx.error ?? new DOMException("Transaction aborted", "AbortError"));
  });
}

function isQuotaError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "QuotaExceededError") ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "QuotaExceededError")
  );
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new StorageError("IndexedDB is unavailable in this browser."));
  }
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName, DB_VERSION);
    } catch (error) {
      reject(new StorageError("Could not open local storage.", { cause: error }));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MANIFESTS)) db.createObjectStore(MANIFESTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new StorageError("Could not open local storage.", { cause: request.error }));
    request.onblocked = () =>
      reject(new StorageError("Local storage is blocked by another open tab; close it and retry."));
  });
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class IdbSessionRepository implements SessionRepository {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly options: IdbRepositoryOptions,
  ) {}

  // Open the database (creating stores on first run). Callers should await `recover()` next
  // to flip any candidate left running/queued by a crash to a terminal state before render.
  static async open(options: IdbRepositoryOptions = {}): Promise<IdbSessionRepository> {
    const db = await openDatabase(options.dbName ?? DB_NAME);
    return new IdbSessionRepository(db, options);
  }

  // Interrupted-run recovery (source recoverInterruptedSessions): on boot any candidate still
  // `running` or `queued` is stale from a crash/tab-close — flip it to `interrupted` and
  // recompute the session status, so a reload shows honest terminal state instead of a stuck
  // spinner. Idempotent (re-running finds nothing to recover), which keeps StrictMode's
  // double-init safe.
  //
  // Cross-tab safety (P7): the caller only awaits this for the PRIMARY tab (useSingleTab.ts's
  // Web Lock) — a secondary tab opening mid-run skips it entirely, so boot recovery can never
  // mark another tab's live `running` candidates interrupted out from under it.
  async recover(): Promise<void> {
    const manifests = await this.allManifests();
    let recovered = false;
    for (const manifest of manifests) {
      const needsRecovery = manifest.arms.some((arm) =>
        arm.candidates.some((candidate) => candidate.status === "running" || candidate.status === "queued"),
      );
      if (!needsRecovery) continue;
      recovered = true;
      await this.mutateManifest(manifest.id, (latest) => {
        const now = new Date().toISOString();
        for (const candidate of latest.arms.flatMap((arm) => arm.candidates)) {
          if (candidate.status !== "running" && candidate.status !== "queued") continue;
          const wasRunning = candidate.status === "running";
          candidate.status = "interrupted";
          candidate.completedAt = now;
          candidate.error = wasRunning
            ? "Workbench stopped before this call completed."
            : "Workbench stopped before this call was submitted.";
          // Only an already-submitted (running) call may have incurred a charge.
          if (wasRunning) {
            candidate.cancellation = { requestedAt: now, billing: "unknown-may-be-charged" };
          }
        }
        latest.status = deriveSessionStatus(latest.arms);
        latest.updatedAt = now;
      });
    }
    // An already-open second tab (e.g. a secondary rendering history) would otherwise stay
    // stale showing a stuck "Running"/"Queued" status until its own next write or manual reload.
    if (recovered) postSessionsChanged();
  }

  async createSession(input: CreateSessionInput): Promise<SessionManifest> {
    const now = new Date().toISOString();
    const id = randomId("session");

    // Hash references + arm/prompt lineage FIRST (outside any transaction). A failure here
    // rejects before we touch the store, so no orphaned Blob can be left behind.
    const references: ReferenceRecord[] = [];
    const referenceBlobs: Array<{ blobId: string; blob: Blob }> = [];
    for (const [index, reference] of input.references.entries()) {
      const blobId = randomId("ref");
      references.push({
        order: index + 1,
        originalName: reference.name,
        blobId,
        mimeType: reference.mimeType,
        bytes: reference.blob.size,
        sha256: await sha256Hex(reference.blob),
      });
      referenceBlobs.push({ blobId, blob: reference.blob });
    }

    const armIds = new Set<string>();
    const arms: SessionManifest["arms"] = [];
    for (const arm of input.arms) {
      if (armIds.has(arm.id)) throw new Error(`Duplicate arm id: ${arm.id}`);
      if (!Number.isInteger(arm.variants) || arm.variants < 1) {
        throw new Error(`Arm ${arm.id} must have at least one variant.`);
      }
      armIds.add(arm.id);
      const recipe = structuredClone(arm.recipe);
      arms.push({
        id: arm.id,
        recipe,
        recipeSha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(recipe))),
        renderedPrompt: arm.renderedPrompt,
        promptSha256: await sha256Hex(new TextEncoder().encode(arm.renderedPrompt)),
        candidates: Array.from({ length: arm.variants }, (_unused, variantIndex) => ({
          id: `candidate-${arm.id}-${variantIndex + 1}`,
          armId: arm.id,
          variant: variantIndex + 1,
          status: "queued" as const,
          queuedAt: now,
          images: [],
        })),
      });
    }

    // structuredClone so caller mutations of input sub-objects can't reach the object we
    // persist (put() clones again on write; this also detaches the returned value).
    const manifest: SessionManifest = structuredClone({
      format: SESSION_FORMAT,
      schemaVersion: 1,
      id,
      createdAt: now,
      updatedAt: now,
      derivedFromSessionId: input.derivedFromSessionId,
      status: "queued",
      subject: input.subject,
      palette: input.palette,
      // Conditional spread: an absent color stays truly absent (no own undefined key),
      // matching the historical manifests that predate the field.
      ...(input.backgroundColor !== undefined ? { backgroundColor: input.backgroundColor } : {}),
      settings: input.settings,
      estimate: input.estimate,
      confirmation: input.confirmation,
      references,
      arms,
      exports: [],
    });

    await this.runWrite([MANIFESTS, BLOBS], (tx) => {
      tx.objectStore(MANIFESTS).put(manifest);
      const blobStore = tx.objectStore(BLOBS);
      for (const { blobId, blob } of referenceBlobs) blobStore.put(blob, blobId);
    });
    postSessionsChanged();
    return structuredClone(manifest);
  }

  async startCandidate(sessionId: string, candidateId: string): Promise<SessionManifest> {
    const manifest = await this.mutateManifest(sessionId, (manifest) => {
      const candidate = findCandidate(manifest, candidateId);
      if (candidate.status !== "queued") {
        throw new Error(`Candidate ${candidateId} is not queued (status: ${candidate.status}).`);
      }
      candidate.status = "running";
      candidate.startedAt = new Date().toISOString();
      manifest.status = deriveSessionStatus(manifest.arms);
      manifest.updatedAt = candidate.startedAt;
    });
    // Without this, another open tab's rail would show "Queued" for the full duration of a
    // potentially 120-second in-flight call — post so it flips to "Running" promptly.
    postSessionsChanged();
    return manifest;
  }

  async writeCandidateResult(
    sessionId: string,
    candidateId: string,
    result: GenerationResult,
  ): Promise<SessionManifest> {
    // Hash + prepare all images BEFORE opening the transaction (see file header).
    const prepared: Array<{ meta: ImageMeta; blobId: string; blob: Blob }> = [];
    for (const image of result.images) prepared.push(await prepareImage(image));

    const manifest = await this.mutateManifest(
      sessionId,
      (manifest) => {
        const candidate = findCandidate(manifest, candidateId);
        // Terminal-wins guard (atomic here, unlike the queue's outer writeIfPending check):
        // if a cancel/fatal already wrote this candidate between the queue's status check and
        // this transaction, don't clobber its terminal result — and signal "no write" so the
        // prepared image blobs are NOT stored (they would otherwise leak, unreferenced).
        if (candidate.status !== "queued" && candidate.status !== "running") return false;
        candidate.status = result.status;
        candidate.completedAt = new Date().toISOString();
        candidate.startedAt ??= candidate.completedAt;
        candidate.images = prepared.map((entry) => entry.meta);
        candidate.providerText = [...result.text];
        candidate.usage = result.usage ? { ...result.usage } : undefined;
        candidate.cost = result.cost ? { ...result.cost } : undefined;
        candidate.modelVersion = result.modelVersion;
        candidate.responseId = result.responseId;
        candidate.error = result.error;
        candidate.cancellation = result.cancellation ? { ...result.cancellation } : undefined;
        // NOTE: result.grounding is intentionally NOT persisted — Google's grounding terms restrict
        // caching Grounded Results / Search Suggestions, so attribution is kept in-memory only (the
        // queue re-applies it to the live view) and does not survive a reload.
        manifest.status = deriveSessionStatus(manifest.arms);
        manifest.updatedAt = candidate.completedAt;
      },
      prepared.map((entry) => ({ blobId: entry.blobId, blob: entry.blob })),
    );
    postSessionsChanged();
    return manifest;
  }

  async selectPrimary(sessionId: string, candidateId: string | null): Promise<SessionManifest> {
    return this.mutateManifest(sessionId, (manifest) => {
      if (candidateId !== null) {
        const candidate = findCandidate(manifest, candidateId);
        if (candidate.status !== "succeeded") {
          throw new Error(`Only a succeeded candidate can be Primary: ${candidateId}`);
        }
      }
      manifest.selectedCandidateId = candidateId ?? undefined;
      manifest.updatedAt = new Date().toISOString();
    });
  }

  async recordExport(sessionId: string, input: ExportInput): Promise<SessionManifest> {
    // Hash export blobs first (outside the transaction).
    const raw = await prepareImage(input.raw);
    const production = input.production ? await prepareImage(input.production) : undefined;
    const blobs = [{ blobId: raw.blobId, blob: raw.blob }];
    if (production) blobs.push({ blobId: production.blobId, blob: production.blob });

    const manifest = await this.mutateManifest(
      sessionId,
      (manifest) => {
        findCandidate(manifest, input.candidateId); // validate the candidate exists
        const record: ExportRecord = {
          id: randomId("export"),
          candidateId: input.candidateId,
          createdAt: new Date().toISOString(),
          raw: raw.meta,
          production: production?.meta,
        };
        manifest.exports.push(record);
        manifest.updatedAt = record.createdAt;
      },
      blobs,
    );
    postSessionsChanged();
    return manifest;
  }

  async getSession(id: string): Promise<SessionManifest | undefined> {
    const tx = this.db.transaction(MANIFESTS, "readonly");
    const manifest = await this.read(tx.objectStore(MANIFESTS).get(id) as IDBRequest<SessionManifest | undefined>);
    return manifest ?? undefined;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const manifests = await this.allManifests();
    return manifests.sort(compareManifestsNewestFirst).map(toSessionSummary);
  }

  async getBlob(blobId: string): Promise<Blob | undefined> {
    const tx = this.db.transaction(BLOBS, "readonly");
    const blob = await this.read(tx.objectStore(BLOBS).get(blobId) as IDBRequest<Blob | undefined>);
    return blob ?? undefined;
  }

  async clear(): Promise<void> {
    await this.runWrite([MANIFESTS, BLOBS], (tx) => {
      tx.objectStore(MANIFESTS).clear();
      tx.objectStore(BLOBS).clear();
    });
    postSessionsChanged();
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private async allManifests(): Promise<SessionManifest[]> {
    const tx = this.db.transaction(MANIFESTS, "readonly");
    return this.read(tx.objectStore(MANIFESTS).getAll() as IDBRequest<SessionManifest[]>);
  }

  // Await a read request, normalizing any failure to a StorageError so a broken read (e.g. a
  // corrupt DB) can't be misclassified downstream as a generation failure. Not-found is not an
  // error here — the request resolves with `undefined`.
  private async read<T>(request: IDBRequest<T>): Promise<T> {
    try {
      return await req(request);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("Could not read from local storage.", { cause: error, quotaExceeded: isQuotaError(error) });
    }
  }

  // The single atomic read-modify-write primitive. Opens one readwrite transaction, reads the
  // manifest (an IDB await — keeps the txn alive), applies `mutate` SYNCHRONOUSLY, then writes
  // the manifest and any prepared Blobs together. `mutate` may throw to reject (validation);
  // that aborts the transaction. Concurrent calls to the same session serialize on IDB.
  private async mutateManifest(
    sessionId: string,
    // Returning `false` means "no change" — skip persisting the manifest AND the prepared blobs
    // (so a no-op update, e.g. the terminal-wins guard, never leaves orphaned blobs behind).
    mutate: (manifest: SessionManifest) => void | false,
    blobsToPut: Array<{ blobId: string; blob: Blob }> = [],
  ): Promise<SessionManifest> {
    const stores = blobsToPut.length ? [MANIFESTS, BLOBS] : [MANIFESTS];
    const manifest = await this.runWrite(stores, async (tx) => {
      const store = tx.objectStore(MANIFESTS);
      const current = await req(store.get(sessionId) as IDBRequest<SessionManifest | undefined>);
      if (!current) throw new Error(`Unknown session: ${sessionId}`);
      const changed = mutate(current); // synchronous — no non-IDB awaits, so the txn stays active
      if (changed === false) return current; // no-op: persist neither the manifest nor the blobs
      store.put(current);
      if (blobsToPut.length) {
        const blobStore = tx.objectStore(BLOBS);
        for (const { blobId, blob } of blobsToPut) blobStore.put(blob, blobId);
      }
      return current;
    });
    return structuredClone(manifest);
  }

  // Run `work` inside one readwrite transaction and await its commit. `work` must await ONLY
  // IDB requests. On a thrown validation error we abort; on a commit failure we surface a
  // StorageError (quota-aware) via onWriteError and rethrow — never swallow a lost write.
  private async runWrite<T>(
    stores: string[],
    work: (tx: IDBTransaction) => T | Promise<T>,
  ): Promise<T> {
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction(stores, "readwrite");
    } catch (error) {
      throw this.reportStorageError(error);
    }
    const done = txDone(tx); // attach handlers before any await so no completion is missed
    let result: T;
    try {
      result = await work(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // already inactive/aborted
      }
      // If the failure is a storage fault (e.g. a put threw quota) surface it; a plain
      // validation Error (unknown session / not queued / not succeeded) rethrows verbatim.
      await done.catch(() => undefined);
      if (isQuotaError(error) || error instanceof StorageError) throw this.reportStorageError(error);
      throw error;
    }
    try {
      await done;
    } catch (error) {
      throw this.reportStorageError(error);
    }
    return result;
  }

  // Normalize to a StorageError, notify the UI callback once, and return it to be thrown.
  private reportStorageError(error: unknown): StorageError {
    const quota = isQuotaError(error);
    const storageError =
      error instanceof StorageError
        ? error
        : new StorageError(
            quota
              ? "Local storage is full. Free space or clear history, then try again."
              : "Could not write to local storage.",
            { cause: error, quotaExceeded: quota },
          );
    this.options.onWriteError?.(storageError);
    return storageError;
  }
}

// Persist-prep for one image: hash the ACTUAL bytes (never trusting a caller digest) and
// derive its metadata + a fresh blobId. The Blob is put into the store inside the caller's
// transaction; here we only do the (non-IDB) hashing.
async function prepareImage(image: GeneratedImage): Promise<{ meta: ImageMeta; blobId: string; blob: Blob }> {
  const blobId = randomId("img");
  const sha256 = await sha256Hex(image.blob);
  return {
    blobId,
    blob: image.blob,
    meta: {
      id: randomId("imgmeta"),
      blobId,
      mimeType: image.mimeType,
      bytes: image.blob.size,
      width: image.width,
      height: image.height,
      sha256,
    },
  };
}

function findCandidate(manifest: SessionManifest, candidateId: string): CandidateRecord {
  const candidate = manifest.arms
    .flatMap((arm) => arm.candidates)
    .find((entry) => entry.id === candidateId);
  if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
  return candidate;
}
