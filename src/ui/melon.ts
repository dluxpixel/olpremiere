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

/**
 * The bite: a round chomp out of the top right of the slice, as a circle in
 * pixel space rather than a second hand-drawn grid.
 *
 * His ask, 2026-08-14: when the melon finds an update, it should show a piece
 * bitten off while the update comes down.
 *
 * Geometry, not a copy of the art, on purpose. A second set of rows would be a
 * duplicate of MELON_ROWS that could drift from it silently, and the art is
 * guarded by a test precisely because it matters. Carving the one grid means
 * the bitten melon is always the same melon.
 *
 * Centred off the top-right corner so the bite opens outward and leaves the
 * rind at the bottom whole: a slice with a mouthful gone, not a broken one.
 */
const BITE = { cx: 15.2, cy: 1.2, r: 4.6 };

/** Is this cell inside the chomp? Measured from the pixel's CENTRE. */
function bitten(x: number, y: number): boolean {
  const dx = x + 0.5 - BITE.cx;
  const dy = y + 0.5 - BITE.cy;
  return dx * dx + dy * dy < BITE.r * BITE.r;
}

/**
 * Flatten the grid into positioned, coloured pixels (transparent cells skipped).
 * `bite` carves the chomp out; everything else is untouched.
 */
export function melonPixels(opts?: { bite?: boolean }): MelonPixel[] {
  const out: MelonPixel[] = [];
  MELON_ROWS.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      if (opts?.bite && bitten(x, y)) continue;
      const color = MELON_PALETTE[ch];
      if (color) out.push({ x, y, color });
    }
  });
  return out;
}
