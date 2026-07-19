// History rail (nano-banana-2 web/app.js history list + "Clear history"). P17: lives in an
// overlay Drawer opened from the workbench toolbar burger. Each item is a
// NavLink: recipe line + style-count badge + truncated subject + status + localized date; the
// active session is marked aria-current AND carries a non-color-only "Current" badge.
// "Clear history" is a guarded destructive command — disabled when empty, confirmed in a modal,
// and BLOCKED while a run is generating (source's history_busy).
//
// P10: the standalone refresh button was removed (vestigial — ported from the server-polling
// original; the rail already updates from local queue/history state). Its one real use, seeing
// another tab's writes, is now automatic: Workbench re-lists on window focus/visibilitychange and
// on a BroadcastChannel ping posted after every repository write (see core/sessionsChannel.ts).
// Removing the button also reclaims the sliver of width it occupied for entry text.

import { Badge, Box, Button, Group, Modal, NavLink, ScrollArea, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";

import type { SessionSummary } from "../core/session";
import { formatTimestamp, statusLabel } from "./statusCopy";

export interface HistoryRailProps {
  sessions: SessionSummary[];
  currentId?: string;
  // True while a generation run is in flight — clearing is blocked until it finishes.
  busy: boolean;
  // True in a secondary tab (single-tab guard): browsing is fine, but destructive writes that would
  // race the primary tab's storage are disabled.
  readOnly?: boolean;
  onSelect: (id: string) => void;
  onClear: () => void;
  // P17: the rail now lives in a Drawer, and the "Clear history" confirmation is a nested Modal.
  // Reported up so the Drawer can suspend its own Escape/click-outside dismissal while the
  // confirmation is open (otherwise one Escape closes both the Modal AND the Drawer).
  onConfirmOpenChange?: (open: boolean) => void;
}

function itemLabel(session: SessionSummary): string {
  return session.recipes.length > 0 ? session.recipes.join(" + ") : "No styles";
}

export function HistoryRail({ sessions, currentId, busy, readOnly, onSelect, onClear, onConfirmOpenChange }: HistoryRailProps) {
  const [confirmOpen, { open: openConfirm, close: closeConfirm }] = useDisclosure(false, {
    onOpen: () => onConfirmOpenChange?.(true),
    onClose: () => onConfirmOpenChange?.(false),
  });

  const isEmpty = sessions.length === 0;

  function confirmClear() {
    closeConfirm();
    onClear();
  }

  return (
    <>
      <Stack gap="xs" h="100%" style={{ minHeight: 0 }}>
        <Text fz="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: "0.06em" }}>
          History
        </Text>

        {isEmpty ? (
          <Text fz="sm" c="dimmed">
            No workbench sessions yet.
          </Text>
        ) : (
          <ScrollArea type="hover" scrollbars="y" style={{ flex: 1, minHeight: 0 }}>
            {/* P11: no offsetScrollbars — the boolean form unconditionally reserved 12px right
                AND bottom gutters, unbalancing the entries against the navbar's own p="md".
                The hover-only scrollbar now overlays the right edge briefly while scrolling;
                scrollbars="y" keeps a phantom horizontal bar from ever appearing. */}
            <Stack gap={4}>
              {sessions.map((session) => {
                const isActive = session.id === currentId;
                return (
                  <NavLink
                    key={session.id}
                    active={isActive}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => onSelect(session.id)}
                    label={
                      <Group gap={6} wrap="nowrap" justify="space-between">
                        <Text fz="sm" fw={600} truncate style={{ minWidth: 0 }}>
                          {itemLabel(session)}
                        </Text>
                        <Badge
                          variant="light"
                          color="gray"
                          size="sm"
                          radius="sm"
                          style={{ flex: "none" }}
                          aria-label={`${session.recipes.length} style${session.recipes.length === 1 ? "" : "s"} generated`}
                        >
                          {session.recipes.length}
                        </Badge>
                      </Group>
                    }
                    description={
                      <Box>
                        <Text fz="xs" truncate>
                          {session.subject}
                        </Text>
                        <Text fz="xs" c="dimmed">
                          {statusLabel(session.status)} · {formatTimestamp(session.createdAt)}
                          {isActive ? " · Current" : ""}
                        </Text>
                      </Box>
                    }
                  />
                );
              })}
            </Stack>
          </ScrollArea>
        )}

        <Button
          color="red"
          variant="light"
          size="xs"
          disabled={isEmpty || readOnly}
          onClick={openConfirm}
          mt="auto"
        >
          Clear history
        </Button>
        {readOnly && (
          <Text fz="xs" c="dimmed">
            Open in another tab. Editing is disabled here.
          </Text>
        )}
      </Stack>

      <Modal opened={confirmOpen} onClose={closeConfirm} title="Clear history" centered>
        {busy ? (
          <Stack gap="md">
            <Text fz="sm">
              A run is still generating. Wait for it to finish before clearing history.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={closeConfirm}>
                Close
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="md">
            <Text fz="sm">
              This permanently deletes all {sessions.length} stored run
              {sessions.length === 1 ? "" : "s"} and their images from this browser. This cannot be
              undone.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={closeConfirm}>
                Cancel
              </Button>
              <Button color="red" onClick={confirmClear}>
                Clear history
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
