// The motion preferences on the UI slice: the numbers a punch is built from,
// and the two that have to survive a reload. The zoom point especially: he sets
// it once with a right-click on his own face and every punch after that
// converges there, so losing it on restart would quietly undo the setting that
// separates his edit from a dead-centre zoom.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ZOOM_ANCHOR, useStore } from './store'

const ANCHOR_KEY = 'olpremiere:zoomAnchor'
const CURVE_KEY = 'olpremiere:moveCurve'

// node env has no localStorage, so back the preferences with an in-memory shim.
const bag = new Map<string, string>()

beforeEach(() => {
  bag.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, v),
    removeItem: (k: string) => void bag.delete(k),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** Boot a FRESH store module against whatever the shim is holding. */
async function reboot() {
  vi.resetModules()
  return (await import('./store')).useStore.getState().ui
}

describe('motion defaults', () => {
  it('opens on a 5-frame rise, the snap curve and the eye-line anchor', async () => {
    const ui = await reboot()
    expect(ui.punchRiseFrames).toBe(5)
    expect(ui.moveCurve).toBe('snapIn')
    expect(ui.zoomAnchor).toEqual({ x: 0.5, y: 0.4 })
    // The Reset button restores this exact point, so it is one constant.
    expect(DEFAULT_ZOOM_ANCHOR).toEqual({ x: 0.5, y: 0.4 })
  })
})

describe('persisted motion preferences', () => {
  it('saves the zoom point and the move curve through setUI', () => {
    useStore.getState().setUI({ zoomAnchor: { x: 0.32, y: 0.28 }, moveCurve: 'overshoot' })
    expect(JSON.parse(bag.get(ANCHOR_KEY)!)).toEqual({ x: 0.32, y: 0.28 })
    expect(bag.get(CURVE_KEY)).toBe('overshoot')
  })

  it('leaves the rest of the UI slice unpersisted', () => {
    useStore.getState().setUI({ punchDepth: 1.7, punchRiseFrames: 9 })
    expect(bag.size).toBe(0)
  })

  it('reads both back on the next boot', async () => {
    bag.set(ANCHOR_KEY, JSON.stringify({ x: 0.7, y: 0.2 }))
    bag.set(CURVE_KEY, 'settle')
    const ui = await reboot()
    expect(ui.zoomAnchor).toEqual({ x: 0.7, y: 0.2 })
    expect(ui.moveCurve).toBe('settle')
  })

  it('clamps a stored anchor back inside the frame', async () => {
    bag.set(ANCHOR_KEY, JSON.stringify({ x: 4, y: -2 }))
    expect((await reboot()).zoomAnchor).toEqual({ x: 1, y: 0 })
  })

  it('boots on the default rather than on NaN when the stored anchor is junk', async () => {
    bag.set(ANCHOR_KEY, '{"x":')
    expect((await reboot()).zoomAnchor).toEqual(DEFAULT_ZOOM_ANCHOR)
    bag.set(ANCHOR_KEY, JSON.stringify({ x: 'left', y: 0.4 }))
    expect((await reboot()).zoomAnchor).toEqual(DEFAULT_ZOOM_ANCHOR)
  })

  it('falls back when the stored curve is not one of the six', async () => {
    // 'constructor' is the one that matters: a plain `in` check would let an
    // Object.prototype key through and hand the builders undefined.
    bag.set(CURVE_KEY, 'constructor')
    expect((await reboot()).moveCurve).toBe('snapIn')
    bag.set(CURVE_KEY, 'bouncy')
    expect((await reboot()).moveCurve).toBe('snapIn')
  })
})
