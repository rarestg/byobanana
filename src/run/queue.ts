// Browser generation queue — a worker pool that runs one session's candidates.
//
// Ported from nano-banana-2 @ 54e0224 src/workbench/jobs.ts (JobQueue: concurrency=2,
// pump/run/cancelSession) and src/workbench/store.ts orderedCandidates (round-robin,
// variant-major across arms). Adapted to the browser: no filesystem, no polling — the
// queue drives the SessionRepository directly (startCandidate -> writeCandidateResult)
// and pushes the fresh manifest to `onUpdate` so React re-renders. It owns the in-flight
// AbortControllers; the single-context in-memory adapter needs no attempt-tokens (P6).
//
// Concurrency is PER-RUN: each session gets its own RunQueue capped at the manifest's
// parallelRequests setting (P16: user-configured 1–24 via the setup form, default 4;
// the class default stays the ported 2 for callers that pass nothing). On
// edit-and-regenerate the previous queue is cancelled before the new one starts, so the
// only transient overlap is the old run's in-flight calls aborting — never new work.
//
// Type-boundary note: the target repo's writeCandidateResult sets candidate.status =
// result.status, and ResultStatus is only succeeded|failed|interrupted. So cancellation
// and fatal-abort land candidates on the terminal `interrupted` status (with a
// cancellation.billing tag) rather than the source's transitional `cancel-requested` —
// which is exactly what the P3 brief asks for.

import { providerFailureMessage } from "../core/gemini";
import type {
  CandidateRecord,
  GenerationRequest,
  GenerationResult,
  ReferenceInput,
  SessionManifest,
  SessionRepository,
} from "../core/session";

// A provider call: build once by the queue, run by whichever runner (real or mock).
export type GenerationRunner = (
  request: GenerationRequest,
  signal: AbortSignal,
) => Promise<GenerationResult>;

// What the queue pushes to the UI after every mutation. The manifest is the single
// source of truth; `fatalError` is an out-of-band run-level message (redacted) that the
// manifest doesn't carry.
export interface RunUpdate {
  manifest: SessionManifest;
  fatalError?: string;
}

export interface RunQueueOptions {
  repo: SessionRepository;
  sessionId: string;
  runner: GenerationRunner;
  onUpdate: (update: RunUpdate) => void;
  // Used only to redact the key from surfaced error text. Omit for the mock runner.
  apiKey?: string;
  concurrency?: number;
}

