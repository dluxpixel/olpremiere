// ⛔ EVERY WAY A DRAG LOST ITS SHAPE OR ATE A CLIP, PINNED ONE BY ONE, 2026-10-03.
//
// His words that day: "sometimes when i drag audio or video clips lanes it deleted the clip behind
// it fix that, and lastly the dragging feature is still so shit! ... make it so when i select
// multiple stuff and drag it anywhere it actually works and stays in the SAME SHAPE as when i
// dragged it".
//
// Two hunts (a shape hunt and a destroy hunt) fuzzed the old drag and reproduced every case below
// on the real pointer as well as in the engine. Each test here was written FIRST and ran red on the
// old code. The R numbers are the shape hunt's, the D numbers the destroy hunt's, so a finding in
// either report can be looked up here by its name.
//
// The rule every one of these checks is the one in blockMove.ts: the dragged set is one rigid
// block, it moves by one time delta and one lane delta, and a drop never deletes, splits, trims,
// carves or reshuffles anything.
//
// Times are frames at 30 fps written as seconds, so every number is exact.

import { describe, expect, it } from 'vitest'
import { dragBlockIds, moveBlock } from './blockMove'
import { clipEndS, defaultTransform, type Clip, type Id, type Sequence, type Track } from './types'

const clip = (id: string, startS: number, durS: number, linkId?: string): Clip => ({
  id,
  assetId: 'av',
  startS,
  inS: 0,
  outS: durS,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...(linkId ? { linkId } : {}),
})

const track = (id: string, kind: 'video' | 'audio', clips: Clip[], locked = false): Track => ({
  id,
  kind,
  name: id,
  height: 64,
  muted: false,
  solo: false,
  locked,
  volumeDb: 0,
  pan: 0,
  clips: [...clips].sort((a, b) => a.startS - b.startS),
})

const seqOf = (tracks: Track[]): Sequence => ({
  id: 's',
  name: 's',
  fps: 30,
  width: 1920,
  height: 1080,
  sampleRate: 48000,
  durationS: 60,
  tracks,
  markers: [],
})

const FRAME = 1 / 30
const f = (n: number): number => n / 30

/**
 * Exactly what the Timeline commits when he lets go: the block is read off his selection as it
 * stands after the press (the grabbed clip is always in it), then the one pure move runs.
 */
function dragSel(seq: Sequence, selection: Id[], grab: Id, lane: Id, tS: number): Sequence {
  const sel = selection.includes(grab) ? selection : [...selection, grab]
  return moveBlock(seq, dragBlockIds(seq, sel, grab), grab, lane, tS)
}

const at = (s: Sequence, id: Id) => {
  const t = s.tracks.find((tr) => tr.clips.some((c) => c.id === id))
  const c = t?.clips.find((x) => x.id === id)
  return c && t ? { lane: t.id, start: +c.startS.toFixed(6), end: +clipEndS(c).toFixed(6) } : null
}
const ids = (s: Sequence) => s.tracks.flatMap((t) => t.clips.map((c) => c.id)).sort()

/** Every clip outside `moving` that is gone or is not deep-equal to what it was, on the same lane. */
function damaged(before: Sequence, after: Sequence, moving: Id[]): string[] {
  const out: string[] = []
  for (const t of before.tracks) {
    for (const c of t.clips) {
      if (moving.includes(c.id)) continue
      const tAfter = after.tracks.find((x) => x.clips.some((y) => y.id === c.id))
      const d = tAfter?.clips.find((y) => y.id === c.id)
      if (!d) out.push(`${c.id} deleted`)
      else if (tAfter!.id !== t.id || JSON.stringify(d) !== JSON.stringify(c)) out.push(`${c.id} changed`)
    }
  }
  return out
}

const overlapping = (seq: Sequence): string[] =>
  seq.tracks.flatMap((t) =>
    t.clips
      .filter((c, i) => i > 0 && c.startS < clipEndS(t.clips[i - 1]!) - 1e-9)
      .map((c) => `${c.id} on ${t.id}`),
  )

