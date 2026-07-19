// The setup form — where a generation run is assembled: output family, style recipes,
// subject, palette, references, model settings, and a live cost estimate + confirmation
// gate. Faithful to nano-banana-2's web/index.html + app.js, rebuilt on Mantine.
//
// State split (the Ponytail line between uncontrolled form and controlled state):
//   • useForm (uncontrolled) owns the SCALAR fields — subject, modelId, size,
//     aspectRatio, variants, googleSearch, paletteId — each input keyed with
//     form.key(). onValuesChange mirrors the values into `snapshot` so the reactive
//     bits (Select option lists, disabled states, the estimate) can render; the
//     uncontrolled form itself does not re-render on field change.
//   • React state owns what needs imperative rules or drives structure: `family`
//     (rebuilds the recipe list + locks aspect), `recipeIds` (max-3 + Custom
//     exclusion), `references`, and the confirmation `acknowledged` flag.
// Reconciliation that the source did with change listeners is done here by wrapping the
// model/aspect/family onChange handlers (repopulate sizes/aspects, lock icon→1:1,
// reset per-family recipe selections), never inside onValuesChange (no setFieldValue
// re-entrancy).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Collapse,
  ColorInput,
  Divider,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { CaretDown, Coins, GoogleChromeLogo, SlidersHorizontal } from "@phosphor-icons/react";

import { confirmationReasons, estimateSessionCost } from "../core/cost";
import { formatApproxCost } from "../core/formatCost";
import {
  FLASH_MODEL_ID,
  LITE_MODEL_ID,
  PRO_MODEL_ID,
  getModelCapability,
  MODEL_CAPABILITIES,
  validateKnownModelSettings,
  type AspectRatio,
  type ImageSize,
} from "../core/models";
import { DEFAULT_PALETTE_ID } from "../core/palettes";
import { DEFAULT_ICON_BACKGROUND, loadRecipes, recipeFamily, type Recipe } from "../core/recipes";
import type { CreateSessionInput } from "../core/session";
import { useApiKey } from "../useApiKey";
import { buildSessionInput } from "./buildSessionInput";
import type { SetupFormSeed } from "./editSeed";
import { PalettePicker } from "./PalettePicker";
import { RecipePicker } from "./RecipePicker";
import { ReferenceInput } from "./ReferenceInput";
import type { StagedReference } from "./references";
import classes from "./SetupForm.module.css";

// Bootstrap defaults. The form opens on the Images family (owner default); the icon
// family is one toggle away. DEFAULT_RECIPES_BY_FAMILY[DEFAULT_FAMILY] follows automatically.
const DEFAULT_FAMILY: "image" | "icon" = "image";
const DEFAULT_RECIPES_BY_FAMILY: Record<"image" | "icon", string[]> = {
  icon: ["geometric-isometric-icon"],
  image: ["airy-pastel-modernist"],
};
const DEFAULT_IMAGE_ASPECT: AspectRatio = "1:1";

// Renamed recipe ids, historical -> current. Compatibility-only lookup keys for stored
// manifests (never emitted, never catalog aliases): "Edit and regenerate" seeds copy ids
// out of old sessions verbatim, and these two styles were renamed in the icon overhaul.
const LEGACY_RECIPE_IDS: Record<string, string> = {
  "folio-flat-cut-paper": "cut-paper-icon",
  "folio-geometric-isometric": "geometric-isometric-icon",
};

// Reconcile a seed's stored recipe ids against the current catalog: map renamed ids,
// dedupe (first occurrence wins, historical order preserved — display-order normalization
// applies only to interactive changes), and drop ids the catalog no longer carries for
// this family (retired styles, unknowns). The notice feeds the recipe live region.
// resolveRecipes stays strict: it validates current form state, not history.
function reconcileSeedRecipeIds(
  seedIds: string[],
  family: "image" | "icon",
  catalog: Recipe[],
): { ids: string[]; notice: string } {
  const current = new Map(catalog.map((recipe) => [recipe.id, recipe]));
  const seen = new Set<string>();
  const ids: string[] = [];
  let dropped = 0;
  for (const raw of seedIds) {
    const id = LEGACY_RECIPE_IDS[raw] ?? raw;
    // Dedupe before classification so a repeated unrestorable id counts once.
    if (seen.has(id)) continue;
    seen.add(id);
    const recipe = current.get(id);
    if (!recipe || recipeFamily(recipe) !== family) {
      dropped += 1;
      continue;
    }
    ids.push(id);
  }
  // "Could not be restored" stays honest for both drop reasons: a retired style is gone,
  // while a wrong-family style still exists but cannot join this run.
  if (ids.length === 0) {
    return {
      ids: DEFAULT_RECIPES_BY_FAMILY[family],
      notice: dropped
        ? "The styles from this run could not be restored. The current default is selected instead."
        : "",
    };
  }
  return {
    ids,
    notice: dropped
      ? dropped === 1
        ? "A style from this run could not be restored and was left out."
        : "Some styles from this run could not be restored and were left out."
      : "",
  };
}

