// The scrub instrument: move the playhead, then time inside the page how long the
// program monitor takes to show it. Used by scrub-repaint.spec.ts (the repo's own
// fixture, in the gate) and scrub-cost.spec.ts (his project, by hand).
//
// ⛔ EVERYTHING IS TIMED IN THE PAGE. The first scrub instrument took an element
// screenshot per poll, and every ship since September printed "0 never repainted
// within 4s. median 8209ms": a hop that repainted inside 4 s cannot take 8 s, so it
// was timing the screenshots. Here the playhead is set and the canvas is read every
// animation frame in one page.evaluate, with no round trip per read, so the number
// is the app's. The preview context keeps its drawing buffer (preview.ts), so a
// 2d copy of the WebGL canvas is the frame on screen.

import type { Page } from '@playwright/test'
import { parkModules, type ParkedWindow } from './storeWrites'

/** A hop that has not repainted by now counts as never repainted. */
export const HOP_LIMIT_MS = 4000

/**
 * What a hop waits for: any change at all to the picture (his project, where the
 * test cannot know what the frame looks like), or the fixture's red or blue half.
 */
export type HopWant = 'changed' | 'red' | 'blue'

/** A coarse fingerprint of the program monitor: 16 pixels from a 4x4 grid, RGBA. */
export async function readGrid(page: Page): Promise<number[] | null> {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement | null
    if (!c || c.width === 0) return null
    const scratch = document.createElement('canvas')
    scratch.width = 4
    scratch.height = 4
    const ctx = scratch.getContext('2d')!
    ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 4, 4)
    return Array.from(ctx.getImageData(0, 0, 4, 4).data)
  })
}

/** True when some cell of the grid carries a picture: not black, not transparent. */
export function gridShowsAPicture(grid: number[] | null): boolean {
  if (!grid) return false
  for (let i = 0; i < grid.length; i += 4) {
    if (grid[i + 3] > 0 && Math.max(grid[i], grid[i + 1], grid[i + 2]) > 20) return true
  }
  return false
}

/**
 * Move the playhead to `at`, then time how long until the picture shows `want`,
 * in the page. Resolves to milliseconds, or -1 when it did not within `limitMs`.
 */
export async function hop(page: Page, at: number, want: HopWant = 'changed', limitMs = HOP_LIMIT_MS): Promise<number> {
  await parkModules(page, ['/src/state/store.ts'])
  return page.evaluate(
    ({ at, want, limit }) => {
      const mods = (window as unknown as ParkedWindow).__e2eMods
      const storeMod = '/src/state/store.ts'
      const { useStore } = mods[storeMod] as {
        useStore: { getState: () => { setUI: (u: { playheadS: number }) => void } }
      }
      const scratch = document.createElement('canvas')
      scratch.width = 4
      scratch.height = 4
      const ctx = scratch.getContext('2d', { willReadFrequently: true })!
      const grid = (): Uint8ClampedArray | null => {
        const c = document.querySelector('[data-testid="program-canvas"]') as HTMLCanvasElement | null
        if (!c || c.width === 0) return null
        ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 4, 4)
        return ctx.getImageData(0, 0, 4, 4).data
      }
      // The fixture is red (230, 57, 70) for its first second and blue (43, 108, 176)
      // after it. The two centre cells of the grid are the middle of the picture.
      const centreIs = (g: Uint8ClampedArray, colour: 'red' | 'blue'): boolean =>
        [5, 6, 9, 10].every((cell) => {
          const [r, , b] = [g[cell * 4], g[cell * 4 + 1], g[cell * 4 + 2]]
          return colour === 'red' ? r > 150 && b < 120 : b > 130 && r < 100
        })
      const first = grid()
      const before = first ? first.join(',') : ''
      const done = (g: Uint8ClampedArray | null): boolean => {
        if (!g) return false
        if (want === 'changed') return g.join(',') !== before
        return centreIs(g, want)
      }
      const t0 = performance.now()
      useStore.getState().setUI({ playheadS: at })
      return new Promise<number>((resolve) => {
        const tick = (): void => {
          const now = performance.now() - t0
          if (done(grid())) resolve(now)
          else if (now > limit) resolve(-1)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    { at, want, limit: limitMs },
  )
}