describe('NEVER DESTROY: a drop onto another lane leaves the clip already there alone', () => {
  it('R1 an audio clip dropped on a lane with a music bed under it goes past the bed, the bed untouched', () => {
    const seq = seqOf([track('V1', 'video', []), track('A1', 'audio', [clip('bed', 0.5, 6)]), track('A2', 'audio', [clip('sfx', 0, 1)])])
    const out = dragSel(seq, ['sfx'], 'sfx', 'A1', 1)
    expect(ids(out)).toEqual(ids(seq))
    expect(damaged(seq, out, ['sfx'])).toEqual([])
    // Left of the bed there is no room (it starts at 0.5 and the sfx is a second long), so the
    // nearest legal spot on A1 is right after it.
    expect(at(out, 'sfx')).toEqual({ lane: 'A1', start: 6.5, end: 7.5 })
    expect(overlapping(out)).toEqual([])
  })

  it('R2 a video clip dropped over a long clip on another lane never cuts a hole in it', () => {
    const seq = seqOf([track('V1', 'video', [clip('g', 3, 2)]), track('V2', 'video', [clip('long', 1, 9)])])
    const out = dragSel(seq, ['g'], 'g', 'V2', 6)
    expect(ids(out)).toEqual(ids(seq))
    expect(damaged(seq, out, ['g'])).toEqual([])
    expect(at(out, 'g')).toEqual({ lane: 'V2', start: 10, end: 12 })
  })

  it('R3 a selected linked pair dragged up a video lane never carves the audio lane under its sound', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('v', 0, 2, 'L')]),
      track('V2', 'video', [clip('o', 0, 3)]),
      track('A1', 'audio', [clip('a', 0, 2, 'L'), clip('bed', 2.5, 6)]),
    ])
    const out = dragSel(seq, ['v', 'a'], 'v', 'V2', 0)
    expect(ids(out)).toEqual(ids(seq))
    expect(damaged(seq, out, ['v', 'a'])).toEqual([])
    expect(at(out, 'v')!.lane).toBe('V2')
    expect(at(out, 'a')!.lane).toBe('A1')
    expect(at(out, 'v')!.start, 'the pair stays in sync').toBe(at(out, 'a')!.start)
    expect(overlapping(out)).toEqual([])
  })

  it('R4 no two clips are ever left lying on top of each other, even with frame times built by sums', () => {
    const fr = (n: number) => n * (1 / 30)
    const seq = seqOf([
      track('V1', 'video', [clip('v0', fr(3), fr(40)), clip('v1', fr(43), fr(96))]),
      track('V3', 'video', [clip('g', fr(23), fr(21))]),
    ])
    const out = dragSel(seq, ['g'], 'g', 'V1', fr(128))
    expect(overlapping(out)).toEqual([])
    expect(damaged(seq, out, ['g'])).toEqual([])
  })

  /** A finished Short: V1 packed with cuts, an overlay on V2 above the middle cut, A1 voice, A2 bed. */
  function packed() {
    return seqOf([
      track('V1', 'video', [clip('k1', 0, 3), clip('k2', 3, 2), clip('k3', 5, 4)]),
      track('V2', 'video', [clip('ov', 3, 2)]),
      track('A1', 'audio', [clip('voice', 2, 2)]),
      track('A2', 'audio', [clip('bed', 0, 10)]),
    ])
  }

  it('D1 the overlay dropped on packed V1 one frame right of where it was keeps k2, the clip behind it', () => {
    const seq = packed()
    const out = dragSel(seq, [], 'ov', 'V1', 3 + FRAME)
    expect(damaged(seq, out, ['ov'])).toEqual([])
    expect(ids(out)).toEqual(ids(seq))
    expect(at(out, 'ov')).toEqual({ lane: 'V1', start: 9, end: 11 })
  })

  it('D1 his voice dropped on the music bed lane never deletes a slice of music', () => {
    const seq = packed()
    const out = dragSel(seq, [], 'voice', 'A2', 2.5)
    expect(damaged(seq, out, ['voice'])).toEqual([])
    expect(at(out, 'voice')).toEqual({ lane: 'A2', start: 10, end: 12 })
  })

  it('D1 a linked half grabbed alone does the same, and its partner stays put', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('k1', 0, 3), clip('k2', 3, 2), clip('k3', 5, 4)]),
      track('V2', 'video', [clip('v', 3, 2, 'L')]),
      track('A1', 'audio', [clip('a', 3, 2, 'L')]),
    ])
    const out = dragSel(seq, [], 'v', 'V1', 3.2)
    expect(damaged(seq, out, ['v'])).toEqual([])
    expect(at(out, 'a')).toEqual(at(seq, 'a'))
  })

  it('D1 a one-frame clip that only touches the drop window is never swept away', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('k1', 0, 3), clip('k2', 3, 2), clip('blip', 5, FRAME), clip('k3', 5 + FRAME, 4)]),
      track('V2', 'video', [clip('ov', 3, 2)]),
    ])
    const out = dragSel(seq, [], 'ov', 'V1', 3.1)
    expect(damaged(seq, out, ['ov'])).toEqual([])
    expect(overlapping(out)).toEqual([])
  })

  /** V2 pair [3,5] with its audio on A1 [3,5]; A1 also holds q at [9,11]; V1 packed to 9. */
  function pairOverPacked() {
    return seqOf([
      track('V1', 'video', [clip('k1', 0, 3), clip('k2', 3, 2), clip('k3', 5, 4)]),
      track('V2', 'video', [clip('v', 3, 2, 'L')]),
      track('A1', 'audio', [clip('a', 3, 2, 'L'), clip('q', 9, 2)]),
    ])
  }

  it('D2 a selected pair dragged straight down never deletes the clip on its sound lane', () => {
    const seq = pairOverPacked()
    for (const tS of [3, 2.9, 3.1]) {
      const out = dragSel(seq, ['v', 'a'], 'v', 'V1', tS)
      expect(damaged(seq, out, ['v', 'a']), `dropped at ${tS}`).toEqual([])
      expect(overlapping(out)).toEqual([])
      expect(at(out, 'v')!.start).toBe(at(out, 'a')!.start)
    }
  })

  it('D2 a selected pair whose nearest room is BEHIND it moves back whole, carving nothing', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('k', 4, 10)]),
      track('V2', 'video', [clip('v', 6, 2, 'L')]),
      track('A1', 'audio', [clip('r', 2, 4), clip('a', 6, 2, 'L')]),
    ])
    const out = dragSel(seq, ['v', 'a'], 'v', 'V1', 6.5)
    expect(damaged(seq, out, ['v', 'a'])).toEqual([])
    expect(at(out, 'r')).toEqual({ lane: 'A1', start: 2, end: 6 })
    expect(at(out, 'v')!.start).toBe(at(out, 'a')!.start)
    expect(overlapping(out)).toEqual([])
  })

  it('D3 two selected overlays dragged down onto packed V1 keep every clip on V1', () => {
    const base = packed()
    const seq = seqOf([
      base.tracks[0]!,
      { ...base.tracks[1]!, clips: [...base.tracks[1]!.clips, clip('ov2', 6, 1)] },
      track('V3', 'video', []),
      base.tracks[2]!,
      base.tracks[3]!,
    ])
    const out = dragSel(seq, ['ov', 'ov2'], 'ov', 'V1', 3 + FRAME)
    expect(damaged(seq, out, ['ov', 'ov2'])).toEqual([])
    expect(at(out, 'ov2')!.start - at(out, 'ov')!.start, 'and the pair keeps its spacing').toBe(3)
  })

  it('D4 a solo audio half dropped on the bed never marks its video partner as having lost its sound', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('v', 2, 2, 'L')]),
      track('A1', 'audio', [clip('a', 2, 2, 'L')]),
      track('A2', 'audio', [clip('bed', 0, 10)]),
    ])
    const out = dragSel(seq, [], 'a', 'A2', 2.5)
    expect(damaged(seq, out, ['a'])).toEqual([])
    const v = out.tracks[0]!.clips[0]!
    expect(v.ownAudioOff).toBeUndefined()
  })

  it('D5 a selected clip under the grabbed one is carried, never carved first', () => {
    const seq = packed()
    const out = dragSel(seq, ['ov', 'k2'], 'ov', 'V1', 3 + FRAME)
    expect(ids(out)).toEqual(ids(seq))
    expect(damaged(seq, out, ['ov', 'k2'])).toEqual([])
    expect(overlapping(out)).toEqual([])
  })

  it('D6 a clip that crosses the drop edge by less than a frame is never left overlapping', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('c', 0, 3.02), clip('d', 3.02, 5.98)]),
      track('V2', 'video', [clip('ov', 3, 2)]),
    ])
    const out = dragSel(seq, [], 'ov', 'V1', 3.5)
    expect(overlapping(out)).toEqual([])
    expect(damaged(seq, out, ['ov'])).toEqual([])
  })

  it('B a body drag never writes a transition onto anything', () => {
    const seq = packed()
    for (const t of [0, 1, 3, 3 + FRAME, 4, 9, 12]) {
      const out = dragSel(seq, [], 'ov', 'V1', t)
      const any = out.tracks.flatMap((tr) => tr.clips).some((c) => c.transitionIn || c.transitionOut)
      expect(any).toBe(false)
    }
  })
})

