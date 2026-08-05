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
    const a = timelineWords(words, clip({ startS: 10, inS: 0 }))[0]
    const b = timelineWords(words, clip({ startS: 10, inS: 7.5 }))[0]
    expect(b.startS).toBeCloseTo(a.startS, 6)
    expect(b.endS).toBeCloseTo(a.endS, 6)
  })

  it('compresses word times by the clip speed', () => {
    const [w] = timelineWords([{ text: 'x', startS: 2, endS: 3 }], clip({ startS: 10, inS: 4, speed: 2 }))
    expect(w.startS).toBeCloseTo(11, 6) // 10 + 2/2
    expect(w.endS).toBeCloseTo(11.5, 6)
  })
})
