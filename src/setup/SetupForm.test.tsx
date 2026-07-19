// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The API-key readiness gate is not what these tests exercise — stub it "ready" so the
// Generate button is enabled.
vi.mock("../useApiKey", () => ({ useApiKey: () => ({ ready: true }) }));

import { getColorPalette } from "../core/palettes";
import { loadRecipes, renderRecipe } from "../core/recipes";
import type { CreateSessionInput } from "../core/session";
import type { SetupFormSeed } from "./editSeed";
import { SetupForm } from "./SetupForm";

function renderForm(onSubmit: (input: CreateSessionInput) => void = () => {}) {
  return render(
    <MantineProvider>
      <SetupForm onSubmit={onSubmit} />
    </MantineProvider>,
  );
}

async function switchToImages(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "Images" }));
}

const card = (name: string) => screen.getByRole("checkbox", { name });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SetupForm — recipe rules", () => {
  it("caps selection at 3: unchecked comparison cards disable, Custom stays enabled", async () => {
    const user = userEvent.setup();
    renderForm();
    await switchToImages(user);

    // Image family default is Airy pastel modernist. Add two more comparison styles.
    await user.click(card("Hard-edge geometric screenprint"));
    await user.click(card("Ornamental miniature maximalism"));

    // Three selected → a fourth comparison card is disabled, but Custom is not.
    expect(card("Refined pixel art")).toBeDisabled();
    expect(card("Tenebrist oil realism")).toBeDisabled();
    expect(card("Custom image")).not.toBeDisabled();
    expect(screen.getByText(/3 of 3 style recipes selected/)).toBeInTheDocument();
  });

  it("enforces Custom mutual-exclusion in both directions", async () => {
    const user = userEvent.setup();
    renderForm();
    await switchToImages(user);

    await user.click(card("Hard-edge geometric screenprint")); // now 2 comparables
    await user.click(card("Custom image")); // Custom replaces both
    expect(card("Custom image")).toBeChecked();
    expect(card("Airy pastel modernist")).not.toBeChecked();
    expect(card("Hard-edge geometric screenprint")).not.toBeChecked();

    // Selecting a comparison style clears Custom.
    await user.click(card("Refined pixel art"));
    expect(card("Custom image")).not.toBeChecked();
    expect(card("Refined pixel art")).toBeChecked();
  });

  it("never allows zero recipes — the last one cannot be removed", async () => {
    const user = userEvent.setup();
    renderForm();
    // Image family (the default) opens with one recipe selected; try to uncheck it.
    await user.click(card("Airy pastel modernist"));
    expect(card("Airy pastel modernist")).toBeChecked();
    expect(screen.getByText(/At least one style recipe is required/)).toBeInTheDocument();
  });
});

describe("SetupForm — settings constraints", () => {
  it("unlocks aspect for images (the default) and locks it to 1:1 for icons", async () => {
    const user = userEvent.setup();
    renderForm();
    // Images is the default family: aspect is unlocked.
    expect(screen.getByRole("combobox", { name: "Aspect" })).not.toBeDisabled();

    // Switch to Icons: aspect locks to 1:1.
    await user.click(screen.getByRole("radio", { name: "Icons" }));
    const aspect = screen.getByRole("combobox", { name: "Aspect" });
    expect(aspect).toBeDisabled();
    expect(aspect).toHaveValue("1:1");

    // Back to Images: unlocked again.
    await switchToImages(user);
    expect(screen.getByRole("combobox", { name: "Aspect" })).not.toBeDisabled();
  });

  it("defaults to Lite (1K, search disabled) and repopulates when models change", async () => {
    // Mantine's Combobox dropdown stays display:none in jsdom (no floating layout), so
    // options read as "hidden"; disable the pointer-visibility check and query hidden.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderForm();

    // P8 defaults: Lite model → only 1K, search grounding unsupported (disabled).
    expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveValue("1K");
    expect(screen.getByRole("switch", { name: /Google Search grounding/ })).toBeDisabled();

    // The resolution list offers only 1K (scoped to the Resolution dropdown).
    const resolution = screen.getByRole("combobox", { name: "Resolution" });
    await user.click(resolution);
    const listId = resolution.getAttribute("aria-controls")!;
    const list = document.getElementById(listId)!;
    const options = within(list).getAllByRole("option", { hidden: true });
    expect(options.map((option) => option.textContent)).toEqual(["1K"]);

    // Switch to Flash: search becomes available; pick its 512 resolution.
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /Flash Image$/, hidden: true }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /Google Search grounding/ })).not.toBeDisabled(),
    );
    await user.click(screen.getByRole("combobox", { name: "Resolution" }));
    await user.click(await screen.findByRole("option", { name: "512px", hidden: true }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveValue("512px"),
    );

    // Back to Lite: unsupported 512 auto-repopulates to 1K, and search disables again.
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /Lite/, hidden: true }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveValue("1K"),
    );
    expect(screen.getByRole("switch", { name: /Google Search grounding/ })).toBeDisabled();
  });
});

