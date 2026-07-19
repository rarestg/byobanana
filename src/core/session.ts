// Boundary types + persistence interface for the browser workbench.
// Modeled on nano-banana-2 @ 54e0224 — src/workbench/store.ts (SessionManifest and
// the incremental candidate lifecycle), but browser-native: image and reference
// bytes are Blobs addressed by id, kept OUT of the JSON-serializable manifest.
// This is the seam later phases build on: P3 writes generation results through
// SessionRepository; P6 swaps the in-memory adapter for an IndexedDB one behind
// the same interface.

import {
  type GenerationCost,
  type GenerationUsage,
  type SpendSummary,
  summarizeSpend,
} from "./cost";
import type { ColorPalette } from "./palettes";
import type { AspectRatio, ImageSize } from "./models";
import type { Recipe } from "./recipes";

// ---------------------------------------------------------------------------
// Binary metadata (the Blob itself lives in the repository, keyed by `blobId`).
// ---------------------------------------------------------------------------

export interface ImageMeta {
  id: string;
  blobId: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

export interface ReferenceRecord {
  order: number;
  originalName: string;
  blobId: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

// A reference image as supplied by the UI, before it is persisted.
export interface ReferenceInput {
  name: string;
  mimeType: string;
  blob: Blob;
}

// ---------------------------------------------------------------------------
// Provider-neutral generation request / result (no apiKey, no @google/genai).
// ---------------------------------------------------------------------------

export type CandidateStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel-requested"
  | "interrupted";

// Exactly what the provider call needs — nothing routing-related. The arm/recipe
// identity and variant index live in the P3 queue's job envelope, not here (they
// don't affect the request Google receives).
export interface GenerationRequest {
  modelId: string;
  size: ImageSize;
  aspectRatio?: AspectRatio;
  prompt: string;
  references: ReferenceInput[];
  googleSearch: boolean;
}

export interface GeneratedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  sha256: string;
}

// Google Search grounding attribution, parsed (defensively) from a response's
// `candidates[].groundingMetadata`. When a candidate used grounding, Google requires
// displaying the Search Suggestions widget (`searchEntryPoint.renderedContent`) and source
// attribution. We keep the fields we can render honestly. NOTE: untestable in this
// environment (no API key), so the shape is parsed guardedly and rendered best-effort.
export interface GroundingMetadata {
  // The Google-supplied Search Suggestions widget (self-contained HTML+CSS). Rendered as-is
  // to satisfy the attribution requirement; any inert <script> in it cannot run under CSP.
  searchEntryPointHtml?: string;
  // The search queries Google ran, surfaced as suggestion links when no widget is present.
  webSearchQueries: string[];
  // Cited web sources (deduped): the grounding chunks' web uri + title.
  sources: { uri: string; title?: string }[];
}

export interface CandidateCancellation {
  requestedAt: string;
  billing: "not-submitted" | "unknown-may-be-charged" | "reported-usage";
}

// A generation attempt's outcome is terminal: queued/running are lifecycle states
// the repository owns, not results a provider returns.
export type ResultStatus = "succeeded" | "failed" | "interrupted";

export interface GenerationResult {
  status: ResultStatus;
  images: GeneratedImage[];
  text: string[];
  usage?: GenerationUsage;
  cost: GenerationCost;
  modelVersion?: string;
  responseId?: string;
  error?: string;
  cancellation?: CandidateCancellation;
  // Present only when the response carried Google Search grounding metadata.
  grounding?: GroundingMetadata;
}

// ---------------------------------------------------------------------------
// Session manifest (JSON-serializable lineage; no binary payloads inline).
// ---------------------------------------------------------------------------

export interface CandidateRecord {
  id: string;
  armId: string;
  variant: number;
  status: CandidateStatus;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  images: ImageMeta[];
  providerText?: string[];
  usage?: GenerationUsage;
  cost?: GenerationCost;
  modelVersion?: string;
  responseId?: string;
  error?: string;
  cancellation?: CandidateCancellation;
  // Google Search grounding attribution. IN-MEMORY ONLY: the queue re-applies it to the live
  // manifest but repositories never persist it (Google grounding terms), so it is absent on reload.
  grounding?: GroundingMetadata;
}

export interface ArmRecord {
  id: string;
  recipe: Recipe;
  recipeSha256: string;
  renderedPrompt: string;
  promptSha256: string;
  candidates: CandidateRecord[];
}

export interface ExportRecord {
  id: string;
  candidateId: string;
  createdAt: string;
  raw: ImageMeta;
  production?: ImageMeta;
}

// A candidate's export as the UI produces it (raw image + optional processed
// production image), before the repository persists the Blobs and assigns ids.
export interface ExportInput {
  candidateId: string;
  raw: GeneratedImage;
  production?: GeneratedImage;
}

export type SessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SessionSettings {
  modelId: string;
  size: ImageSize;
  aspectRatio?: AspectRatio;
  googleSearch: boolean;
  variantsPerRecipe: number;
  callCount: number;
  // How many generation requests may be in flight at once (RunQueue concurrency),
  // 1–24. Optional: manifests stored before P16 lack it (those runs used the fixed
  // concurrency-2 port); consumers default a missing value to 4.
  parallelRequests?: number;
}

// Discriminator distinguishing the browser manifest from the Node workbench's
// on-disk SessionManifest (also schemaVersion 1) so exports/imports can't be confused.
export const SESSION_FORMAT = "nano-banana-web/session";

export interface SessionManifest {
  format: typeof SESSION_FORMAT;
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  derivedFromSessionId?: string;
  status: SessionStatus;
  subject: string;
  palette?: ColorPalette;
  // Canonical uppercase #RRGGBB icon background rendered into the arm prompts. Present
  // only when a selected recipe's template consumed {{backgroundColor}}; manifests from
  // before the field existed (and custom-icon or image runs) simply lack it.
  backgroundColor?: string;
  settings: SessionSettings;
  estimate: {
    status: "estimated" | "unavailable";
    usd?: number;
    excludesGrounding: boolean;
  };
  confirmation: {
    required: boolean;
    acknowledged: boolean;
    reasons: string[];
  };
  references: ReferenceRecord[];
  arms: ArmRecord[];
  selectedCandidateId?: string;
  exports: ExportRecord[];
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  subject: string;
  recipes: string[];
  settings: SessionSettings;
  estimate: SessionManifest["estimate"];
  spend: SpendSummary;
  // Count of images across succeeded candidates (source listHistory generatedImageCount) —
  // the cross-session spend popover shows per-model generated-image counts.
  generatedImageCount: number;
  selectedCandidateId?: string;
}

// Realized image count for a manifest (source listHistory): images from succeeded candidates.
export function generatedImageCount(manifest: SessionManifest): number {
  return manifest.arms
    .flatMap((arm) => arm.candidates)
    .reduce((sum, candidate) => sum + (candidate.status === "succeeded" ? candidate.images.length : 0), 0);
}

// Newest-first comparator shared by the in-memory and IndexedDB adapters: createdAt
// descending, ties broken by id descending so ordering is deterministic.
export function compareManifestsNewestFirst(a: SessionManifest, b: SessionManifest): number {
  return a.createdAt === b.createdAt
    ? b.id.localeCompare(a.id)
    : a.createdAt < b.createdAt
      ? 1
      : -1;
}

// Project a stored manifest to its history summary (shared by both adapters).
export function toSessionSummary(manifest: SessionManifest): SessionSummary {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    status: manifest.status,
    subject: manifest.subject,
    recipes: manifest.arms.map((arm) => arm.recipe.name),
    settings: manifest.settings,
    estimate: manifest.estimate,
    spend: summarizeSpend(manifest.arms.flatMap((arm) => arm.candidates)),
    generatedImageCount: generatedImageCount(manifest),
    selectedCandidateId: manifest.selectedCandidateId,
  };
}

