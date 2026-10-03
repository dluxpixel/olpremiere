import { describe, expect, it } from 'vitest'

import { addTrack } from '../engine/timeline'
import { newProject, type MediaAsset, type Sequence } from '../engine/types'
import { placeTakeClips, takeClipSpans, voiceHomeTrackIndex, type TakeTiming } from './takePlacement'

// ⛔ HIS ANSWER, 2026-09-30: "Yes, place it for me." A kept take lands where he
// started, on a free audio line, lined up to the frame, and pausing with Space
// while dubbing no longer drifts. These are the numbers that decide where.

const take = (over: Partial<TakeTiming>): TakeTiming => ({
  recorderStartMs: 10_000,
  inputLatencyS: 0.01,
  heard: [],
  startPlayheadS: 4,
  ...over,
})

describe('takeClipSpans: each stretch he heard becomes one clip, from its own part of the file', () => {
  it('a straight take: the voice for timeline 4.0 is the audio that went into the mic as he heard it', () => {
    // Measured in the real app on 2026-09-29: the preview was first heard 134.8
    // ms after the recorder started. The mic hears it 10 ms before the recorder
    // is handed it, so that sound sits at 0.1448 s into the file.
    const spans = takeClipSpans(take({ heard: [{ timelineS: 4, heardAtMs: 10_134.8, endedAtMs: 20_134.8 }] }), 30)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.startS).toBe(4)
    expect(spans[0]!.inS).toBeCloseTo(0.1448, 9)
    expect(spans[0]!.outS).toBeCloseTo(10.1448, 9)
  })

  it('three Space pauses: every stretch sits on its own spot, and nothing drifts', () => {
    // Each resume is heard a different time after the recorder started; the
    // stretch after the third pause is placed by its own numbers, not by the sum
    // of every pause before it. That sum is what used to drift, 45 to 62 ms each.
    const heard = [
      { timelineS: 0, heardAtMs: 10_135, endedAtMs: 12_635 },
      { timelineS: 2.5, heardAtMs: 13_521, endedAtMs: 15_021 },
      { timelineS: 4, heardAtMs: 15_907, endedAtMs: 17_407 },
      { timelineS: 5.5, heardAtMs: 18_293, endedAtMs: null },
    ]
    const spans = takeClipSpans(take({ heard }), 12)
    expect(spans.map((s) => s.startS)).toEqual([0, 2.5, 4, 5.5])
    for (const [i, h] of heard.entries()) {
      expect(spans[i]!.inS).toBeCloseTo((h.heardAtMs - 10_000) / 1000 + 0.01, 9)
    }
    // A stretch still being heard when he stopped runs to the end of the file.
    expect(spans[3]!.outS).toBe(12)
    // Timeline length is file length: the voice plays back at the speed he spoke.
    for (const s of spans.slice(0, 3)) expect(s.outS - s.inS).toBeCloseTo(s === spans[0] ? 2.5 : 1.5, 9)
  })

  it('a preview already rolling when he pressed record: the take joins it partway', () => {
    // Heard from timeline 1.0 at 9,500 ms, half a second before the recorder
    // started. The file's first sample went into the mic at 9,990 ms, when he
    // was hearing timeline 1.49.
    const spans = takeClipSpans(take({ heard: [{ timelineS: 1, heardAtMs: 9_500, endedAtMs: null }] }), 5)
    expect(spans[0]!.inS).toBe(0)
    expect(spans[0]!.startS).toBeCloseTo(1.49, 9)
  })

  it('no preview at all: the whole take goes where he started, less the mic delay at the head', () => {
    expect(takeClipSpans(take({}), 6)).toEqual([{ startS: 4, inS: 0.01, outS: 6 }])
  })

  it('stretches that overlap by a hair meet exactly, and one he went back over keeps its overlap', () => {
    // 1.3 ms over the next one, the most measured in the real app: a join.
    const joined = takeClipSpans(
      take({
        heard: [
          { timelineS: 0, heardAtMs: 10_100, endedAtMs: 12_601.3 },
          { timelineS: 2.5, heardAtMs: 13_500, endedAtMs: 15_000 },
        ],
      }),
      12,
    )
    expect(joined[0]!.startS + joined[0]!.outS - joined[0]!.inS).toBeCloseTo(joined[1]!.startS, 9)
    // Half a second over: he went back during the pause. Left as it is, so it
    // lands on the next free line instead of being cut.
    const back = takeClipSpans(
      take({
        heard: [
          { timelineS: 0, heardAtMs: 10_100, endedAtMs: 13_100 },
          { timelineS: 2.5, heardAtMs: 14_000, endedAtMs: 15_000 },
        ],
      }),
      12,
    )
    expect(back[0]!.outS - back[0]!.inS).toBeCloseTo(3, 9)
  })

  it('a stretch too short to hold a word (Space tapped twice) is not placed', () => {
    const heard = [{ timelineS: 3, heardAtMs: 11_000, endedAtMs: 11_010 }]
    expect(takeClipSpans(take({ heard }), 6)).toEqual([])
  })
})