describe('THE SELECTION GOES WHERE HE DRAGGED IT', () => {
  it('R5 two butted clips, both selected: grabbing the left one and dragging right moves both', () => {
    const seq = seqOf([track('V1', 'video', [clip('p', 0, 2), clip('q', 2, 2)])])
    const out = dragSel(seq, ['p', 'q'], 'p', 'V1', 1)
    expect(at(out, 'p')!.start).toBe(1)
    expect(at(out, 'q')!.start).toBe(3)
  })

  it('D5 a selected run of three butted clips moves from whichever clip he grabs', () => {
    const seq = seqOf([track('V1', 'video', [clip('a', 0, 2), clip('b', 2, 2), clip('c', 4, 2)])])
    for (const [grab, tS] of [['a', 1], ['b', 3], ['c', 5]] as const) {
      const out = dragSel(seq, ['a', 'b', 'c'], grab, 'V1', tS)
      expect([at(out, 'a')!.start, at(out, 'b')!.start, at(out, 'c')!.start], `grabbing ${grab}`).toEqual([1, 3, 5])
    }
  })

  it('R6 a selection with room to spare goes the whole way, never stopping against its own clip', () => {
    const seq = seqOf([track('V1', 'video', [clip('p', 0, 2), clip('q', 3, 2)])])
    const out = dragSel(seq, ['p', 'q'], 'p', 'V1', 4)
    expect(at(out, 'p')!.start).toBe(4)
    expect(at(out, 'q')!.start).toBe(7)
  })

  it('R7 a linked pair with the audio clip right after it, all selected, moves as one', () => {
    const seq = seqOf([track('V1', 'video', [clip('v', 0, 1, 'L')]), track('A1', 'audio', [clip('a', 0, 1, 'L'), clip('b', 1, 1)])])
    const out = dragSel(seq, ['v', 'a', 'b'], 'v', 'V1', 2)
    expect(at(out, 'v')!.start).toBe(2)
    expect(at(out, 'a')!.start).toBe(2)
    expect(at(out, 'b')!.start).toBe(3)
  })

  it('R8 a purely vertical drag of a stacked selection moves lanes and not time', () => {
    const seq = seqOf([track('V1', 'video', [clip('g', 0, 2)]), track('V2', 'video', [clip('y', 0, 2)]), track('V3', 'video', [])])
    const out = dragSel(seq, ['g', 'y'], 'g', 'V2', 0)
    expect(at(out, 'g')).toEqual({ lane: 'V2', start: 0, end: 2 })
    expect(at(out, 'y')).toEqual({ lane: 'V3', start: 0, end: 2 })
  })

  it('R9 dragged left onto another lane, it goes left (stopping the whole block at zero)', () => {
    const seq = seqOf([track('V1', 'video', []), track('V2', 'video', [clip('y', 0.5, 2.5)]), track('V3', 'video', [clip('g', 1.5, 3)])])
    const out = dragSel(seq, ['g', 'y'], 'g', 'V2', 0)
    expect(at(out, 'g')).toEqual({ lane: 'V2', start: 1, end: 4 })
    expect(at(out, 'y')).toEqual({ lane: 'V1', start: 0, end: 2.5 })
  })

  it('R10 a single clip dragged right onto another lane takes the nearest free spot, here to the right', () => {
    const seq = seqOf([track('V1', 'video', [clip('g', f(50), f(34))]), track('V2', 'video', [clip('y', f(44), f(54))])])
    const out = dragSel(seq, ['g'], 'g', 'V2', f(56))
    expect(at(out, 'g')).toEqual({ lane: 'V2', start: +f(98).toFixed(6), end: +f(132).toFixed(6) })
  })

  it('F17 a selected pair jumps over a neighbour to a free spot exactly as a single clip would', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('v1', f(130), f(112), 'L0'), clip('v2', f(272), f(100))]),
      track('A1', 'audio', [clip('a3', f(130), f(112), 'L0')]),
      track('A2', 'audio', []),
    ])
    const out = dragSel(seq, ['v1', 'a3'], 'a3', 'A2', f(519))
    expect(at(out, 'a3')).toEqual({ lane: 'A2', start: +f(519).toFixed(6), end: +f(631).toFixed(6) })
    expect(at(out, 'v1')).toEqual({ lane: 'V1', start: +f(519).toFixed(6), end: +f(631).toFixed(6) })
  })
})

