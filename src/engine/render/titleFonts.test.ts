import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CUSTOM_TITLE_FONTS, LUCKIEST_GUY_STACK, TITLE_FONT_OPTIONS } from './titleFonts'

// Guard the BUNDLED Minecraft font's glyph coverage. The app is used in Czech,
// so the font must carry every Czech diacritic natively. Otherwise Czech titles
// silently fall back to a non-Minecraft face (and can diverge preview vs export).
// Parses the TrueType cmap (format 4 / 12) directly, no font library needed.

const fontPath = fileURLToPath(new URL('../../assets/fonts/Monocraft.ttf', import.meta.url))

function cmapHasFactory(buf: Buffer): (cp: number) => boolean {
  const u16 = (o: number) => buf.readUInt16BE(o)
  const u32 = (o: number) => buf.readUInt32BE(o)
  const i16 = (o: number) => buf.readInt16BE(o)
  const numTables = u16(4)
  let cmapOff = 0
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16
    if (buf.toString('ascii', r, r + 4) === 'cmap') cmapOff = u32(r + 8)
  }
  if (!cmapOff) throw new Error('no cmap table')
  const nSub = u16(cmapOff + 2)
  let best = 0
  let bestScore = -1
  for (let i = 0; i < nSub; i++) {
    const r = cmapOff + 4 + i * 8
    const pid = u16(r)
    const eid = u16(r + 2)
    const off = u32(r + 4)
    const score = pid === 3 && eid === 10 ? 4 : pid === 3 && eid === 1 ? 3 : pid === 0 ? 2 : pid === 3 && eid === 0 ? 1 : -1
    if (score > bestScore) {
      bestScore = score
      best = cmapOff + off
    }
  }
  const fmt = u16(best)
  return (cp: number): boolean => {
    if (fmt === 4) {
      const segX2 = u16(best + 6)
      const seg = segX2 / 2
      const endO = best + 14
      const startO = endO + segX2 + 2
      const deltaO = startO + segX2
      const rangeO = deltaO + segX2
      for (let s = 0; s < seg; s++) {
        const end = u16(endO + s * 2)
        if (cp > end) continue
        const start = u16(startO + s * 2)
        if (cp < start) return false
        const idr = u16(rangeO + s * 2)
        const delta = i16(deltaO + s * 2)
        if (idr === 0) return ((cp + delta) & 0xffff) !== 0
        return u16(rangeO + s * 2 + idr + (cp - start) * 2) !== 0
      }
      return false
    }
    if (fmt === 12) {
      const nGroups = u32(best + 12)
      for (let g = 0; g < nGroups; g++) {
        const r = best + 16 + g * 12
        if (cp >= u32(r) && cp <= u32(r + 4)) return true
      }
      return false
    }
    throw new Error(`unsupported cmap format ${fmt}`)
  }
}

describe('bundled Minecraft font (Monocraft)', () => {
  const has = cmapHasFactory(readFileSync(fontPath))
  const CZECH = 'áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ'

  it('covers every Czech diacritic', () => {
    const missing = [...CZECH].filter((c) => !has(c.codePointAt(0)!))
    expect(missing).toEqual([])
  })

  it('covers ASCII and common punctuation', () => {
    for (const c of 'ABCabc0123.,!?:-') expect(has(c.codePointAt(0)!)).toBe(true)
  })
})

describe('bundled caption font (Montserrat)', () => {
  const path = fileURLToPath(new URL('../../assets/fonts/Montserrat-Variable.ttf', import.meta.url))
  const has = cmapHasFactory(readFileSync(path))
  const CZECH = 'áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ'

  it('covers ASCII and common punctuation', () => {
    for (const c of "ABCabc0123.,!?:-*'") expect(has(c.codePointAt(0)!)).toBe(true)
  })

  it('covers every Czech diacritic, which the old comic caption face did not', () => {
    const missing = [...CZECH].filter((c) => !has(c.codePointAt(0)!))
    expect(missing).toEqual([])
  })
})

describe('bundled comic font (Lilita One)', () => {
  const lilitaPath = fileURLToPath(new URL('../../assets/fonts/LilitaOne-Regular.ttf', import.meta.url))
  const has = cmapHasFactory(readFileSync(lilitaPath))

  it('covers ASCII and common punctuation', () => {
    for (const c of 'ABCabc0123.,!?:-*') expect(has(c.codePointAt(0)!)).toBe(true)
  })

  it('documents the known Czech gaps: caron glyphs fall back down the stack', () => {
    // Per-glyph canvas fallback is identical in preview and export (same stack
    // registered in both contexts), so this is cosmetic, not a divergence. This
    // is also why it is no longer the CAPTION face: Montserrat covers Czech.
    const missing = [...'čďěňřťů'].filter((c) => !has(c.codePointAt(0)!))
    expect(missing.length).toBeGreaterThan(0)
    for (const c of 'áéíóúý') expect(has(c.codePointAt(0)!)).toBe(true)
  })
})

describe('bundled display font (Luckiest Guy)', () => {
  // His ask, 2026-08-24. Same coverage gate as every other bundled face: the app
  // is used in Czech, and a face that silently drops a diacritic makes a title
  // change shape mid-word.
  const path = fileURLToPath(new URL('../../assets/fonts/LuckiestGuy-Regular.ttf', import.meta.url))
  const has = cmapHasFactory(readFileSync(path))

  it('covers ASCII and common punctuation', () => {
    for (const c of 'ABCabc0123.,!?:-') expect(has(c.codePointAt(0)!)).toBe(true)
  })

  it('is in the dropdown, and its stack is the one the loader registers', () => {
    // The row and the option list are generated from CUSTOM_TITLE_FONTS, so this
    // catches a font added to the loader but missing from the menu, which is a
    // font he cannot choose and would never know shipped.
    const row = CUSTOM_TITLE_FONTS.find((f) => f.label === 'Luckiest Guy')
    expect(row).toBeDefined()
    expect(row!.family).toBe('Luckiest Guy')
    expect(row!.stack).toBe(LUCKIEST_GUY_STACK)
    expect(TITLE_FONT_OPTIONS.map((o) => o.value)).toContain(LUCKIEST_GUY_STACK)
  })

  it('covers every Czech diacritic, unlike the other comic face', () => {
    // Measured, not assumed: this file really does carry the full set, which is
    // more than Lilita One manages above. So a Czech title in Luckiest Guy keeps
    // one face all the way through instead of changing shape mid-word.
    const missing = [...'áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ'].filter((c) => !has(c.codePointAt(0)!))
    expect(missing).toEqual([])
  })
})