// ⛔ MIC-4, found by review 2026-10-01: when the preview's sound was rebuilt
// while play went on, the take came out as two clips on two lines with 80 to
// 125 ms of his voice twice, or with 84 ms cut out. A stretch that continues
// the one before it now extends that clip: one clip, the file in one piece.
describe('a stretch that continues the one before it is the same clip', () => {
  /** Every second of the file appears once on the timeline, nothing twice, nothing missing. */
  const fileOnce = (spans: { inS: number; outS: number }[], fileS: number) => {
    const sorted = [...spans].sort((a, b) => a.inS - b.inS)
    for (let k = 1; k < sorted.length; k++) expect(sorted[k]!.inS).toBeGreaterThanOrEqual(sorted[k - 1]!.outS - 1e-9)
    return sorted.reduce((n, s) => n + (s.outS - s.inS), 0) / fileS
  }

  it('the first take after opening a project: the picture alone, then the sound joins, one clip', () => {
    // Measured shape: the picture rolls from 10.0 at 10,134 ms; the sound is
    // ready 230 ms later and joins on the picture, 4 ms off its guess.
    const heard = [
      { timelineS: 10, heardAtMs: 10_134, endedAtMs: 10_364 },
      { timelineS: 10.226, heardAtMs: 10_364, endedAtMs: null, continues: true },
    ]
    const spans = takeClipSpans(take({ heard }), 6)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.startS).toBe(10)
    // Mapped the way the sound he went on to hear is heard.
    expect(spans[0]!.inS).toBeCloseTo(0.364 + 0.01 - 0.226, 9)
    expect(spans[0]!.outS).toBe(6)
    expect(fileOnce(spans, 6)).toBeLessThanOrEqual(1)
    const { seq } = placeTakeClips(seqWith(), asset, spans)
    expect(seq.tracks.filter((t) => t.clips.length > 0)).toHaveLength(1)
  })

  it('a clock that started late: one clip', () => {
    const heard = [
      { timelineS: 4, heardAtMs: 10_050, endedAtMs: 10_340 },
      { timelineS: 4.33, heardAtMs: 10_340, endedAtMs: null, continues: true },
    ]
    expect(takeClipSpans(take({ heard }), 5)).toHaveLength(1)
  })

  it('a mix change mid-take: one clip, nothing of his voice skipped', () => {
    // The old sound stopped at 11,500 ms, the rebuilt one is heard from 11,566
    // ms carrying on from 1.566 s further along: the file stays one piece.
    const heard = [
      { timelineS: 0, heardAtMs: 10_100, endedAtMs: 11_500 },
      { timelineS: 1.4665, heardAtMs: 11_566, endedAtMs: null, continues: true },
    ]
    const spans = takeClipSpans(take({ heard }), 4)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.outS).toBe(4)
    expect(spans[0]!.outS - spans[0]!.inS).toBeCloseTo(4 - spans[0]!.inS, 9)
  })

  it('six Space pauses, every resume with a late sound (the case the review found): one clip per stretch, one line, exact joins', () => {
    // Each resume: the picture alone from where the last stretch ended, then
    // the late sound continuing it 200 ms later.
    const heard: { timelineS: number; heardAtMs: number; endedAtMs: number | null; continues?: boolean }[] = []
    let at = 10
    let ms = 10_100
    for (let k = 0; k < 7; k++) {
      const len = 0.7 + 0.037 * k
      heard.push({ timelineS: at, heardAtMs: ms, endedAtMs: ms + 200 })
      heard.push({ timelineS: at + 0.2, heardAtMs: ms + 200, endedAtMs: ms + len * 1000, continues: true })
      at += len
      ms += len * 1000 + 400 // 400 ms paused
    }
    const spans = takeClipSpans(take({ heard }), 30)
    expect(spans).toHaveLength(7)
    for (let k = 1; k < spans.length; k++) {
      const prev = spans[k - 1]!
      expect(spans[k]!.startS).toBeCloseTo(prev.startS + prev.outS - prev.inS, 9)
    }
    const { seq } = placeTakeClips(seqWith(), asset, spans)
    expect(seq.tracks.filter((t) => t.clips.length > 0)).toHaveLength(1)
  })

  it('a stretch after a pause never merges, even if it says it continues', () => {
    // A stretch too short to place (Space tapped twice) breaks the chain.
    const heard = [
      { timelineS: 0, heardAtMs: 10_100, endedAtMs: 11_100 },
      { timelineS: 1, heardAtMs: 12_000, endedAtMs: 12_005 },
      { timelineS: 1.005, heardAtMs: 12_005, endedAtMs: 13_000, continues: true },
    ]
    expect(takeClipSpans(take({ heard }), 6)).toHaveLength(2)
  })
})