// Icon background swatches: three light and three dark anchor tones drawn from the
// bundled palettes' neutral endpoints. An explicit user choice — the control never
// follows the app color scheme.
const ICON_BACKGROUND_SWATCHES = [
  "#FAFAFA",
  "#FFFDF7",
  "#FAFAF5",
  "#18181B",
  "#1C1917",
  "#1F2923",
];

interface FormValues {
  subject: string;
  modelId: string;
  size: ImageSize;
  aspectRatio: AspectRatio;
  variants: number;
  parallel: number;
  googleSearch: boolean;
  paletteId: string;
  backgroundColor: string;
}

// P8 defaults: the cheapest model (Lite — which only offers 1K) and 2 variants, so the
// out-of-the-box run is a light-touch spend. The initial aspect is the image default
// (DEFAULT_IMAGE_ASPECT, square per owner call in P35), in lock-step with the remembered
// image aspect a family switch would restore; a manual aspect choice stays sticky.
const INITIAL_VALUES: FormValues = {
  subject: "",
  modelId: LITE_MODEL_ID,
  size: "1K",
  aspectRatio: DEFAULT_IMAGE_ASPECT,
  variants: 2,
  parallel: 4,
  googleSearch: false,
  paletteId: DEFAULT_PALETTE_ID,
  backgroundColor: DEFAULT_ICON_BACKGROUND,
};

function formatSize(size: string): string {
  return /^\d+$/.test(size) ? `${size}px` : size;
}

// Friendly short model names for the collapsed-settings summary chips (a decorative 🍌
// prefixes them in the chip, hidden from AT). Exported: RunSummary (P11) reuses the same
// chip vocabulary for the collapsed run card.
export const MODEL_CHIP_LABELS: Record<string, string> = {
  [FLASH_MODEL_ID]: "NB 2",
  [LITE_MODEL_ID]: "NB 2 Lite",
  [PRO_MODEL_ID]: "NB Pro",
};

// Pick a valid size for a model when the current one is unsupported: prefer the source
// default (512), then 1K, else the model's first size.
function preferredSize(sizes: ImageSize[]): ImageSize {
  return sizes.includes("512") ? "512" : sizes.includes("1K") ? "1K" : sizes[0];
}

export interface SetupFormProps {
  // The P3 seam: assemble a CreateSessionInput and hand it off. P2 wired this to a stub
  // (InMemorySessionRepository) in Workbench; P3 replaces it with the real queue kickoff.
  onSubmit: (input: CreateSessionInput) => void | Promise<void>;
  // Harness-only mock gate (?mock=1 in Workbench): lets a run start with NO validated key.
  // It enables Generate and relaxes the readiness hint; runner selection happens in Workbench.
  mockMode?: boolean;
  // "Edit and regenerate": pre-fill the whole form from a prior session (subject, recipes,
  // palette, settings, AND inherited references). Applied once per distinct `seed.token`.
  seed?: SetupFormSeed;
  // Called after a seed is applied so the parent can drop its (potentially large) reference
  // Files — the form now owns them in its own references state.
  onSeedApplied?: () => void;
  // When set (e.g. this is a secondary tab), generation is disabled and the reason is shown.
  generationDisabledReason?: string;
}

