// Key entry + validation modal, and the header key-status pill.
//
// The pill mirrors nano-banana-2's #key-status semantics (is-configured / is-missing),
// non-color-only: each state carries its own icon + label. After the onboarding banner
// dismisses (P8), the pill briefly flashes/shimmers to say key management lives here.

import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { CheckCircle, Coins } from "@phosphor-icons/react";
import { useId } from "react";

import { modelNameParts } from "./run/spendAggregate";
import { useApiKey } from "./useApiKey";
import classes from "./KeyPanel.module.css";

const AI_STUDIO_KEY_URL = "https://aistudio.google.com/apikey";

// The always-visible real-money warning (P8: moved out of the remember toggle — it applies
// whether or not the key is remembered). Shared by the modal and the onboarding banner.
export function ChargesNote() {
  return (
    <Alert
      color="yellow"
      variant="light"
      icon={<Coins size={18} weight="bold" aria-hidden />}
      title="Generating images costs real money"
      // Mantine's light-yellow title color fails AA on the light scheme (~2.7:1); force a
      // scheme-safe deep amber / light yellow instead (see KeyPanel.module.css).
      classNames={{ title: classes.chargesTitle }}
    >
      Billed by Google to your account. BYOBanana doesn't charge; Google bills generation through your key.
    </Alert>
  );
}

// The "This session only / Remember" persistence choice, shared by the modal and the onboarding
// banner so both surfaces carry the same segmented control + honest per-mode caption and drive
// the SAME useApiKey persistence (localStorage under the frozen key) — one behavior, no fork. A
// pure controlled projection of `remember` (no local state): the default "This session only"
// keeps plaintext storage opt-in, and a remembered key that fails boot validation still shows
// "Remember" selected because `remember` remains true.
export function RememberChoice() {
  const { remember, setRemember } = useApiKey();
  const captionId = useId();
  return (
    <Stack gap="xs">
      <SegmentedControl
        fullWidth
        aria-label="How long to keep your API key"
        aria-describedby={captionId}
        value={remember ? "remember" : "session"}
        onChange={(value) => setRemember(value === "remember")}
        data={[
          { value: "session", label: "This session only" },
          { value: "remember", label: "Remember" },
        ]}
      />
      <Text id={captionId} c="dimmed" fz="xs">
        {remember
          ? "Saves your key in this browser so you don't have to paste it again. Avoid on shared computers."
          : "Not saved. You'll need to paste it again after reloading or closing this tab."}
      </Text>
    </Stack>
  );
}

// `flash` (P8): set briefly after the onboarding banner flies away — the pill shimmers/rings
// to hand off key management. Respects reduced motion (ring only, no shimmer sweep).
export function KeyStatusPill({ flash = false }: { flash?: boolean }) {
  const { status } = useApiKey();
  const [opened, { open, close }] = useDisclosure(false);

  const configured = status.state === "valid";
  const label = configured ? "API key configured" : "API key not configured";
  // Non-color-only: a distinct symbol per state, alongside the color + label.
  const symbol = configured ? "✓" : "○";

  return (
    <>
      <Badge
        component="button"
        type="button"
        id="nb-key-pill"
        onClick={open}
        variant="light"
        color={configured ? "workbench" : "gray"}
        radius="xl"
        size="lg"
        style={{ cursor: "pointer" }}
        className={`${classes.keyPill}${flash ? ` ${classes.pillFlash}` : ""}`}
        aria-haspopup="dialog"
        // Redundant with the visible label normally; carries the name alone when the
        // phone-tight header collapses the pill to its symbol (P16). title gives sighted
        // users a hover hint for the bare ✓/○ in that collapsed state.
        aria-label={label}
        title={label}
        leftSection={<span aria-hidden>{symbol}</span>}
      >
        {label}
      </Badge>
      <KeyModal opened={opened} onClose={close} />
    </>
  );
}

// The "Key validated" alert body: CheckCircle title + the visible models as a banana-bulleted
// grid (friendly name column | muted provider name column, aligned across rows).
export function ValidatedModels({ availableModels }: { availableModels: string[] }) {
  const title =
    availableModels.length === 3
      ? "Key validated — all 3 workbench models available"
      : `Key validated — ${availableModels.length} of 3 workbench models available`;
  return (
    <Alert
      color="workbench"
      variant="light"
      icon={<CheckCircle size={18} weight="bold" aria-hidden />}
      title={title}
    >
      {availableModels.length > 0 ? (
        <ul className={classes.modelGrid}>
          {availableModels.map((id) => {
            const { name, detail } = modelNameParts(id);
            return (
              <li key={id}>
                <span className={classes.modelBullet} aria-hidden>
                  🍌
                </span>
                <span>{name}</span>
                <span className={classes.modelDetail}>{detail}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <Text fz="sm">
          The key is valid but none of the 3 workbench image models are visible to it. Check that
          your key has Gemini image access.
        </Text>
      )}
    </Alert>
  );
}

function KeyModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { status, setKey, validate, clear } = useApiKey();
  const key = "key" in status ? status.key : "";
  const validating = status.state === "validating";

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Google API key"
      size="lg"
      centered
      closeButtonProps={{ "aria-label": "Close" }}
    >
      <Stack gap="md">
        <Text fz="sm" c="dimmed">
          Bring your own Google API key. It is held in this browser and sent{" "}
          <strong>directly from your browser to Google</strong> — never to our servers. Get a key at{" "}
          <Anchor href={AI_STUDIO_KEY_URL} target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </Anchor>
          .
        </Text>

        <ChargesNote />

        <PasswordInput
          label="Gemini API key"
          placeholder="AIza…"
          value={key}
          autoComplete="off"
          onChange={(event) => setKey(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !validating) void validate();
          }}
        />

        <RememberChoice />

        {status.state === "valid" && <ValidatedModels availableModels={status.availableModels} />}

        {status.state === "invalid" && (
          <Alert color="red" variant="light" title="Could not validate">
            {status.error}
          </Alert>
        )}

        <Group justify="space-between">
          <Button variant="subtle" color="gray" onClick={clear} disabled={status.state === "empty"}>
            Clear key
          </Button>
          <Button onClick={() => void validate()} loading={validating} disabled={!key}>
            {status.state === "valid" ? "Re-validate" : "Connect / Validate"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
