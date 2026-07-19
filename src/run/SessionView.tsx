// The session/results view (nano-banana-2 web/app.js renderSession). Heading/meta line,
// subject, an aria-live progress line, a "Cancel remaining" action, and the results
// layout: a plain CSS grid (contact sheet + sticky inspector) INSIDE AppShell.Main — not
// an AppShell.Aside. Owns the focused-candidate state that the P4 inspector consumes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Group, Stack, Text, Title } from "@mantine/core";

import type { SessionManifest, SessionRepository } from "../core/session";
import { ContactSheet } from "./ContactSheet";
import { ExportTray } from "./ExportTray";
import { InspectorSlot } from "./InspectorSlot";
import { summarizeProgress } from "./queue";
import { formatSize, modelShortLabel } from "./statusCopy";
import classes from "./SessionView.module.css";

export interface SessionViewProps {
  repo: SessionRepository;
  manifest: SessionManifest;
  fatalError?: string;
  // Secondary tab (single-tab guard): results are viewable, but writes (Primary, export recording)
  // are disabled so this tab can't race the primary tab's storage.
  readOnly?: boolean;
  onCancel: () => void;
  // A manifest mutation (Primary selection) fed back into run state so cards + inspector
  // re-render from the single source of truth.
  onManifestChange: (manifest: SessionManifest) => void;
  // "Edit and regenerate": seed the setup form from this session (subject, recipes, palette,
  // settings, and inherited references) to launch a derived run.
  onEditSetup: () => void;
}

function progressText(manifest: SessionManifest): string {
  const p = summarizeProgress(manifest);
  const parts = [`${p.total} total`, `${p.succeeded} succeeded`];
  const rest: Array<[number, string]> = [
    [p.running, "running"],
    [p.queued, "queued"],
    [p.failed, "failed"],
    [p.interrupted, "interrupted"],
    [p.cancelRequested, "cancel requested"],
  ];
  for (const [count, label] of rest) if (count) parts.push(`${count} ${label}`);
  return parts.join(" · ");
}

export function SessionView({
  repo,
  manifest,
  fatalError,
  readOnly,
  onCancel,
  onManifestChange,
  onEditSetup,
}: SessionViewProps) {
  const [focusedCandidateId, setFocusedCandidateId] = useState<string>();
  // Export selection (the tray). Kept SEPARATE from manifest.selectedCandidateId (Primary) and
  // from focusedCandidateId — a candidate can be Primary, focused, and export-selected
  // independently. Reset on a new run.
  const [exportSelectedIds, setExportSelectedIds] = useState<Set<string>>(() => new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A new run resets the focused candidate + export selection and moves focus to the heading
  // (a11y: the form collapsed, so land keyboard focus at the top of the results).
  useEffect(() => {
    setFocusedCandidateId(undefined);
    setExportSelectedIds(new Set());
    headingRef.current?.focus();
  }, [manifest.id]);

  const toggleExport = useCallback((candidateId: string) => {
    setExportSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }, []);

  const clearExport = useCallback(() => setExportSelectedIds(new Set()), []);

  // Only still-succeeded, still-present candidates are exportable — drop any stale ids (a
  // candidate can't leave "succeeded", but this keeps the tray honest across manifest folds).
  const selectedIds = useMemo(() => {
    const succeeded = new Set(
      manifest.arms
        .flatMap((arm) => arm.candidates)
        .filter((candidate) => candidate.status === "succeeded")
        .map((candidate) => candidate.id),
    );
    return [...exportSelectedIds].filter((id) => succeeded.has(id));
  }, [manifest, exportSelectedIds]);

  const { active } = summarizeProgress(manifest);
  const styleCount = manifest.arms.length;

  return (
    <Stack gap="md">
      {/* px="md": the un-carded heading + progress line share the contact sheet's inset
          (SessionView.module.css .sheet) so all session content sits on one left edge;
          cards (ExportTray, the fatal Alert) stay flush per the P10 rule. */}
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md" px="md">
        <Box style={{ minWidth: 0 }}>
          <Title order={2} fz="h3" ref={headingRef} tabIndex={-1} style={{ outline: "none" }}>
            {styleCount} style{styleCount === 1 ? "" : "s"} · {modelShortLabel(manifest.settings.modelId)}{" "}
            · {formatSize(manifest.settings.size)}
          </Title>
          <Text c="dimmed" fz="sm" mt={2} style={{ overflowWrap: "anywhere" }}>
            {manifest.subject}
          </Text>
        </Box>
        {active ? (
          // classes.cancelLive: a subtle shimmer sweep while the run is in flight (same
          // reduced-motion gating as the spend pill) — signals a live, cancelable process.
          <Button
            color="red"
            variant="light"
            size="sm"
            onClick={onCancel}
            className={classes.cancelLive}
            style={{ flex: "none" }}
          >
            Cancel remaining
          </Button>
        ) : (
          // A terminal run (completed / partial / failed / interrupted, or a loaded history
          // item): offer a derived run pre-filled from this session, references included.
          <Button variant="default" size="sm" onClick={onEditSetup} style={{ flex: "none" }}>
            Edit and regenerate
          </Button>
        )}
      </Group>

      <Text role="status" aria-live="polite" fz="sm" fw={500} px="md">
        {progressText(manifest)}
      </Text>

      {fatalError && (
        <Alert color="red" variant="light" title="Run stopped">
          {fatalError}
        </Alert>
      )}

      {/* Above the contact sheet (source renderExportTray placement); appears only with a
          selection. */}
      <ExportTray
        repo={repo}
        manifest={manifest}
        selectedIds={selectedIds}
        readOnly={readOnly}
        onManifestChange={onManifestChange}
        onClear={clearExport}
      />

      <div className={classes.layout}>
        <div className={classes.sheet}>
          <ContactSheet
            repo={repo}
            manifest={manifest}
            focusedCandidateId={focusedCandidateId}
            exportSelectedIds={exportSelectedIds}
            onToggleExport={toggleExport}
            onFocus={setFocusedCandidateId}
          />
        </div>
        <div className={classes.inspector}>
          <InspectorSlot
            repo={repo}
            manifest={manifest}
            focusedCandidateId={focusedCandidateId}
            readOnly={readOnly}
            onManifestChange={onManifestChange}
            onEditSetup={onEditSetup}
          />
        </div>
      </div>
    </Stack>
  );
}
