// Cutting the quiet parts, driven through the real timeline surgery.
//
// The gap arithmetic is proven in engine/silence.test.ts. What this covers is
// the half that would silently ruin an edit: mapping SOURCE seconds onto the
// timeline, and refusing to delete a piece that did not cut cleanly at both ends.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newProject, type Clip, type MediaAsset, type Sequence } from '../engine/types'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

// The transcript door, faked: this suite is about the EDIT, not about Whisper.
const words = vi.fn()
vi.mock('./transcribeActions', () => ({
  wordsForClip: (...a: unknown[]) => words(...a),
}))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clips = (): Clip[] => seq().tracks.flatMap((t) => t.clips)

const ASSET: MediaAsset = {
  id: 'a1',
  name: 'take.mp4',
  kind: 'video',
  blobKey: 'asset/a1',
  durationS: 60,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true,
}

function seedClip(over: Partial<Clip> = {}): Clip {
  const clip: Clip = {
    id: 'c1',
    assetId: 'a1',
    startS: 0,
    inS: 0,
    outS: 12,
    speed: 1,
    enabled: true,
    transform: {
      x: 0,
      y: 0,
      scale: 1,
      rotationDeg: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      crop: { t: 0, r: 0, b: 0, l: 0 },
    },
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
    ...over,
  }
  useStore.getState().setProject({ ...newProject(), assets: { a1: ASSET } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)),
    }),
  )
  return clip
}

beforeEach(() => {
  show.mockClear()
  words.mockReset()
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('cutQuietParts', () => {
  it('takes out the gap between two runs of speech and closes it', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    // Speech 0-2 and 8-12, so 2-8 is quiet, and the head/tail have speech in them.
    words.mockResolvedValue([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    // The clip is now two pieces with the quiet six seconds gone from between.
    expect(clips()).toHaveLength(2)
    const total = clips().reduce((s, c) => s + (c.outS - c.inS), 0)
    expect(total).toBeCloseTo(6, 4)
    // Rippled, not lifted: no hole left behind.
    expect(clips()[1].startS).toBeCloseTo(2, 4)
  })

  // ⛔ THE ONE THAT MATTERS ON A RETIMED CLIP. The transcript is SOURCE seconds
  // and the timeline is not, so a 2x clip's cuts land at half the offsets.
  it('maps source seconds onto the timeline through the clip speed', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip({ speed: 2 })
    words.mockResolvedValue([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    expect(clips()).toHaveLength(2)
    // Source 2..8 at 2x is timeline 1..4, so the second piece starts at 1s.
    expect(clips()[1].startS).toBeCloseTo(1, 4)
  })

  it('is ONE undo press however many places it cut', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    words.mockResolvedValue([
      { text: 'a', startS: 0, endS: 1 },
      { text: 'b', startS: 4, endS: 5 },
      { text: 'c', startS: 9, endS: 12 },
    ])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })
    expect(clips().length).toBeGreaterThan(1)

    useStore.getState().undo()
    expect(clips()).toHaveLength(1)
    expect(clips()[0].outS - clips()[0].inS).toBeCloseTo(12, 4)
  })

  it('offers the undo on the toast, because that is the only way back', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    words.mockResolvedValue([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    const call = show.mock.calls.find((c) => /Cut .*quiet/i.test(String(c[0])))
    expect(call).toBeDefined()
    expect(call?.[2]).toMatchObject({ label: 'Undo' })
  })

  it('cuts nothing and says so when he never stops talking', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    words.mockResolvedValue([{ text: 'a', startS: 0, endS: 12 }])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    expect(clips()).toHaveLength(1)
    expect(show.mock.calls.some((c) => /no quiet parts/i.test(String(c[0])))).toBe(true)
  })

  it('leaves the clip alone when there is no transcript', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    words.mockResolvedValue([])

    await cutQuietParts('c1')

    expect(clips()).toHaveLength(1)
    expect(show.mock.calls.some((c) => /no speech/i.test(String(c[0])))).toBe(true)
  })

  it('says the track is locked instead of quietly doing nothing', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)),
    }))
    show.mockClear()

    await cutQuietParts('c1')

    expect(clips()).toHaveLength(1)
    expect(show.mock.calls.some((c) => /locked/i.test(String(c[0])))).toBe(true)
    // And it never even asked for a transcript, which costs real time.
    expect(words).not.toHaveBeenCalled()
  })
})
