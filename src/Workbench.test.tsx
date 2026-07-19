// @vitest-environment jsdom
// End-to-end drive-through of the real P3 kickoff in jsdom (no browser available): the
// harness mock gate on (?mock=1, no key), submit the setup form -> it collapses into the run
// summary -> the contact sheet fills with placeholder images -> the progress line reaches
// "succeeded" -> Cancel visibility toggles -> Edit setup restores the form.
import { StrictMode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { render, screen, waitFor, within } from "../test-utils";
import userEvent from "@testing-library/user-event";
import * as gemini from "./core/gemini";
import { InMemorySessionRepository } from "./core/session";
import { ApiKeyProvider, STORAGE_KEY } from "./useApiKey";
import { Workbench } from "./Workbench";

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

beforeEach(() => {
  // No stored key -> the provider gate stays closed; ?mock=1 (the harness gate) enables the
  // mock runner. Reset both between tests — the banner tests use a clean URL.
  localStorage.clear();
  window.history.replaceState({}, "", "/?mock=1");
});

// Inject an in-memory repository so the drive-through avoids IndexedDB (fake-indexeddb can't
// round-trip jsdom Blobs); the async-boot path (open + first listSessions) is still exercised.
function renderWorkbench() {
  return render(
    <ApiKeyProvider>
      <Workbench repository={new InMemorySessionRepository()} />
    </ApiKeyProvider>,
  );
}

describe("Workbench — boot", () => {
  it("finishes async boot under StrictMode double-init (no stuck loading state)", async () => {
    // StrictMode mounts, unmounts, remounts the effect. A discarded first run must not strand the
    // loading state — the surviving run has to open the repo and render the form.
    render(
      <StrictMode>
        <ApiKeyProvider>
          <Workbench repository={new InMemorySessionRepository()} />
        </ApiKeyProvider>
      </StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: "Set up a run" })).toBeInTheDocument();
  });
});

