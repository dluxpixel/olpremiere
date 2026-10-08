// Cutting the quiet parts, driven through the real timeline surgery.
//
// The gap arithmetic is proven in engine/silence.test.ts. What this covers is
// the half that would silently ruin an edit: mapping SOURCE seconds onto the
// timeline, and refusing to delete a piece that did not cut cleanly at both ends.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { timelineWords } from '../engine/captions/transcribe'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newProject, type Clip, type MediaAsset, type Sequence } from '../engine/types'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

// The transcript door, faked: this suite is about the EDIT, not about Whisper.
// `isCancel` is the real rule (a thrown object that says it was cancelled), so
// the throw, cancel and busy paths below run as they do in the app.
const words = vi.fn()
vi.mock('./transcribeActions', () => ({
  wordsForCut: (...a: unknown[]) => words(...a),
  isCancel: (err: unknown) => typeof err === 'object' && err !== null && 'cancelled' in err,
}))

// ⛔ THE FAKE ANSWERS IN THE REAL DOOR'S CLOCK. wordsForCut hands back TIMELINE
// seconds (it ends in timelineWords), and the old fake handed back source
// seconds for a clip at 0:00, the one case where the two agree. That hid a cutter
// that ate his words on every clip placed later for seven weeks. `said` is what
// he said, in seconds into the clip's source span, the way Whisper heard it.
function heard(said: { text: string; startS: number; endS: number }[]) {
  words.mockImplementation(async (clip: Clip) => timelineWords(said, clip))
}

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

/** Each clip's source span, in order, to within float noise. */
function expectSpans(cs: Clip[], want: [number, number][]): void {
  expect(cs).toHaveLength(want.length)
  cs.forEach((c, i) => {
    expect(c.inS).toBeCloseTo(want[i][0], 4)
    expect(c.outS).toBeCloseTo(want[i][1], 4)
  })
}