describe('THE SHAPE HOLDS', () => {
  it('R11 an unselected clip where one carried clip would land moves the WHOLE block, not that clip alone', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('a', 1, 2)]),
      track('V2', 'video', [clip('b', 2, 2), clip('c', 5, 1)]),
      track('V3', 'video', [clip('w', 7.5, 2)]),
    ])
    const out = dragSel(seq, ['a', 'b', 'c'], 'b', 'V3', 4)
    const dT = at(out, 'b')!.start - 2
    expect(at(out, 'a')).toEqual({ lane: 'V2', start: 1 + dT, end: 3 + dT })
    expect(at(out, 'c')).toEqual({ lane: 'V3', start: 5 + dT, end: 6 + dT })
    expect(at(out, 'b')!.lane).toBe('V3')
    expect(damaged(seq, out, ['a', 'b', 'c'])).toEqual([])
    expect(overlapping(out)).toEqual([])
    // The block wanted +2s; c would sit on w there, so it stops against w at +1.5s.
    expect(dT).toBe(1.5)
  })

  it('S2 two selected clips with a blocker ahead of the second keep their gap', () => {
    const seq = seqOf([track('V1', 'video', [clip('a', 0, 2), clip('b', 5, 2), clip('x', 7.5, 1.5)])])
    const out = dragSel(seq, ['a', 'b'], 'a', 'V1', 1)
    expect(at(out, 'b')!.start - at(out, 'a')!.start).toBe(5)
    expect(at(out, 'x')).toEqual(at(seq, 'x'))
  })

  it('R12 dragging left past zero stops the whole block when its EARLIEST clip reaches zero', () => {
    const seq = seqOf([track('V1', 'video', [clip('g', 2, 1)]), track('V2', 'video', [clip('e', 0.5, 1)])])
    const out = dragSel(seq, ['g', 'e'], 'g', 'V1', 0.5)
    expect(at(out, 'e')!.start).toBe(0)
    expect(at(out, 'g')!.start - at(out, 'e')!.start, 'gap between them unchanged').toBe(1.5)
  })

  it('R13 a two-lane selection dragged past the top of the stack stops at the top, still two lanes', () => {
    const seq = seqOf([track('V1', 'video', [clip('g', 0, 2)]), track('V2', 'video', [clip('y', 0, 2)]), track('V3', 'video', [])])
    const out = dragSel(seq, ['g', 'y'], 'g', 'V3', 0)
    expect(at(out, 'g')).toEqual({ lane: 'V2', start: 0, end: 2 })
    expect(at(out, 'y')).toEqual({ lane: 'V3', start: 0, end: 2 })
  })

  it('S2 a two-lane selection pushed up a lane at the top of the stack does not collapse onto one lane', () => {
    const seq = seqOf([track('V1', 'video', [clip('lo', 0, 2)]), track('V2', 'video', [clip('hi', 4, 2)])])
    const out = dragSel(seq, ['lo', 'hi'], 'lo', 'V2', 0)
    expect(at(out, 'lo')!.lane).toBe('V1')
    expect(at(out, 'hi')!.lane).toBe('V2')
  })

  it('R14 grabbing an AUDIO clip takes a selected pair\'s audio half down the same lane, the video stays', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('v', 0, 1, 'L')]),
      track('A1', 'audio', [clip('a', 0, 1, 'L'), clip('x', 3, 1)]),
      track('A2', 'audio', []),
    ])
    const out = dragSel(seq, ['v', 'a', 'x'], 'x', 'A2', 3)
    expect(at(out, 'x')!.lane).toBe('A2')
    expect(at(out, 'a')!.lane).toBe('A2')
    expect(at(out, 'v')).toEqual(at(seq, 'v'))
  })

  it('R15 a carried pair whose sound meets an unselected clip holds the whole block back with it', () => {
    const seq = seqOf([
      track('V1', 'video', [clip('g', 0, 1)]),
      track('V2', 'video', [clip('v', 0, 1, 'L')]),
      track('A1', 'audio', [clip('a', 0, 1, 'L'), clip('w', 1.5, 1.5)]),
    ])
    const out = dragSel(seq, ['g', 'v', 'a'], 'g', 'V1', 1)
    const dT = at(out, 'g')!.start
    expect(dT).toBe(0.5)
    expect(at(out, 'v')!.start).toBe(dT)
    expect(at(out, 'a')!.start).toBe(dT)
    expect(damaged(seq, out, ['g', 'v', 'a'])).toEqual([])
  })

  it('R16 a lane change that would put one clip on a LOCKED lane is refused for the whole block', () => {
    const seq = seqOf([track('V1', 'video', [clip('g', 0, 1)]), track('V2', 'video', [clip('x', 3, 1)]), track('V3', 'video', [], true)])
    const out = dragSel(seq, ['g', 'x'], 'g', 'V2', 0)
    expect(at(out, 'g')!.lane).toBe('V1')
    expect(at(out, 'x')!.lane).toBe('V2')
  })

  it('R17 the order clips are handled in can never tear a block that fits exactly where it was dropped', () => {
    const seq = seqOf([
      track('A1', 'audio', [clip('a0', f(48), f(80))]),
      track('A2', 'audio', [clip('a1', f(49), f(109)), clip('a2', f(162), f(88))]),
      track('A3', 'audio', []),
    ])
    const out = dragSel(seq, ['a0', 'a1', 'a2'], 'a2', 'A3', f(129))
    expect(at(out, 'a0')).toEqual({ lane: 'A2', start: +f(15).toFixed(6), end: +f(95).toFixed(6) })
    expect(at(out, 'a1')).toEqual({ lane: 'A3', start: +f(16).toFixed(6), end: +f(125).toFixed(6) })
    expect(at(out, 'a2')).toEqual({ lane: 'A3', start: +f(129).toFixed(6), end: +f(217).toFixed(6) })
  })

  it('R18 a selected pair with one half on a LOCKED lane never splits out of sync', () => {
    const seq = seqOf([track('V1', 'video', [clip('v', 1, 1, 'L')], true), track('A1', 'audio', [clip('a', 1, 1, 'L')])])
    const out = dragSel(seq, ['v', 'a'], 'a', 'A1', 3)
    expect(at(out, 'a')!.start - at(out, 'v')!.start).toBe(0)
    expect(at(out, 'v')).toEqual(at(seq, 'v'))
  })
})

