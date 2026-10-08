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
import { cacheBudgets } from '../memoryBudget'
import { resolveFrame } from '../render/resolve'
import type { RenderLayer } from '../render/types'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset, type Sequence } from '../types'
import {
  closeProvider,
  frameForClip,
  planReverseReading,
  reverseBudgetBytes,
  reverseReaderFor,
  reverseWindowFrames,
  type ClipProvider,
} from './clipReader'
import { ProviderPool } from './providerPool'

/** The whole reverse share at the frame budget's ceiling: 128 MB, as on his machine. */
const FULL = 128 * 1024 * 1024

interface Fake {
  sink: CanvasSink
  decoded: number
  /** Frames handed out as canvases. The ones before the start are decoded but never drawn. */
  drawn: number
  /** The earliest frame ever handed out. */
  minDrawn: number
  opened: number
}

/**
 * A file of `count` frames at `fps`, a keyframe every `gop`, its first frame at `offsetS`. Each
 * canvas is its frame number. Opened before the first frame, it starts at the first frame, as
 * mediabunny's CanvasSink does.
 */
function fakeFile(count: number, fps: number, gop: number, offsetS = 0): Fake {
  const fake = { decoded: 0, drawn: 0, minDrawn: Infinity, opened: 0 } as Fake
  const shownAt = (t: number): number => Math.min(count - 1, Math.max(0, Math.floor((t - offsetS) * fps + 1e-9)))
  fake.sink = {
    canvases: (start = 0) =>
      (async function* () {
        fake.opened++
        const first = shownAt(start)
        const key = first - (first % gop)
        for (let i = key; i < count; i++) {
          fake.decoded++
          if (i < first) continue
          fake.drawn++
          fake.minDrawn = Math.min(fake.minDrawn, i)
          yield { canvas: { frame: i }, timestamp: offsetS + i / fps, duration: 1 / fps } as unknown as WrappedCanvas
        }
      })(),
  } as unknown as CanvasSink
  return fake
}

/**
 * Opened at `start` the way the worker opens it: at the clip's in point, whichever way it plays.
 * `lowestS` is the lowest time it will be asked for, the in point unless a test says otherwise.
 */
function provider(fake: Fake, fps: number, start: number, backFrames: number, reverse = false, lowestS = start): ClipProvider {
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
    reverse,
    lowestS,
  }
}

