// Reference-image input: a dropzone plus an ordered, stable-id list with move/remove
// controls. Order is preserved into the request (references lead the prompt parts).
// Files are validated on add by MAGIC BYTES (not the browser's File.type) and against
// the count / per-file / total-size limits in references.ts; rejects are announced via
// a notification. Object URLs back the thumbnails and are revoked on remove + unmount.

import { ActionIcon, Group, Stack, Text } from "@mantine/core";
import { Dropzone, type FileRejection, type FileWithPath } from "@mantine/dropzone";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";

import {
  ACCEPTED_MIME_TYPES,
  addReferences,
  moveReference,
  type IncomingReference,
  type StagedReference,
} from "./references";
import classes from "./SetupForm.module.css";

export interface ReferenceInputProps {
  value: StagedReference[];
  onChange: (next: StagedReference[]) => void;
  // Reports whether a drop is being read/validated, so the parent can block submission
  // until in-flight files are staged (a submit mid-read would silently omit them).
  onBusyChange?: (busy: boolean) => void;
}

async function readHeader(file: FileWithPath): Promise<IncomingReference> {
  // Only the first bytes are needed to sniff the type; slicing avoids reading MBs.
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return { name: file.name, file, bytes };
}

export function ReferenceInput({ value, onChange, onBusyChange }: ReferenceInputProps) {
  const [busy, setBusy] = useState(false);
  // Keep the latest staged list in a ref so (a) the unmount cleanup revokes every URL
  // without re-subscribing the effect, and (b) back-to-back drops validate against the
  // freshest total rather than a stale closure/prop while the first read is in flight.
  const latest = useRef(value);
  latest.current = value;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const reference of latest.current) URL.revokeObjectURL(reference.url);
    };
  }, []);

  // Mirror the read/validate state up so the parent can gate submission on it.
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  function notifyRejected(rejected: { name: string; reason: string }[]) {
    notifications.show({
      color: "red",
      title: `${rejected.length} reference${rejected.length === 1 ? "" : "s"} rejected`,
      message: rejected.map((entry) => `${entry.name}: ${entry.reason}`).join("\n"),
    });
  }

  async function handleDrop(files: FileWithPath[]) {
    setBusy(true);
    try {
      const incoming = await Promise.all(files.map(readHeader));
      // Unmounted mid-read: bail BEFORE addReferences so no object URLs are created after
      // the cleanup already ran (they would leak, unreferenced).
      if (!mounted.current) return;
      const base = latest.current;
      const { accepted, rejected } = addReferences(base, incoming);
      if (accepted.length) {
        const next = [...base, ...accepted];
        latest.current = next; // commit synchronously so a concurrent drop sees it
        onChange(next);
      }
      if (rejected.length) notifyRejected(rejected);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  // Files the browser's MIME filter refused (wrong declared type) never reach onDrop —
  // surface them too so a rejected upload is never silent.
  function handleReject(rejections: FileRejection[]) {
    notifyRejected(
      rejections.map((rejection) => ({
        name: rejection.file.name,
        reason: "Not a PNG, JPEG, WebP, or GIF image.",
      })),
    );
  }

  function remove(id: string) {
    const target = value.find((reference) => reference.id === id);
    if (target) URL.revokeObjectURL(target.url);
    onChange(value.filter((reference) => reference.id !== id));
  }

  function move(index: number, offset: number) {
    onChange(moveReference(value, index, offset));
  }

  return (
    <Stack gap="xs">
      <Text fw={500} fz="sm">
        Reference images
      </Text>
      <Text fz="xs" c="dimmed">
        PNG, JPEG, WebP, or GIF. Order is preserved in the request.
      </Text>
      <Dropzone
        onDrop={handleDrop}
        onReject={handleReject}
        loading={busy}
        accept={ACCEPTED_MIME_TYPES}
        multiple
        role="button"
        aria-label="Upload reference images"
        // The labeled role="button" region IS the control; the internal file input is triggered
        // programmatically and carries tabindex=-1. Hide it from the a11y tree so it is neither
        // an unlabeled form field nor an interactive control nested inside the button.
        inputProps={{ "aria-hidden": true }}
      >
        <Group justify="center" mih={72} style={{ pointerEvents: "none" }}>
          <div>
            <Text fz="sm" fw={500} ta="center">
              Drop images here or click to browse
            </Text>
            <Text fz="xs" c="dimmed" ta="center">
              Up to 14 references, 20 MB each
            </Text>
          </div>
        </Group>
      </Dropzone>

      {value.length > 0 && (
        <Stack gap={6} component="ol" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {value.map((reference, index) => (
            <Group
              key={reference.id}
              component="li"
              gap="sm"
              wrap="nowrap"
              p={6}
              style={{
                border: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
                borderRadius: "var(--mantine-radius-sm)",
              }}
            >
              <img className={classes.thumb} src={reference.url} alt="" />
              <Text fz="sm" style={{ flex: 1, minWidth: 0 }} truncate>
                {index + 1}. {reference.name}
              </Text>
              <Group gap={4} wrap="nowrap">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={`Move ${reference.name} up`}
                >
                  ↑
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={`Move ${reference.name} down`}
                >
                  ↓
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="sm"
                  onClick={() => remove(reference.id)}
                  aria-label={`Remove ${reference.name}`}
                >
                  ✕
                </ActionIcon>
              </Group>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