describe("Workbench — mock run drive-through", () => {
  it("submits, collapses to a run summary, fills the contact sheet, and toggles Cancel", async () => {
    const user = userEvent.setup();
    renderWorkbench();

    // Setup form is visible once the async boot completes; mock mode defaults on (no key).
    expect(await screen.findByRole("heading", { name: "Set up a run" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Subject prompt"), "A local transcript search tool.");

    await user.click(screen.getByRole("button", { name: "Generate" }));

    // The form collapses into the run summary and the results view appears.
    await screen.findByRole("button", { name: "Edit setup" });
    expect(screen.queryByRole("heading", { name: "Set up a run" })).not.toBeInTheDocument();

    // Progress line (role=status) starts at 2 total (image default: 1 style × 2 variants).
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("2 total");
    // While work remains, Cancel remaining is offered.
    expect(screen.getByRole("button", { name: "Cancel remaining" })).toBeInTheDocument();

    // The mock run completes: every candidate succeeds and shows its placeholder image.
    await waitFor(
      () => expect(status).toHaveTextContent("2 succeeded"),
      { timeout: 4000 },
    );
    const images = await screen.findAllByAltText(/Generated /);
    expect(images).toHaveLength(2);
    // Cancel disappears once nothing is queued/running.
    expect(screen.queryByRole("button", { name: "Cancel remaining" })).not.toBeInTheDocument();

    // Edit setup restores the (still-mounted) form.
    await user.click(screen.getByRole("button", { name: "Edit setup" }));
    expect(screen.getByRole("heading", { name: "Set up a run" })).toBeInTheDocument();
  });

  it("focuses a candidate into the inspector slot on click", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    await screen.findByLabelText("Subject prompt");
    await user.type(screen.getByLabelText("Subject prompt"), "A subject brief.");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    const images = await screen.findAllByAltText(/Generated /, {}, { timeout: 4000 });
    expect(images.length).toBeGreaterThan(0);
    // Inspector starts empty.
    expect(screen.getByText("Select a candidate to inspect it.")).toBeInTheDocument();

    // Click the first candidate card -> it focuses into the inspector slot.
    const firstButton = screen.getAllByRole("button", { name: /Inspect / })[0];
    await user.click(firstButton);
    expect(firstButton).toHaveAttribute("aria-pressed", "true");
    // The empty hint is gone and the inspector's identity path + facts appear.
    expect(screen.queryByText("Select a candidate to inspect it.")).not.toBeInTheDocument();
    const identity = screen.getByLabelText("Candidate identity");
    expect(within(identity).getByText("A subject brief.")).toBeInTheDocument();
  });

  it("sets a focused succeeded candidate as Primary and shows the badge on its card", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    await screen.findByLabelText("Subject prompt");
    await user.type(screen.getByLabelText("Subject prompt"), "A subject brief.");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await screen.findAllByAltText(/Generated /, {}, { timeout: 4000 });
    // Nothing focused yet -> the inspector is empty, so no "Primary" text anywhere.
    expect(screen.queryByText("Primary")).not.toBeInTheDocument();

    // Focus the first candidate: the inspector opens with the Set-as-Primary button but no
    // "Primary" text yet (P34 removed the section heading; the badges only appear once set).
    const firstCard = screen.getAllByRole("button", { name: /Inspect / })[0];
    await user.click(firstCard);
    await screen.findByRole("button", { name: "Set as Primary" });
    expect(screen.queryAllByText("Primary")).toHaveLength(0); // heading removed; no badge yet

    // Deliberately Set as Primary: the card badge + inspector badge appear (2 badges), and
    // the inspector swaps to Clear Primary — all from the one run-state manifest
    // (selectedCandidateId).
    await user.click(screen.getByRole("button", { name: "Set as Primary" }));
    await screen.findByRole("button", { name: "Clear Primary" });
    expect(screen.getAllByText("Primary")).toHaveLength(2);

    // Clearing removes both badges again.
    await user.click(screen.getByRole("button", { name: "Clear Primary" }));
    await screen.findByRole("button", { name: "Set as Primary" });
    expect(screen.queryAllByText("Primary")).toHaveLength(0);
  });

  it("adds the completed run to the history rail and updates the spend pill", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    await screen.findByLabelText("Subject prompt");
    // Spend pill starts in the unknown state (no stored runs yet) — P25: the micro-label
    // plus the "$ -.--" dash board (no animated digit cells, no popover button).
    const placeholder = document.querySelector("[data-spend-pill]") as HTMLElement;
    expect(placeholder).toHaveTextContent("Total spend");
    expect(placeholder).toHaveAttribute("aria-label", "Total spend: none recorded yet");
    expect(placeholder.querySelectorAll("[data-digit]")).toHaveLength(0);

    await user.type(screen.getByLabelText("Subject prompt"), "A history subject.");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    // Re-query inside the waitFor: three live regions carry role="status" (the recipe
    // picker's, the setup form's, and the run progress line). Capturing one synchronously
    // here binds to whichever the setup form still has mounted, because the switch to the
    // results view has not happened yet — then the assertion waits out its timeout on an
    // element that will never say "2 succeeded".
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 succeeded"), {
      timeout: 4000,
    });

    // The spend pill now shows a real aggregated amount (never "—" once a run has spent):
    // the dollars live in the button's accessible name; the board cells carry the digits.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Total spend: \$\d/ })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(document.querySelectorAll("[data-digit]").length).toBeGreaterThanOrEqual(3),
    );

    // The run appears in the history rail. It now lives in an overlay Drawer (P17), so open it
    // (the burger label carries the count) before asserting its recipe line + subject.
    await user.click(screen.getByRole("button", { name: /^History/ }));
    const navbar = await screen.findByRole("navigation", { name: "Run history" });
    await waitFor(() => expect(within(navbar).getByText("A history subject.")).toBeInTheDocument());
    expect(within(navbar).getByText("Airy pastel modernist")).toBeInTheDocument();
  });

  it("shows a stored-run count bubble on the history burger", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    await screen.findByLabelText("Subject prompt");
    // No stored runs: no bubble, plain label.
    expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Subject prompt"), "A bubble subject.");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 succeeded"), {
      timeout: 4000,
    });

    // One stored run: the burger label carries the count and the bubble shows it.
    const burger = await screen.findByRole("button", { name: "History, 1 run" });
    expect(within(burger.parentElement as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  it("keeps busy=true until the coalesced history refresh drains after the queue idles", async () => {
    // P12 race (Codex find): the run-completion path must await the refresh DRAIN —
    // including any trailing re-list requested while one was in flight — before clearing
    // `busy`, or the spend pill settles/announces a stale partial total. Gate every
    // listSessions call after boot behind manual resolvers to hold the drain open.
    const gated: Array<() => void> = [];
    let gateOn = false;
    class GatedRepository extends InMemorySessionRepository {
      async listSessions() {
        const result = await super.listSessions();
        if (gateOn) await new Promise<void>((resolve) => gated.push(resolve));
        return result;
      }
    }
    const user = userEvent.setup();
    render(
      <ApiKeyProvider>
        <Workbench repository={new GatedRepository()} />
      </ApiKeyProvider>,
    );
    await screen.findByLabelText("Subject prompt");
    await user.type(screen.getByLabelText("Subject prompt"), "A race subject.");
    gateOn = true; // every refresh from here on blocks until released
    await user.click(screen.getByRole("button", { name: "Generate" }));

    // The queue finishes all candidates (progress comes from onUpdate manifests, not
    // listSessions) while at least one coalesced refresh is still gated.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 succeeded"), {
      timeout: 4000,
    });
    await waitFor(() => expect(gated.length).toBeGreaterThan(0));
    // Busy must be held: the refresh drain has not completed. Give the (wrong) unbusy
    // path ample opportunity to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(document.querySelector('[data-spend-pill][data-live="true"]')).not.toBeNull();

    // Release the gate (and any trailing re-lists the drain loop issues).
    gateOn = false;
    while (gated.length > 0) {
      gated.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Only now may busy fall — and the pill's settle target is the final aggregate.
    await waitFor(() => expect(document.querySelector('[data-live="true"]')).toBeNull());
    expect(screen.getByRole("button", { name: /Total spend: \$\d/ })).toBeInTheDocument();
  });

  it("Edit and regenerate re-seeds the form from the run, overriding in-progress edits", async () => {
    const user = userEvent.setup();
    renderWorkbench();
    await screen.findByLabelText("Subject prompt");
    await user.type(screen.getByLabelText("Subject prompt"), "Alpha subject");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 succeeded"), { timeout: 4000 });

    // Reopen the form and make an unsubmitted edit.
    await user.click(screen.getByRole("button", { name: "Edit setup" }));
    const subject = screen.getByLabelText("Subject prompt");
    await user.clear(subject);
    await user.type(subject, "Beta edited");
    expect(subject).toHaveValue("Beta edited");

    // "Edit and regenerate" (from the terminal run) seeds the form from the session, resetting
    // the subject back to the run's — proving the seed is applied over the in-progress edit.
    await user.click(screen.getByRole("button", { name: "Edit and regenerate" }));
    await waitFor(() => expect(screen.getByLabelText("Subject prompt")).toHaveValue("Alpha subject"));
  });
});