// ⛔ DECIDED FOR HIM, 2026-10-01: never drop his words from the timeline. When
// the preview runs off the end of his edit and he keeps talking, the rest of the
// take is placed right after the end, on the same line.
describe('talking past the end of the edit', () => {
  it('the last stretch runs on past the end to the end of the take', () => {
    const heard = [{ timelineS: 20, heardAtMs: 10_100, endedAtMs: 14_600, endedBy: 'end' as const }]
    const spans = takeClipSpans(take({ heard }), 30)
    expect(spans).toEqual([{ startS: 20, inS: 0.11, outS: 30 }])
  })

  it('and only up to where the next stretch begins when he plays again', () => {
    const heard = [
      { timelineS: 20, heardAtMs: 10_100, endedAtMs: 14_600, endedBy: 'end' as const },
      { timelineS: 0, heardAtMs: 19_000, endedAtMs: null },
    ]
    const spans = takeClipSpans(take({ heard }), 30)
    expect(spans[0]!.outS).toBeCloseTo(9.01, 9)
    expect(spans[1]!.inS).toBeCloseTo(9.01, 9)
  })

  it('a stretch stopped with Space does not run on', () => {
    const heard = [{ timelineS: 20, heardAtMs: 10_100, endedAtMs: 14_600 }]
    expect(takeClipSpans(take({ heard }), 30)[0]!.outS).toBeCloseTo(4.61, 9)
  })
})

const asset = { id: 'take-1', kind: 'audio', name: 'Voice recording 1.wav', durationS: 12 } as MediaAsset

function seqWith(over: (s: Sequence) => Sequence = (s) => s): Sequence {
  const p = newProject()
  return over(p.sequences[p.activeSequenceId]!)
}

describe('placeTakeClips: on his voice line, or the next free one, never on top of anything', () => {
  it('prefers the line he marked as voice over the top audio line', () => {
    const seq = seqWith((s) => {
      const two = addTrack(s, 'audio')
      return { ...two, tracks: two.tracks.map((t, i) => (i === two.tracks.length - 1 ? { ...t, audioRole: 'voice' as const } : t)) }
    })
    const home = voiceHomeTrackIndex(seq)
    expect(seq.tracks[home]!.audioRole).toBe('voice')
    const { seq: next, clipIds } = placeTakeClips(seq, asset, [{ startS: 1, inS: 0.2, outS: 3 }])
    expect(clipIds).toHaveLength(1)
    expect(next.tracks[home]!.clips.map((c) => [c.startS, c.inS, c.outS])).toEqual([[1, 0.2, 3]])
  })

  it('every stretch of a dubbed take lands in its own spot, on one line when they do not overlap', () => {
    const spans = [
      { startS: 0, inS: 0.14, outS: 2.64 },
      { startS: 2.5, inS: 3.53, outS: 5.03 },
      { startS: 4, inS: 5.92, outS: 7.42 },
    ]
    const { seq, clipIds } = placeTakeClips(seqWith(), asset, spans)
    expect(clipIds).toHaveLength(3)
    const line = seq.tracks[voiceHomeTrackIndex(seq)]!
    expect(line.clips.map((c) => c.startS)).toEqual([0, 2.5, 4])
    expect(seq.durationS).toBeCloseTo(5.5, 9)
  })

  it('a spot already taken sends the take to the next free line, leaving what was there alone', () => {
    const first = placeTakeClips(seqWith(), asset, [{ startS: 0, inS: 0, outS: 5 }]).seq
    const home = voiceHomeTrackIndex(first)
    const { seq } = placeTakeClips(first, { ...asset, id: 'take-2' }, [{ startS: 2, inS: 0, outS: 2 }])
    expect(seq.tracks[home]!.clips).toHaveLength(1)
    expect(seq.tracks[home]!.clips[0]!.assetId).toBe('take-1')
    const moved = seq.tracks.find((t) => t.clips.some((c) => c.assetId === 'take-2'))!
    expect(moved.kind).toBe('audio')
    expect(moved.clips[0]!.startS).toBe(2)
  })
})
