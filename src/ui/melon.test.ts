import { describe, it, expect } from 'vitest';
import { MELON_ROWS, MELON_PALETTE, MELON_W, MELON_H, melonPixels } from './melon';

describe('melon mascot art', () => {
  it('every row is the canonical width', () => {
    for (const row of MELON_ROWS) expect(row.length).toBe(MELON_W);
  });

  it('row count matches the declared height', () => {
    expect(MELON_ROWS.length).toBe(MELON_H);
  });

  it('uses only known symbols', () => {
    const legal = new Set(['.', ...Object.keys(MELON_PALETTE)]);
    for (const row of MELON_ROWS) {
      for (const ch of row) expect(legal.has(ch)).toBe(true);
    }
  });

  it('every palette colour is a 6-digit hex', () => {
    for (const hex of Object.values(MELON_PALETTE)) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('renders only opaque, in-bounds pixels with palette colours', () => {
    const colors = new Set(Object.values(MELON_PALETTE));
    const px = melonPixels();
    expect(px.length).toBeGreaterThan(0);
    for (const p of px) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(MELON_W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(MELON_H);
      expect(colors.has(p.color)).toBe(true);
    }
  });

  it('is a recognisable slice: flesh + seeds + both rind layers', () => {
    const joined = MELON_ROWS.join('');
    expect(joined).toContain('R'); // flesh
    expect(joined).toContain('S'); // seeds
    expect(joined).toContain('L'); // inner (light) rind
    expect(joined).toContain('D'); // outer (dark) rind
    // a scatter of seeds, not just one
    expect((joined.match(/S/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps seeds in the flesh, never in the rind rows', () => {
    MELON_ROWS.forEach((row) => {
      const hasRind = row.includes('L') || row.includes('D');
      if (hasRind) expect(row).not.toContain('S');
    });
  });
});

// His ask, 2026-08-14: when the melon finds an update it should show a piece
// bitten off, and pop. The bite is carved out of the ONE grid rather than drawn
// as a second one, so these hold it to being the same melon with a mouthful
// gone rather than a different picture.
describe('the bitten melon', () => {
  it('is the same melon by default: no bite unless it is asked for', () => {
    expect(melonPixels()).toEqual(melonPixels({ bite: false }))
    expect(melonPixels().length).toBe(melonPixels({ bite: undefined }).length)
  })

  it('takes a real mouthful, but nothing like the whole slice', () => {
    const whole = melonPixels().length
    const bitten = melonPixels({ bite: true }).length
    const eaten = whole - bitten
    // Big enough to read at 16px, small enough to still be a melon.
    expect(eaten).toBeGreaterThan(whole * 0.06)
    expect(eaten).toBeLessThan(whole * 0.25)
  })

  it('bites the TOP RIGHT and leaves the rind at the bottom whole', () => {
    const whole = melonPixels()
    const bitten = melonPixels({ bite: true })
    const gone = whole.filter((w) => !bitten.some((b) => b.x === w.x && b.y === w.y))
    expect(gone.length).toBeGreaterThan(0)
    // Every missing pixel is in the top half and the right half.
    for (const p of gone) {
      expect(p.y).toBeLessThan(MELON_H / 2)
      expect(p.x).toBeGreaterThan(MELON_W / 2)
    }
    // The bottom rows, the rind, are untouched: a bite, not a broken slice.
    const bottomWhole = whole.filter((p) => p.y >= MELON_H - 3).length
    const bottomBitten = bitten.filter((p) => p.y >= MELON_H - 3).length
    expect(bottomBitten).toBe(bottomWhole)
  })

  it('removes pixels only, never adds or moves one', () => {
    const whole = melonPixels()
    for (const p of melonPixels({ bite: true })) {
      expect(whole.some((w) => w.x === p.x && w.y === p.y && w.color === p.color)).toBe(true)
    }
  })
})