describe("Workbench — API-key onboarding banner", () => {
  it("shows the banner with an inert setup form when no key is configured (no mock param)", async () => {
    window.history.replaceState({}, "", "/");
    renderWorkbench();
    await screen.findByText("First things first");
    expect(screen.getByLabelText("Google API key")).toBeInTheDocument();
    // The setup form renders but is window-shopping only: its wrapper is inert.
    const heading = await screen.findByRole("heading", { name: "Set up a run" });
    expect(heading.closest("[inert]")).not.toBeNull();
  });

  it("?mock=0 does not enable the harness gate — the banner still shows", async () => {
    window.history.replaceState({}, "", "/?mock=0");
    renderWorkbench();
    expect(await screen.findByText("First things first")).toBeInTheDocument();
  });

  it("?mock=1 suppresses the banner and enables Generate without a key", async () => {
    renderWorkbench(); // beforeEach set /?mock=1
    await screen.findByRole("heading", { name: "Set up a run" });
    expect(screen.queryByText("First things first")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate" })).not.toBeDisabled();
  });

  it("dismisses on successful validation, un-inerts the form, and flashes the pill", async () => {
    window.history.replaceState({}, "", "/");
    vi.spyOn(gemini, "validateApiKey").mockResolvedValue({
      availableModels: ["gemini-3.1-flash-lite-image"],
    });
    const user = userEvent.setup();
    renderWorkbench();

    await screen.findByText("First things first");
    // Default persistence is "This session only" (remember stays off), so connecting won't persist.
    expect(screen.getByRole("radio", { name: "This session only" })).toBeChecked();
    await user.type(screen.getByLabelText("Google API key"), "AIza-banner");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    // The banner flies away and unmounts (fly 430ms + collapse 240ms).
    await waitFor(
      () => expect(screen.queryByText("First things first")).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
    // The pill reflects the configured key and briefly carries the flash treatment.
    const pill = document.getElementById("nb-key-pill")!;
    expect(pill).toHaveTextContent("API key configured");
    expect(pill.className).toMatch(/pillFlash/);
    // The form is interactive again (no inert ancestor) and Generate is enabled.
    const heading = screen.getByRole("heading", { name: "Set up a run" });
    expect(heading.closest("[inert]")).toBeNull();
    expect(screen.getByRole("button", { name: "Generate" })).not.toBeDisabled();
    // Remember defaults OFF: connecting from the banner must not persist the key.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("remember ON in the banner persists the key exactly like the modal flow", async () => {
    window.history.replaceState({}, "", "/");
    vi.spyOn(gemini, "validateApiKey").mockResolvedValue({
      availableModels: ["gemini-3.1-flash-lite-image"],
    });
    const user = userEvent.setup();
    renderWorkbench();

    await screen.findByText("First things first");
    // The banner carries the shared session/Remember choice (same control + captions as the
    // modal), defaulting to "This session only". Pick Remember before connecting.
    const rememberOption = screen.getByRole("radio", { name: "Remember" });
    expect(rememberOption).not.toBeChecked();
    await user.click(rememberOption);
    await user.type(screen.getByLabelText("Google API key"), "AIza-banner-remember");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(
      () => expect(screen.queryByText("First things first")).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
    // Persisted under the frozen localStorage key via the SAME useApiKey path as the modal.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("AIza-banner-remember");
  });

  it("stays hidden on reload with a remembered key that auto-validates", async () => {
    window.history.replaceState({}, "", "/");
    localStorage.setItem("nano-banana-web:gemini-key", "AIza-stored");
    vi.spyOn(gemini, "validateApiKey").mockResolvedValue({
      availableModels: ["gemini-3.1-flash-lite-image"],
    });
    renderWorkbench();

    await screen.findByRole("heading", { name: "Set up a run" });
    expect(screen.queryByText("First things first")).not.toBeInTheDocument();
    // Auto-validation lands: Generate unlocks without any banner or modal round-trip.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate" })).not.toBeDisabled(),
    );
    expect(screen.queryByText("First things first")).not.toBeInTheDocument();
  });

  it("?mock=1 never bills: even with a valid remembered key the mock runner is used", async () => {
    // URL is /?mock=1 from beforeEach; a remembered key auto-validates successfully.
    localStorage.setItem("nano-banana-web:gemini-key", "AIza-valid");
    vi.spyOn(gemini, "validateApiKey").mockResolvedValue({
      availableModels: ["gemini-3.1-flash-lite-image"],
    });
    const generateSpy = vi.spyOn(gemini, "generateImage");
    const user = userEvent.setup();
    renderWorkbench();

    await screen.findByLabelText("Subject prompt");
    // Wait for the auto-validation to land so the "valid key" path is genuinely armed.
    await waitFor(() => expect(screen.getByText("API key configured")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Subject prompt"), "Never bill in mock.");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 succeeded"), {
      timeout: 4000,
    });
    // The provider was never called — the mock gate wins over the validated key.
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("re-shows the banner when the remembered key fails its boot validation", async () => {
    window.history.replaceState({}, "", "/");
    localStorage.setItem("nano-banana-web:gemini-key", "AIza-bad");
    vi.spyOn(gemini, "validateApiKey").mockRejectedValue(
      new gemini.GeminiFatalError("Invalid or unauthorized API key."),
    );
    renderWorkbench();

    expect(await screen.findByText("First things first")).toBeInTheDocument();
    expect(screen.getByText("Invalid or unauthorized API key.")).toBeInTheDocument();
    // Controlled projection: a remembered key that fails boot validation keeps remember=true, so
    // the re-shown banner shows "Remember" selected (the choice is never reset on remount).
    expect(screen.getByRole("radio", { name: "Remember" })).toBeChecked();
  });
});