/** Every decoded frame a provider is holding on to, wherever it keeps it. */
function heldBy(p: ClipProvider): Set<unknown> {
  const held = new Set<unknown>()
  if (p.current) held.add(p.current)
  if (p.ahead) held.add(p.ahead)
  if (p.back) {
    for (const f of p.back.frames) held.add(f)
    // Anything else in the window that is a frame, such as the one after it.
    for (const v of Object.values(p.back)) if (v && typeof v === 'object' && 'canvas' in v) held.add(v)
  }
  return held
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
  async function reverse(backFrames: number, endS: number, frames: number, speed = -1, asReversed = true) {
    const fake = fakeFile(600, FPS, GOP)
    const p = provider(fake, FPS, Math.max(0, endS + (frames / FPS) * speed), backFrames, asReversed)
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
    // A window of one frame on a reader that does not know the clip is reversed: a fresh re-open
    // for every frame, as it used to be.
    const old = await reverse(1, 3.3, 60, -1, false)
    const now = await reverse(reverseWindowFrames(1920, 1080, FULL), 3.3, 60)
    expect(now.shown).toEqual(old.shown)
    // Measured with this stand-in, the first read of the slice included: 3,030 decodes before,
    // about 50 for each of the 60 frames; 224 now at 1080p (16 frame window), 130 at 720p (30),
    // 780 at 4K (4).
    expect(old.decoded).toBe(3030)
    expect(now.decoded).toBe(224)
    expect((await reverse(reverseWindowFrames(3840, 2160, FULL), 3.3, 60)).decoded).toBeLessThan(old.decoded / 3)
  })

  it('its first frame is one window, not the whole slice decoded forward from the in point', async () => {
    // A 3 s slice, 1.5 s to 4.5 s, reversed. Its first frame is the one at 4.5 s, and the reader
    // is opened at the in point, 1.5 s. Read forward from there, that first frame cost 272
    // decodes from the keyframe at 0 s and 182 frames drawn, before reverse play even began.
    const fake = fakeFile(600, FPS, GOP)
    const p = provider(fake, FPS, 1.5, 16, true)
    expect(frameOf(await frameForClip(p, 4.5))).toBe(truth(600, FPS, 4.5))
    // From the keyframe at 4.0 s to the frame after 4.5 s, and only the window drawn.
    expect(fake.decoded).toBe(32)
    expect(fake.drawn).toBe(17)
    for (let f = 1; f < 180; f++) {
      const t = 4.5 - f / FPS
      expect(frameOf(await frameForClip(p, t)), `${t}`).toBe(truth(600, FPS, t))
    }
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
  it('16 frames at 1080p, 30 at 720p and below, 4 at 4K, inside 128 MB', () => {
    expect(reverseWindowFrames(1920, 1080, FULL)).toBe(16)
    expect(reverseWindowFrames(1080, 1920, FULL)).toBe(16)
    expect(reverseWindowFrames(1280, 720, FULL)).toBe(30)
    // 4 x 33.2 MB = 132.7 MB, inside 128 MiB now that the frame after the window is not held too.
    expect(reverseWindowFrames(3840, 2160, FULL)).toBe(4)
    expect(reverseWindowFrames(0, 0, FULL)).toBe(30)
  })

  it('⛔ never more than its budget, at 4K too; one frame is the least any reader holds', () => {
    // A four frame floor plus the frame after the window made 166 MB at 4K against a stated 128 MB.
    for (const [w, h] of [[640, 360], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [7680, 4320]]) {
      for (const budget of [FULL, FULL / 2, 40e6, 20e6, 1e6]) {
        const n = reverseWindowFrames(w, h, budget)
        expect(n === 1 || n * w * h * 4 <= budget, `${w}x${h} in ${budget}`).toBe(true)
      }
    }
  })

  it('the share follows the machine: a quarter of the frame budget, 128 MB at its ceiling', () => {
    expect(reverseBudgetBytes(cacheBudgets(0).frames)).toBe(FULL)
    // 600 MB spare: the frame budget is about 107 MB, so all reverse windows get about 27 MB.
    const short = reverseBudgetBytes(cacheBudgets(600e6).frames)
    expect(short).toBeLessThan(28e6)
    expect(reverseWindowFrames(1920, 1080, short)).toBe(3)
  })
})

// The frame index helper is what decides "the same frame": keep the stand-in honest about it.
it('the stand-in shows frame i from i / fps', () => {
  expect(frameIndexAt(3.3, 60)).toBe(198)
})

describe('⛔ a reverse window stays inside its clip', () => {
  const FPS = 60
  const GOP = 120

  it('never decodes or holds a frame before the in point', async () => {
    // A slice from 3.0 s to 3.5 s, reversed. Its last window used to start a whole window before
    // 3.0 s and hold frames the clip never shows (export review S2, 2026-10-08).
    const fake = fakeFile(600, FPS, GOP)
    const p = provider(fake, FPS, 3.0, 16, true)
    for (let f = 0; f < 30; f++) {
      const t = 3.5 - f / FPS
      expect(frameOf(await frameForClip(p, t)), `${t}`).toBe(truth(600, FPS, t))
      for (const held of heldBy(p)) expect((held as { canvas: { frame: number } }).canvas.frame).toBeGreaterThanOrEqual(180)
    }
    // The first frame the clip shows is frame 180 (3.0 s): nothing earlier was even handed out.
    expect(fake.minDrawn).toBeGreaterThanOrEqual(180)
  })

  it('keeps no frame after its window, only that frame\'s time', async () => {
    const fake = fakeFile(600, FPS, GOP)
    const p = provider(fake, FPS, 2.0, 16, true)
    for (let f = 0; f < 40; f++) {
      await frameForClip(p, 3.3 - f / FPS)
      expect(heldBy(p).size).toBeLessThanOrEqual(16)
    }
  })

  it('⛔ a file whose first frame starts late shows that first frame, never black', async () => {
    // A recording whose first picture is at 0.9 s. The window opened at 0.5 s got that frame first,
    // was not marked as the start of the file, and every time before 0.9 s refilled the same window
    // and drew nothing (export review N3, 2026-10-08). The old reader clamped to the first frame.
    const OFFSET = 0.9
    const fake = fakeFile(300, 30, 60, OFFSET)
    const p = provider(fake, 30, 0, 16, true)
    for (let f = 0; f < 36; f++) {
      const t = 1.2 - f / 30
      const shown = frameOf(await frameForClip(p, t))
      expect(shown, `${t}`).not.toBe(-1)
      // Before the first frame, the first frame; after it, the frame the forward reader shows.
      if (t < OFFSET) expect(shown, `${t}`).toBe(0)
      else expect(shown, `${t}`).toBe(truth(300, 30, t - OFFSET))
    }
  })
})