describe("SetupForm — estimate, gate, and submit", () => {
  it("shows the estimate banner and reveals the confirmation gate over 8 calls", async () => {
    const user = userEvent.setup();
    renderForm();
    await switchToImages(user);
    // 1 default recipe × 2 variants = 2 image generations, no gate. Lite@1K ≈ $0.0336 each,
    // so the headline cost reads in compact cents.
    expect(screen.getByText("2 image generations")).toBeInTheDocument();
    expect(screen.getByText(/≈ 6\.7¢/)).toBeInTheDocument();
    expect(screen.getByText(/1 style × 2 variants · estimate excludes input/)).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /I confirm this run exceeds the safety threshold/ }),
    ).not.toBeInTheDocument();

    // Add two comparison styles and raise variants to 4 → 3 × 4 = 12 calls > 8 → gate appears.
    await user.click(card("Hard-edge geometric screenprint"));
    await user.click(card("Ornamental miniature maximalism"));
    const variants = screen.getByLabelText("Variants per style");
    await user.clear(variants);
    await user.type(variants, "4");
    expect(screen.getByText("12 image generations")).toBeInTheDocument();
    expect(screen.getByText(/3 styles × 4 variants · estimate excludes input/)).toBeInTheDocument();
    expect(
      await screen.findByRole("checkbox", { name: /I confirm this run exceeds the safety threshold/ }),
    ).toBeInTheDocument();
  });

  it("appends '+ extra' to the estimate only while grounding is on (P9)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderForm();

    // Default Lite doesn't support grounding: subtext explains, no "+ extra".
    expect(screen.getByText(/does not support grounding/)).toBeInTheDocument();
    expect(screen.queryByText("+ extra")).not.toBeInTheDocument();

    // Switch to Flash (grounding-capable): the cost subtext appears, still no "+ extra".
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /Flash Image$/, hidden: true }));
    const grounding = screen.getByRole("switch", { name: /Google Search grounding/ });
    await waitFor(() => expect(grounding).not.toBeDisabled());
    expect(screen.getByText("May incur extra costs.")).toBeInTheDocument();
    expect(screen.queryByText("+ extra")).not.toBeInTheDocument();

    // On: "+ extra" joins the estimate headline. Off again: it leaves.
    await user.click(grounding);
    expect(await screen.findByText("+ extra")).toBeInTheDocument();
    await user.click(grounding);
    await waitFor(() => expect(screen.queryByText("+ extra")).not.toBeInTheDocument());
  });

  it("blocks submit until the gate is acknowledged, then emits a correct payload", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    await switchToImages(user);
    await user.click(card("Hard-edge geometric screenprint"));
    await user.click(card("Ornamental miniature maximalism"));
    const variants = screen.getByLabelText("Variants per style");
    await user.clear(variants);
    await user.type(variants, "4");

    await user.type(screen.getByLabelText("Subject prompt"), "a friendly robot");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    // Gate not acknowledged → blocked.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Confirm this run exceeds the safety threshold/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /I confirm this run exceeds the safety threshold/ }));
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const input = onSubmit.mock.calls[0][0] as CreateSessionInput;
    expect(input.subject).toBe("a friendly robot");
    expect(input.settings.callCount).toBe(12);
    expect(input.confirmation).toMatchObject({ required: true, acknowledged: true });
    expect(input.arms).toHaveLength(3);
    expect(input.arms.map((arm) => arm.recipe.id)).toEqual([
      "airy-pastel-modernist",
      "hard-edge-geometric-screenprint",
      "ornamental-miniature-maximalism",
    ]);
    // Arms carry pre-rendered prompts.
    const catalog = loadRecipes();
    const airy = catalog.find((r) => r.id === "airy-pastel-modernist")!;
    const palette = getColorPalette("folio-teal")!;
    expect(input.arms[0].renderedPrompt).toBe(renderRecipe(airy, "a friendly robot", palette));
  });

  it("submits a simple icon run with a 1:1 aspect and no gate", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    // The form opens on Images (default); switch to Icons for this icon-run assertion.
    await user.click(screen.getByRole("radio", { name: "Icons" }));
    await user.type(screen.getByLabelText("Subject prompt"), "a compass");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const input = onSubmit.mock.calls[0][0] as CreateSessionInput;
    expect(input.settings.aspectRatio).toBe("1:1");
    expect(input.settings.callCount).toBe(2);
    // P16 default: 4 parallel requests unless the user changes the setting.
    expect(input.settings.parallelRequests).toBe(4);
    expect(input.confirmation.required).toBe(false);
    expect(input.arms).toHaveLength(1);
    expect(input.arms[0].recipe.id).toBe("geometric-isometric-icon");
  });

  it("surfaces a rejected onSubmit as an inline error", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("Queue is offline"));
    renderForm(onSubmit);
    await user.type(screen.getByLabelText("Subject prompt"), "a compass");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByText("Queue is offline")).toBeInTheDocument();
    // The button is re-enabled after the failure (not stuck loading).
    expect(screen.getByRole("button", { name: "Generate" })).not.toBeDisabled();
  });
});

