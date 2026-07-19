import {
  createTheme,
  defaultVariantColorsResolver,
  type MantineColorsTuple,
  type VariantColorsResolver,
} from "@mantine/core";

// Brand tokens from nano-banana-2 DESIGN.md frontmatter ("The Selection Bench").
// Teal marks action/selection/positive state; a zinc scale carries quiet structure
// across matched light and dark themes. Flat elevation: tone + borders, minimal shadow.

// Workbench Teal (Tailwind teal 50..900), registered as its own named color rather
// than replacing Mantine's built-in `teal` (which stays available as a semantic hue).
// primaryShade picks #0f766e in light (7) and #2dd4bf in dark (4) = accent-light /
// accent-dark. Filled-control TEXT color is set per scheme via --mantine-primary-color-contrast
// (white on the dark light-mode accent, black on the light dark-mode accent) in app.css — NOT
// via Mantine autoContrast, which (with primaryShade as a {light,dark} object) computes the
// contrast off the light shade and then renders it over the scheme-flipped background, leaving
// white text on #2dd4bf (~1.86:1, fails WCAG AA).
const workbench: MantineColorsTuple = [
  "#f0fdfa",
  "#ccfbf1",
  "#99f6e4",
  "#5eead4",
  "#2dd4bf",
  "#14b8a6",
  "#0d9488",
  "#0f766e",
  "#115e59",
  "#134e4a",
];

// Zinc neutrals in Mantine's dark-scale semantic order (text -> muted -> border ->
// progressively darker surfaces). P14: the surface ladder is lifted roughly one step off
// the original zinc-950 void-black (Mantine's own dark convention — darkest shades are
// chrome, not the page) while staying zinc-neutral; text steps 0-3 unchanged, elevation
// separation preserved. dark-2 = text-muted #d4d4d8, dark-4 = line #5b5b64,
// dark-5 = surface-muted #28282e, dark-6 = raised surface #1e1e23 (settings bar,
// recipe/palette cards), dark-7 = page #141418 (body — and Mantine Paper, which rides
// --mantine-color-body; card elevation here is flat, carried by borders).
const dark: MantineColorsTuple = [
  "#fafafa",
  "#e4e4e7",
  "#d4d4d8",
  "#a1a1aa",
  "#5b5b64",
  "#28282e",
  "#1e1e23",
  "#141418",
  "#0c0c0f",
  "#050507",
];

// Danger red (Tailwind red 50..900), replacing Mantine's Open Color red so destructive
// controls ride the same Tailwind family as teal/zinc. P15: Mantine's defaults read washed
// out here — light filled was #fa5252 (white text 3.3:1, fails AA); dark light-variant was
// a muted brick wash. The theme-wide primaryShade {light:7, dark:4} applies to EVERY
// registered color, so filled danger resolves to the deep decisive red-7 #b91c1c in light
// (white text 6.5:1) and the bright red-4 #f87171 in dark (dark text 6.4:1 — see the
// variantColorResolver + --nb-danger-contrast below); light variants get red-3 text on a
// translucent red-4 wash in dark (app.css overrides).
const red: MantineColorsTuple = [
  "#fef2f2",
  "#fee2e2",
  "#fecaca",
  "#fca5a5",
  "#f87171",
  "#ef4444",
  "#dc2626",
  "#b91c1c",
  "#991b1b",
  "#7f1d1d",
];

// Zinc gray for light-mode neutrals (borders, dimmed/placeholder text, disabled
// states) so they read as zinc rather than Mantine's Open Color defaults.
const gray: MantineColorsTuple = [
  "#fafafa",
  "#f4f4f5",
  "#e4e4e7",
  "#d4d4d8",
  "#a1a1aa",
  "#71717a",
  "#52525b",
  "#3f3f46",
  "#27272a",
  "#18181b",
];

// Filled controls set their text via --button-color / --badge-color = white, which fails on the
// LIGHT dark-mode accent (#2dd4bf). autoContrast can't fix it here (with primaryShade as a
// {light,dark} object it computes one contrast off the light shade). So for filled PRIMARY
// controls we return a scheme-aware text color (--nb-primary-contrast, defined per scheme in
// app.css: white in light on #0f766e, black in dark on #2dd4bf). P15: filled DANGER controls
// have the same shape (primaryShade derives the deep red-7 light filled, which wants white,
// and the bright red-4 dark filled, which wants black), via the parallel
// --nb-danger-contrast. Other colors are untouched.
const variantColorResolver: VariantColorsResolver = (input) => {
  const resolved = defaultVariantColorsResolver(input);
  if (input.variant === "filled" && (input.color === "workbench" || input.color === undefined)) {
    return { ...resolved, color: "var(--nb-primary-contrast)" };
  }
  if (input.variant === "filled" && input.color === "red") {
    return { ...resolved, color: "var(--nb-danger-contrast)" };
  }
  return resolved;
};

export const theme = createTheme({
  primaryColor: "workbench",
  primaryShade: { light: 7, dark: 4 },
  // autoContrast intentionally off — see the workbench-color note above; filled-primary contrast
  // is handled by variantColorResolver + --nb-primary-contrast so controls stay AA-legible.
  variantColorResolver,
  respectReducedMotion: true,
  colors: { workbench, dark, gray, red },
  black: "#18181b",
  fontFamily:
    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  headings: {
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    fontWeight: "700",
  },
  // DESIGN.md radius scale: small 6 / control 8 / card 10 / panel 12 (pill = 999 is
  // applied per-component via radius="xl" or radius={999}).
  radius: { xs: "6px", sm: "8px", md: "10px", lg: "12px", xl: "16px" },
  defaultRadius: "sm",
});
