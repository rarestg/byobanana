// Export tray (nano-banana-2 web/app.js renderExportTray). Appears ONLY when ≥1 candidate is
// export-selected, above the contact sheet. "Download ZIP (N)" builds the bundle in the
// browser (icons get their production PNG generated via image.ts), triggers the download, then
// records each export so manifest.exports reflects it. Download-only — the source's second
// "Export to disk" button is dropped (a static BYOK SPA has no server filesystem).

import { useState } from "react";
import { Button, Group, Paper, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";

import { buildExportBundle, bundleExportInputs, triggerDownload } from "../core/exportBundle";
import type { SessionManifest, SessionRepository } from "../core/session";

export interface ExportTrayProps {
  repo: SessionRepository;
  manifest: SessionManifest;
  selectedIds: string[];
  // Secondary tab (single-tab guard): the ZIP write (recordExport) is disabled to avoid racing.
  readOnly?: boolean;
  onManifestChange: (manifest: SessionManifest) => void;
  onClear: () => void;
}

export function ExportTray({
  repo,
  manifest,
  selectedIds,
  readOnly,
  onManifestChange,
  onClear,
}: ExportTrayProps) {
  const [busy, setBusy] = useState(false);
  const count = selectedIds.length;
  if (count === 0) return null;

  async function download() {
    if (readOnly) return; // secondary tab: never write export records from here
    setBusy(true);
    // Build first (may fail before anything is downloaded).
    let bundle;
    try {
      bundle = await buildExportBundle(repo, manifest, selectedIds);
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Could not build the download",
        message: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
      return;
    }

    // The download is the export; trigger it, THEN record best-effort. A recording failure must
    // not be reported as a failed download — fold whatever recorded and warn separately.
    triggerDownload(new Blob([bundle.zip], { type: "application/zip" }), bundle.filename);
    let latest = manifest;
    let recordError: unknown;
    try {
      for (const input of bundleExportInputs(bundle)) {
        latest = await repo.recordExport(manifest.id, input);
      }
    } catch (error) {
      recordError = error;
    }
    onManifestChange(latest);
    setBusy(false);

    if (recordError) {
      notifications.show({
        color: "yellow",
        title: "Downloaded; history not fully recorded",
        message: recordError instanceof Error ? recordError.message : String(recordError),
      });
    } else {
      notifications.show({
        color: "teal",
        title: "Download ready",
        message: `${bundle.filename} (${bundle.assets.length} item${bundle.assets.length === 1 ? "" : "s"}).`,
      });
    }
  }

  return (
    <Paper p="sm" radius="md" withBorder>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text fz="sm" fw={500}>
          {count} candidate{count === 1 ? "" : "s"} selected for export
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Button variant="subtle" size="sm" onClick={onClear} disabled={busy}>
            Clear
          </Button>
          <Button size="sm" loading={busy} disabled={readOnly} onClick={() => void download()}>
            Download ZIP ({count})
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}