/** A phone clip of him talking: picture on V1, its sound on A1, linked. */
function seedPair(o: { videoOutS?: number } = {}): void {
  const base = seedClip()
  const v: Clip = { ...base, id: 'V', linkId: 'L', outS: o.videoOutS ?? 12 }
  const a: Clip = { ...base, id: 'A', linkId: 'L' }
  updateActiveSequence('pair', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [v] } : i === 2 ? { ...t, clips: [a] } : t)),
    }),
  )
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
    heard([
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
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    expect(clips()).toHaveLength(2)
    // Source 2..8 at 2x is timeline 1..4, so the second piece starts at 1s.
    expect(clips()[1].startS).toBeCloseTo(1, 4)
  })

  // ⛔ HIS NORMAL CASE, and the one the old fake could not see: a kept take lands
  // where he performed it, never at 0:00. The cuts used to land a clip start late,
  // so the head cut ate his first sentence.
  it('keeps every word on a clip that does not start at 0:00', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip({ startS: 3.2 })
    heard([
      { text: 'a', startS: 0.5, endS: 2 },
      { text: 'b', startS: 8, endS: 11.5 },
    ])

    await cutQuietParts('c1', { minGapS: 0.3, padS: 0 })

    // What is left is exactly what he said, in source seconds, closed up.
    expectSpans(clips(), [
      [0.5, 2],
      [8, 11.5],
    ])
    expect(clips()[0].startS).toBeCloseTo(3.2, 4)
    expect(clips()[1].startS).toBeCloseTo(4.7, 4)
  })

  it('keeps every word on a sped up clip that does not start at 0:00', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip({ startS: 5, speed: 2 })
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    expectSpans(clips(), [
      [0, 2],
      [8, 12],
    ])
    // Source 0..2 at 2x is one second of timeline, so the second piece follows at 6.
    expect(clips()[1].startS).toBeCloseTo(6, 4)
  })

  it('never deletes a whole take that sits later than its own length', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip({ startS: 15 })
    heard([
      { text: 'a', startS: 0.5, endS: 2 },
      { text: 'b', startS: 8, endS: 11.5 },
    ])

    await cutQuietParts('c1', { minGapS: 0.3, padS: 0 })

    const total = clips().reduce((s, c) => s + (c.outS - c.inS), 0)
    expect(total).toBeCloseTo(5, 4)
    expect(clips()[0].startS).toBeCloseTo(15, 4)
  })

  it('refuses a clip that plays backwards, before the long read', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip({ speed: -1 })
    heard([{ text: 'a', startS: 0, endS: 2 }])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    expect(clips()).toHaveLength(1)
    expect(words).not.toHaveBeenCalled()
    expect(show.mock.calls.some((c) => /backwards/i.test(String(c[0])))).toBe(true)
  })

  // ⛔ A LINKED CLIP: the picture and its sound are cut TOGETHER. Cutting the
  // sound alone slid his voice ahead of his lips by everything it took out.
  it('cuts the picture with its sound, so they stay in sync', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedPair()
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('A', { minGapS: 0.5, padS: 0 })

    const v = seq().tracks[0].clips
    const a = seq().tracks[2].clips
    expectSpans(a, [
      [0, 2],
      [8, 12],
    ])
    expect(a[1].startS).toBeCloseTo(2, 4)
    // The picture holds the very same pieces at the very same times.
    expect(v.map((c) => [c.startS, c.inS, c.outS])).toEqual(a.map((c) => [c.startS, c.inS, c.outS]))
    // And each piece of sound still belongs to its piece of picture.
    expect(a.map((c) => c.linkId)).toEqual(v.map((c) => c.linkId))
    expect(new Set(a.map((c) => c.linkId)).size).toBe(2)
  })

  it('leaves a quiet part alone when the linked picture runs past it', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedPair({ videoOutS: 14 })
    // Quiet from 10 to the end of the sound at 12, but the picture goes on to 14:
    // taking the group would delete two seconds of picture with no sound cut.
    heard([{ text: 'a', startS: 0, endS: 10 }])

    await cutQuietParts('A', { minGapS: 0.5, padS: 0 })

    expect(seq().tracks[0].clips.map((c) => [c.startS, c.outS])).toEqual([[0, 14]])
    expect(seq().tracks[2].clips).toHaveLength(1)
  })

  it('refuses when the linked picture is on a locked track', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedPair()
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)),
    }))
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('A', { minGapS: 0.5, padS: 0 })

    expect(clips()).toHaveLength(2)
    expect(words).not.toHaveBeenCalled()
    expect(show.mock.calls.some((c) => /locked/i.test(String(c[0])))).toBe(true)
  })

  it('is ONE undo press however many places it cut', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    heard([
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
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    const call = show.mock.calls.find((c) => /Cut .*quiet/i.test(String(c[0])))
    expect(call).toBeDefined()
    expect(call?.[2]).toMatchObject({ label: 'Undo' })
  })

  it('⛔ never slides a caption onto another one, and the same toast names the track that kept its timing', async () => {
    // MEASURED 2026-10-01 in his mc night: a cut like this one slid the words
    // after it on top of a word that sat inside the removed time, and only one
    // of the two was drawn. The caption track keeps its own timing instead, and
    // he is told so on the line he already reads, not on a second toast.
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    const caption = (id: string, startS: number): Clip => ({ ...clips()[0], id, startS, inS: 0, outS: 1 })
    updateActiveSequence('captions', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t, i) => (i === 1 ? { ...t, name: 'Captions', clips: [caption('w1', 4), caption('w2', 9)] } : t)),
      }),
    )
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])
    show.mockClear()

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    const captions = seq().tracks[1].clips
    expect(captions.map((c) => c.startS)).toEqual([4, 9])
    const said = show.mock.calls.filter((c) => /quiet/i.test(String(c[0])))
    expect(said).toHaveLength(1)
    expect(String(said[0][0])).toMatch(/Captions kept its timing/)
  })

  it('cuts nothing and says so when he never stops talking', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    heard([{ text: 'a', startS: 0, endS: 12 }])

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

  // ---------------------------------------------------------------------------
  // AU-8: the words are kept on the media, and a selection is one pass.

  const asset = () => useStore.getState().project.assets.a1!
  const knowsWords = (words: { text: string; startS: number; endS: number }[], heardSpans: { fromS: number; toS: number }[]) =>
    useStore.getState().dispatch('knows', (p) => ({ ...p, assets: { ...p.assets, a1: { ...p.assets.a1!, words, heardSpans } } }))

  it('uses the words the media already has when all of the clip was heard, and listens to nothing', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip({ startS: 3.2, inS: 2, outS: 14 })
    // Source seconds: he speaks 2.5 to 4 and 10 to 13.5 of the file, heard from 0 to 20.
    knowsWords(
      [
        { text: 'a', startS: 2.5, endS: 4 },
        { text: 'b', startS: 10, endS: 13.5 },
      ],
      [{ fromS: 0, toS: 20 }],
    )

    await cutQuietParts('c1', { minGapS: 0.3, padS: 0 })

    expect(words).not.toHaveBeenCalled()
    expectSpans(clips(), [
      [2.5, 4],
      [10, 13.5],
    ])
    expect(clips()[0]!.startS).toBeCloseTo(3.2, 4)
  })

  it('listens again when the media has words but never heard all of this clip', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    // Words from a shorter listening, and a project older than the spans has none.
    knowsWords([{ text: 'a', startS: 0, endS: 2 }], [{ fromS: 0, toS: 5 }])
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts('c1', { minGapS: 0.5, padS: 0 })

    expect(words).toHaveBeenCalledTimes(1)
    // The listening found speech the old words did not know about, and kept it.
    expectSpans(clips(), [
      [0, 2],
      [8, 12],
    ])
  })

  it('keeps what it heard on the media, in source seconds, and one undo takes the cut and the words back', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip({ startS: 3.2, inS: 1, outS: 13 })
    heard([
      { text: 'a', startS: 0.5, endS: 2 },
      { text: 'b', startS: 8, endS: 11.5 },
    ])

    await cutQuietParts('c1', { minGapS: 0.3, padS: 0 })

    expect(asset().words?.map((w) => [w.text, +w.startS.toFixed(4), +w.endS.toFixed(4)])).toEqual([
      ['a', 1.5, 3],
      ['b', 9, 12.5],
    ])
    expect(asset().heardSpans).toEqual([{ fromS: 1, toS: 13 }])

    useStore.getState().undo()
    expect(clips()).toHaveLength(1)
    expect(asset().words).toBeUndefined()
    expect(asset().heardSpans).toBeUndefined()
  })

  it('cuts every clip of a selection in one pass and ONE undo step', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    const first = seedClip({ outS: 12 })
    const second: Clip = { ...first, id: 'c2', startS: 12, inS: 20, outS: 32 }
    updateActiveSequence('second', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [first, second] } : t)) }),
    )
    // Each take: speech for the first 2 s and the last 4 s of it.
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])
    const history = useStore.getState().history.undo.length

    await cutQuietParts(['c1', 'c2'], { minGapS: 0.5, padS: 0 })

    expect(words).toHaveBeenCalledTimes(2)
    expectSpans(clips(), [
      [0, 2],
      [8, 12],
      [20, 22],
      [28, 32],
    ])
    // Closed up, the second take now follows the first one's six seconds.
    expect(clips()[2]!.startS).toBeCloseTo(6, 4)
    expect(useStore.getState().history.undo.length).toBe(history + 1)
    const said = show.mock.calls.find((c) => /Cut .*quiet/i.test(String(c[0])))
    expect(String(said?.[0])).toMatch(/in 2 places, across 2 clips/)

    useStore.getState().undo()
    expectSpans(clips(), [
      [0, 12],
      [20, 32],
    ])
  })

  it('reads a linked pair once when both halves are selected', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedPair()
    heard([
      { text: 'a', startS: 0, endS: 2 },
      { text: 'b', startS: 8, endS: 12 },
    ])

    await cutQuietParts(['V', 'A'], { minGapS: 0.5, padS: 0 })

    expect(words).toHaveBeenCalledTimes(1)
    expectSpans(seq().tracks[2]!.clips, [
      [0, 2],
      [8, 12],
    ])
    expect(seq().tracks[0]!.clips.map((c) => [c.startS, c.inS, c.outS])).toEqual(seq().tracks[2]!.clips.map((c) => [c.startS, c.inS, c.outS]))
  })

  // ---------------------------------------------------------------------------
  // Review 2026-10-08, nits 1, 5 and 6.

  /** What each clip says, by clip id, in seconds into its source span. */
  function heardBy(said: Record<string, { text: string; startS: number; endS: number }[]>) {
    words.mockImplementation(async (clip: Clip) => timelineWords(said[clip.id] ?? [], clip))
  }
  const toast = (re: RegExp): string | undefined => show.mock.calls.map((c) => String(c[0])).find((m) => re.test(m))

  it('⛔ a selection across tracks cuts one line only, and says what it left, so the tracks stay in sync', async () => {
    // A marquee over gameplay (V1 and A1, linked) and his voice on A2. Each line
    // ripples by its own cuts only, so cutting both slid the voice and the
    // gameplay apart by different amounts, and nothing said so.
    const { cutQuietParts } = await import('./silenceActions')
    seedPair()
    const voice: Clip = { ...clips()[0]!, id: 'VO', linkId: undefined, startS: 0, inS: 20, outS: 32 }
    updateActiveSequence('voice', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 3 ? { ...t, clips: [voice] } : t)) }),
    )
    heardBy({
      A: [
        { text: 'gg', startS: 0, endS: 2 },
        { text: 'gg', startS: 8, endS: 12 },
      ],
      VO: [
        { text: 'so', startS: 0, endS: 5 },
        { text: 'so', startS: 9, endS: 12 },
      ],
    })
    show.mockClear()

    await cutQuietParts(['A', 'VO'], { minGapS: 0.5, padS: 0 })

    // The line he pointed at is cut, picture and sound together.
    expectSpans(seq().tracks[2]!.clips, [
      [0, 2],
      [8, 12],
    ])
    expect(seq().tracks[0]!.clips.map((c) => [c.startS, c.inS, c.outS])).toEqual(seq().tracks[2]!.clips.map((c) => [c.startS, c.inS, c.outS]))
    // The voice on another track is not cut against its own quiet parts, and
    // not even listened to.
    expectSpans(seq().tracks[3]!.clips, [[20, 32]])
    expect(words).toHaveBeenCalledTimes(1)
    expect(toast(/Cut .*quiet/i)).toMatch(/1 on another track left alone/)
  })

  it('a clip refused inside a selection is named, not passed over in silence', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    const first = seedClip({ outS: 12 })
    const back: Clip = { ...first, id: 'rev', startS: 12, inS: 20, outS: 32, speed: -1 }
    updateActiveSequence('two', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [first, back] } : t)) }),
    )
    heardBy({
      c1: [
        { text: 'a', startS: 0, endS: 2 },
        { text: 'b', startS: 8, endS: 12 },
      ],
    })
    show.mockClear()

    await cutQuietParts(['c1', 'rev'], { minGapS: 0.5, padS: 0 })

    expect(seq().tracks[0]!.clips).toHaveLength(3)
    expect(toast(/Cut .*quiet/i)).toMatch(/1 playing backwards/)
  })

  it('a quiet part its linked clip does not cover says so, not that it was too short', async () => {
    // A J-cut: his sound starts before the picture does, so the linked picture
    // is not under the quiet part, and the pair is never cut on one side only.
    const { cutQuietParts } = await import('./silenceActions')
    seedPair({ videoOutS: 6 })
    // Quiet from 6.5 to 10, where only the sound runs.
    heard([
      { text: 'a', startS: 0, endS: 6.5 },
      { text: 'b', startS: 10, endS: 12 },
    ])
    show.mockClear()

    await cutQuietParts('A', { minGapS: 0.5, padS: 0 })

    expect(seq().tracks[2]!.clips).toHaveLength(1)
    const said = toast(/cut/i)
    expect(said).toBeDefined()
    expect(said).not.toMatch(/too short/i)
    expect(said).toMatch(/linked/i)
  })

  it('a cancelled reading cuts nothing and says nothing', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    words.mockRejectedValue({ cancelled: true })
    show.mockClear()
    await cutQuietParts('c1')
    expect(clips()).toHaveLength(1)
    expect(show).not.toHaveBeenCalled()
  })

  it('a reading that is already running elsewhere says so', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    words.mockResolvedValue(null)
    await cutQuietParts('c1')
    expect(clips()).toHaveLength(1)
    expect(toast(/already running/)).toBeDefined()
  })

  it('a reading that fails says it could not read the speech', async () => {
    const { cutQuietParts } = await import('./silenceActions')
    seedClip()
    words.mockRejectedValue(new Error('model failed'))
    await cutQuietParts('c1')
    expect(clips()).toHaveLength(1)
    expect(toast(/Could not read the speech/)).toBeDefined()
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