// Round-robin, variant-major across arms (store.ts orderedCandidates): variant 1 of every
// arm, then variant 2 of every arm, … so comparison styles interleave in the sheet.
export function orderedCandidates(manifest: SessionManifest): CandidateRecord[] {
  const out: CandidateRecord[] = [];
  for (let variant = 1; variant <= manifest.settings.variantsPerRecipe; variant += 1) {
    for (const arm of manifest.arms) {
      const candidate = arm.candidates.find((item) => item.variant === variant);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

export interface RunProgress {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  interrupted: number;
  cancelRequested: number;
  // True while any candidate is still queued or running (drives the Cancel button).
  active: boolean;
}

export function summarizeProgress(manifest: SessionManifest): RunProgress {
  const candidates = manifest.arms.flatMap((arm) => arm.candidates);
  const count = (status: string) => candidates.filter((c) => c.status === status).length;
  const queued = count("queued");
  const running = count("running");
  return {
    total: candidates.length,
    queued,
    running,
    succeeded: count("succeeded"),
    failed: count("failed"),
    interrupted: count("interrupted"),
    cancelRequested: count("cancel-requested"),
    active: queued + running > 0,
  };
}

export class RunQueue {
  private readonly repo: SessionRepository;
  private readonly sessionId: string;
  private readonly runner: GenerationRunner;
  private readonly onUpdate: (update: RunUpdate) => void;
  private readonly apiKey?: string;
  private readonly concurrency: number;

  private pending: string[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly idleWaiters = new Set<() => void>();
  private fatalError?: string;
  // The most recently emitted manifest — reused to surface a run-level storage error when a
  // fresh read is itself failing.
  private lastManifest?: SessionManifest;
  private started = false;
  // Captured at start() so synthetic cancel/fatal results report the run's grounding flag.
  private grounding = false;
  // Grounding attribution is NOT persisted (Google grounding terms restrict caching Grounded
  // Results / Search Suggestions). The queue holds it in-memory per candidate and re-applies it to
  // every emitted manifest, so it stays visible for the live run but never reaches IndexedDB and is
  // gone after a reload.
  private readonly groundingByCandidate = new Map<string, GenerationResult["grounding"]>();

  constructor(options: RunQueueOptions) {
    this.repo = options.repo;
    this.sessionId = options.sessionId;
    this.runner = options.runner;
    this.onUpdate = options.onUpdate;
    this.apiKey = options.apiKey;
    // Public-boundary normalization (Codex P16): a 0/NaN/negative concurrency would
    // strand every candidate (pump() would launch nothing) — clamp to an integer 1–24,
    // falling back to the ported default for non-finite values.
    const requested = options.concurrency ?? 2;
    this.concurrency = Number.isFinite(requested)
      ? Math.min(24, Math.max(1, Math.floor(requested)))
      : 2;
  }

  // Seed the queue from the manifest (queued candidates, round-robin order) and pump.
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const manifest = await this.repo.getSession(this.sessionId);
    if (!manifest) throw new Error(`Unknown session: ${this.sessionId}`);
    this.grounding = manifest.settings.googleSearch;
    this.pending = orderedCandidates(manifest)
      .filter((candidate) => candidate.status === "queued")
      .map((candidate) => candidate.id);
    this.emit(manifest);
    this.pump();
  }

  snapshot() {
    return {
      pending: this.pending.length,
      active: this.active.size,
      concurrency: this.concurrency,
    };
  }

  waitForIdle(): Promise<void> {
    if (!this.pending.length && !this.active.size) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  // "Cancel remaining": queued-but-unstarted candidates land terminal without being
  // submitted; in-flight ones get their controller aborted and resolve to a
  // may-be-charged interruption via the normal run() path (jobs.ts cancelSession).
  //
  // Boundary (P5 spend accounting): if a real runner's HTTP response already returned
  // before the abort took effect, run() writes that genuine success verbatim. The image
  // is real, so keeping it `succeeded` is correct; we simply don't retro-tag its billing
  // as "reported-usage" the way the source did. The mock runner throws AbortError on
  // abort, so mock cancellation always tags may-be-charged.
  async cancel(): Promise<void> {
    const queued = this.pending.splice(0);
    for (const controller of this.active.values()) controller.abort();
    let manifest: SessionManifest | undefined;
    for (const candidateId of queued) {
      // A storage failure mid-cancel must not abort the loop (leaving other candidates queued):
      // record it and stop trying to write, but finish tearing the run down.
      try {
        manifest = await this.writeIfPending(candidateId, this.notSubmittedResult());
      } catch (error) {
        if (isStorageError(error)) {
          this.triggerStorage(error);
          break;
        }
        throw error;
      }
    }
    if (manifest) this.emit(manifest);
    this.resolveIdleIfNeeded();
  }

  private pump() {
    while (this.active.size < this.concurrency && this.pending.length) {
      const candidateId = this.pending.shift();
      if (!candidateId) break;
      const controller = new AbortController();
      this.active.set(candidateId, controller);
      void this.run(candidateId, controller)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(candidateId);
          this.pump();
          this.resolveIdleIfNeeded();
        });
    }
    this.resolveIdleIfNeeded();
  }

  private async run(candidateId: string, controller: AbortController): Promise<void> {
    // Outer guard: a durable-storage failure from ANY repository mutation below — the initial
    // startCandidate, a fallback cancel/fatal write, or the result write — is NOT a provider
    // failure. The store itself is failing, so re-writing the candidate would just fail again
    // (and mislead). Stop the whole run and surface it; never swallow it.
    try {
      // A cancel/fatal that already terminated this candidate wins the race — skip it.
      let manifest = await this.repo.getSession(this.sessionId);
      if (!manifest) return;
      const current = this.findCandidate(manifest, candidateId);
      if (!current || current.status !== "queued") return;

      manifest = await this.repo.startCandidate(this.sessionId, candidateId);
      this.emit(manifest);

      try {
        // Inside the terminalizing try: a rejected reference blob must fail the candidate,
        // not leave it stuck `running` with the rejection swallowed by pump's .catch.
        const request = await this.buildRequest(manifest, candidateId);
        const result = await this.runner(request, controller.signal);
        // Remember grounding attribution in-memory (never persisted) so emit() can re-apply it.
        if (result.grounding) this.groundingByCandidate.set(candidateId, result.grounding);
        manifest = await this.writeIfPending(candidateId, result);
      } catch (error) {
        if (isStorageError(error)) throw error; // to the outer storage guard
        if (controller.signal.aborted || isAbortError(error)) {
          manifest = await this.writeIfPending(candidateId, this.mayBeChargedResult());
        } else if (isFatal(error)) {
          await this.triggerFatal(error);
          manifest = await this.writeIfPending(candidateId, this.failedResult(error));
        } else {
          manifest = await this.writeIfPending(candidateId, this.failedResult(error));
        }
      }
      this.emit(manifest);
    } catch (error) {
      if (!isStorageError(error)) throw error; // unexpected; pump's .catch handles it (unchanged)
      this.triggerStorage(error);
      // Emit the freshest manifest we can so the run-level storage error reaches the UI; fall
      // back to the last emitted manifest if even the read fails.
      const latest = await this.repo.getSession(this.sessionId).catch(() => this.lastManifest);
      if (latest) this.emit(latest);
    }
  }

  // Abort the whole run on a fatal provider error (bad key / model unavailable): stop
  // other in-flight jobs and drop every still-queued candidate to interrupted so nothing
  // else is submitted with a key we know Google rejects. A storage failure here re-throws to
  // run()'s outer guard (fatal + storage both stop the run).
  private async triggerFatal(error: unknown): Promise<void> {
    if (this.fatalError) return;
    this.fatalError = this.redact(error);
    const queued = this.pending.splice(0);
    for (const controller of this.active.values()) controller.abort();
    for (const candidateId of queued) {
      await this.writeIfPending(candidateId, this.notSubmittedResult());
    }
  }

  // A durable-storage failure aborts the run: drop pending work and abort in-flight calls
  // (stop further billing), and record a run-level storage message. We deliberately do NOT
  // try to write candidate results — the store is the thing failing. On reload, recovery
  // flips any still-`running` candidate to interrupted.
  private triggerStorage(error: unknown): void {
    if (this.fatalError) return;
    this.fatalError = this.redact(error);
    this.pending.splice(0);
    for (const controller of this.active.values()) controller.abort();
  }

  // Only fold a result in if the candidate hasn't already reached a terminal state (a
  // cancel or fatal may have written it first). Returns the resulting manifest.
  private async writeIfPending(
    candidateId: string,
    result: GenerationResult,
  ): Promise<SessionManifest> {
    const manifest = await this.repo.getSession(this.sessionId);
    if (!manifest) throw new Error(`Unknown session: ${this.sessionId}`);
    const candidate = this.findCandidate(manifest, candidateId);
    if (!candidate || (candidate.status !== "queued" && candidate.status !== "running")) {
      return manifest;
    }
    return this.repo.writeCandidateResult(this.sessionId, candidateId, result);
  }

  private async buildRequest(
    manifest: SessionManifest,
    candidateId: string,
  ): Promise<GenerationRequest> {
    const arm = manifest.arms.find((entry) =>
      entry.candidates.some((candidate) => candidate.id === candidateId),
    );
    if (!arm) throw new Error(`Unknown candidate: ${candidateId}`);

    const references: ReferenceInput[] = await Promise.all(
      [...manifest.references]
        .sort((a, b) => a.order - b.order)
        .map(async (record) => {
          const blob = await this.repo.getBlob(record.blobId);
          if (!blob) throw new Error(`Missing reference blob: ${record.blobId}`);
          return { name: record.originalName, mimeType: record.mimeType, blob };
        }),
    );

    return {
      modelId: manifest.settings.modelId,
      size: manifest.settings.size,
      aspectRatio: manifest.settings.aspectRatio,
      prompt: arm.renderedPrompt,
      references,
      googleSearch: manifest.settings.googleSearch,
    };
  }

  private emit(manifest: SessionManifest) {
    // Re-apply in-memory grounding attribution to this (freshly-read, un-grounded) manifest so it
    // stays visible across the run's updates without ever being written to storage.
    if (this.groundingByCandidate.size) {
      for (const arm of manifest.arms) {
        for (const candidate of arm.candidates) {
          const grounding = this.groundingByCandidate.get(candidate.id);
          if (grounding) candidate.grounding = grounding;
        }
      }
    }
    this.lastManifest = manifest;
    this.onUpdate({ manifest, fatalError: this.fatalError });
  }

  private resolveIdleIfNeeded() {
    if (this.pending.length || this.active.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private findCandidate(
    manifest: SessionManifest,
    candidateId: string,
  ): CandidateRecord | undefined {
    return manifest.arms
      .flatMap((arm) => arm.candidates)
      .find((candidate) => candidate.id === candidateId);
  }

  private notSubmittedResult(): GenerationResult {
    return {
      status: "interrupted",
      images: [],
      text: [],
      cost: { status: "unavailable", excludesGrounding: this.grounding },
      error: "Generation stopped before the request was submitted.",
      cancellation: { requestedAt: new Date().toISOString(), billing: "not-submitted" },
    };
  }

  private mayBeChargedResult(): GenerationResult {
    return {
      status: "interrupted",
      images: [],
      text: [],
      cost: { status: "unavailable", excludesGrounding: this.grounding },
      error: "Generation stopped after the request was submitted; billing may still occur.",
      cancellation: { requestedAt: new Date().toISOString(), billing: "unknown-may-be-charged" },
    };
  }

  private failedResult(error: unknown): GenerationResult {
    // Map to friendly copy exactly once here (redact the key first) so cards/inspector can
    // display candidate.error verbatim without re-running providerFailureMessage.
    return {
      status: "failed",
      images: [],
      text: [],
      cost: { status: "unavailable", excludesGrounding: this.grounding },
      error: providerFailureMessage(this.redact(error)),
    };
  }

  private redact(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const withoutKey = this.apiKey ? message.split(this.apiKey).join("[redacted]") : message;
    return withoutKey.replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[redacted]").slice(0, 2000);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  );
}

function isFatal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "GeminiFatalError"
  );
}

// Recognize a repository StorageError by name — the queue stays decoupled from the concrete
// IndexedDB adapter (it consumes only the SessionRepository interface).
function isStorageError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "StorageError"
  );
}
