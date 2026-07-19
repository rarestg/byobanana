// One candidate card in the contact sheet (nano-banana-2 web/app.js renderCandidate).
// Succeeded → the generated image (object URL, revoked on unmount/change via useBlobUrl).
// Non-succeeded terminal states → a non-color-only placeholder (icon + headline). Queued/
// running → an animated shimmer. Clicking the card focuses it for the P4 inspector.
// Primary badge / export checkbox are P4/P5 — hooks are left but not built here.

import { Badge, Box, Checkbox, Loader, Skeleton, Text } from "@mantine/core";

import { recipeFamily } from "../core/recipes";
import type { ArmRecord, CandidateRecord, SessionRepository } from "../core/session";
import {
  candidateIdentity,
  candidateMessage,
  candidateShortFailureLabel,
  statusLabel,
  terminalCandidateLabel,
} from "./statusCopy";
import { useBlobUrl } from "./useBlobUrl";
import classes from "./SessionView.module.css";

// Distinct glyph per terminal state (non-color-only): failure vs interruption read apart
// without relying on the red tint.
const TERMINAL_ICON: Record<string, string> = {
  failed: "⚠",
  interrupted: "◼",
  "cancel-requested": "◼",
};

export interface CandidateCardProps {
  repo: SessionRepository;
  subject: string;
  arm: ArmRecord;
  candidate: CandidateRecord;
  focused: boolean;
  // The run's Primary candidate (manifest.selectedCandidateId) — distinct from focus and
  // from export selection.
  primary: boolean;
  // Export selection (the P5 tray). A separate Set<string> owned by SessionView, independent
  // of Primary and focus. Only a succeeded candidate can be selected.
  exportSelected: boolean;
  onToggleExport: (candidateId: string) => void;
  onFocus: (candidateId: string) => void;
}

export function CandidateCard({
  repo,
  subject,
  arm,
  candidate,
  focused,
  primary,
  exportSelected,
  onToggleExport,
  onFocus,
}: CandidateCardProps) {
  const ready = candidate.status === "succeeded" && candidate.images.length > 0;
  const image = ready ? candidate.images[0] : undefined;
  const blobId = image?.blobId;
  const url = useBlobUrl(repo, blobId);

  // Export-eligible = succeeded with an image AND (for icons) square — a non-square icon can't
  // be masked into a circle, so its ZIP would always fail; source disables its checkbox. The
  // inspector still offers a raw download for it.
  const exportEligible =
    ready && (recipeFamily(arm.recipe) !== "icon" || (!!image && image.width === image.height));

  const identity = candidateIdentity(subject, arm, candidate);
  const terminalLabel = terminalCandidateLabel(candidate.status);
  const message = candidateMessage(arm, candidate);
  const isFailed = candidate.status === "failed";
  // P15: compact failure reason ("Blocked: content policy") under the headline when the
  // stored error maps to a known finishReason; the full explanation stays inspector-only.
  const shortFailure = candidateShortFailureLabel(candidate);

  return (
    <Box className={`${classes.card}${focused ? ` ${classes.focused}` : ""}`} data-candidate={candidate.id}>
      {/* Primary badge: shown when this is the run's selectedCandidateId. Non-color-only
          (star glyph + label); Primary is deliberate, distinct from focus/export. */}
      {primary && (
        <Badge
          className={classes.primaryBadge}
          variant="filled"
          radius="sm"
          leftSection={<span aria-hidden>★</span>}
        >
          Primary
        </Badge>
      )}
      {/* Export-selection checkbox: export-eligible only (succeeded, and square for icons),
          top-right, independent of Primary/focus. Its own control so toggling export never
          triggers the focus button. */}
      {exportEligible && (
        <Checkbox
          className={classes.exportCheckbox}
          size="md"
          checked={exportSelected}
          onChange={() => onToggleExport(candidate.id)}
          aria-label={`Select ${identity} for export`}
        />
      )}
      <button
        type="button"
        className={classes.focusButton}
        aria-pressed={focused}
        aria-label={`Inspect ${identity}`}
        onClick={() => onFocus(candidate.id)}
      >
        {ready && url ? (
          <img className={classes.image} src={url} alt={`Generated ${identity}`} />
        ) : terminalLabel ? (
          <span className={`${classes.terminal}${isFailed ? ` ${classes.terminalFailed}` : ""}`}>
            <span className={classes.terminalIcon} aria-hidden>
              {TERMINAL_ICON[candidate.status] ?? "◼"}
            </span>
            <strong>{terminalLabel}</strong>
            {shortFailure && <span>{shortFailure}</span>}
          </span>
        ) : (
          // Queued (static skeleton) vs running (animated skeleton + spinner) read apart
          // without color; a succeeded-but-decoding image also lands here briefly.
          <span className={classes.loadingWrap} aria-hidden>
            <Skeleton height="100%" radius={0} animate={candidate.status !== "queued"} />
            {candidate.status === "running" && <Loader className={classes.loaderOverlay} size="sm" />}
          </span>
        )}
      </button>

      <div className={classes.cardLabel}>
        <Text component="strong" fz="xs" fw={600}>
          Variant {candidate.variant} of {arm.candidates.length}
        </Text>
        {candidate.status !== "succeeded" && (
          <Text c="dimmed" fz="xs">
            {statusLabel(candidate.status)}
          </Text>
        )}
      </div>

      {message && (
        <Text c="dimmed" fz="xs" mt={4} style={{ overflowWrap: "anywhere" }}>
          {message}
        </Text>
      )}
    </Box>
  );
}