describe('the 2026-08-05 rule still holds: a partner travels only when it is selected too', () => {
  const seq = () =>
    seqOf([
      track('V1', 'video', [clip('v1', 0, 1, 'L1'), clip('v2', 4, 1, 'L2')]),
      track('A1', 'audio', [clip('a1', 0, 1, 'L1'), clip('a2', 4, 1, 'L2')]),
    ])

  it('grabbing one half alone leaves the other half where it is', () => {
    const out = dragSel(seq(), [], 'v1', 'V1', 2)
    expect(at(out, 'v1')!.start).toBe(2)
    expect(at(out, 'a1')!.start).toBe(0)
  })

  it('two video halves selected: both move, neither sound does', () => {
    const out = dragSel(seq(), ['v1', 'v2'], 'v1', 'V1', 8)
    expect([at(out, 'v1')!.start, at(out, 'v2')!.start]).toEqual([8, 12])
    expect([at(out, 'a1')!.start, at(out, 'a2')!.start]).toEqual([0, 4])
  })

  it('both halves selected: they move together', () => {
    const out = dragSel(seq(), ['v1', 'a1'], 'v1', 'V1', 2)
    expect(at(out, 'v1')!.start).toBe(2)
    expect(at(out, 'a1')!.start).toBe(2)
  })

  it('reads the block off the selection, partners only when both halves are in it', () => {
    const s = seq()
    expect(dragBlockIds(s, ['v1'], 'v1')).toEqual(['v1'])
    expect(dragBlockIds(s, ['v1', 'a1'], 'v1').sort()).toEqual(['a1', 'v1'])
    expect(dragBlockIds(s, ['v1', 'v2', 'a2'], 'v1').sort()).toEqual(['a2', 'v1', 'v2'])
    // The grabbed clip is always in its own drag, even before the selection catches up.
    expect(dragBlockIds(s, [], 'a2')).toEqual(['a2'])
  })
})

