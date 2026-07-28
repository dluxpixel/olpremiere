// The splash window's second beat is split across three files that cannot see
// each other: JavaScript waits, CSS animates, and the Electron main process
// resizes the window and closes it. Nothing at runtime would ever complain if one
// of those numbers moved, so this is where they are held together.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SPLASH_CARD_EXIT_MS, SPLASH_MELON_POP_MS, SPLASH_MELON_PX } from '../../electron/ipc-types'

const css = readFileSync(new URL('./splash.css', import.meta.url), 'utf8')
const main = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8')

/** Every `<n>px` a named CSS rule sets for `prop`, in source order. */
function pxIn(rule: string, prop: string): number[] {
  const block = new RegExp(`\\.${rule}\\s*\\{([^}]*)\\}`, 'g')
  const out: number[] = []
  for (const m of css.matchAll(block)) {
    for (const v of m[1].matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`, 'g'))) out.push(Number(v[1]))
  }
  return out
}

describe('the splash card handing over to the melon', () => {
  it('waits exactly as long as the card takes to leave', () => {
    // splash.ts sleeps SPLASH_CARD_EXIT_MS before swapping in the melon. A shorter
    // animation leaves dead air; a longer one cuts the card off mid-pop.
    expect(css).toContain(`cardOut ${SPLASH_CARD_EXIT_MS}ms`)
  })

  it('keeps the window alive for exactly the length of the pop', () => {
    // main.ts closes the splash SPLASH_MELON_POP_MS after the click. If the CSS ran
    // longer the fruit would be cut off mid-burst; if shorter, a blank square would
    // sit over the editor.
    expect(css).toContain(`melonPop ${SPLASH_MELON_POP_MS}ms`)
    expect(main).toContain('SPLASH_MELON_POP_MS')
  })
})

describe('the melon fits the square it is given', () => {
  it('never outgrows the window, even at the top of its pop', () => {
    const [melon] = pxIn('melonHero', 'width')
    expect(melon).toBeGreaterThan(0)
    // melonPop peaks at scale(1.5). Past the window edge the fruit is clipped, and
    // a clipped burst is worse than no burst at all.
    expect(melon * 1.5).toBeLessThanOrEqual(SPLASH_MELON_PX)
  })

  it('keeps the glow inside the square too', () => {
    const [halo] = pxIn('halo', 'width')
    expect(halo).toBeGreaterThan(0)
    // The halo is blurred by 6px, which spreads it a little past its box.
    expect(halo + 12).toBeLessThanOrEqual(SPLASH_MELON_PX)
  })

  it('puts no text on his wallpaper', () => {
    // The window is transparent, so any caption sits on whatever is behind it and
    // no colour survives every wallpaper. The fruit is the whole affordance.
    expect(css).not.toMatch(/\.hint\s*\{/)
  })
})

describe('the melon is a button, not a drag handle', () => {
  it('opts the fruit out of the window drag region', () => {
    // The whole stage drags the window. A drag region swallows clicks outright, so
    // without this the melon would look like a button and do nothing at all.
    expect(css).toMatch(/\.melonStage\s*\{[^}]*-webkit-app-region:\s*drag/)
    expect(css).toMatch(/\.melonBtn\s*\{[^}]*-webkit-app-region:\s*no-drag/)
  })
})
