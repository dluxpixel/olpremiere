// Frames made by hand, so "a bright thing moved to the left" can be asserted
// without a decoder or a fixture file.

import { describe, expect, it } from 'vitest'
import { greyFromRgba, motionCentre, NOISE_FLOOR, scanFrames, scanTimesS, SCAN_SAMPLES } from './actionScan'

const W = 32
const H = 18

/** A grey frame with one bright block in it, centred on (cx, cy) in pixels. */
function frameWithBlock(cx: number, cy: number, size = 4, level = 255, base = 40): Uint8Array {
  const f = new Uint8Array(W * H).fill(base)
  const half = size / 2
  for (let y = Math.max(0, Math.round(cy - half)); y < Math.min(H, Math.round(cy + half)); y++) {
    for (let x = Math.max(0, Math.round(cx - half)); x < Math.min(W, Math.round(cx + half)); x++) {
      f[y * W + x] = level
    }
  }
  return f
}

describe('motionCentre', () => {
  it('lands on the thing that moved, not on the middle of the picture', () => {
    // A block appears on the left quarter. Nothing else changes.
    const a = new Uint8Array(W * H).fill(40)
    const b = frameWithBlock(W * 0.25, H / 2)
    const s = motionCentre(a, b, W, H)
    expect(s).not.toBeNull()
    expect(s!.x).toBeCloseTo(0.25, 1)
    expect(s!.y).toBeCloseTo(0.5, 1)
  })

  it('follows the block from one side to the other', () => {
    const left = motionCentre(frameWithBlock(4, H / 2), frameWithBlock(6, H / 2), W, H)!
    const right = motionCentre(frameWithBlock(W - 6, H / 2), frameWithBlock(W - 4, H / 2), W, H)!
    expect(left.x).toBeLessThan(0.35)
    expect(right.x).toBeGreaterThan(0.65)
  })

  it('says nothing moved rather than answering the middle', () => {
    const f = frameWithBlock(10, 9)
    expect(motionCentre(f, f, W, H)).toBeNull()
  })

  // ⛔ THE REASON THE WEIGHT IS SQUARED. A wide dim drift is what a camera does
  // and a small violent change is what the action does; on a linear weight the
  // drift wins and the answer creeps back to the centre on exactly the frames
  // that matter.
  it('lets one violent change outweigh a wide gentle one', () => {
    const base = new Uint8Array(W * H).fill(40)
    const next = new Uint8Array(base)
    // A gentle lift across the whole RIGHT half, just above the noise floor.
    for (let y = 0; y < H; y++) for (let x = W / 2; x < W; x++) next[y * W + x] = 40 + NOISE_FLOOR + 2
    // A violent flash in a tiny patch on the LEFT.
    for (let y = 8; y < 10; y++) for (let x = 3; x < 5; x++) next[y * W + x] = 255
    const s = motionCentre(base, next, W, H)!
    expect(s.x).toBeLessThan(0.5)
  })

  it('ignores a change too small to be anything but the encoder', () => {
    const a = new Uint8Array(W * H).fill(40)
    const b = new Uint8Array(W * H).fill(40 + NOISE_FLOOR - 1)
    expect(motionCentre(a, b, W, H)).toBeNull()
  })

  it('refuses a frame it cannot read rather than inventing a centre', () => {
    expect(motionCentre(new Uint8Array(4), new Uint8Array(4), 0, 0)).toBeNull()
    expect(motionCentre(new Uint8Array(4), new Uint8Array(W * H), W, H)).toBeNull()
  })
})

describe('scanFrames', () => {
  it('gives one sample per pair and drops the still ones', () => {
    const still = frameWithBlock(10, 9)
    const moved = frameWithBlock(20, 9)
    expect(scanFrames([still, still, still], W, H)).toHaveLength(0)
    expect(scanFrames([still, moved, still], W, H)).toHaveLength(2)
  })

  it('cannot find change in fewer than two frames', () => {
    expect(scanFrames([frameWithBlock(10, 9)], W, H)).toHaveLength(0)
    expect(scanFrames([], W, H)).toHaveLength(0)
  })
})

describe('greyFromRgba', () => {
  it('reads green as the brightest and blue as the dimmest, like the eye does', () => {
    const px = (r: number, g: number, b: number): Uint8ClampedArray => Uint8ClampedArray.from([r, g, b, 255])
    const [red] = greyFromRgba(px(255, 0, 0), 1, 1)
    const [green] = greyFromRgba(px(0, 255, 0), 1, 1)
    const [blue] = greyFromRgba(px(0, 0, 255), 1, 1)
    expect(green).toBeGreaterThan(red)
    expect(red).toBeGreaterThan(blue)
    expect(greyFromRgba(px(255, 255, 255), 1, 1)[0]).toBeGreaterThan(250)
    expect(greyFromRgba(px(0, 0, 0), 1, 1)[0]).toBe(0)
  })
})

describe('scanTimesS', () => {
  it('spends the same number of looks on a short clip and a long one', () => {
    expect(scanTimesS(0, 0.4)).toHaveLength(SCAN_SAMPLES)
    expect(scanTimesS(0, 60)).toHaveLength(SCAN_SAMPLES)
  })

  it('starts at the start and ends at the end', () => {
    const t = scanTimesS(2, 6)
    expect(t[0]).toBeCloseTo(2, 10)
    expect(t[t.length - 1]).toBeCloseTo(6, 10)
  })

  it('answers a single time for a clip with no length rather than dividing by zero', () => {
    expect(scanTimesS(3, 3)).toEqual([3])
    expect(scanTimesS(5, 1)).toEqual([5])
    expect(scanTimesS(Number.NaN, Number.NaN)).toEqual([0])
  })
})
