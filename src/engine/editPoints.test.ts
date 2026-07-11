import { describe, expect, it } from 'vitest'

import { editPoints, nextEditPoint, prevEditPoint } from './editPoints'
import { defaultTransform, type Clip, type Sequence, type Track } from './types'

// ---------------------------------------------------------------------------
// Fixtures

let n = 0
const uid = (prefix: string): string => `${prefix}-${++n}`

// A clip from startS to endS (speed 1, so inS/outS just give the duration).
const clip = (startS: number, endS: number, over: Partial<Clip> = {}): Clip => ({
  id: uid('clip'),
  assetId: 'av',
  startS,
  inS: 0,
  outS: endS - startS,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...over,
})

const track = (clips: Clip[], over: Partial<Track> = {}): Track => ({
  id: uid('track'),
  kind: 'video',
  name: 'V1',
  height: 64,
  muted: false,
  solo: false,
  locked: false,
  volumeDb: 0,
  pan: 0,
  clips,
  ...over,
})

const seq = (tracks: Track[]): Sequence => ({
  id: 'seq',
  name: 'Test',
  fps: 30,
  width: 1920,
  height: 1080,
  sampleRate: 48000,
  durationS: 0,
  tracks,
  markers: [],
})

// The canonical two-clip track from the task: 0..2, 3..5.
const twoClip = (): Sequence => seq([track([clip(0, 2), clip(3, 5)])])

// ---------------------------------------------------------------------------

describe('editPoints', () => {
  it('yields sorted starts and ends plus 0 for a two-clip track', () => {
    expect(editPoints(twoClip())).toEqual([0, 2, 3, 5])
  })

  it('always includes 0 even with no clips', () => {
    expect(editPoints(seq([track([])]))).toEqual([0])
  })

  it('always includes 0 even when the first clip starts after it', () => {
    expect(editPoints(seq([track([clip(3, 5)])]))).toEqual([0, 3, 5])
  })

  it('includes 0 once, not twice, when a clip already starts at 0', () => {
    expect(editPoints(seq([track([clip(0, 2)])]))).toEqual([0, 2])
  })

  it('merges and dedupes cuts across MULTIPLE tracks', () => {
    // A video cut at 2 and an audio cut at 2 collapse to a single 2.
    const s = seq([
      track([clip(0, 2)]),
      track([clip(2, 4)], { kind: 'audio', name: 'A1' }),
    ])
    expect(editPoints(s)).toEqual([0, 2, 4])
  })

  it('dedupes near-equal times within epsilon', () => {
    const s = seq([track([clip(0, 2), clip(2 + 1e-9, 5)])])
    expect(editPoints(s)).toEqual([0, 2, 5])
  })

  it('keeps distinct times just outside epsilon', () => {
    const pts = editPoints(seq([track([clip(0, 2), clip(2.001, 5)])]))
    expect(pts).toEqual([0, 2, 2.001, 5])
  })

  it('returns a sorted result even when tracks are out of time order', () => {
    const s = seq([
      track([clip(3, 5)]),
      track([clip(0, 2)], { kind: 'audio', name: 'A1' }),
    ])
    expect(editPoints(s)).toEqual([0, 2, 3, 5])
  })

  it('unlockedOnly excludes a locked track cuts', () => {
    const s = seq([
      track([clip(0, 2)]),
      track([clip(6, 8)], { kind: 'audio', name: 'A1', locked: true }),
    ])
    expect(editPoints(s, { unlockedOnly: true })).toEqual([0, 2])
    // Without the option, the locked track's cuts are still present.
    expect(editPoints(s)).toEqual([0, 2, 6, 8])
  })

  it('does not drop a shared cut when only one of the tracks at it is locked', () => {
    const s = seq([
      track([clip(0, 2)]),
      track([clip(2, 4)], { kind: 'audio', name: 'A1', locked: true }),
    ])
    // The unlocked track still contributes the 2, so it survives.
    expect(editPoints(s, { unlockedOnly: true })).toEqual([0, 2])
  })
})