/** A video asset of `durationS` for the timeline tests. */
const asset = (id: string, durationS: number): MediaAsset =>
  ({ id, name: `${id}.mp4`, kind: 'video', blobKey: `asset/${id}`, durationS, fps: 60 }) as MediaAsset

/** A clip of `a` reading inS..outS, placed at startS, played at `speed`. */
function clipOf(a: MediaAsset, startS: number, inS: number, outS: number, speed: number, over: Partial<Clip> = {}): Clip {
  return { ...newClipFromAsset(a, startS), id: `${a.id}@${startS}`, inS, outS, speed, ...over }
}

function sequenceOf(clips: Clip[], fps = 30): Sequence {
  const p = newProject('Reverse')
  const seq = activeSequence(p)
  seq.fps = fps
  seq.tracks[0].clips = clips
  seq.durationS = Math.max(...clips.map((c) => c.startS + (c.outS - c.inS) / Math.abs(c.speed)))
  return seq
}

describe('planReverseReading: what each clip reads, worked out from the timeline', () => {
  it('a reversed clip read past its end by a dissolve reaches below its in point by the dissolve', () => {
    const a = clipOf(asset('a', 20), 0, 4, 6, -1)
    const b = clipOf(asset('b', 20), 2, 10, 12, -2, { transitionIn: { type: 'crossDissolve', durationS: 1 } })
    const plan = planReverseReading(sequenceOf([a, b]), cacheBudgets(0).frames)
    // A runs back from 6 s; the dissolve shows it 1 s past its end, so down to 3 s.
    expect(plan.lowestS.get(a.id)).toBeCloseTo(3, 9)
    expect(plan.doneAtS.get(a.id)).toBeCloseTo(3, 9)
    // B has nothing after it: its in point, and its own end.
    expect(plan.lowestS.get(b.id)).toBe(10)
    expect(plan.doneAtS.get(b.id)).toBeCloseTo(3, 9)
    // Read at the same moment, they share the reverse budget.
    expect(plan.windowBytes).toBe(Math.floor(FULL / 2))
  })

  it('back to back they are never read at once, so each may have all of it', () => {
    const a = asset('a', 20)
    const clips = [0, 1, 2, 3, 4].map((i) => clipOf(a, i, 2 * i, 2 * i + 1, -1))
    const plan = planReverseReading(sequenceOf(clips), cacheBudgets(0).frames)
    expect(plan.windowBytes).toBe(FULL)
    clips.forEach((c, i) => {
      expect(plan.lowestS.get(c.id)).toBe(2 * i)
      expect(plan.doneAtS.get(c.id)).toBe(i + 1)
    })
  })

  it('a forward clip keeps its in point, a still frame its own time, and neither is closed early', () => {
    const fwd = clipOf(asset('a', 20), 0, 4, 6, 1)
    const still = clipOf(asset('b', 20), 2, 4, 6, -1, { freezeAtS: 5.5 })
    const plan = planReverseReading(sequenceOf([fwd, still]), cacheBudgets(0).frames)
    expect(plan.lowestS.get(fwd.id)).toBe(4)
    expect(plan.lowestS.get(still.id)).toBe(5.5)
    expect(plan.doneAtS.has(fwd.id)).toBe(false)
    expect(plan.doneAtS.has(still.id)).toBe(false)
  })
})