describe('the block always moves when there is anywhere legal to go (2026-08-12)', () => {
  it('a clip on a packed track dragged past the middle of its neighbour jumps over it', () => {
    const seq = seqOf([track('V1', 'video', [clip('a', 0, 2), clip('b', 2, 2), clip('c', 4, 2)])])
    // b wants +2.5s. Home is 2.5s back and the spot after c is 1.5s on, so it goes on.
    const out = dragSel(seq, [], 'b', 'V1', 4.5)
    expect(at(out, 'b')!.start).toBe(6)
    expect(damaged(seq, out, ['b'])).toEqual([])
  })

  it('a nudge that has nowhere to go puts it back exactly where it was, and changes nothing', () => {
    const seq = seqOf([track('V1', 'video', [clip('a', 0, 2), clip('b', 2, 2), clip('c', 4, 2)])])
    expect(dragSel(seq, [], 'b', 'V1', 2.5)).toBe(seq)
  })

  it('a tie between the two nearest spots goes the way he dragged', () => {
    const tie = seqOf([track('V1', 'video', [clip('w', 2, 2)]), track('V2', 'video', [clip('g', 10, 2)])])
    // g dropped on V1 at 2: the clip w occupies 2..4, g is 2 long. Left spot 0 and right spot 4
    // are both 2s away; he dragged left (10 -> 2), so it lands at 0.
    expect(at(dragSel(tie, [], 'g', 'V1', 2), 'g')).toEqual({ lane: 'V1', start: 0, end: 2 })
    // The same drop dragged RIGHT from 1 to 2 goes right.
    const tie2 = seqOf([track('V1', 'video', [clip('w', 2, 2)]), track('V2', 'video', [clip('g', 1, 2)])])
    expect(at(dragSel(tie2, [], 'g', 'V1', 2), 'g')).toEqual({ lane: 'V1', start: 4, end: 6 })
  })
})

