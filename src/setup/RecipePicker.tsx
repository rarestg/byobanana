// Style-recipe selector. A controlled Checkbox.Card group (recipeIds lives in the
// parent's React state, not the uncontrolled form) so the source's selection rules can
// be enforced imperatively:
//   • min 1 — the last checked recipe cannot be removed.
//   • max 3 — unchecked COMPARISON cards are disabled once three are selected. We do
//     NOT use Checkbox.Group's maxSelectedValues={3}: its handleChange hard-blocks ANY
//     add at the cap, which would also block Custom from REPLACING three comparison
//     styles (a behavior the source keeps). Manual disable enforces the same cap while
//     leaving Custom free to replace.
//   • Custom (non-comparable) is mutually exclusive: picking Custom clears the others;
//     picking a comparison style clears Custom.
// The list is rebuilt per family (image vs icon) with Custom sorted last, matching
// renderRecipes. A polite live region announces the count and the last rule that fired.

import { Box, Checkbox, Group, SimpleGrid, Stack, Text } from "@mantine/core";

import { recipeFamily, type Recipe } from "../core/recipes";
import classes from "./SetupForm.module.css";

export interface RecipePickerProps {
  family: "image" | "icon";
  recipes: Recipe[]; // full catalog
  value: string[]; // selected recipe ids, in display order
  onChange: (ids: string[], feedback: string) => void;
  feedback: string;
}

const MAX_RECIPES = 3;

// Owner-ratified gallery order for the styled icon recipes. A display concern only: the
// catalog's own filename sort is an internal deterministic contract and stays untouched.
// Ids missing from this list keep their catalog position after the listed five.
const ICON_DISPLAY_ORDER = [
  "cut-paper-icon",
  "geometric-isometric-icon",
  "impact-icon",
  "modern-flat-icon",
  "glass-icon",
];

// Recipes for the active family, Custom (non-comparable) last — matches the source's
// `sort((l,r) => Number(l.kind==="custom") - Number(r.kind==="custom"))`. The icon
// family additionally follows ICON_DISPLAY_ORDER; the image family keeps catalog order
// (the sort is stable).
export function familyRecipes(recipes: Recipe[], family: "image" | "icon"): Recipe[] {
  const rank = (recipe: Recipe) => {
    const index = ICON_DISPLAY_ORDER.indexOf(recipe.id);
    return index === -1 ? ICON_DISPLAY_ORDER.length : index;
  };
  return recipes
    .filter((recipe) => recipeFamily(recipe) === family)
    .sort(
      (left, right) =>
        Number(!left.comparable) - Number(!right.comparable) ||
        (family === "icon" ? rank(left) - rank(right) : 0),
    );
}

export function RecipePicker({ family, recipes, value, onChange, feedback }: RecipePickerProps) {
  const options = familyRecipes(recipes, family);
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const selectedComparableCount = value.filter((id) => byId.get(id)?.comparable).length;
  const capReached = selectedComparableCount >= MAX_RECIPES;

  // Normalize a selection to DISPLAY order (comparison styles first, Custom last), so
  // arms are built in the same order the source produced from DOM-ordered checkboxes —
  // Mantine's Checkbox.Group appends in click order, which would otherwise leak through.
  const order = new Map(options.map((recipe, index) => [recipe.id, index]));
  const inDisplayOrder = (ids: string[]) =>
    [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  // Checkbox.Group hands us the toggled array (one id added or removed). We reconcile it
  // against the current selection to apply the exclusion + never-empty rules.
  function handleGroupChange(next: string[]) {
    if (next.length === 0) {
      onChange(value, "At least one style recipe is required.");
      return;
    }
    const added = next.find((id) => !value.includes(id));
    if (!added) {
      // A removal that still leaves ≥1 selected — accept as-is.
      onChange(inDisplayOrder(next), "");
      return;
    }
    const addedRecipe = byId.get(added);
    if (addedRecipe && !addedRecipe.comparable) {
      // Custom picked: it replaces everything else.
      const hadOthers = value.some((id) => id !== added);
      onChange([added], hadOthers ? `${addedRecipe.name} replaces the selected style recipes.` : "");
      return;
    }
    // A comparison style picked: drop any Custom that was selected.
    const withoutCustom = next.filter((id) => byId.get(id)?.comparable);
    if (withoutCustom.length !== next.length) {
      onChange(inDisplayOrder(withoutCustom), "Custom was replaced so these styles can be compared.");
      return;
    }
    onChange(inDisplayOrder(next), "");
  }

  return (
    <Checkbox.Group
      value={value}
      onChange={handleGroupChange}
      label="Style recipes"
      description="Compare up to three style recipes with the same subject."
    >
      <Stack gap="xs" mt="xs">
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
          {options.map((recipe) => {
            const checked = value.includes(recipe.id);
            // Cap only disables unchecked COMPARISON cards; Custom stays enabled so it
            // can replace a full comparison set.
            const disabled = !checked && recipe.comparable && capReached;
            return (
              <Checkbox.Card
                key={recipe.id}
                value={recipe.id}
                disabled={disabled}
                className={classes.card}
                aria-labelledby={`recipe-${recipe.id}-name`}
                aria-describedby={`recipe-${recipe.id}-desc`}
              >
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                  <Box>
                    <Text id={`recipe-${recipe.id}-name`} fw={600} fz="sm" lh={1.25}>
                      {recipe.name}
                    </Text>
                    <Text id={`recipe-${recipe.id}-desc`} c="dimmed" fz="xs" mt={4} lh={1.3}>
                      {recipe.description}
                    </Text>
                  </Box>
                  {/* Always rendered — hidden (not removed) when unchecked so its space is
                      reserved and selection never jogs the card layout. */}
                  <span
                    className={`${classes.checkBadge}${checked ? "" : ` ${classes.checkBadgeIdle}`}`}
                    aria-hidden
                  >
                    ✓
                  </span>
                </Group>
              </Checkbox.Card>
            );
          })}
        </SimpleGrid>
        <Text fz="xs" c="dimmed" role="status" aria-live="polite">
          {feedback ? `${feedback} ` : ""}
          {value.length} of {MAX_RECIPES} style recipes selected.
        </Text>
      </Stack>
    </Checkbox.Group>
  );
}