describe('⛔ every reversed clip together stays inside the budget', () => {
  // Two reversed clips in a dissolve held about 280 MB at 1080p and 330 MB at 4K, and a boomerang
  // of five 1 s reversed clips back to back about half a gigabyte, all on top of a machine that is
  // already paging (export review S2, 2026-10-08).
  const SRC_FPS = 60
  const OUT_FPS = 30

  /**
   * The worker's sweep (exportWorker.ts runNative): the real resolver, the real pool, a stand-in
   * decoder per clip. Reports the most decoded bytes all live providers held at once.
   */
  async function sweep(seq: Sequence, width: number, height: number, frameBudget: number) {
    const reading = planReverseReading(seq, frameBudget)
    const live = new Set<ClipProvider>()
    const pool = new ProviderPool<ClipProvider>({
      close: (p) => {
        closeProvider(p)
        live.delete(p)
      },
    })
    const clips = new Map(seq.tracks.flatMap((t) => t.clips).map((c) => [c.id, c]))
    const opened = new Map<string, number>()
    let mostHeld = 0
    let wrong = 0
    const frames = Math.ceil(seq.durationS * OUT_FPS) + 2 * OUT_FPS
    for (let f = 0; f < frames; f++) {
      const t = f / OUT_FPS
      pool.beginFrame()
      pool.reap(t)
      const layers: RenderLayer[] = []
      for (const op of resolveFrame(seq, t).ops) {
        if (op.type === 'layer') layers.push(op.layer)
        else if (op.type === 'transition') layers.push(op.from, op.to)
      }
      for (const layer of layers) {
        const clip = clips.get(layer.clipId)
        if (!clip || !layer.assetId) continue
        let p = pool.get(clip.id)
        if (!p) {
          const fake = fakeFile(1200, SRC_FPS, 120)
          p = {
            sink: fake.sink,
            iterator: fake.sink.canvases(Math.max(0, clip.inS)),
            dispose: () => undefined,
            started: false,
            current: null,
            ahead: null,
            fps: SRC_FPS,
            ...reverseReaderFor(clip, reading, width, height),
          }
          pool.set(clip.id, clip, p, reading.doneAtS.get(clip.id))
          live.add(p)
          opened.set(clip.id, (opened.get(clip.id) ?? 0) + 1)
        }
        const sourceT = Math.max(0, layer.sourceTimeS)
        if (frameOf(await frameForClip(p, sourceT)) !== truth(1200, SRC_FPS, sourceT)) wrong++
      }
      let held = 0
      for (const p of live) held += heldBy(p).size
      mostHeld = Math.max(mostHeld, held * width * height * 4)
    }
    return { mostHeld, wrong, opened: [...opened.values()] }
  }

  const dissolve = () =>
    sequenceOf([
      clipOf(asset('a', 20), 0, 4, 6, -1),
      clipOf(asset('b', 20), 2, 10, 12, -1, { transitionIn: { type: 'crossDissolve', durationS: 1 } }),
    ])
  const boomerang = () => {
    const a = asset('gym', 20)
    return sequenceOf([0, 1, 2, 3, 4].map((i) => clipOf(a, i, 2 * i + 1, 2 * i + 2, -1)))
  }

  for (const [label, w, h] of [['1080p', 1920, 1080], ['4K', 3840, 2160]] as const) {
    it(`two reversed clips in a dissolve, ${label}: under the reverse share, every frame right`, async () => {
      const r = await sweep(dissolve(), w, h, cacheBudgets(0).frames)
      expect(r.wrong).toBe(0)
      expect(r.mostHeld).toBeLessThanOrEqual(FULL)
      // Each clip opened once: closing it at its end never closed it while it was still read.
      expect(r.opened).toEqual([1, 1])
    })

    it(`five 1 s reversed clips back to back, ${label}: under the reverse share, every frame right`, async () => {
      const r = await sweep(boomerang(), w, h, cacheBudgets(0).frames)
      expect(r.wrong).toBe(0)
      expect(r.mostHeld).toBeLessThanOrEqual(FULL)
      expect(r.opened).toEqual([1, 1, 1, 1, 1])
    })
  }

  it('on a machine short of memory it shrinks with the budget', async () => {
    const budget = cacheBudgets(600e6).frames
    for (const seq of [dissolve(), boomerang()]) {
      const r = await sweep(seq, 1920, 1080, budget)
      expect(r.wrong).toBe(0)
      // One 1080p frame per clip is the floor; above it, the share.
      expect(r.mostHeld).toBeLessThanOrEqual(Math.max(reverseBudgetBytes(budget), 2 * 1920 * 1080 * 4))
    }
  })
})
