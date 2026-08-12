// Dropping a clip onto occupied space overwrites what is under it.
//
// His choice, 2026-08-12, after "click-dragging is so fucking bad ... it has one
// function, and it can't even do that". On a packed track a dragged clip had
// nowhere it fitted, so it silently sat back down, and a finished edit is packed
// by definition.

import { describe, expect, it } from 'vitest'
import { clipEndS, moveClipOverwrite } from './timeline'
import { defaultTransform, type Clip, type Sequence, type Track } from './types'

const clip = (id: string, startS: number, lenS: number): Clip => ({
  id,
  assetId: 'a1',
  startS,
  inS: 0,
  outS: lenS,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
})

const track = (id: string, clips: Clip[]): Track => ({
  id,
  kind: 'video',
  name: id,
  height: 64,
  muted: false,
  solo: false,
  locked: false,
  volumeDb: 0,
  pan: 0,
  clips,
})

const seqOf = (...clips: Clip[]): Sequence => ({
  id: 's',
  name: 'S',
  fps: 30,
  width: 1920,
  height: 1080,
  sampleRate: 48000,
  durationS: 0,
  tracks: [track('V1', clips)],
  markers: [],
})

const shape = (s: Sequence) =>
  s.tracks[0].clips.map((c) => [Number(c.startS.toFixed(3)), Number(clipEndS(c).toFixed(3))])

describe('moveClipOverwrite', () => {
  // THE CASE HE HIT. Three clips butted together, drag the first one right.
  // Before this it did nothing at all.
  it('moves on a packed track, where the old move gave up', () => {
    const s = seqOf(clip('a', 0, 2), clip('b', 2, 2), clip('c', 4, 2))
    const out = moveClipOverwrite(s, 'a', 'V1', 1)
    const a = out.tracks[0].clips.find((c) => c.id === 'a')!
    expect(a.startS).toBe(1)
  })

  it('eats the part of a neighbour it lands on, and leaves the rest', () => {
    const s = seqOf(clip('a', 0, 2), clip('b', 2, 2))
    // 'a' lands at 1..3, covering the first second of 'b'.
    const out = moveClipOverwrite(s, 'a', 'V1', 1)
    expect(shape(out)).toEqual([
      [1, 3],
      [3, 4],
    ])
  })

  it('swallows a clip it completely covers', () => {
    const s = seqOf(clip('a', 0, 4), clip('small', 5, 1), clip('c', 8, 2))
    // 'a' lands at 4..8, which contains 'small' entirely.
    const out = moveClipOverwrite(s, 'a', 'V1', 4)
    expect(out.tracks[0].clips.map((c) => c.id).sort()).toEqual(['a', 'c'])
  })

  // Dropped INSIDE a longer clip: that clip becomes two, one either side.
  it('splits a clip it lands in the middle of', () => {
    const s = seqOf(clip('long', 0, 10), clip('a', 20, 2))
    const out = moveClipOverwrite(s, 'a', 'V1', 4)
    expect(shape(out)).toEqual([
      [0, 4],
      [4, 6],
      [6, 10],
    ])
    expect(out.tracks[0].clips).toHaveLength(3)
  })

  it('trims a neighbour it overlaps from the left', () => {
    const s = seqOf(clip('b', 0, 4), clip('a', 10, 2))
    // 'a' lands at 3..5, eating the tail of 'b'.
    const out = moveClipOverwrite(s, 'a', 'V1', 3)
    expect(shape(out)).toEqual([
      [0, 3],
      [3, 5],
    ])
  })

  // ⛔ It must not carve ITSELF away. The clip is lifted out before the window is
  // cleared; without that, a small nudge inside a packed track would delete the
  // very clip being dragged.
  it('a small nudge does not delete the clip being dragged', () => {
    const s = seqOf(clip('a', 0, 2), clip('b', 2, 2))
    const out = moveClipOverwrite(s, 'a', 'V1', 0.5)
    const a = out.tracks[0].clips.find((c) => c.id === 'a')
    expect(a).toBeDefined()
    expect(a!.startS).toBe(0.5)
  })

  it('never places a clip before zero', () => {
    const s = seqOf(clip('a', 5, 2))
    expect(moveClipOverwrite(s, 'a', 'V1', -3).tracks[0].clips[0].startS).toBe(0)
  })

  it('a locked track refuses the move outright', () => {
    const s = seqOf(clip('a', 0, 2), clip('b', 4, 2))
    s.tracks[0] = { ...s.tracks[0], locked: true }
    expect(moveClipOverwrite(s, 'a', 'V1', 8)).toBe(s)
  })

  it('landing exactly where it already is changes nothing', () => {
    const s = seqOf(clip('a', 2, 2), clip('b', 6, 2))
    expect(moveClipOverwrite(s, 'a', 'V1', 2)).toBe(s)
  })

  it('keeps the sequence duration honest after eating the last clip', () => {
    const s = seqOf(clip('a', 0, 2), clip('b', 6, 2))
    const out = moveClipOverwrite(s, 'a', 'V1', 6)
    expect(out.durationS).toBe(8)
  })
})
