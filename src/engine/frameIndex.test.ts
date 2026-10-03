// Which frame shows at a moment: the NEAREST one, and the same one in the
// paused preview and in the export.
//
// ⛔ FOUND 2026-09-29 on his iPhone clips: both sides took the last frame that
// had STARTED (a floor), so on a cut whose in point is off the frame grid the
// picture ran behind the sound by up to a whole frame, 24.1 ms on average over
// his seven GYM cuts and always in the same direction.
//
// The model below is his phone's real shape: a 1/600 time base, 20 ticks a
// frame, and a few frames a tick early or late (his clips have 4 and 9).

import { describe, expect, it } from 'vitest'
import { frameIndexAt } from './frameCache'
import { frameReached } from './frameIndex'

const FPS = 30

/** Frame start times of a 30 fps iPhone clip, with his kind of one tick jitter. */
function iphoneTimes(frames: number): number[] {
  const ticks: number[] = []
  let t = 0
  for (let i = 0; i < frames; i++) {
    ticks.push(t)
    // A 19 tick frame and the 21 tick frame that pays it back, now and then.
    t += i % 97 === 40 ? 19 : i % 97 === 41 ? 21 : 20
  }
  return ticks.map((k) => k / 600)
}

/** The export's pull-down: advance while the next frame is reached, show the last one reached. */
function exportPick(times: number[], sourceT: number): number {
  let current = -1
  while (current + 1 < times.length && frameReached(times[current + 1], sourceT, FPS)) current++
  return Math.max(0, current)
}

/**
 * The preview's frame cache: frames are filed under `frameIndexAt` of their own
 * time and looked up under `frameIndexAt` of the wanted time. A slot nothing
 * landed in shows the last frame before it (decodeSequential's overshoot).
 */
function previewPick(times: number[], sourceT: number): number {
  const want = frameIndexAt(sourceT, FPS)
  let last = 0
  for (const [i, t] of times.entries()) {
    const slot = frameIndexAt(t, FPS)
    if (slot === want) return i
    if (slot > want) break
    last = i
  }
  return last
}

/**
 * His seven GYM iPhone cuts, [in, out] in source seconds, read from the GYM
 * project itself. Six of the seven in points are off the grid, the way a
 * razor on a 30 fps timeline leaves them.
 */
const GYM_CUTS: [number, number][] = [
  [2.3333333333333335, 5.933333333333334],
  [17.464966666666665, 19.0983],
  [22.298299999999998, 28.064966666666663],
  [35.231633333333335, 36.898300000000006],
  [41.66496666666667, 47.664966666666665],
  [64.86496666666666, 66.53163333333333],
  [68.96096666666608, 73.09229999999941],
]

/** Every source time his GYM cuts ask for, one per timeline frame. */
const gymTimes = (): { cut: number; f: number; sourceT: number }[] =>
  GYM_CUTS.flatMap(([inS, outS], cut) =>
    Array.from({ length: Math.round((outS - inS) * FPS) }, (_, f) => ({ cut, f, sourceT: inS + f / FPS })),
  )

describe('the frame shown at a moment is the nearest one', () => {
  it('⛔ an off-grid in point shows the frame nearest the sound, not the one before it', () => {
    // 17.46497 s is 523.95 frames in: frame 524 is 1.7 ms away, frame 523 is
    // 31.6 ms away, and the floor picked 523.
    expect(frameIndexAt(17.46497, FPS)).toBe(524)
    expect(frameIndexAt(17.455, FPS)).toBe(524)
    expect(frameIndexAt(17.44, FPS)).toBe(523)
  })

  it('keeps a frame a tick off the grid in its own slot', () => {
    // Under the floor a frame 1.67 ms early fell into the slot before it and
    // shared it with its neighbour.
    expect(frameIndexAt(10 / 30 - 1 / 600, FPS)).toBe(10)
    expect(frameIndexAt(10 / 30 + 1 / 600, FPS)).toBe(10)
  })

  it('still puts an exact frame time on that frame', () => {
    for (const k of [0, 1, 29, 523, 2266]) expect(frameIndexAt(k / FPS, FPS)).toBe(k)
  })

  it('settles an exact half way the same way every time', () => {
    expect(frameIndexAt(10.5 / 30, FPS)).toBe(10)
  })
})

describe('preview == export, frame for frame, on his iPhone cuts', () => {
  const times = iphoneTimes(2267)

  it('picks the same source frame in the export as in the paused preview, every frame', () => {
    const all = gymTimes()
    for (const { cut, f, sourceT } of all) {
      expect(exportPick(times, sourceT), `cut ${cut}, frame ${f}`).toBe(previewPick(times, sourceT))
    }
    expect(all.length).toBe(734)
  })

  it('keeps the picture within half a frame of the sound, either way', () => {
    const errs = gymTimes().map(({ sourceT }) => Math.abs(times[exportPick(times, sourceT)] - sourceT) * 1000)
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length
    // Half a frame at 30 fps is 16.7 ms, plus the one tick his phone wobbles by.
    expect(Math.max(...errs)).toBeLessThanOrEqual(1000 / 60 + 1000 / 600 + 1e-6)
    // Under the floor this was 24.1 ms on his real cuts, always late.
    expect(mean).toBeLessThan(10)
  })

  it('never repeats or skips a frame the source itself does not', () => {
    for (const [cut, [inS, outS]] of GYM_CUTS.entries()) {
      let prev = exportPick(times, inS)
      for (let f = 1; f < Math.round((outS - inS) * FPS); f++) {
        const next = exportPick(times, inS + f / FPS)
        expect(next - prev, `cut ${cut}, frame ${f}`).toBe(1)
        prev = next
      }
    }
  })
})