describe("SetupForm — icon background", () => {
  it("shows the control for icons only and disables it when Custom icon is the selection", async () => {
    const user = userEvent.setup();
    renderForm();

    // Images family (the default): no background control.
    expect(screen.queryByLabelText("Icon background")).not.toBeInTheDocument();

    // Icons with a styled recipe selected: control present, enabled, at the default.
    await user.click(screen.getByRole("radio", { name: "Icons" }));
    const control = screen.getByLabelText("Icon background");
    expect(control).not.toBeDisabled();
    expect(control).toHaveValue("#FAFAFA");
    expect(screen.getByText(/Solid fill behind the icon/)).toBeInTheDocument();

    // Custom icon only: the control stays anchored but disables with a hint.
    await user.click(card("Custom icon"));
    expect(screen.getByLabelText("Icon background")).toBeDisabled();
    expect(screen.getByText("Background not used in Custom mode.")).toBeInTheDocument();

    // Back to a styled recipe: enabled again.
    await user.click(card("Geometric isometric icon"));
    expect(screen.getByLabelText("Icon background")).not.toBeDisabled();

    // Back to Images: gone.
    await switchToImages(user);
    expect(screen.queryByLabelText("Icon background")).not.toBeInTheDocument();
  });

  it("submits the chosen background canonically (lowercase input becomes #RRGGBB)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    await user.click(screen.getByRole("radio", { name: "Icons" }));
    await user.type(screen.getByLabelText("Subject prompt"), "a compass");

    // Default value flows through untouched and lands in the rendered prompt.
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    let input = onSubmit.mock.calls[0][0] as CreateSessionInput;
    expect(input.backgroundColor).toBe("#FAFAFA");
    expect(input.arms[0].renderedPrompt).toContain(
      "First create one continuous solid #FAFAFA field",
    );

    // A typed lowercase hex canonicalizes to uppercase before render + storage.
    const control = screen.getByLabelText("Icon background");
    await user.clear(control);
    await user.type(control, "#18181b");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    input = onSubmit.mock.calls[1][0] as CreateSessionInput;
    expect(input.backgroundColor).toBe("#18181B");
    expect(input.arms[0].renderedPrompt).toContain(
      "First create one continuous solid #18181B field",
    );
  });

  it("blocks a styled icon submit on an invalid color with a field error", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    await user.click(screen.getByRole("radio", { name: "Icons" }));
    await user.type(screen.getByLabelText("Subject prompt"), "a compass");
    const control = screen.getByLabelText("Icon background");
    await user.clear(control);
    await user.type(control, "#12");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByText(/six digit hex color/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    // Selecting Custom icon (which ignores the field) clears the stale error from the
    // now-disabled control.
    await user.click(card("Custom icon"));
    expect(screen.getByLabelText("Icon background")).toBeDisabled();
    expect(screen.queryByText(/six digit hex color/)).not.toBeInTheDocument();
  });

  it("restores a seeded background into the control and the next submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <MantineProvider>
        <SetupForm
          onSubmit={onSubmit}
          seed={{
            token: "seed-1",
            subject: "a compass",
            modelId: "gemini-3.1-flash-lite-image",
            size: "1K",
            aspectRatio: "1:1",
            variants: 2,
            parallel: 4,
            googleSearch: false,
            paletteId: "folio-teal",
            backgroundColor: "#1F2923",
            family: "icon",
            recipeIds: ["cut-paper-icon"],
            references: [],
            derivedFromSessionId: "session-1",
          }}
        />
      </MantineProvider>,
    );
    const control = await screen.findByLabelText("Icon background");
    expect(control).toHaveValue("#1F2923");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const input = onSubmit.mock.calls[0][0] as CreateSessionInput;
    expect(input.backgroundColor).toBe("#1F2923");
    expect(input.derivedFromSessionId).toBe("session-1");
  });
});

