import { describe, expect, it } from 'vitest'
import { hasStrobe, musicClips, previewSequence, sequenceWithBeats } from '../beatGrid'
import { defaultTransform, type Clip, type EffectInstance, type Sequence, type Track } from '../types'
import { resolveFrame } from './resolve'
import type { RenderLayer } from './types'

// The strobe's flash is worked out in the PURE resolver from the beats riding on
// the sequence, so the preview and the export worker are handed the same number.

let uid = 0
const id = (p: string): string => `${p}-${uid++}`

const strobeFx = (params: Record<string, number> = {}): EffectInstance => ({
  id: id('fx'),
  type: 'strobe',
  enabled: true,
  params: { strength: 0.8, ...params },
})

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: id('clip'),
    assetId: id('asset'),
    startS: 0,
    inS: 0,
    outS: 10,
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

const seq = (tracks: Track[], over: Partial<Sequence> = {}): Sequence => ({
  id: id('seq'),
  name: 'Seq',
  fps: 30,
  width: 1920,
  height: 1080,
  sampleRate: 48000,
  durationS: 10,
  tracks,
  markers: [],
  ...over,
})

function flashAt(s: Sequence, t: number): number {
  const op = resolveFrame(s, t).ops[0]
  if (!op || op.type !== 'layer') throw new Error('expected a layer')
  const layer: RenderLayer = op.layer
  const fx = layer.effects.find((e) => e.type === 'strobe')
  if (!fx) throw new Error('strobe was dropped from the stack')
  return fx.params.flash
}

describe('the resolver stamps the strobe flash per frame', () => {
  const v = track({ clips: [clip({ effects: [strobeFx({ flashMs: 100 })] })] })

  it('is full on a detected beat and zero between beats', () => {
    const s = seq([v], { beatGridS: [1, 2.5, 4] })
    expect(flashAt(s, 1)).toBe(1)
    expect(flashAt(s, 1.05)).toBeCloseTo(0.25, 6)
    expect(flashAt(s, 1.5)).toBe(0)
    expect(flashAt(s, 2.5)).toBe(1)
    expect(flashAt(s, 0.5)).toBe(0)
  })

  it('falls back to the BPM grid, counted from the clip start, with no beats', () => {
    const s = seq([v])
    expect(flashAt(s, 0)).toBe(1)
    expect(flashAt(s, 0.5)).toBe(1)
    expect(flashAt(s, 0.3)).toBe(0)
    const later = seq([track({ clips: [clip({ startS: 3, effects: [strobeFx({ flashMs: 100 })] })] })])
    expect(flashAt(later, 3.5)).toBe(1)
  })

  it('honours Every N beats on the detected grid', () => {
    const two = seq([track({ clips: [clip({ effects: [strobeFx({ everyN: 2, flashMs: 100 })] })] })], {
      beatGridS: [1, 2, 3, 4],
    })
    expect(flashAt(two, 1)).toBe(1)
    expect(flashAt(two, 2)).toBe(0)
    expect(flashAt(two, 3)).toBe(1)
  })

  it('gives the same number twice for the same frame (preview and export agree)', () => {
    const s = seq([v], { beatGridS: [1.2] })
    expect(flashAt(s, 1.23)).toBe(flashAt(s, 1.23))
  })

  it('drops a strobe at Strength 0 like any neutral effect', () => {
    const idle = seq([track({ clips: [clip({ effects: [strobeFx({ strength: 0 })] })] })])
    const op = resolveFrame(idle, 0).ops[0]
    expect(op.type === 'layer' && op.layer.effects.length).toBe(0)
  })
})

describe('the beat grid module', () => {
  const music = (over: Partial<Track> = {}): Track => track({ kind: 'audio', name: 'A1', ...over })

  it('knows when a strobe is on a clip', () => {
    expect(hasStrobe(seq([track({ clips: [clip({ effects: [strobeFx()] })] })]))).toBe(true)
    expect(hasStrobe(seq([track({ clips: [clip()] })]))).toBe(false)
    const off = { ...strobeFx(), enabled: false }
    expect(hasStrobe(seq([track({ clips: [clip({ effects: [off] })] })]))).toBe(false)
  })

  it('follows the music tracks, else any audio that is not voice, never muted ones', () => {
    const m = clip()
    const vo = clip()
    const loose = clip()
    const marked = seq([music({ audioRole: 'music', clips: [m] }), music({ audioRole: 'voice', clips: [vo] })])
    expect(musicClips(marked)).toEqual([m])
    const unmarked = seq([music({ clips: [loose] }), music({ audioRole: 'voice', clips: [vo] })])
    expect(musicClips(unmarked)).toEqual([loose])
    expect(musicClips(seq([music({ muted: true, audioRole: 'music', clips: [m] })]))).toEqual([])
  })

  it('leaves the sequence alone when nothing strobes or nothing can be heard', () => {
    const plain = seq([track({ clips: [clip()] })])
    expect(previewSequence(plain, {}, () => {})).toBe(plain)
    const strobing = seq([track({ clips: [clip({ effects: [strobeFx()] })] })])
    expect(previewSequence(strobing, {}, () => {})).toBe(strobing)
    return expect(sequenceWithBeats(strobing, {})).resolves.toBe(strobing)
  })
})
