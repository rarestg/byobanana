// Color-palette picker: seven Radio.Card swatches. Each palette's hex colors are drawn
// as an inline-SVG strip (source renderPalettes). When the only selected recipe is
// Custom, the palette is unused (Custom's template has no {{colorPalette}}) — the whole
// group is disabled and greyed with an explanatory note, matching updatePaletteAvailability.

import { Box, Radio, SimpleGrid, Stack, Text } from "@mantine/core";

import { COLOR_PALETTES, getColorPalette } from "../core/palettes";
import classes from "./SetupForm.module.css";

export interface PalettePickerProps {
  value: string;
  onChange: (id: string) => void;
  // True when Custom is the only selected recipe — palette is not applied.
  customOnly: boolean;
}

function Swatch({ colors }: { colors: readonly string[] }) {
  return (
    <svg
      className={classes.swatch}
      viewBox={`0 0 ${colors.length} 1`}
      preserveAspectRatio="none"
      focusable="false"
      aria-hidden
    >
      {colors.map((color, index) => (
        <rect key={color} x={index} y={0} width={1} height={1} fill={color} />
      ))}
    </svg>
  );
}

export function PalettePicker({ value, onChange, customOnly }: PalettePickerProps) {
  const selected = getColorPalette(value);
  const description = customOnly
    ? "Palette not used in Custom mode."
    : (selected?.description ?? "");

  return (
    <Radio.Group value={value} onChange={onChange} label="Color palette" description={description}>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="sm" mt="xs">
        {COLOR_PALETTES.map((palette) => (
          <Radio.Card
            key={palette.id}
            value={palette.id}
            disabled={customOnly}
            className={classes.card}
            aria-label={`${palette.name}, ${palette.colors.length} colors`}
          >
            <Stack gap={6}>
              <Swatch colors={palette.colors} />
              <Box>
                <Text fw={600} fz="sm" lh={1.2}>
                  {palette.name}
                </Text>
                <Text c="dimmed" fz="xs">
                  {palette.colors.length} colors
                </Text>
              </Box>
            </Stack>
          </Radio.Card>
        ))}
      </SimpleGrid>
    </Radio.Group>
  );
}