describe('nextEditPoint', () => {
  it('jumps to the cut after a mid-clip time', () => {
    expect(nextEditPoint(twoClip(), 2.5)).toBe(3)
  })

  it('sitting exactly on a cut jumps to the NEXT cut, not itself', () => {
    expect(nextEditPoint(twoClip(), 2)).toBe(3)
  })

  it('from before everything jumps to the first non-zero cut', () => {
    expect(nextEditPoint(twoClip(), -1)).toBe(0)
    expect(nextEditPoint(twoClip(), 0)).toBe(2)
  })

  it('past the end returns the last edit point (no-op at the tail)', () => {
    expect(nextEditPoint(twoClip(), 10)).toBe(5)
  })

  it('exactly on the last cut returns that last cut', () => {
    expect(nextEditPoint(twoClip(), 5)).toBe(5)
  })

  it('on an empty timeline stays at 0', () => {
    expect(nextEditPoint(seq([track([])]), 0)).toBe(0)
    expect(nextEditPoint(seq([track([])]), 5)).toBe(0)
  })

  it('crosses tracks: the next cut can come from another lane', () => {
    const s = seq([
      track([clip(0, 4)]),
      track([clip(2, 6)], { kind: 'audio', name: 'A1' }),
    ])
    // Cuts: 0, 2, 4, 6. From 0 the next is the audio cut at 2.
    expect(nextEditPoint(s, 0)).toBe(2)
    expect(nextEditPoint(s, 2)).toBe(4)
  })
})

describe('prevEditPoint', () => {
  it('jumps to the cut before a mid-clip time', () => {
    expect(prevEditPoint(twoClip(), 2.5)).toBe(2)
  })

  it('sitting exactly on a cut jumps to the PREVIOUS cut, not itself', () => {
    expect(prevEditPoint(twoClip(), 3)).toBe(2)
  })

  it('before everything returns 0', () => {
    expect(prevEditPoint(twoClip(), -1)).toBe(0)
    expect(prevEditPoint(twoClip(), 0)).toBe(0)
  })

  it('exactly on 0 returns 0', () => {
    expect(prevEditPoint(twoClip(), 0)).toBe(0)
  })

  it('from past the end steps back to the last cut', () => {
    expect(prevEditPoint(twoClip(), 10)).toBe(5)
  })

  it('just after the first cut steps back to it, not to 0', () => {
    expect(prevEditPoint(twoClip(), 2.0001)).toBe(2)
  })

  it('crosses tracks: the previous cut can come from another lane', () => {
    const s = seq([
      track([clip(0, 4)]),
      track([clip(2, 6)], { kind: 'audio', name: 'A1' }),
    ])
    // Cuts: 0, 2, 4, 6. From 5 the previous is 4; from 3 it is the audio cut 2.
    expect(prevEditPoint(s, 5)).toBe(4)
    expect(prevEditPoint(s, 3)).toBe(2)
  })
})

describe('round trips', () => {
  it('next then prev from a cut returns to that cut', () => {
    const s = twoClip()
    const forward = nextEditPoint(s, 2) // 2 -> 3
    expect(prevEditPoint(s, forward)).toBe(2)
  })

  it('walking next repeatedly visits every cut then rests at the end', () => {
    const s = twoClip()
    const visited: number[] = []
    let t = -1
    for (let i = 0; i < 10; i++) {
      const nt = nextEditPoint(s, t)
      if (nt === t) break
      visited.push(nt)
      t = nt
    }
    expect(visited).toEqual([0, 2, 3, 5])
  })

  it('walking prev repeatedly visits every cut down to 0', () => {
    const s = twoClip()
    const visited: number[] = []
    let t = 10
    for (let i = 0; i < 10; i++) {
      const pt = prevEditPoint(s, t)
      if (pt === t) break
      visited.push(pt)
      t = pt
    }
    expect(visited).toEqual([5, 3, 2, 0])
  })
})
