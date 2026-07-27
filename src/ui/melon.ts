/**
 * The OL suite's mascot (shared with the OL Studio DAW), the pixel-art watermelon slice, as pure data.
 *
 * Kept here as plain data (not baked into JSX) so the boot splash can render it
 * crisply at any size and a unit test can guard the art from accidental
 * corruption. The palette is sampled from the brand launcher icon
 * (`.launchers/icons/ot-studio.ico`): red flesh with black seeds, a light-green
 * inner rind, and a dark-green outer rind. The flesh red is the same coral the
 * app uses for `--rec`, so the mascot reads as on-brand.
 *
 * One character per pixel; '.' = transparent. Rows are top→bottom: flesh (the cut
 * face) at the top, then the inner rind, then the outer rind curving to a rounded
 * bottom, i.e. a watermelon slice with the cut side up.
 */
export const MELON_PALETTE: Record<string, string> = {
  R: '#E2483D', // flesh, base (≈ the app's --rec coral)
  r: '#E67168', // flesh, lighter top sheen
  S: '#23140F', // seed (warm near-black)
  L: '#8FCF7F', // inner rind (light green)
  D: '#2E7D4F', // outer rind (dark green)
};

export const MELON_ROWS: readonly string[] = [
  '....rrrrrrrr....',
  '..rRRRRRRRRRRr..',
  '.RRRRRRRRRRRRRR.',
  'RRRRSRRRRRRRSRRR',
  'RRRRRRRSRRRRRRRR',
  'RRRSRRRRRRSRRRRR',
  'RRRRRRRRRRRSRRRR',
  '.RRRRSRRRRRRRRR.',
  '.LLLLLLLLLLLLLL.',
  '..LLLLLLLLLLLL..',
  '..DDDDDDDDDDDD..',
  '...DDDDDDDDDD...',
];

/** Canonical art dimensions (the SVG viewBox keys off these). */
export const MELON_W = 16;
export const MELON_H = MELON_ROWS.length; // 12

interface MelonPixel {
  x: number;
  y: number;
  color: string;
}

/** Flatten the grid into positioned, coloured pixels (transparent cells skipped). */
export function melonPixels(): MelonPixel[] {
  const out: MelonPixel[] = [];
  MELON_ROWS.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const color = MELON_PALETTE[ch];
      if (color) out.push({ x, y, color });
    }
  });
  return out;
}
