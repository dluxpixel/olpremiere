// How the export reads a clip, with a stand-in decoder that counts what it costs.
//
// ⛔ A REVERSED CLIP USED TO RE-OPEN THE DECODER FOR EVERY FRAME (export audit, 2026-10-06), and
// each re-open decodes forward from the keyframe before the time asked for: on 60 fps OBS footage
// with a keyframe every 2 s, about 60 decodes per frame of a reversed clip where a forward one
// costs one. The stand-in decodes the way mediabunny's CanvasSink does: canvases(t) starts at the
// keyframe before t, decodes every frame from there, and yields from the frame shown at t.

import { describe, expect, it } from 'vitest'
import type { CanvasSink, WrappedCanvas } from 'mediabunny'
import { frameIndexAt, frameReached } from '../frameIndex'
import { frameForClip, reverseWindowFrames, type ClipProvider } from './clipReader'

interface Fake {
  sink: CanvasSink
  decoded: number
  opened: number
}

/** A file of `count` frames at `fps`, a keyframe every `gop`. Each canvas is its frame number. */
function fakeFile(count: number, fps: number, gop: number): Fake {
  const fake = { decoded: 0, opened: 0 } as Fake
  const shownAt = (t: number): number => Math.min(count - 1, Math.max(0, Math.floor(t * fps + 1e-9)))
  fake.sink = {
    canvases: (start = 0) =>
      (async function* () {
        fake.opened++
        const first = shownAt(start)
        const key = first - (first % gop)
        for (let i = key; i < count; i++) {
          fake.decoded++
          if (i >= first) yield { canvas: { frame: i }, timestamp: i / fps, duration: 1 / fps } as unknown as WrappedCanvas
        }
      })(),
  } as unknown as CanvasSink
  return fake
}

function provider(fake: Fake, fps: number, start: number, backFrames: number): ClipProvider {
  return {
    sink: fake.sink,
    iterator: fake.sink.canvases(start),
    dispose: () => undefined,
    started: false,
    current: null,
    ahead: null,
    fps,
    back: null,
    backFrames,
  }
}

const frameOf = (c: unknown): number => (c as { frame: number } | null)?.frame ?? -1

/** What the plain forward reader lands on, opened fresh at t: the frame the preview shows there. */
function truth(count: number, fps: number, t: number): number {
  const first = Math.min(count - 1, Math.max(0, Math.floor(t * fps + 1e-9)))
  let current = -1
  for (let i = first; i < count && frameReached(i / fps, t, fps); i++) current = i
  return current >= 0 ? current : first
}

describe('⛔ a reversed clip decodes a window at a time, not from the keyframe for every frame', () => {
  const FPS = 60
  const GOP = 120 // OBS at 60 fps, a keyframe every 2 s

  /** Reverse play of `frames` frames ending at source time `endS`, at `speed` (negative). */
  async function reverse(backFrames: number, endS: number, frames: number, speed = -1) {
    const fake = fakeFile(600, FPS, GOP)
    const p = provider(fake, FPS, Math.max(0, endS + (frames / FPS) * speed), backFrames)
    const shown: number[] = []
    const want: number[] = []
    let held = 0
    for (let f = 0; f < frames; f++) {
      const t = endS + (f / FPS) * speed
      shown.push(frameOf(await frameForClip(p, t)))
      want.push(truth(600, FPS, t))
      held = Math.max(held, p.back?.frames.length ?? 0)
    }
    return { shown, want, decoded: fake.decoded, held }
  }

  it('shows exactly the frames the forward reader would, so preview and export still agree', async () => {
    for (const speed of [-1, -2, -0.5]) {
      const { shown, want } = await reverse(16, 3.3, 60, speed)
      expect(shown, `speed ${speed}`).toEqual(want)
    }
    // Across the start of the file, clamped to its first frame like the forward reader.
    const { shown, want } = await reverse(16, 0.4, 40)
    expect(shown).toEqual(want)
    expect(shown.at(-1)).toBe(0)
  })

  it('a 60 frame reversed clip in the middle of a 2 s keyframe group: 10 times fewer decodes at 1080p', async () => {
    // backFrames 1 is a window of one frame: a fresh re-open for every frame, as it used to be.
    const old = await reverse(1, 3.3, 60)
    const now = await reverse(reverseWindowFrames(1920, 1080), 3.3, 60)
    expect(now.shown).toEqual(old.shown)
    // Measured with this stand-in, the first forward read of the slice (80 decodes) included:
    // 3,030 decodes before, about 50 for each of the 60 frames; 300 now at 1080p (16 frame
    // window), 208 at 720p (30), 845 at 4K (4).
    expect(old.decoded).toBe(3030)
    expect(now.decoded).toBe(300)
    expect((await reverse(reverseWindowFrames(3840, 2160), 3.3, 60)).decoded).toBeLessThan(old.decoded / 3)
  })

  it('never holds more frames than its window, however long the clip', async () => {
    const { held } = await reverse(16, 9, 400)
    expect(held).toBeGreaterThan(0)
    expect(held).toBeLessThanOrEqual(16)
  })

  it('a forward clip is untouched: every frame decoded once', async () => {
    const fake = fakeFile(600, FPS, GOP)
    const p = provider(fake, FPS, 2.5, 16)
    for (let f = 0; f < 120; f++) {
      const t = 2.5 + f / FPS
      expect(frameOf(await frameForClip(p, t))).toBe(truth(600, FPS, t))
    }
    expect(fake.opened).toBe(1)
    // From the keyframe at 2.0 s to the frame after 4.5 s: 30 of pre-roll, 120 shown, 1 looked ahead.
    expect(fake.decoded).toBe(30 + 120 + 1)
    expect(p.back).toBeNull()
  })

  it('a forward step after reverse play goes back to the plain reader and lands right', async () => {
    const fake = fakeFile(600, FPS, GOP)
    const p = provider(fake, FPS, 3, 16)
    for (const t of [3.2, 3.1, 3.0, 2.95, 4.0, 4.0 + 1 / FPS]) {
      expect(frameOf(await frameForClip(p, t)), `${t}`).toBe(truth(600, FPS, t))
    }
  })
})

describe('the reverse window is a byte budget', () => {
  it('16 frames at 1080p, 30 at 720p and below, 4 at 4K', () => {
    expect(reverseWindowFrames(1920, 1080)).toBe(16)
    expect(reverseWindowFrames(1080, 1920)).toBe(16)
    expect(reverseWindowFrames(1280, 720)).toBe(30)
    expect(reverseWindowFrames(3840, 2160)).toBe(4)
    expect(reverseWindowFrames(0, 0)).toBe(30)
  })
})

// The frame index helper is what decides "the same frame": keep the stand-in honest about it.
it('the stand-in shows frame i from i / fps', () => {
  expect(frameIndexAt(3.3, 60)).toBe(198)
})