describe("SetupForm — aspect memory", () => {
  it("restores the remembered image aspect after a round-trip through a model that drops it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderForm();
    await user.click(screen.getByRole("radio", { name: "Images" }));

    // Default is Lite (standard aspects only) — switch to Flash first.
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /Flash Image$/, hidden: true }));

    // Pick 1:8 — a Flash-only aspect that Lite does not support.
    await user.click(screen.getByRole("combobox", { name: "Aspect" }));
    await user.click(await screen.findByRole("option", { name: "1:8", hidden: true }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Aspect" })).toHaveValue("1:8"));

    // Flash → Lite drops 1:8 back to a supported aspect...
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /Lite/, hidden: true }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Aspect" })).not.toHaveValue("1:8"),
    );

    // ...and Lite → Flash restores the remembered 1:8.
    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /Flash Image$/, hidden: true }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Aspect" })).toHaveValue("1:8"));
  });
});

describe("SetupForm — collapsed settings chips (P8)", () => {
  it("shows live summary chips while collapsed and updates them from form state", async () => {
    const user = userEvent.setup();
    renderForm();
    const bar = screen.getByRole("button", { name: /Reference images and settings/ });

    // Open by default: no chips.
    expect(bar).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("No references")).not.toBeInTheDocument();

    // Collapse: chips summarize the current values (P8 defaults).
    await user.click(bar);
    expect(bar).toHaveAttribute("aria-expanded", "false");
    const chips = screen.getByTestId("settings-chips");
    // P9 friendly model chip: "🍌 NB 2 Lite" (the banana is decorative, aria-hidden).
    expect(within(chips).getByText(/NB 2 Lite/)).toBeInTheDocument();
    expect(within(chips).getByText("1K")).toBeInTheDocument();
    // Image family default: the initial aspect is the image default 1:1 (owner call, P35).
    expect(within(chips).getByText("1:1")).toBeInTheDocument();
    expect(within(chips).getByText("2 variants")).toBeInTheDocument();
    expect(within(chips).getByText("No references")).toBeInTheDocument();

    // Change variants with the section open, re-collapse: the chip tracks the new value.
    await user.click(bar);
    const variants = screen.getByLabelText("Variants per style");
    await user.clear(variants);
    await user.type(variants, "3");
    await user.click(bar);
    expect(within(screen.getByTestId("settings-chips")).getByText("3 variants")).toBeInTheDocument();
  });
});

describe("SetupForm — recipe card selection indicator (P8 jog fix)", () => {
  it("reserves the check badge space on every card, checked or not", () => {
    renderForm();
    const cards = screen.getAllByRole("checkbox");
    // Every card renders the ✓ span (hidden-but-present when unchecked), so toggling a
    // selection can never reflow the text or change the card height.
    for (const cardEl of cards) {
      expect(within(cardEl).getByText("✓")).toBeInTheDocument();
    }
  });
});

