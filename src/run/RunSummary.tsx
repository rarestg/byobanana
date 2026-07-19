// Collapsed run summary shown in place of the setup form once a run starts (nano-banana-2
// web/app.js updateRunSummary / #run-summary). Compact, read-only. P11 styling: the subject
// leads as the run's identity (quoted, medium weight, clamped), the styles line sits under it,
// and the settings render as chips reusing the SetupForm settings-bar vocabulary
// ("🍌 NB 2 Lite" · "1K" · "16:9" · "2 per style"). "Edit setup" restores the (still-mounted)
// form; full "Edit and regenerate" reference-inheritance is P6.

import { Badge, Button, Group, Paper, Stack, Text } from "@mantine/core";

import type { SessionManifest } from "../core/session";
import { MODEL_CHIP_LABELS } from "../setup/SetupForm";
import { formatSize } from "./statusCopy";

export interface RunSummaryProps {
  manifest: SessionManifest;
  onEdit: () => void;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="light" color="gray" radius="sm" size="sm" tt="none">
      {children}
    </Badge>
  );
}

export function RunSummary({ manifest, onEdit }: RunSummaryProps) {
  const styles = manifest.arms.map((arm) => arm.recipe.name).join(" + ");
  const { settings } = manifest;

  return (
    <Paper maw={880} mx="auto" p="md" radius="lg" withBorder>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Text fw={600} lineClamp={2} style={{ overflowWrap: "anywhere" }}>
            “{manifest.subject}”
          </Text>
          <Text c="dimmed" fz="sm" style={{ overflowWrap: "anywhere" }}>
            {styles || "No styles"}
          </Text>
          <Group gap={6} wrap="wrap" data-testid="run-summary-chips">
            <Chip>
              <span aria-hidden>🍌 </span>
              {MODEL_CHIP_LABELS[settings.modelId] ?? settings.modelId}
            </Chip>
            <Chip>{formatSize(settings.size)}</Chip>
            <Chip>{settings.aspectRatio || "default"}</Chip>
            <Chip>{settings.variantsPerRecipe} per style</Chip>
          </Group>
        </Stack>
        <Button variant="default" size="sm" onClick={onEdit} style={{ flex: "none" }}>
          Edit setup
        </Button>
      </Group>
    </Paper>
  );
}
