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
        const code = line.replace(/\/\/.*$/, '')
        for (const [what, re] of BANNED) {
          if (re.test(code)) found.push(`${file.slice(SRC.length)}:${i + 1} ${what}: ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(found, 'use a token (rounded-dialog, -overlay, -field, -inner, -clip, -mark) or rounded-full').toEqual([])
  })
})
