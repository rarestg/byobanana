// API-key onboarding banner (P8) — the first-run headline. Shown at the top of the
// workspace while no valid key is configured; the setup form below renders inert so new
// users can window-shop recipes but not interact. Two-column card: the left column carries
// the heading, the free/Google-bills lede, and a bottom-pinned footer (key stays local +
// a link to create one); the right column carries the key input, the shared session/Remember
// choice (KeyPanel's RememberChoice, so always-remember users never have to open the modal),
// and Connect. Grid children are flat and in DOM/tab order intro -> form -> footer, so the key
// input precedes the footer link; grid areas place the footer bottom-left visually. Once
// validated, Workbench flies this banner toward the pill and flashes it (key management lives
// there from then on).

import { Anchor, Button, Paper, PasswordInput, Stack, Text, Title } from "@mantine/core";

import { RememberChoice } from "./KeyPanel";
import { useApiKey } from "./useApiKey";
import classes from "./OnboardingBanner.module.css";

const AI_STUDIO_KEY_URL = "https://aistudio.google.com/apikey";

export interface OnboardingBannerProps {
  // True while the banner is animating toward the pill (key just validated).
  dismissing: boolean;
}

export function OnboardingBanner({ dismissing }: OnboardingBannerProps) {
  const { status, setKey, validate } = useApiKey();
  const key = "key" in status ? status.key : "";
  const validating = status.state === "validating";

  return (
    <Paper
      maw={880}
      mx="auto"
      w="100%"
      p="lg"
      radius="lg"
      withBorder
      className={`${classes.banner}${dismissing ? ` ${classes.flying}` : ""}`}
      aria-label="Set up your API key"
    >
      <div className={classes.grid}>
        <Stack gap="xs" className={classes.intro}>
          <Title order={2} fz="h4">
            <span aria-hidden>🍌 </span>First things first
          </Title>
          <Text fz="sm">
            Paste a Google API key to use the workbench. This tool is free, but Google bills
            usage through your key.
          </Text>
        </Stack>

        <Stack gap="sm" className={classes.form}>
          <PasswordInput
            id="nb-onboarding-key"
            label="Google API key"
            placeholder="AIza…"
            classNames={{ label: classes.keyLabel }}
            value={key}
            autoComplete="off"
            onChange={(event) => setKey(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !validating && key) void validate();
            }}
          />

          <RememberChoice />

          {status.state === "invalid" && (
            <Text c="red" fz="sm" role="alert">
              {status.error}
            </Text>
          )}

          <Button fullWidth onClick={() => void validate()} loading={validating} disabled={!key}>
            Connect
          </Button>
        </Stack>

        <Text className={classes.footer} fz="xs" c="dimmed">
          Your key stays in this browser and goes only to Google. No key yet?{" "}
          {/* underline=always: inside a text block the link must not rely on color alone. */}
          <Anchor href={AI_STUDIO_KEY_URL} target="_blank" rel="noreferrer" fz="xs" underline="always">
            Create one in a minute
          </Anchor>
        </Text>
      </div>
    </Paper>
  );
}
