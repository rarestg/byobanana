import { MantineProvider } from "@mantine/core";
import { render as testingLibraryRender } from "@testing-library/react";

import { theme } from "../src/theme";

// Mantine-provider RTL wrapper for component tests (ported from lease-pdf).
export function render(ui: React.ReactNode) {
  return testingLibraryRender(ui, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <MantineProvider theme={theme} env="test">
        {children}
      </MantineProvider>
    ),
  });
}