export function SetupForm({
  onSubmit,
  mockMode = false,
  seed,
  onSeedApplied,
  generationDisabledReason,
}: SetupFormProps) {
  const { ready } = useApiKey();
  const canGenerate = (ready || mockMode) && !generationDisabledReason;
  const catalog = useMemo(() => loadRecipes(), []);

  const [family, setFamily] = useState<"image" | "icon">(DEFAULT_FAMILY);
  const [recipeIds, setRecipeIds] = useState<string[]>(DEFAULT_RECIPES_BY_FAMILY[DEFAULT_FAMILY]);
  const [references, setReferences] = useState<StagedReference[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [recipeFeedback, setRecipeFeedback] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refsBusy, setRefsBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<FormValues>(INITIAL_VALUES);
  const [settingsOpened, { toggle: toggleSettings }] = useDisclosure(true);

  // Remembered per-family recipe selection + the last image aspect, so toggling family
  // restores prior choices (source state.recipeSelections / state.imageAspectRatio).
  const recipeSelections = useRef({ ...DEFAULT_RECIPES_BY_FAMILY });
  const imageAspect = useRef<AspectRatio>(DEFAULT_IMAGE_ASPECT);
  const recipeSectionRef = useRef<HTMLDivElement>(null);
  const ackRef = useRef<HTMLInputElement>(null);
  // Latest references kept in a ref so the seed effect can revoke the outgoing set's object
  // URLs without depending on `references` (which would re-run the effect on every add/remove).
  const referencesRef = useRef(references);
  referencesRef.current = references;
  // The immediate parent session for a derived run (source derivedFromSessionId), set when a
  // seed is applied and cleared one-shot after the next successful submit.
  const derivedFrom = useRef<string | undefined>(undefined);
  const appliedSeedToken = useRef<string | undefined>(undefined);

  const form = useForm<FormValues>({
    mode: "uncontrolled",
    initialValues: INITIAL_VALUES,
    onValuesChange: (values) => setSnapshot(values),
    validate: {
      subject: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "Enter a subject brief.";
        if (trimmed.length > 12000) return "Subject must be at most 12,000 characters.";
        return null;
      },
      variants: (value) =>
        !Number.isInteger(value) || value < 1 || value > 8 ? "Variants must be 1 to 8." : null,
      parallel: (value) =>
        !Number.isInteger(value) || value < 1 || value > 24
          ? "Parallel requests must be 1 to 24."
          : null,
    },
  });

  // Apply an "Edit and regenerate" seed exactly once per token: replace every form field and
  // the inherited references. Revoke the outgoing references' object URLs first (they are
  // being discarded), and do NOT inherit the confirmation acknowledgement.
  useEffect(() => {
    if (!seed || seed.token === appliedSeedToken.current) return;
    appliedSeedToken.current = seed.token;
    for (const reference of referencesRef.current) URL.revokeObjectURL(reference.url);
    // Stored ids are historical: map renamed ones, drop retired ones (announced via the
    // recipe live region), and fall back to the family default if nothing survives.
    const reconciled = reconcileSeedRecipeIds(seed.recipeIds, seed.family, catalog);
    setFamily(seed.family);
    setRecipeIds(reconciled.ids);
    recipeSelections.current[seed.family] = reconciled.ids;
    setReferences(seed.references);
    referencesRef.current = seed.references;
    setAcknowledged(false);
    setRecipeFeedback(reconciled.notice);
    setFormError("");
    if (seed.family === "image") imageAspect.current = seed.aspectRatio;
    derivedFrom.current = seed.derivedFromSessionId;
    const next: FormValues = {
      subject: seed.subject,
      modelId: seed.modelId,
      size: seed.size as ImageSize,
      aspectRatio: seed.aspectRatio,
      variants: seed.variants,
      parallel: seed.parallel,
      googleSearch: seed.googleSearch,
      paletteId: seed.paletteId,
      backgroundColor: seed.backgroundColor,
    };
    form.setValues(next);
    setSnapshot(next);
    onSeedApplied?.();
  }, [seed, form, onSeedApplied, catalog]);

  const model = getModelCapability(snapshot.modelId);
  const sizes = model?.sizes ?? [];
  const aspects = model?.aspects ?? [];
  const searchSupported = model?.searchGrounding ?? false;
  const isIcon = family === "icon";

  const customOnly =
    recipeIds.length === 1 && catalog.find((r) => r.id === recipeIds[0])?.comparable === false;

  // Live estimate + confirmation gate (source updateEstimate).
  const recipeCount = recipeIds.length || 1;
  const variants = Math.max(1, Math.min(8, Number(snapshot.variants) || 2));
  const callCount = recipeCount * variants;
  const estimate = estimateSessionCost(snapshot.modelId, snapshot.size, callCount, snapshot.googleSearch);
  const reasons = confirmationReasons(callCount, estimate.usd);
  const gate = reasons.length > 0;

  // A run that no longer trips the gate drops its acknowledgement.
  useEffect(() => {
    if (!gate && acknowledged) setAcknowledged(false);
  }, [gate, acknowledged]);

  const subjectLen = snapshot.subject.length;

  function handleRecipeChange(ids: string[], feedback: string) {
    setRecipeIds(ids);
    setRecipeFeedback(feedback);
    recipeSelections.current[family] = ids;
    // A background field error is meaningless once Custom (which ignores the field) is
    // the selection; do not leave it attached to the now-disabled control.
    if (ids.length === 1 && catalog.find((r) => r.id === ids[0])?.comparable === false) {
      form.clearFieldError("backgroundColor");
    }
  }

  function changeFamily(next: "image" | "icon") {
    if (next === family) return;
    recipeSelections.current[family] = recipeIds;
    const remembered = recipeSelections.current[next];
    const nextRecipes = remembered.length ? remembered : DEFAULT_RECIPES_BY_FAMILY[next];
    setFamily(next);
    setRecipeIds(nextRecipes);
    setRecipeFeedback("");
    // Family constraint: icons are square (aspect locked 1:1); images restore the last
    // image aspect if the current model supports it (source applyFamilyConstraints).
    const current = getModelCapability(form.getValues().modelId);
    if (next === "icon") {
      form.setFieldValue("aspectRatio", "1:1");
    } else {
      const want = imageAspect.current;
      const fallback = (current?.aspects[0] as AspectRatio) ?? "1:1";
      form.setFieldValue("aspectRatio", current?.aspects.includes(want) ? want : fallback);
    }
  }

  // Model change repopulates the valid sizes/aspects and toggles search availability
  // (source updateModelSettings). Done in the Select's own onChange, not onValuesChange.
  function reconcileModel(modelId: string) {
    const next = getModelCapability(modelId);
    if (!next) return;
    const values = form.getValues();
    if (!next.sizes.includes(values.size)) {
      form.setFieldValue("size", preferredSize(next.sizes));
    }
    if (isIcon) {
      form.setFieldValue("aspectRatio", "1:1");
    } else {
      // Source updateModelSettings repopulates aspects, then applyFamilyConstraints
      // ALWAYS reapplies the remembered image aspect when the new model supports it —
      // so switching Flash(1:8) → Lite → Flash restores 1:8, not a stuck 1:1. Only when
      // the remembered aspect is unsupported AND the current one is too do we fall back.
      const want = imageAspect.current;
      if (next.aspects.includes(want)) {
        form.setFieldValue("aspectRatio", want);
      } else if (!next.aspects.includes(values.aspectRatio)) {
        form.setFieldValue("aspectRatio", next.aspects[0] as AspectRatio);
      }
    }
    if (!next.searchGrounding) form.setFieldValue("googleSearch", false);
  }

  const modelInput = form.getInputProps("modelId");
  const sizeInput = form.getInputProps("size");
  const aspectInput = form.getInputProps("aspectRatio");
  const subjectInput = form.getInputProps("subject");
  const variantsInput = form.getInputProps("variants");
  const parallelInput = form.getInputProps("parallel");
  const searchInput = form.getInputProps("googleSearch", { type: "checkbox" });
  const backgroundInput = form.getInputProps("backgroundColor");

  async function handleValid(values: FormValues) {
    setFormError("");
    if (submitting || refsBusy) return;
    if (recipeIds.length < 1) {
      setRecipeFeedback("At least one style recipe is required.");
      recipeSectionRef.current?.querySelector<HTMLElement>('[role="checkbox"]')?.focus();
      return;
    }
    const capability = getModelCapability(values.modelId);
    if (!capability) {
      setFormError("Choose a supported model.");
      return;
    }
    // validateKnownModelSettings intentionally passes unknown models, so the size/aspect
    // gate runs only after the model is confirmed known (above).
    const settingsError = validateKnownModelSettings(values.modelId, values.size, values.aspectRatio);
    if (settingsError) {
      setFormError(settingsError);
      return;
    }
    if (values.googleSearch && !capability.searchGrounding) {
      setFormError(`${values.modelId} does not support Google Search grounding.`);
      return;
    }
    if (isIcon && values.aspectRatio !== "1:1") {
      setFormError("Icon recipes require a 1:1 aspect ratio.");
      return;
    }
    // Styled icon runs render the background into the prompt; Custom-icon-only runs
    // ignore the field, so a stale invalid value must not block them.
    if (isIcon && !customOnly && !/^#[0-9a-fA-F]{6}$/.test(values.backgroundColor.trim())) {
      form.setFieldError("backgroundColor", "Enter a six digit hex color like #FAFAFA.");
      form.getInputNode("backgroundColor")?.focus();
      return;
    }
    if (gate && !acknowledged) {
      setFormError("Confirm this run exceeds the safety threshold before generating.");
      ackRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      // Assembly runs inside the error boundary too: an unexpected buildSessionInput
      // throw (bad palette, catalog drift) must surface inline, not as an unhandled
      // rejection that leaves the form silent.
      const { input } = buildSessionInput({
        subject: values.subject,
        recipeIds,
        paletteId: values.paletteId,
        backgroundColor: isIcon ? values.backgroundColor : undefined,
        settings: {
          modelId: values.modelId,
          size: values.size,
          aspectRatio: values.aspectRatio,
          googleSearch: values.googleSearch,
          variants: values.variants,
          parallel: values.parallel,
        },
        references: references.map((reference) => ({
          name: reference.name,
          mimeType: reference.mimeType,
          blob: reference.file,
        })),
        acknowledged,
        catalog,
        derivedFromSessionId: derivedFrom.current,
      });
      await onSubmit(input);
      // derivedFromSessionId is one-shot: it points at the seeded parent for THIS run only.
      derivedFrom.current = undefined;
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not start the run. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleInvalid(errors: Record<string, unknown>) {
    const firstPath = Object.keys(errors)[0];
    if (!firstPath) return;
    // Fields living inside the collapsible settings section must expand it first, or the
    // error + focus land in a closed panel (P16: parallel joins variants).
    if (!settingsOpened && (firstPath === "variants" || firstPath === "parallel")) {
      toggleSettings();
    }
    requestAnimationFrame(() => {
      const node = form.getInputNode(firstPath);
      node?.focus();
      node?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  return (
    <Paper component="form" onSubmit={form.onSubmit(handleValid, handleInvalid)} maw={880} mx="auto" p="lg" radius="lg" withBorder>
      <Stack gap="lg">
        <Box>
          <Title order={2} fz="h3">
            Set up a run
          </Title>
          <Text c="dimmed" fz="sm">
            Pick styles, describe a subject, and generate variants to compare side by side.
          </Text>
        </Box>

        {/* Output family */}
        <Box>
          <Text fw={500} fz="sm" mb={6}>
            Output
          </Text>
          <SegmentedControl
            aria-label="Output"
            value={family}
            onChange={(value) => changeFamily(value as "image" | "icon")}
            data={[
              { value: "image", label: "Images" },
              { value: "icon", label: "Icons" },
            ]}
          />
          <Text c="dimmed" fz="xs" mt={4}>
            {isIcon ? "Square, circular production assets." : "Full-frame backgrounds and artwork."}
          </Text>
        </Box>

        {/* Style recipes */}
        <div ref={recipeSectionRef}>
          <RecipePicker
            family={family}
            recipes={catalog}
            value={recipeIds}
            onChange={handleRecipeChange}
            feedback={recipeFeedback}
          />
        </div>

        {/* Subject */}
        <Textarea
          {...subjectInput}
          key={form.key("subject")}
          label="Subject prompt"
          description={`${subjectLen.toLocaleString()} / 12,000`}
          inputWrapperOrder={["label", "input", "description", "error"]}
          placeholder="Describe what to generate. For Custom, this is the complete prompt."
          rows={4}
          // P16: native bottom-right grip so long prompts can be grown by hand. Vertical
          // only — horizontal would break the form grid. (No autosize here to fight: the
          // field is fixed-rows, so the grip composes cleanly.)
          resize="vertical"
          maxLength={12000}
        />

        {/* Palette */}
        <PalettePicker
          value={snapshot.paletteId}
          onChange={(id) => form.setFieldValue("paletteId", id)}
          customOnly={Boolean(customOnly)}
        />

        {/* Icon background (icon family only). When Custom icon is the only selection it
            stays anchored in place but disabled — a governing control should not jump in
            and out of the layout. An explicit persisted choice; never follows the app
            color scheme. */}
        {isIcon && (
          <ColorInput
            {...backgroundInput}
            key={form.key("backgroundColor")}
            label="Icon background"
            description={
              customOnly
                ? "Background not used in Custom mode."
                : "Solid fill behind the icon. The circular mask is applied at export."
            }
            disabled={customOnly}
            format="hex"
            swatches={ICON_BACKGROUND_SWATCHES}
            // Mantine's eye dropper ActionIcon ships without a label (axe button-name).
            eyeDropperButtonProps={{ "aria-label": "Pick a color from the screen" }}
            maw={300}
          />
        )}

        {/* References + generation settings (collapsible). The toggle is an obviously
            clickable bordered bar; while collapsed it carries live summary chips. */}
        <Box>
          <UnstyledButton
            type="button"
            onClick={toggleSettings}
            aria-expanded={settingsOpened}
            aria-controls="setup-settings"
            className={classes.settingsBar}
          >
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
                <SlidersHorizontal
                  size={16}
                  aria-hidden
                  color="var(--mantine-color-dimmed)"
                  style={{ flex: "none" }}
                />
                <Text fw={600} fz="sm" style={{ flex: "none" }}>
                  Reference images and settings
                </Text>
                {/* No aria-label here: the chips' own text must contribute to the button's
                    accessible name (a descendant label would replace it for AT). */}
                {!settingsOpened && (
                  <Group gap={6} wrap="wrap" data-testid="settings-chips">
                    <Badge variant="light" color="gray" radius="sm" size="sm" tt="none">
                      <span aria-hidden>🍌 </span>
                      {MODEL_CHIP_LABELS[snapshot.modelId] ?? snapshot.modelId}
                    </Badge>
                    <Badge variant="light" color="gray" radius="sm" size="sm" tt="none">
                      {formatSize(snapshot.size)}
                    </Badge>
                    <Badge variant="light" color="gray" radius="sm" size="sm" tt="none">
                      {snapshot.aspectRatio}
                    </Badge>
                    <Badge variant="light" color="gray" radius="sm" size="sm" tt="none">
                      {variants} variant{variants === 1 ? "" : "s"}
                    </Badge>
                    <Badge
                      variant="light"
                      color={references.length > 0 ? "workbench" : "gray"}
                      radius="sm"
                      size="sm"
                      tt="none"
                    >
                      {references.length > 0
                        ? `${references.length} reference${references.length === 1 ? "" : "s"}`
                        : "No references"}
                    </Badge>
                  </Group>
                )}
              </Group>
              <CaretDown
                size={16}
                aria-hidden
                className={classes.settingsChevron}
                data-open={settingsOpened || undefined}
              />
            </Group>
          </UnstyledButton>
          <Collapse expanded={settingsOpened} id="setup-settings">
            <Stack gap="md" mt="md">
              <ReferenceInput
                value={references}
                onChange={setReferences}
                onBusyChange={setRefsBusy}
              />
              <Divider />
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                <Select
                  {...modelInput}
                  key={form.key("modelId")}
                  onChange={(value, option) => {
                    modelInput.onChange(value, option);
                    if (value) reconcileModel(value);
                  }}
                  label="Model"
                  data={MODEL_CAPABILITIES.map((m) => ({ value: m.id, label: m.label }))}
                  allowDeselect={false}
                />
                <Select
                  {...sizeInput}
                  key={form.key("size")}
                  label="Resolution"
                  data={sizes.map((size) => ({ value: size, label: formatSize(size) }))}
                  allowDeselect={false}
                />
                <Select
                  {...aspectInput}
                  key={form.key("aspectRatio")}
                  onChange={(value, option) => {
                    aspectInput.onChange(value, option);
                    if (!isIcon && value) imageAspect.current = value as AspectRatio;
                  }}
                  label="Aspect"
                  description={isIcon ? "Locked to 1:1 for icons." : undefined}
                  // Description BELOW the control so the select stays on the same baseline
                  // as "Variants per style" beside it (icon family adds the lock text).
                  inputWrapperOrder={["label", "input", "description", "error"]}
                  data={aspects.map((aspect) => ({ value: aspect, label: aspect }))}
                  disabled={isIcon}
                  allowDeselect={false}
                />
                <NumberInput
                  {...variantsInput}
                  key={form.key("variants")}
                  label="Variants per style"
                  min={1}
                  max={8}
                  clampBehavior="strict"
                  allowDecimal={false}
                />
                <NumberInput
                  {...parallelInput}
                  key={form.key("parallel")}
                  label="Parallel requests"
                  description="Higher values generate faster; Google may rate-limit bursts (retried automatically)."
                  inputWrapperOrder={["label", "input", "description", "error"]}
                  min={1}
                  max={24}
                  clampBehavior="strict"
                  allowDecimal={false}
                />
              </SimpleGrid>
              <Switch
                {...searchInput}
                key={form.key("googleSearch")}
                label={
                  // The Chrome glyph colors up when grounding is on (dimmed when off); the
                  // switch itself is the real on/off signal — the icon is decorative.
                  <Group component="span" gap={6} wrap="nowrap" display="inline-flex">
                    <GoogleChromeLogo
                      size={16}
                      aria-hidden
                      weight={searchSupported && snapshot.googleSearch ? "fill" : "regular"}
                      color={
                        searchSupported && snapshot.googleSearch
                          ? "#4285f4"
                          : "var(--mantine-color-dimmed)"
                      }
                      style={{ flex: "none" }}
                    />
                    Google Search grounding
                  </Group>
                }
                description={
                  searchSupported
                    ? "May incur extra costs."
                    : `${model?.label ?? "This model"} does not support grounding.`
                }
                disabled={!searchSupported}
              />
            </Stack>
          </Collapse>
        </Box>

        <Divider />

        {/* Estimate + confirmation gate + Generate. Bold banner: the generation count and a
            big accent cost headline; the token caveat demoted to a small muted line. */}
        <Stack gap="sm">
          <Box>
            <Group justify="space-between" wrap="wrap" gap="xs" align="baseline">
              <Text fw={700} fz="lg">
                {callCount} image generation{callCount === 1 ? "" : "s"}
              </Text>
              {estimate.status === "estimated" ? (
                <Text fw={700} fz="xl" c="workbench" component="span">
                  <Coins
                    size={20}
                    weight="bold"
                    aria-hidden
                    style={{ verticalAlign: "-0.18em", marginRight: 6 }}
                  />
                  ≈ {formatApproxCost(estimate.usd!)}
                  {snapshot.googleSearch && (
                    // Grounding bills separately (the caveat line excludes it) — flag it
                    // right beside the number, subordinate to the big figure.
                    <Text component="span" fz="sm" fw={600} c="dimmed">
                      {" "}
                      + extra
                    </Text>
                  )}
                </Text>
              ) : (
                <Text fw={600} fz="sm" c="dimmed">
                  Estimate unavailable
                </Text>
              )}
            </Group>
            <Text c="dimmed" fz="xs" mt={2}>
              {recipeCount} style{recipeCount === 1 ? "" : "s"} × {variants} variant
              {variants === 1 ? "" : "s"} · estimate excludes input, text, thinking &amp; grounding
              tokens
            </Text>
          </Box>

          <Collapse expanded={gate} keepMounted={false}>
            <Alert color="yellow" variant="light" title="Confirmation required">
              <Stack gap="xs">
                <Box>
                  {reasons.map((reason) => (
                    <Text key={reason} fz="sm">
                      • {reason}
                    </Text>
                  ))}
                </Box>
                <Checkbox
                  ref={ackRef}
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                  label="I confirm this run exceeds the safety threshold."
                />
              </Stack>
            </Alert>
          </Collapse>

          {formError && (
            <Text c="red" fz="sm" role="alert">
              {formError}
            </Text>
          )}
          {!ready && !mockMode && (
            <Text c="dimmed" fz="sm">
              Connect your Google API key (above, or via the key pill top-right) to enable
              generation.
            </Text>
          )}
          {!ready && mockMode && !generationDisabledReason && (
            <Text c="dimmed" fz="sm">
              Mock generation is on — this run draws placeholder images locally and calls no
              provider.
            </Text>
          )}
          {generationDisabledReason && (
            <Text c="dimmed" fz="sm" role="status">
              {generationDisabledReason}
            </Text>
          )}

          <Group justify="flex-end">
            <Button type="submit" disabled={!canGenerate || refsBusy} loading={submitting} size="md">
              Generate
            </Button>
          </Group>
        </Stack>
      </Stack>
    </Paper>
  );
}
