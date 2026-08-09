// The desktop splash card and the in-app loading card are the SAME card drawn by
// two different renderers, and their stylesheets are two files on purpose: the
// splash page must not import the app stylesheet, or the window whose whole job is
// to be on screen before the editor bundle is read off disk would be waiting for
// that bundle.
//
// A comment saying "keep these in step" is not a mechanism. Nothing in this repo
// compared the two files until 2026-08-09, so the copy could drift silently, and a
// redesign that touched one and not the other would have shipped a splash window
// that did not match the card it is a copy of. This is the mechanism.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const card = readFileSync(new URL('./LoadingCard.module.css', import.meta.url), 'utf8')
const splash = readFileSync(new URL('../splash/splash.css', import.meta.url), 'utf8')

const SHARED_START = '/* SHARED WITH LoadingCard.module.css'
const SHARED_END = '/* END SHARED WITH LoadingCard.module.css'

/** Comments and whitespace out: what is left is the rules and nothing else. */
function rulesOnly(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The part of splash.css that claims to be a copy, between its two markers. */
function sharedRegion(css: string): string {
  const from = css.indexOf(SHARED_START)
  const to = css.indexOf(SHARED_END, from + 1)
  expect(from, 'splash.css has lost its SHARED WITH marker').toBeGreaterThanOrEqual(0)
  expect(to, 'splash.css has lost its END SHARED marker').toBeGreaterThan(from)
  return css.slice(from, to)
}

describe('the splash window card is a real copy of the in-app card', () => {
  it('carries every rule LoadingCard.module.css does, declaration for declaration', () => {
    // Not a spot check on a handful of properties: the whole shared region, or the
    // next person edits one file and finds out on his desktop.
    expect(rulesOnly(sharedRegion(splash))).toBe(rulesOnly(card))
  })

  it('keeps the splash-only rules OUT of the shared region', () => {
    // The window, the drag handle and the melon it shrinks to exist only in the
    // splash. Anything from that list inside the copy means the two files have
    // started to be edited as one, and the comparison above would then be pinning
    // the in-app card to a window it does not live in.
    const shared = sharedRegion(splash)
    for (const splashOnly of ['melonStage', 'melonHero', 'halo', '-webkit-app-region']) {
      expect(shared).not.toContain(splashOnly)
    }
  })

  it('declares the tokens the app stylesheet would have given it', () => {
    // The copy uses var(--font-sans), var(--font-mono) and the radius tokens. The
    // splash page loads no index.css, so its own :root has to carry them or the
    // wordmark falls back to a serif and the corners go square.
    const head = splash.slice(0, splash.indexOf(SHARED_START))
    for (const token of ['--font-sans', '--font-mono', '--radius-dialog', '--radius-clip']) {
      expect(head).toContain(token)
    }
    for (const token of ['--font-sans', '--font-mono', '--radius-dialog', '--radius-clip']) {
      expect(card).toContain(`var(${token})`)
    }
  })
})

describe('the faults the redesign was for', () => {
  it('has no diagonal left on the brand pane', () => {
    // His words: "the starting up text is completed right to the app thing". The
    // pane's slanted clip-path put a different gap in front of every row of the
    // list, and the coral line drawn down it read as a slash through the checklist.
    for (const css of [card, splash]) {
      expect(css).not.toMatch(/clip-path/)
      expect(css).not.toMatch(/\.seam/)
    }
  })

  it('draws the bar as one segment per row, not as one width', () => {
    // A single filled width is what let the bar be full while three rows under it
    // were plainly unfinished. Segments can be counted against the ticks above.
    for (const css of [card, splash]) {
      expect(css).toMatch(/\.seg\s*\{/)
      expect(css).not.toMatch(/\.fill\s*\{/)
    }
  })
})
