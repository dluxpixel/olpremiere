// Where captions land when the clip has been TRIMMED.
//
// A bug sweep on 2026-08-05 reported, and a second agent confirmed, that
// timelineWords was missing a `clip.inS` term and that captions on a trimmed
// clip therefore land early. Both were WRONG, and applying their fix would have
// introduced exactly the bug they described.
//
// extractClipPcm renders the slice with `source.start(0, clip.inS, durS)`: the
// source is READ from clip.inS but WRITTEN into a fresh offline context that
// begins at zero. So a word's reported time is already relative to the clip's
// in point, and the in point must NOT be added again. Slice time 0 is timeline
// time clip.startS, by construction.
//
// This file exists so the next sweep that "finds" this cannot land it.
//
// ⛔ AND SINCE 2026-08-18 IT PINS THE OTHER HALF TOO: the mapping now DROPS a
// word that falls outside the clip's own span. That is not a second opinion
// about `inS`, it is a bound on what the recogniser is allowed to claim, and the
// two are easy to confuse. The second describe block below is the evidence and
// the reason. Do not relax it to make a fixture pass: check first whether the
// fixture describes a clip that could actually contain the word.

import { describe, expect, it } from 'vitest'
import { timelineWords } from './transcribe'
import type { Clip } from '../types'

const clip = (over: Partial<Clip> = {}): Clip =>
  ({
    id: 'c1',
    assetId: 'a1',
    startS: 10,
    inS: 0,
    outS: 5,
    speed: 1,
    enabled: true,
    transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5, crop: { l: 0, r: 0, t: 0, b: 0 } },
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    effects: [],
    ...over,
  }) as unknown as Clip

const words = [{ text: 'hello', startS: 0, endS: 0.5 }]

describe('caption timing on a trimmed clip', () => {
  it('puts the first word at the clip start when nothing is trimmed', () => {
    const [w] = timelineWords(words, clip({ startS: 10, inS: 0 }))
    expect(w.startS).toBeCloseTo(10, 6)
  })

  it('STILL puts the first word at the clip start when the head is trimmed off', () => {
    // The slice begins at inS, so its first word is the first word he HEARS,
    // which is at the clip's start on the timeline. Adding inS here would push
    // every caption late by the trim amount.
    const [w] = timelineWords(words, clip({ startS: 10, inS: 2 }))
    expect(w.startS).toBeCloseTo(10, 6)
  })

  it('is unaffected by how far into the source the clip starts', () => {
    // ⛔ outS MOVES WITH inS HERE, and that is not tidying. Since 2026-08-18 a
    // word outside the clip's own span is dropped, so a fixture with inS 7.5 and
    // outS 5 describes a clip of negative length that could not contain any word
    // at all. The point of this test is the in-point arithmetic, so both clips
    // are given the same real length and only their in point differs.
    const a = timelineWords(words, clip({ startS: 10, inS: 0, outS: 5 }))[0]
    const b = timelineWords(words, clip({ startS: 10, inS: 7.5, outS: 12.5 }))[0]
    expect(b.startS).toBeCloseTo(a.startS, 6)
    expect(b.endS).toBeCloseTo(a.endS, 6)
  })

  it('compresses word times by the clip speed', () => {
    // 3 source seconds at speed 2 is 1.5 on the timeline, which is long enough
    // to hold a word ending at slice time 3.
    const [w] = timelineWords([{ text: 'x', startS: 2, endS: 3 }], clip({ startS: 10, inS: 4, outS: 11, speed: 2 }))
    expect(w.startS).toBeCloseTo(11, 6) // 10 + 2/2
    expect(w.endS).toBeCloseTo(11.5, 6)
  })
})

/**
 * ⛔ HIS REPORT, 2026-08-18, VERBATIM: *"sometimes it captions clips that aren't
 * even there, or they are at the end. It's completely broken."*
 *
 * Whisper's most familiar failure is inventing words at the end of audio and
 * stamping them past the end of what it was given. `timelineWords` trusted those
 * timestamps completely, so the inventions were mapped onto the timeline AFTER
 * the clip finished: onto bare timeline where no clip exists, and on the last
 * clip of a sequence they piled up at the very end.
 */
describe('a word Whisper invented past the end of the audio', () => {
  // A five second clip sitting at ten seconds, so it occupies 10 to 15.
  const fiveSeconds = () => clip({ startS: 10, inS: 0, outS: 5, speed: 1 })

  it('is dropped, not pulled back onto the last frame', () => {
    const out = timelineWords(
      [
        { text: 'real', startS: 1, endS: 1.4 },
        { text: 'invented', startS: 5.2, endS: 5.9 },
      ],
      fiveSeconds(),
    )
    // ⛔ DROPPED rather than clamped. Clamping the START would stack every
    // invention on the final frame, which reads as a burst of nonsense at the
    // cut: the same bug wearing different clothes.
    expect(out.map((w) => w.text)).toEqual(['real'])
  })

  it('is dropped even when it lands on a LATER clip, which is what he saw', () => {
    const out = timelineWords([{ text: 'ghost', startS: 12, endS: 12.5 }], fiveSeconds())
    // Timeline time would have been 22s: well past this clip, and quite possibly
    // on top of a completely different one.
    expect(out).toEqual([])
  })

  it('keeps a real last word but holds its tail inside the clip', () => {
    const [w] = timelineWords([{ text: 'goodbye', startS: 4.8, endS: 5.4 }], fiveSeconds())
    // A genuine final word can legitimately run a few milliseconds long, so the
    // END is clamped rather than the word thrown away.
    expect(w.startS).toBeCloseTo(14.8, 6)
    expect(w.endS).toBeCloseTo(15, 6)
  })

  it('drops a word with no time left once its tail is clamped', () => {
    // Starts exactly at the clip end: nothing of it is inside, and a
    // zero-length caption cannot be shown or clicked.
    expect(timelineWords([{ text: 'x', startS: 5, endS: 5.3 }], fiveSeconds())).toEqual([])
  })

  it('respects speed: the bound is the clip on the TIMELINE, not the source', () => {
    // 6 source seconds at speed 2 is 3 timeline seconds, so the clip is 10 to 13.
    const fast = clip({ startS: 10, inS: 0, outS: 6, speed: 2 })
    const out = timelineWords(
      [
        { text: 'in', startS: 5, endS: 5.5 }, // 10 + 2.5 = 12.5, inside
        { text: 'out', startS: 6.5, endS: 7 }, // 10 + 3.25 = 13.25, outside
      ],
      fast,
    )
    expect(out.map((w) => w.text)).toEqual(['in'])
  })

  it('drops a word stamped BEFORE the slice began', () => {
    expect(timelineWords([{ text: 'x', startS: -2, endS: -1 }], fiveSeconds())).toEqual([])
  })
})
