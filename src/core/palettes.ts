// Ported from nano-banana-2 @ 54e0224 — src/workbench/palettes.ts
// Pure color-palette definitions + validation. Copied verbatim.

export interface ColorPalette {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly colors: readonly string[];
}

export const DEFAULT_PALETTE_ID = "folio-teal";

export const COLOR_PALETTES: readonly ColorPalette[] = [
  {
    id: "folio-teal",
    name: "Folio teal",
    description: "Cool zinc neutrals with a clear teal accent.",
    colors: ["#FAFAFA", "#E4E4E7", "#71717B", "#18181B", "#CBFBF1", "#00BBA7"],
  },
  {
    id: "ink-ochre",
    name: "Ink & ochre",
    description: "A restrained four-color warm editorial palette.",
    colors: ["#FAFAF7", "#D6D3D1", "#292524", "#D97706"],
  },
  {
    id: "coastal-blue",
    name: "Coastal blue",
    description: "Stone neutrals with airy sky and cobalt blues.",
    colors: ["#FAFAF9", "#E7E5E4", "#78716C", "#1C1917", "#DBEAFE", "#3B82F6"],
  },
  {
    id: "sunlit-coral",
    name: "Sunlit coral",
    description: "Warm paper, amber sunlight, and a coral focal accent.",
    colors: [
      "#FFFDF7",
      "#F3E8DD",
      "#A8A29E",
      "#292524",
      "#FDE68A",
      "#F59E0B",
      "#FED7D7",
      "#F43F5E",
    ],
  },
  {
    id: "garden-green",
    name: "Garden green",
    description: "Soft botanical greens grounded by deep forest neutrals.",
    colors: [
      "#FAFAF5",
      "#E7E8D9",
      "#7C8172",
      "#1F2923",
      "#D9F99D",
      "#65A30D",
      "#BBF7D0",
      "#16A34A",
    ],
  },
  {
    id: "orchid-dusk",
    name: "Orchid dusk",
    description: "Layered violet and orchid accents with quiet neutrals.",
    colors: [
      "#FDFBFF",
      "#E7E5E4",
      "#A1A1AA",
      "#52525B",
      "#18181B",
      "#F3E8FF",
      "#C084FC",
      "#DDD6FE",
      "#8B5CF6",
      "#DB2777",
    ],
  },
  {
    id: "pastel-prism",
    name: "Pastel prism",
    description: "A broad twelve-color spectrum for layered, airy artwork.",
    colors: [
      "#FFFCF7",
      "#E7E5E4",
      "#78716C",
      "#1C1917",
      "#FECDD3",
      "#FDBA74",
      "#FDE68A",
      "#BEF264",
      "#99F6E4",
      "#BAE6FD",
      "#BFDBFE",
      "#DDD6FE",
    ],
  },
];

const paletteIds = new Set<string>();
for (const palette of COLOR_PALETTES) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(palette.id)) {
    throw new Error(`Invalid color palette ID: ${palette.id}`);
  }
  if (paletteIds.has(palette.id)) throw new Error(`Duplicate color palette ID: ${palette.id}`);
  paletteIds.add(palette.id);
  if (palette.colors.length < 4 || palette.colors.length > 12) {
    throw new Error(`Color palette ${palette.id} must contain 4 to 12 colors.`);
  }
  if (new Set(palette.colors).size !== palette.colors.length) {
    throw new Error(`Color palette ${palette.id} contains duplicate colors.`);
  }
  const invalidColor = palette.colors.find((color) => !/^#[0-9A-F]{6}$/.test(color));
  if (invalidColor !== undefined)
    throw new Error(`Color palette ${palette.id} has invalid color ${invalidColor}.`);
}

export function getColorPalette(id: string) {
  return COLOR_PALETTES.find((palette) => palette.id === id);
}

export function palettePrompt(palette: ColorPalette) {
  return palette.colors.join(", ");
}
