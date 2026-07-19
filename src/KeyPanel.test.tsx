// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gemini from "./core/gemini";
import { KeyStatusPill } from "./KeyPanel";
import { ApiKeyProvider } from "./useApiKey";

function renderPill(node: ReactNode = <KeyStatusPill />) {
  return render(
    <MantineProvider>
      <ApiKeyProvider>{node}</ApiKeyProvider>
    </MantineProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => localStorage.clear());

describe("KeyStatusPill", () => {
  it("renders 'not configured' by default and opens the modal on click", async () => {
    const user = userEvent.setup();
    renderPill();
    expect(screen.getByText("API key not configured")).toBeInTheDocument();

    await user.click(screen.getByText("API key not configured"));
    expect(await screen.findByLabelText("Gemini API key")).toBeInTheDocument();
  });

  it("always shows the real-money warning and the session/Remember choice with honest captions", async () => {
    const user = userEvent.setup();
    renderPill();
    await user.click(screen.getByText("API key not configured"));

    // The charges warning is in the modal body, key or no key, remember or not.
    expect(await screen.findByText("Generating images costs real money")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Billed by Google to your account\. BYOBanana doesn't charge; Google bills generation through your key\./,
      ),
    ).toBeInTheDocument();

    // The persistence choice is a segmented control, defaulting to "This session only"
    // (plaintext storage stays opt-in). The group + caption are programmatically associated.
    const sessionOption = screen.getByRole("radio", { name: "This session only" });
    const rememberOption = screen.getByRole("radio", { name: "Remember" });
    expect(sessionOption).toBeChecked();
    expect(rememberOption).not.toBeChecked();
    const control = screen.getByRole("radiogroup", { name: "How long to keep your API key" });
    expect(control).toHaveAccessibleDescription(
      "Not saved. You'll need to paste it again after reloading or closing this tab.",
    );

    // Choosing Remember flips the caption to the honest plaintext disclosure ("in this browser"
    // + "avoid on shared computers") — plain English, no storage jargon.
    await user.click(rememberOption);
    expect(rememberOption).toBeChecked();
    expect(control).toHaveAccessibleDescription(
      "Saves your key in this browser so you don't have to paste it again. Avoid on shared computers.",
    );
    expect(screen.queryByText(/localStorage/)).not.toBeInTheDocument();
    expect(screen.queryByText(/plaintext/)).not.toBeInTheDocument();
  });

  it("validates a key and flips the pill to 'configured', listing available models in aligned columns", async () => {
    vi.spyOn(gemini, "validateApiKey").mockResolvedValue({
      availableModels: ["gemini-3.1-flash-image"],
    });
    const user = userEvent.setup();
    renderPill();

    await user.click(screen.getByText("API key not configured"));
    await user.type(await screen.findByLabelText("Gemini API key"), "AIza-good");
    await user.click(screen.getByRole("button", { name: /connect \/ validate/i }));

    await waitFor(() => expect(screen.getByText("API key configured")).toBeInTheDocument());
    // Title counts the visible models; the row splits friendly + provider names into columns.
    expect(
      screen.getByText("Key validated — 1 of 3 workbench models available"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nano Banana 2")).toBeInTheDocument();
    expect(screen.getByText("Gemini 3.1 Flash Image")).toBeInTheDocument();
  });

  it("says 'all 3' when every workbench model is visible", async () => {
    vi.spyOn(gemini, "validateApiKey").mockResolvedValue({
      availableModels: ["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image"],
    });
    const user = userEvent.setup();
    renderPill();

    await user.click(screen.getByText("API key not configured"));
    await user.type(await screen.findByLabelText("Gemini API key"), "AIza-good");
    await user.click(screen.getByRole("button", { name: /connect \/ validate/i }));

    expect(
      await screen.findByText("Key validated — all 3 workbench models available"),
    ).toBeInTheDocument();
  });
});