// A seed to exercise reconciliation of historical recipe ids against the current catalog.
function iconSeed(recipeIds: string[], over: Partial<SetupFormSeed> = {}): SetupFormSeed {
  return {
    token: `seed-${JSON.stringify(recipeIds)}`,
    subject: "a compass",
    modelId: "gemini-3.1-flash-lite-image",
    size: "1K",
    aspectRatio: "1:1" as const,
    variants: 2,
    parallel: 4,
    googleSearch: false,
    paletteId: "folio-teal",
    backgroundColor: "#FAFAFA",
    family: "icon" as const,
    recipeIds,
    references: [],
    derivedFromSessionId: "session-1",
    ...over,
  };
}

function renderSeeded(recipeIds: string[], over = {}, onSubmit: (input: CreateSessionInput) => void = () => {}) {
  return render(
    <MantineProvider>
      <SetupForm onSubmit={onSubmit} seed={iconSeed(recipeIds, over)} />
    </MantineProvider>,
  );
}

describe("SetupForm — seed reconciliation (renamed and retired recipe ids)", () => {
  it("maps legacy renamed ids onto the current catalog without a notice", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderSeeded(["folio-flat-cut-paper", "folio-geometric-isometric"], {}, onSubmit);

    expect(await screen.findByRole("checkbox", { name: "Cut-paper icon" })).toBeChecked();
    expect(card("Geometric isometric icon")).toBeChecked();
    expect(screen.getByText(/2 of 3 style recipes selected/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be restored/)).not.toBeInTheDocument();

    // Historical order survives into the submitted arms (cut-paper was stored first).
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const input = onSubmit.mock.calls[0][0] as CreateSessionInput;
    expect(input.arms.map((arm) => arm.recipe.id)).toEqual([
      "cut-paper-icon",
      "geometric-isometric-icon",
    ]);
  });

  it("drops a retired id, announces it, and keeps the survivors", async () => {
    renderSeeded(["folio-restrained-screenprint", "folio-geometric-isometric"]);

    expect(await screen.findByRole("checkbox", { name: "Geometric isometric icon" })).toBeChecked();
    expect(card("Cut-paper icon")).not.toBeChecked();
    expect(
      screen.getByText(/A style from this run could not be restored and was left out/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 style recipes selected/)).toBeInTheDocument();
  });

  it("counts a repeated unrestorable id once (singular notice)", async () => {
    renderSeeded([
      "folio-restrained-screenprint",
      "folio-restrained-screenprint",
      "folio-geometric-isometric",
    ]);

    expect(await screen.findByRole("checkbox", { name: "Geometric isometric icon" })).toBeChecked();
    expect(
      screen.getByText(/A style from this run could not be restored and was left out/),
    ).toBeInTheDocument();
  });

  it("drops a wrong-family id with the notice", async () => {
    renderSeeded(["airy-pastel-modernist", "folio-geometric-isometric"]);

    expect(await screen.findByRole("checkbox", { name: "Geometric isometric icon" })).toBeChecked();
    expect(
      screen.getByText(/A style from this run could not be restored and was left out/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 style recipes selected/)).toBeInTheDocument();
  });

  it("falls back to the family default with a notice when nothing survives", async () => {
    renderSeeded(["folio-restrained-screenprint"]);

    expect(await screen.findByRole("checkbox", { name: "Geometric isometric icon" })).toBeChecked();
    expect(
      screen.getByText(/The styles from this run could not be restored\. The current default is selected instead/),
    ).toBeInTheDocument();
  });

  it("keeps the reconciled selection across a family round-trip (no resurrected ids)", async () => {
    const user = userEvent.setup();
    renderSeeded(["folio-flat-cut-paper", "folio-restrained-screenprint"]);

    expect(await screen.findByRole("checkbox", { name: "Cut-paper icon" })).toBeChecked();
    await switchToImages(user);
    await user.click(screen.getByRole("radio", { name: "Icons" }));
    expect(card("Cut-paper icon")).toBeChecked();
    expect(card("Geometric isometric icon")).not.toBeChecked();
    expect(screen.getByText(/1 of 3 style recipes selected/)).toBeInTheDocument();
  });

  it("surfaces an assembly error inline instead of an unhandled rejection", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderSeeded(["folio-geometric-isometric"], { paletteId: "not-a-palette" }, onSubmit);

    await screen.findByRole("checkbox", { name: "Geometric isometric icon" });
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByText("Unknown color palette: not-a-palette")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    // The button recovers (not stuck loading).
    expect(screen.getByRole("button", { name: "Generate" })).not.toBeDisabled();
  });
});
