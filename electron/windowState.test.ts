// The editor opens where he left it, on whichever of his three screens, and never off
// screen. See ./windowState.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { centreIn, FIRST_SIZE, readWindowState, restoreBounds, writeWindowState, type DisplayLike } from './windowState'

// Three screens side by side, the main one in the middle, each with a taskbar.
const MAIN: DisplayLike = { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1392 } }
const G40B: DisplayLike = { id: 2, workArea: { x: 2560, y: 0, width: 1920, height: 1032 } }
const G3: DisplayLike = { id: 3, workArea: { x: -1920, y: 0, width: 1920, height: 1032 } }
const ALL = [MAIN, G40B, G3]

const inside = (r: { x: number; y: number; width: number; height: number }, d: DisplayLike): boolean =>
  r.x >= d.workArea.x &&
  r.y >= d.workArea.y &&
  r.x + r.width <= d.workArea.x + d.workArea.width &&
  r.y + r.height <= d.workArea.y + d.workArea.height

describe('restoreBounds', () => {
  it('the first time: the main screen, maximized, as it always opened', () => {
    const p = restoreBounds(null, ALL, MAIN)
    expect(p.maximized).toBe(true)
    expect(p.displayId).toBe(MAIN.id)
    expect(p.bounds.width).toBe(FIRST_SIZE.width)
    expect(inside(p.bounds, MAIN)).toBe(true)
  })

  it('back on the G40B, at the size he left it', () => {
    const bounds = { x: 2700, y: 100, width: 1500, height: 800 }
    expect(restoreBounds({ bounds, maximized: false, displayId: 2 }, ALL, MAIN)).toEqual({ bounds, maximized: false, displayId: 2 })
  })

  it('a maximized window stays maximized, on its own screen', () => {
    const p = restoreBounds({ bounds: { x: -1800, y: 50, width: 1600, height: 900 }, maximized: true, displayId: 3 }, ALL, MAIN)
    expect(p.maximized).toBe(true)
    expect(p.displayId).toBe(G3.id)
    expect(inside(p.bounds, G3)).toBe(true)
  })

  it('a screen that is gone: the main one, never off screen', () => {
    const p = restoreBounds({ bounds: { x: 2700, y: 100, width: 1500, height: 800 }, maximized: true, displayId: 2 }, [MAIN, G3], MAIN)
    expect(p.displayId).toBe(MAIN.id)
    expect(p.maximized).toBe(true)
    expect(inside(p.bounds, MAIN)).toBe(true)
    expect(p.bounds.width).toBe(1500)
  })

  it('the G40B switched to 1280x1024 for CS2: still there, shrunk to fit', () => {
    const small: DisplayLike = { id: 2, workArea: { x: 2560, y: 0, width: 1280, height: 984 } }
    const p = restoreBounds({ bounds: { x: 2560, y: 0, width: 1920, height: 1032 }, maximized: false, displayId: 2 }, [MAIN, small, G3], MAIN)
    expect(p.displayId).toBe(2)
    expect(inside(p.bounds, small)).toBe(true)
    expect(p.bounds).toEqual({ x: 2560, y: 0, width: 1280, height: 984 })
  })

  it('a window that mostly hangs off its screen is pulled back onto the screen it was on', () => {
    const tiny: DisplayLike = { id: 2, workArea: { x: 2560, y: 0, width: 800, height: 600 } }
    const p = restoreBounds({ bounds: { x: 2900, y: 200, width: 1500, height: 800 }, maximized: false, displayId: 2 }, [MAIN, tiny], MAIN)
    expect(p.displayId).toBe(2)
    expect(inside(p.bounds, tiny)).toBe(true)
  })

  it('treats a broken save as nothing saved', () => {
    for (const odd of [{ bounds: { x: 1, y: 2 } }, { bounds: { x: 0, y: 0, width: 0, height: 10 } }, { bounds: null }]) {
      expect(restoreBounds(odd as never, ALL, MAIN).maximized).toBe(true)
    }
  })
})

describe('centreIn', () => {
  it('puts the cards in the middle of the screen the editor is on, not always the main one', () => {
    expect(centreIn(G40B.workArea, 700, 520)).toEqual({ x: 2560 + 610, y: 256 })
    expect(centreIn(G3.workArea, 700, 520)).toEqual({ x: -1920 + 610, y: 256 })
  })
})

describe('the file', () => {
  it('round trips, and anything odd reads as nothing saved', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'olp-winstate-'))
    try {
      const file = path.join(dir, 'window-state.json')
      expect(readWindowState(file)).toBeNull()
      writeWindowState(file, { bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true, displayId: 2 })
      expect(readWindowState(file)).toEqual({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true, displayId: 2 })
      writeFileSync(file, '{not json')
      expect(readWindowState(file)).toBeNull()
      expect(() => writeWindowState(path.join(dir, 'no', 'such', 'x.json'), { bounds: { x: 0, y: 0, width: 1, height: 1 }, maximized: false })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
