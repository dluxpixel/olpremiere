// The corner radius scale, and the promise that nothing steps outside it.
//
// His words, 2026-10-03: "make every GUI more rounded, make the corners a little bit more rounded
// everywhere". The scale moved up together (src/index.css has the steps and why), and what keeps it
// one scale is that a corner is a TOKEN. A lone `rounded-[3px]` is how the old look got
// inconsistent in the first place, and nothing but this file notices one being added.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const indexCss = readFileSync(join(SRC, 'index.css'), 'utf8')
const splashCss = readFileSync(join(SRC, 'splash', 'splash.css'), 'utf8')

/** The px value a `--radius-<name>: Npx;` line declares. */
function token(css: string, name: string): number {
  const m = css.match(new RegExp(`--radius-${name}:\\s*([0-9.]+)px;`))
  expect(m, `--radius-${name} is not declared in px`).not.toBeNull()
  return Number(m![1])
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'assets' ? [] : sourceFiles(full)
    return /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

describe('the radius scale', () => {
  const dialog = token(indexCss, 'dialog')
  const overlay = token(indexCss, 'overlay')
  const field = token(indexCss, 'field')
  const inner = token(indexCss, 'inner')
  const clip = token(indexCss, 'clip')
  const mark = token(indexCss, 'mark')

  it('gets smaller with the box: dialog, overlay, field, inner, mark', () => {
    // Nested elements use a smaller inner radius than their container, so the steps
    // only ever go down. A step that equals the one above it is how a button ended
    // up exactly as round as the segmented well it sits in.
    expect(dialog).toBeGreaterThan(overlay)
    expect(overlay).toBeGreaterThan(field)
    expect(field).toBeGreaterThan(inner)
    expect(inner).toBeGreaterThan(mark)
  })

  it('keeps a timeline clip no rounder than a field, so its ends still read as ends', () => {
    expect(clip).toBeLessThanOrEqual(field)
    expect(clip).toBeGreaterThan(mark)
  })

  it('stops at 12px: past that is the "rounded everywhere" look he turned down twice', () => {
    expect(Math.max(dialog, overlay, field, inner, clip, mark)).toBeLessThanOrEqual(12)
  })

  it('is the same scale on the splash page, which does not load index.css', () => {
    expect(token(splashCss, 'dialog')).toBe(dialog)
    expect(token(splashCss, 'clip')).toBe(clip)
  })
})

describe('no corner is a number', () => {
  const BANNED: Array<[string, RegExp]> = [
    ['a pixel radius class', /rounded-\[[^\]]*\]/],
    ['a stock Tailwind radius step', /\brounded-(xs|sm|md|lg|xl|2xl|3xl)\b/],
    ['a bare `rounded` class', /(["'`\s])rounded(["'`\s])/],
    ['an inline borderRadius', /\bborderRadius\b/],
    ['a CSS radius in px or rem', /border-radius:\s*[0-9.]+(px|rem|em)/],
  ]

  it('anywhere in the app source', () => {
    const found: string[] = []
    for (const file of sourceFiles(SRC)) {
      // Prose is free to say "rounded": comments are not corners. Block comments go with
      // their line breaks kept, so a hit still reports the line it is really on.
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
      text.split('\n').forEach((line, i) => {
        // A corner that belongs to his CONTENT, not the app (a caption's own background
        // box drawn in a preview at its real radius), says so on its line and is skipped.
        if (/\/\/\s*corner-is-content\b/.test(line)) return
        const code = line.replace(/\/\/.*$/, '')
        for (const [what, re] of BANNED) {
          if (re.test(code)) found.push(`${file.slice(SRC.length)}:${i + 1} ${what}: ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(found, 'use a token (rounded-dialog, -overlay, -field, -inner, -clip, -mark) or rounded-full').toEqual([])
  })
})

// ⛔ ROUNDED-FULL IS FOR CIRCLES (2026-10-07). index.css says so: knobs, dots, LEDs, and the thin
// bars and lines whose ends are round. The check above let it through anywhere, so the toast's
// Undo button, the export chip, the live room badge, the captioning card, the effect's Off chip
// and the shuttle badge were text pills, the "rounded everywhere" look he turned down twice, next
// to 6px buttons in the same bar. A text pill gives itself away by its side padding, or by a
// height of 20px or more with no width to match.
describe('rounded-full', () => {
  /** Tailwind spacing steps are 4px each. Null when the class is not a number of steps or px. */
  const px = (v: string): number | null => {
    const arb = /^\[([0-9.]+)px\]$/.exec(v)
    if (arb) return Number(arb[1])
    return /^[0-9.]+$/.test(v) ? Number(v) * 4 : null
  }

  /** Why this class string is a text pill, or null when it is a circle, a dot or a bar. */
  function pillReason(classes: string): string | null {
    if (/(?:^|\s)p[xlr]-/.test(classes)) return 'side padding'
    const h = /(?:^|\s)h-(\S+)/.exec(classes)?.[1]
    const w = /(?:^|\s)w-(\S+)/.exec(classes)?.[1]
    const tall = h === undefined ? null : px(h)
    if (tall !== null && tall >= 20 && w !== h) return `${tall}px tall with no width to match`
    return null
  }

  it('is a circle, a dot or a bar, never a text pill', () => {
    const found: string[] = []
    for (const file of sourceFiles(SRC)) {
      if (!file.endsWith('.tsx')) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/\brounded-full\b/.test(line.replace(/\/\/.*$/, ''))) return
          const why = pillReason(line)
          if (why) found.push(`${file.slice(SRC.length)}:${i + 1} ${why}: ${line.trim().slice(0, 90)}`)
        })
    }
    expect(found, 'a button or chip is rounded-field, a card or badge rounded-overlay').toEqual([])
  })

  it('tells a pill from a circle', () => {
    expect(pillReason('shrink-0 rounded-full bg-accent px-2.5 py-0.5')).toBe('side padding')
    expect(pillReason('flex h-7 min-w-0 rounded-full border')).toBe('28px tall with no width to match')
    expect(pillReason('h-1.5 w-1.5 shrink-0 rounded-full bg-warning')).toBeNull()
    expect(pillReason('flex h-11 w-11 items-center rounded-full')).toBeNull()
    expect(pillReason('mt-2 h-1 overflow-hidden rounded-full bg-bg-input')).toBeNull()
    expect(pillReason('h-full rounded-full bg-ember')).toBeNull()
  })
})
