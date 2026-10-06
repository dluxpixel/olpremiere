// Where the editor was, so it opens there again. Pure placement maths plus a tiny file,
// so it can be tested without a screen.
//
// He has three screens. Until 2026-10-06 every launch, and every update relaunch, opened
// the editor maximized on the main one, wherever he had moved it, and the opening card
// and the update card always sat in the middle of the main screen too. Now the editor's
// screen, size and maximized state are kept in userData/window-state.json and given back,
// as long as that place still exists: a screen that is gone, or one switched to a lower
// resolution for a game, must never leave the window off screen or bigger than it.

import { readFileSync, writeFileSync } from 'node:fs'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The part of Electron's Display this needs. */
export interface DisplayLike {
  id: number
  workArea: Rect
}

export interface SavedWindowState {
  /** The window's normal (not maximized) bounds. */
  bounds: Rect
  maximized: boolean
  displayId?: number
}

export interface Placement {
  bounds: Rect
  maximized: boolean
  /** The screen it opens on, so the cards can open there too. */
  displayId: number
}

export const WINDOW_STATE_FILE = 'window-state.json'

/** The size the editor opens at the very first time, before it is maximized. */
export const FIRST_SIZE = { width: 1600, height: 1000 }

/** At least this much of the window has to land on a screen to count as being on it. */
const ON_SCREEN_SHARE = 0.5

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** `size` centred in `area`, never bigger than it. */
function centred(size: { width: number; height: number }, area: Rect): Rect {
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  }
}

/** Shrink `r` to fit `area` and slide it inside, keeping as much of where it was as fits. */
function clampInto(r: Rect, area: Rect): Rect {
  const width = Math.min(r.width, area.width)
  const height = Math.min(r.height, area.height)
  const x = Math.min(Math.max(r.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(r.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

function isRect(r: unknown): r is Rect {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return (['x', 'y', 'width', 'height'] as const).every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]))
}

/**
 * Where to open the editor, given what was saved (or null) and the screens there are now.
 *
 * - nothing saved: the main screen, maximized, as it always opened
 * - saved on a screen it still mostly lands on: there, fitted inside it
 * - that screen is still there but changed (a lower resolution for a game): on it, shrunk
 * - that screen is gone: the main screen, at the saved size where it fits
 */
export function restoreBounds(saved: SavedWindowState | null, displays: readonly DisplayLike[], primary: DisplayLike): Placement {
  if (!saved || !isRect(saved.bounds) || saved.bounds.width <= 0 || saved.bounds.height <= 0) {
    return { bounds: centred(FIRST_SIZE, primary.workArea), maximized: true, displayId: primary.id }
  }
  const maximized = saved.maximized === true
  const area = saved.bounds.width * saved.bounds.height
  let best: DisplayLike | null = null
  let bestShare = 0
  for (const d of displays) {
    const share = overlapArea(saved.bounds, d.workArea) / area
    if (share > bestShare) {
      best = d
      bestShare = share
    }
  }
  if (best && bestShare >= ON_SCREEN_SHARE) {
    return { bounds: clampInto(saved.bounds, best.workArea), maximized, displayId: best.id }
  }
  const same = displays.find((d) => d.id === saved.displayId)
  if (same) return { bounds: clampInto(saved.bounds, same.workArea), maximized, displayId: same.id }
  return { bounds: centred(saved.bounds, primary.workArea), maximized, displayId: primary.id }
}

/** Where a w by h card sits in the middle of `area`: the opening card and the update card. */
export function centreIn(area: Rect, w: number, h: number): { x: number; y: number } {
  return { x: area.x + Math.round((area.width - w) / 2), y: area.y + Math.round((area.height - h) / 2) }
}

/** Read the saved state. Anything missing or odd is "nothing saved". */
export function readWindowState(file: string): SavedWindowState | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedWindowState>
    if (!isRect(raw.bounds)) return null
    return {
      bounds: raw.bounds,
      maximized: raw.maximized === true,
      displayId: typeof raw.displayId === 'number' ? raw.displayId : undefined,
    }
  } catch {
    return null
  }
}

/** Write it. Never throws: a window that forgets its place is not worth an error. */
export function writeWindowState(file: string, state: SavedWindowState): void {
  try {
    writeFileSync(file, JSON.stringify(state))
  } catch {
    // see above
  }
}