// ⛔ A LANE WITH NO ROOM NEAR THE POINTER IS NOT WORTH A FLIGHT, 2026-10-03.
//
// Measured through the real mouse that day: an overlay pulled from V2 down onto a packed V1 at
// 10 s landed at 60 s, fifty seconds from his hand and off the screen (the preview was not even
// drawn, it was so far away), and with a hole at 40 s it landed at 40 s. Nearest legal spot on the
// lane he aimed at, yes, but nowhere near where he was looking. The nearest spot is now measured
// the way he sees it, on screen: a lane short of where he aimed counts as `laneCostS` seconds of
// sideways miss, so a spot on his aimed lane wins while it is close, and a block whose aimed lane
// has no room anywhere near stays on the nearest lane that does, following his hand in time.
// Without `laneCostS` (no pointer, no screen) the aimed lane always wins, as before.
describe('a lane with no room near the pointer is not worth a flight (2026-10-03)', () => {
  /** V1 packed with 2 s cuts from 0 to 60, the ones starting at `holes` left out. */
  const packed = (holes: number[] = []) =>
    Array.from({ length: 30 }, (_, i) => i * 2)
      .filter((s) => !holes.includes(s))
      .map((s) => clip(`k${s}`, s, 2))
  // 400 px of reach at 60 px a second.
  const REACH = 400 / 60
  const dragAt = (seq: Sequence, sel: Id[], grab: Id, lane: Id, tS: number, laneCostS?: number) =>
    moveBlock(seq, dragBlockIds(seq, sel.includes(grab) ? sel : [...sel, grab], grab), grab, lane, tS, laneCostS === undefined ? {} : { laneCostS })

  it('an overlay aimed at a packed lane stays on its own lane under the hand, never 50 s away', () => {
    const seq = seqOf([track('V1', 'video', packed()), track('V2', 'video', [clip('ov', 10, 2)])])
    const out = dragAt(seq, [], 'ov', 'V1', 10.5, REACH)
    expect(at(out, 'ov')).toEqual({ lane: 'V2', start: 10.5, end: 12.5 })
    expect(damaged(seq, out, ['ov'])).toEqual([])
  })

  it('a hole 30 s away on the aimed lane is no reason to fly there either', () => {
    const seq = seqOf([track('V1', 'video', packed([40])), track('V2', 'video', [clip('ov', 10, 2)])])
    expect(at(dragAt(seq, [], 'ov', 'V1', 10, REACH), 'ov')).toEqual({ lane: 'V2', start: 10, end: 12 })
  })

  it('a hole close to the hand on the aimed lane still takes it', () => {
    const seq = seqOf([track('V1', 'video', packed([12])), track('V2', 'video', [clip('ov', 10, 2)])])
    expect(at(dragAt(seq, [], 'ov', 'V1', 10.5, REACH), 'ov')).toEqual({ lane: 'V1', start: 12, end: 14 })
  })

  it('aimed two lanes down at a packed lane, it stops on the free lane in between', () => {
    const seq = seqOf([track('V1', 'video', packed()), track('V2', 'video', []), track('V3', 'video', [clip('ov', 10, 2)])])
    expect(at(dragAt(seq, [], 'ov', 'V1', 11, REACH), 'ov')).toEqual({ lane: 'V2', start: 11, end: 13 })
  })

  it('a two lane block keeps its shape whichever lanes it settles on', () => {
    // a on V2, b on V3, aimed one lane down: a would land on packed V1, so the block stays put in
    // lanes and follows the hand in time, a and b still one lane and 1 s apart.
    const seq = seqOf([track('V1', 'video', packed()), track('V2', 'video', [clip('a', 10, 1)]), track('V3', 'video', [clip('b', 11, 1)])])
    const out = dragAt(seq, ['a', 'b'], 'a', 'V1', 12, REACH)
    expect(at(out, 'a')).toEqual({ lane: 'V2', start: 12, end: 13 })
    expect(at(out, 'b')).toEqual({ lane: 'V3', start: 13, end: 14 })
  })

  it('with no reach given (no pointer, no screen) the aimed lane wins, however far', () => {
    const seq = seqOf([track('V1', 'video', packed()), track('V2', 'video', [clip('ov', 10, 2)])])
    expect(at(dragAt(seq, [], 'ov', 'V1', 10.5), 'ov')).toEqual({ lane: 'V1', start: 60, end: 62 })
  })

  it('a miss exactly worth a lane goes to the lane he aimed at', () => {
    // On V1 the nearest fit is 1 s from the hand; the lane is worth exactly 1 s.
    const seq = seqOf([track('V1', 'video', [clip('w', 4, 2)]), track('V2', 'video', [clip('g', 2, 2)])])
    expect(at(dragAt(seq, [], 'g', 'V1', 3, 1), 'g')).toEqual({ lane: 'V1', start: 2, end: 4 })
  })
})
