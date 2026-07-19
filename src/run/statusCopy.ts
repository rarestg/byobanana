// Status/label copy for the session view. Ported verbatim from nano-banana-2 @ 54e0224
// web/app.js (statusLabel, terminalCandidateLabel, candidateMessages, candidateIdentity,
// modelShortLabel, formatSize). providerFailureMessage lives in core/gemini.ts (P1).

import { failureShortLabel } from "../core/gemini";
import { getModelCapability } from "../core/models";
import type { ArmRecord, CandidateRecord, CandidateStatus } from "../core/session";

export function statusLabel(status: string): string {
  return (
    {
      queued: "Queued",
      running: "Running",
      succeeded: "Succeeded",
      failed: "Failed",
      interrupted: "Interrupted",
      "cancel-requested": "Cancellation requested",
      completed: "Completed",
      partial: "Partial",
      cancelled: "Cancelled",
    }[status] ?? status
  );
}

// The terminal-placeholder headline for a non-succeeded card (undefined while queued/running).
export function terminalCandidateLabel(status: CandidateStatus): string | undefined {
  return {
    failed: "Generation failed",
    interrupted: "Generation interrupted",
    "cancel-requested": "Cancellation requested",
  }[status as "failed" | "interrupted" | "cancel-requested"];
}

// The detailed failure/interruption line — inspector-only (P4), NOT the contact-sheet card.
// candidate.error is ALREADY friendly: the queue maps every provider error through
// providerFailureMessage exactly once before storing it (queue.ts failedResult), and
// synthetic interruption/cancellation messages are friendly by construction. Return it
// verbatim — re-normalizing here would collapse specific copy (bad key, rate limit, blocked)
// back to the generic fallback.
export function candidateFailureMessage(candidate: CandidateRecord): string {
  return String(candidate.error ?? "");
}

// P15: the candidate card's compact failure tag ("Blocked: content policy") — a short,
// non-color-only reason next to the ⚠ "Generation failed" headline. Only failures whose
// stored error is a mapped finishReason message get one (failureShortLabel's reverse
// lookup); every other failure keeps just the headline, with the detail in the inspector.
export function candidateShortFailureLabel(candidate: CandidateRecord): string | undefined {
  if (candidate.status !== "failed") return undefined;
  return failureShortLabel(candidate.error);
}

// The quiet message line under a contact-sheet card. Ports web/app.js candidateMessages
// with includeFailureDetail=false (the card default): only the cancellation billing note
// and the icon-not-square export note — the failure REASON is shown in the inspector.
export function candidateMessage(arm: ArmRecord, candidate: CandidateRecord): string {
  const messages: string[] = [];
  if (candidate.cancellation?.billing === "unknown-may-be-charged") {
    messages.push("Cancellation requested; billing may still occur.");
  }
  if (
    candidate.status === "succeeded" &&
    arm.recipe.export.type === "folio-icon" &&
    candidate.images[0]?.width !== candidate.images[0]?.height
  ) {
    messages.push("Export unavailable: project icons require a square generated image.");
  }
  return messages.join(" ");
}

export function candidateIdentity(subject: string, arm: ArmRecord, candidate: CandidateRecord): string {
  return `${arm.recipe.name} → ${subject} → Variant ${candidate.variant} of ${arm.candidates.length}`;
}

export function modelShortLabel(modelId: string): string {
  const label = getModelCapability(modelId)?.label ?? modelId;
  return label.split(" · ").pop() ?? modelId;
}

export function formatSize(size: string): string {
  return /^\d+$/.test(size) ? `${size}px` : size;
}

// History-rail timestamp (P11): "Jul 16, 2026 · 5:36 pm" — localized month/day/year and
// hour:minute (no seconds), with the day period lowercased via formatToParts so only that
// part is touched (locale-safe). Invalid input falls back to the raw string.
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: true })
    .formatToParts(date)
    .map((part) => (part.type === "dayPeriod" ? part.value.toLocaleLowerCase() : part.value))
    .join("");
  return `${day} · ${time}`;
}

// File size for the inspector facts ("1376×768 · 214 KB"). KB = bytes/1024: one decimal
// under 100 KB, whole numbers from there, and MB with one decimal from 1024 KB up.
export function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  if (kb >= 100) return `${Math.round(kb)} KB`;
  return `${kb.toFixed(1)} KB`;
}
