import { describe, expect, it } from 'vitest'
import { defaultTitleDef, withTitleFontSize, type TitleDef } from './types'

const styled = (over: Partial<TitleDef> = {}): TitleDef => ({
  ...defaultTitleDef('Hi'),
  fontSizePx: 96,
  outline: { color: '#000000', widthPx: 8 },
  shadow: { color: '#000000', dx: 4, dy: 6, blurPx: 12 },
  box: { color: '#000000', paddingPx: 20, radiusPx: 10 },
  offsetXPx: 30,
  offsetYPx: -40,
  ...over,
})

describe('resizing type brings its decoration with it', () => {
  it('scales outline, shadow and box with the size', () => {
    // Small (48) -> Huge (240) is the app's own ladder: 5x.
    const huge = withTitleFontSize(styled({ fontSizePx: 48 }), 240)
    expect(huge.fontSizePx).toBe(240)
    expect(huge.outline!.widthPx).toBe(40)
    expect(huge.shadow!.blurPx).toBe(60)
    expect(huge.shadow!.dx).toBe(20)
    expect(huge.box!.paddingPx).toBe(100)
    expect(huge.box!.radiusPx).toBe(50)
  })

  it('scales back down again, so the ladder is reversible', () => {
    const there = withTitleFontSize(styled(), 240)
    const back = withTitleFontSize(there, 96)
    expect(back.outline!.widthPx).toBe(styled().outline!.widthPx)
    expect(back.box!.paddingPx).toBe(styled().box!.paddingPx)
  })

  it('does NOT move the title, because position is not a decoration', () => {
    const out = withTitleFontSize(styled(), 240)
    expect(out.offsetXPx).toBe(30)
    expect(out.offsetYPx).toBe(-40)
  })

  it('leaves style alone', () => {
    const out = withTitleFontSize(styled({ bold: true, color: '#ff0000' }), 200)
    expect(out.bold).toBe(true)
    expect(out.color).toBe('#ff0000')
    expect(out.outline!.color).toBe('#000000')
  })

  it('keeps an outline visible instead of rounding it away', () => {
    const tiny = withTitleFontSize(styled({ fontSizePx: 240 }), 8)
    expect(tiny.outline!.widthPx).toBeGreaterThanOrEqual(1)
  })

  it('is a no-op at the same size, and never returns a size below 1', () => {
    const d = styled()
    expect(withTitleFontSize(d, 96)).toBe(d)
    expect(withTitleFontSize(d, 0).fontSizePx).toBe(1)
  })

  it('handles a title with no outline or box (the default shape)', () => {
    // A default title ships a drop shadow but no outline and no box.
    const plain = { ...defaultTitleDef('Hi'), fontSizePx: 96 }
    const out = withTitleFontSize(plain, 192)
    expect(out.fontSizePx).toBe(192)
    expect(out.outline).toBeUndefined()
    expect(out.box).toBeUndefined()
    expect(out.shadow!.blurPx).toBe(plain.shadow!.blurPx * 2)
    expect(out.shadow!.dy).toBe(plain.shadow!.dy * 2)
  })
})

describe('decoration survives a there-and-back size change', () => {
  it('never lets a non-zero measurement round away to nothing', () => {
    // 0 is a fixed point of a multiply, so anything that rounds to 0 on the way
    // DOWN can never come back on the way up. The shadow would be gone for good.
    const tiny = withTitleFontSize(styled({ fontSizePx: 240 }), 8)
    expect(tiny.shadow!.blurPx).toBeGreaterThanOrEqual(1)
    expect(tiny.shadow!.dy).toBeGreaterThanOrEqual(1)
    expect(tiny.box!.paddingPx).toBeGreaterThanOrEqual(1)
    expect(tiny.outline!.widthPx).toBeGreaterThanOrEqual(1)

    const back = withTitleFontSize(tiny, 240)
    expect(back.shadow!.blurPx).toBeGreaterThan(1)
    expect(back.box!.paddingPx).toBeGreaterThan(1)
  })

  it('leaves a deliberate ZERO alone: that is how "no outline" is expressed', () => {
    const none = withTitleFontSize(styled({ outline: { color: '#000', widthPx: 0 } }), 240)
    expect(none.outline!.widthPx).toBe(0)
  })

  it('keeps the sign of a negative shadow offset', () => {
    const up = withTitleFontSize(styled({ shadow: { color: '#000', dx: -6, dy: -4, blurPx: 8 } }), 192)
    expect(up.shadow!.dx).toBeLessThan(0)
    expect(up.shadow!.dy).toBeLessThan(0)
  })
})