// Input to create a session. `arms` is pre-rendered (renderRecipe) by the caller
// so this layer stays free of prompt-rendering concerns.
export interface CreateSessionInput {
  subject: string;
  palette?: ColorPalette;
  // Canonical uppercase #RRGGBB (see SessionManifest.backgroundColor).
  backgroundColor?: string;
  settings: SessionSettings;
  estimate: SessionManifest["estimate"];
  confirmation: SessionManifest["confirmation"];
  references: ReferenceInput[];
  arms: Array<{
    id: string;
    recipe: Recipe;
    renderedPrompt: string;
    variants: number;
  }>;
  derivedFromSessionId?: string;
}

// ---------------------------------------------------------------------------
// Persistence interface. One in-memory adapter today; an IndexedDB adapter will
// implement the same surface in P6 without changing callers.
// ---------------------------------------------------------------------------

export interface SessionRepository {
  createSession(input: CreateSessionInput): Promise<SessionManifest>;
  getSession(id: string): Promise<SessionManifest | undefined>;
  listSessions(): Promise<SessionSummary[]>;
  // Transition a queued candidate to running (P3 calls this as the queue picks it
  // up) so the manifest lifecycle is honest queued -> running -> terminal rather
  // than jumping straight to a completed state. Multi-tab attempt tokens are a P3
  // concern layered on top of this; P0's single-context adapter doesn't need them.
  startCandidate(sessionId: string, candidateId: string): Promise<SessionManifest>;
  // Fold one finished candidate's terminal result into its manifest. Persists the
  // result's Blobs (re-hashing them) and returns the updated manifest.
  writeCandidateResult(
    sessionId: string,
    candidateId: string,
    result: GenerationResult,
  ): Promise<SessionManifest>;
  // candidateId | null — null clears it; a non-null id must reference a SUCCEEDED
  // candidate (store.ts only lets you promote a succeeded candidate to Primary).
  selectPrimary(sessionId: string, candidateId: string | null): Promise<SessionManifest>;
  // Persist an export's Blob(s) and append the resulting portable record.
  recordExport(sessionId: string, input: ExportInput): Promise<SessionManifest>;
  getBlob(blobId: string): Promise<Blob | undefined>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// SHA-256 hex via WebCrypto (source used node:crypto). Accepts a Blob or bytes.
export async function sha256Hex(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const buffer: ArrayBuffer =
    data instanceof Blob
      ? await data.arrayBuffer()
      : data instanceof Uint8Array
        ? (data.slice().buffer as ArrayBuffer)
        : data;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function deriveSessionStatus(arms: ArmRecord[]): SessionStatus {
  const candidates = arms.flatMap((arm) => arm.candidates);
  if (candidates.some((candidate) => candidate.status === "running")) return "running";
  if (candidates.some((candidate) => candidate.status === "queued")) return "queued";
  const succeeded = candidates.filter((candidate) => candidate.status === "succeeded").length;
  if (succeeded === candidates.length) return "completed";
  if (succeeded > 0) return "partial";
  if (candidates.every((candidate) => candidate.status === "cancel-requested")) return "cancelled";
  if (candidates.some((candidate) => candidate.status === "interrupted")) return "interrupted";
  return "failed";
}

// ---------------------------------------------------------------------------
// In-memory adapter.
// ---------------------------------------------------------------------------

export class InMemorySessionRepository implements SessionRepository {
  private manifests = new Map<string, SessionManifest>();
  private blobs = new Map<string, Blob>();

  async createSession(input: CreateSessionInput): Promise<SessionManifest> {
    const now = new Date().toISOString();
    const id = randomId("session");

    // Prepare all reference metadata (hashing can throw) BEFORE mutating the blob
    // store, so a failure can't leave an orphaned Blob behind.
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
    const arms: ArmRecord[] = [];
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

    // structuredClone the whole manifest into storage so later caller mutations of
    // the input objects (palette/settings/estimate/…) can't reach into the store.
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
    for (const { blobId, blob } of referenceBlobs) this.blobs.set(blobId, blob);
    this.manifests.set(id, manifest);
    return structuredClone(manifest);
  }

  // Persist one image's Blob and derive its metadata by hashing the ACTUAL bytes
  // (never trusting a caller-supplied digest).
  private async putImage(image: GeneratedImage): Promise<ImageMeta> {
    const blobId = randomId("img");
    const sha256 = await sha256Hex(image.blob);
    this.blobs.set(blobId, image.blob);
    return {
      id: randomId("imgmeta"),
      blobId,
      mimeType: image.mimeType,
      bytes: image.blob.size,
      width: image.width,
      height: image.height,
      sha256,
    };
  }

  async getSession(id: string): Promise<SessionManifest | undefined> {
    const manifest = this.manifests.get(id);
    return manifest ? structuredClone(manifest) : undefined;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.manifests.values()].sort(compareManifestsNewestFirst).map(toSessionSummary);
  }

  async startCandidate(sessionId: string, candidateId: string): Promise<SessionManifest> {
    const manifest = this.require(sessionId);
    const candidate = this.findCandidate(manifest, candidateId);
    if (candidate.status !== "queued") {
      throw new Error(`Candidate ${candidateId} is not queued (status: ${candidate.status}).`);
    }
    candidate.status = "running";
    candidate.startedAt = new Date().toISOString();
    manifest.status = deriveSessionStatus(manifest.arms);
    manifest.updatedAt = candidate.startedAt;
    return structuredClone(manifest);
  }

  async writeCandidateResult(
    sessionId: string,
    candidateId: string,
    result: GenerationResult,
  ): Promise<SessionManifest> {
    const manifest = this.require(sessionId);

    // Hash all images FIRST, without storing them (mirrors the IndexedDB adapter's hash-before-
    // txn discipline). Storing is deferred to the synchronous commit below so a concurrent write
    // that terminalizes this candidate during the (async) hash can't be clobbered.
    const prepared: Array<{ blobId: string; blob: Blob; meta: ImageMeta }> = [];
    for (const image of result.images) {
      const blobId = randomId("img");
      const sha256 = await sha256Hex(image.blob);
      prepared.push({
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
      });
    }

    // Terminal-wins guard, rechecked AFTER hashing and with NO further await before the commit —
    // so the recheck + commit are atomic. A cancel/fatal that terminalized this candidate during
    // the hash wins; the prepared (unstored) blobs are simply discarded (no orphans).
    const candidate = this.findCandidate(manifest, candidateId);
    if (candidate.status !== "queued" && candidate.status !== "running") {
      return structuredClone(manifest);
    }

    const images: ImageMeta[] = prepared.map((entry) => {
      this.blobs.set(entry.blobId, entry.blob);
      return entry.meta;
    });

    candidate.status = result.status;
    candidate.completedAt = new Date().toISOString();
    candidate.startedAt ??= candidate.completedAt;
    candidate.images = images;
    candidate.providerText = [...result.text];
    candidate.usage = result.usage ? { ...result.usage } : undefined;
    candidate.cost = result.cost ? { ...result.cost } : undefined;
    candidate.modelVersion = result.modelVersion;
    candidate.responseId = result.responseId;
    candidate.error = result.error;
    candidate.cancellation = result.cancellation ? { ...result.cancellation } : undefined;
    // result.grounding is intentionally NOT persisted (Google grounding terms) — see the queue,
    // which re-applies it to the live view only.

    manifest.status = deriveSessionStatus(manifest.arms);
    manifest.updatedAt = candidate.completedAt;
    return structuredClone(manifest);
  }

  async selectPrimary(sessionId: string, candidateId: string | null): Promise<SessionManifest> {
    const manifest = this.require(sessionId);
    if (candidateId !== null) {
      const candidate = this.findCandidate(manifest, candidateId);
      if (candidate.status !== "succeeded") {
        throw new Error(`Only a succeeded candidate can be Primary: ${candidateId}`);
      }
    }
    manifest.selectedCandidateId = candidateId ?? undefined;
    manifest.updatedAt = new Date().toISOString();
    return structuredClone(manifest);
  }

  async recordExport(sessionId: string, input: ExportInput): Promise<SessionManifest> {
    const manifest = this.require(sessionId);
    this.findCandidate(manifest, input.candidateId); // validate the candidate exists
    const record: ExportRecord = {
      id: randomId("export"),
      candidateId: input.candidateId,
      createdAt: new Date().toISOString(),
      raw: await this.putImage(input.raw),
      production: input.production ? await this.putImage(input.production) : undefined,
    };
    manifest.exports.push(record);
    manifest.updatedAt = record.createdAt;
    return structuredClone(manifest);
  }

  async getBlob(blobId: string): Promise<Blob | undefined> {
    return this.blobs.get(blobId);
  }

  async clear(): Promise<void> {
    this.manifests.clear();
    this.blobs.clear();
  }

  private require(sessionId: string): SessionManifest {
    const manifest = this.manifests.get(sessionId);
    if (!manifest) throw new Error(`Unknown session: ${sessionId}`);
    return manifest;
  }

  private findCandidate(manifest: SessionManifest, candidateId: string): CandidateRecord {
    const candidate = manifest.arms
      .flatMap((arm) => arm.candidates)
      .find((entry) => entry.id === candidateId);
    if (!candidate) throw new Error(`Unknown candidate: ${candidateId}`);
    return candidate;
  }
}
