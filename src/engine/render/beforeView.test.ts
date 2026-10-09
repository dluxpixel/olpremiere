import { describe, expect, it } from 'vitest'
import { beforeScopeFor, beforeView, dropIdleAdjustments } from './beforeView'
import { resolveFrame } from './resolve'
import { defaultTransform, type Clip, type EffectInstance, type Sequence, type Track } from '../types'

// The Before picture: the sequence with its effects off, held to compare. It is
// a view, so the claims are about what it leaves alone as much as what it takes.

let uid = 0
const id = (p: string): string => `${p}-${uid++}`

const blur = (): EffectInstance => ({ id: id('fx'), type: 'gaussianBlur', params: { blur: 8 }, enabled: true })

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: id('clip'),
    assetId: id('asset'),
    startS: 0,
    inS: 0,
    outS: 4,
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
  }
}

function track(over: Partial<Track> = {}): Track {
  return {
    id: id('track'),
    kind: 'video',
    name: 'V1',
    height: 64,
    muted: false,
    solo: false,
    locked: false,
    volumeDb: 0,
    pan: 0,
    clips: [],
    ...over,
  }
}

function seqOf(tracks: Track[], over: Partial<Sequence> = {}): Sequence {
  return {
    id: id('seq'),
    name: 'Seq',
    fps: 30,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    durationS: 0,
    tracks,
    markers: [],
    ...over,
  }
}

describe('beforeScopeFor', () => {
  it('is every clip when nothing is selected', () => {
    const seq = seqOf([track({ clips: [clip()] })])
    expect(beforeScopeFor(seq, [])).toBe('all')
  })

  it('is the selected video clips, and nothing else', () => {
    const a = clip()
    const b = clip()
    const seq = seqOf([track({ clips: [a, b] })])
    const scope = beforeScopeFor(seq, [a.id])
    expect(scope).not.toBe('all')
    expect([...(scope as ReadonlySet<string>)]).toEqual([a.id])
  })

  it('falls back to every clip when only audio clips are selected', () => {
    const v = clip()
    const a = clip()
    const seq = seqOf([track({ clips: [v] }), track({ kind: 'audio', name: 'A1', clips: [a] })])
    expect(beforeScopeFor(seq, [a.id])).toBe('all')
  })

  it('ignores a selected id that no longer exists', () => {
    const seq = seqOf([track({ clips: [clip()] })])
    expect(beforeScopeFor(seq, ['gone'])).toBe('all')
  })
})

describe('beforeView', () => {
  it('empties the effects of every video clip in the "all" scope', () => {
    const a = clip({ effects: [blur()] })
    const b = clip({ effects: [blur(), blur()] })
    const seq = seqOf([track({ clips: [a] }), track({ name: 'V2', clips: [b] })])
    const view = beforeView(seq, 'all')
    expect(view.tracks.flatMap((t) => t.clips).map((c) => c.effects.length)).toEqual([0, 0])
    // The real sequence is untouched: a view, never an edit.
    expect(a.effects).toHaveLength(1)
    expect(b.effects).toHaveLength(2)
    expect(seq.tracks[0].clips[0]).toBe(a)
  })

  it('keeps everything else about the clips, so the picture is the same but flat', () => {
    const a = clip({ effects: [blur()], opacity: 0.5, startS: 1 })
    const view = beforeView(seqOf([track({ clips: [a] })]), 'all')
    expect(view.tracks[0].clips[0]).toEqual({ ...a, effects: [] })
  })

  it('only strips the scoped clips', () => {
    const a = clip({ effects: [blur()] })
    const b = clip({ effects: [blur()] })
    const seq = seqOf([track({ clips: [a, b] })])
    const view = beforeView(seq, new Set([a.id]))
    expect(view.tracks[0].clips[0].effects).toHaveLength(0)
    expect(view.tracks[0].clips[1]).toBe(b)
  })

  it('leaves audio tracks as they were', () => {
    const song = clip({ effects: [blur()] })
    const audio = track({ kind: 'audio', name: 'A1', clips: [song] })
    const seq = seqOf([track({ clips: [clip({ effects: [blur()] })] }), audio])
    expect(beforeView(seq, 'all').tracks[1]).toBe(audio)
  })

  it('hands back the very same sequence when there is nothing to strip', () => {
    const seq = seqOf([track({ clips: [clip(), clip()] })])
    expect(beforeView(seq, 'all')).toBe(seq)
    const other = clip({ effects: [blur()] })
    const seq2 = seqOf([track({ clips: [clip(), other] })])
    expect(beforeView(seq2, new Set([seq2.tracks[0].clips[0].id]))).toBe(seq2)
  })

  it('is cached per sequence and scope, and rebuilt when either changes', () => {
    const seq = seqOf([track({ clips: [clip({ effects: [blur()] })] })])
    const first = beforeView(seq, 'all')
    expect(beforeView(seq, 'all')).toBe(first)
    const scope = new Set([seq.tracks[0].clips[0].id])
    const narrow = beforeView(seq, scope)
    expect(narrow).not.toBe(first)
    expect(beforeView(seq, scope)).toBe(narrow)
    // An edit makes a new sequence, which never reads the old view.
    const edited = { ...seq, tracks: seq.tracks.map((t) => ({ ...t })) }
    expect(beforeView(edited, 'all')).not.toBe(first)
  })
})

describe('the Before frame', () => {
  it('has no effects on a clip, where the real frame has them', () => {
    const seq = seqOf([track({ clips: [clip({ effects: [blur()] })] })])
    const real = resolveFrame(seq, 1).ops[0]
    const before = resolveFrame(beforeView(seq, 'all'), 1).ops[0]
    expect(real.type === 'layer' && real.layer.effects.length).toBe(1)
    expect(before.type === 'layer' && before.layer.effects.length).toBe(0)
  })

  it('keeps the blurred backdrop blurred: it is not the clip effect', () => {
    const seq = seqOf([track({ clips: [clip({ effects: [blur()] })] })], {
      width: 1080,
      height: 1920,
      blurBackground: true,
    })
    const ops = resolveFrame(beforeView(seq, 'all'), 1).ops
    expect(ops).toHaveLength(2)
    const [backdrop, picture] = ops
    expect(backdrop.type === 'layer' && backdrop.layer.effects.map((e) => e.type)).toEqual(['gaussianBlur'])
    expect(picture.type === 'layer' && picture.layer.effects).toEqual([])
  })

  it('keeps an adjustment layer but with nothing in it, then drops it', () => {
    const adj = clip({ adjustment: true, effects: [blur()] })
    const seq = seqOf([track({ clips: [clip()] }), track({ name: 'V2', clips: [adj] })])
    const realOps = resolveFrame(seq, 1).ops
    expect(realOps.map((o) => o.type)).toEqual(['layer', 'adjustment'])
    const flat = resolveFrame(beforeView(seq, 'all'), 1)
    expect(flat.ops.map((o) => o.type)).toEqual(['layer', 'adjustment'])
    const cleaned = dropIdleAdjustments(flat)
    expect(cleaned.ops.map((o) => o.type)).toEqual(['layer'])
  })
})

describe('dropIdleAdjustments', () => {
  it('returns the same frame when every adjustment still has an effect', () => {
    const adj = clip({ adjustment: true, effects: [blur()] })
    const frame = resolveFrame(seqOf([track({ clips: [clip()] }), track({ name: 'V2', clips: [adj] })]), 1)
    expect(dropIdleAdjustments(frame)).toBe(frame)
  })
})
