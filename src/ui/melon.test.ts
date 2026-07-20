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
