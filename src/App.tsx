// CSS import order matters: Mantine core first, then component packages that layer
// on top (dropzone, notifications). app.css last so page tokens win.
import "@mantine/core/styles.css";
import "@mantine/dropzone/styles.css";
import "@mantine/notifications/styles.css";
import "./app.css";

import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";

import { ApiKeyProvider } from "./useApiKey";
import { Workbench } from "./Workbench";
import { theme } from "./theme";

export default function App() {
  // defaultColorScheme MUST match public/theme-init.js's default ('auto') and
  // Mantine's localStorage key ('mantine-color-scheme-value'): the pre-paint script
  // sets data-mantine-color-scheme before first paint and this provider re-computes
  // the same value on mount, so there is no flash.
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications />
      <ApiKeyProvider>
        <Workbench />
      </ApiKeyProvider>
    </MantineProvider>
  );
}
