// Wide footage in a tall frame fills it (his ask, 2026-10-08, for the Shorts start): the picture is
// scaled to cover, centred, with no bars, and never stretched. "Both" was his answer to whether Shorts
// should make the phone shape or make wide footage fill it, so this is the fill half.
//
// The maths itself is fitNewClipToFrame / refitClipToFill (timeline.ts), the one the format switch and
// every add already share. What these prove is the shapes that matter to a gym clip: 16:9, wider,
// taller, the same, odd sizes and a phone clip that carries a rotation, measured the way the
// renderer draws them (resolveFrame + computeQuad, the numbers the preview and the export both use).

import { describe, expect, it } from 'vitest'
import { fillScale, frameFitDims } from './frameFit'
import { computeQuad } from './render/mat'
import { resolveFrame } from './render/resolve'
import { fitNewClipToFrame, refitClipToFill, setSequenceFormat } from './timeline'
import {
  activeSequence,
  defaultTransform,
  newClipFromAsset,
  newProject,
  type Clip,
  type MediaAsset,
  type Sequence,
} from './types'

const asset = (id: string, width: number, height: number): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: id,
  durationS: 10,
  hasAudio: false,
  hasVideo: true,
  width,
  height,
})

/** A sequence of the given size with these clips on V1. */
function seqOf(clips: Clip[], width: number, height: number): Sequence {
  const base = activeSequence(newProject())
  return {
    ...base,
    width,
    height,
    durationS: 10,
    tracks: base.tracks.map((t, i) => (i === 0 ? { ...t, clips } : t)),
  }
}

/** The corners of the picture as drawn, in sequence pixels, from the renderer's own resolver and quad. */
function drawn(seq: Sequence, src: MediaAsset) {
  const op = resolveFrame(seq, 1).ops.find((o) => o.type === 'layer')
  if (!op || op.type !== 'layer') throw new Error('expected a picture layer')
  const { corners } = computeQuad({
    frameW: seq.width,
    frameH: seq.height,
    texW: src.width!,
    texH: src.height!,
    transform: op.layer.transform,
  })
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

/** The clip as a drop or a double click makes it, landed on a sequence. */
const landed = (src: MediaAsset, frame: Sequence): Clip => fitNewClipToFrame(newClipFromAsset(src, 0), src, frame)

const TALL: readonly [number, number][] = [
  [1080, 1920], // 9:16
  [1080, 2112], // the Phone shape the Shorts start makes
]

describe('wide footage fills a tall frame', () => {
  const WIDE: readonly [string, number, number][] = [
    ['16:9 full HD', 1920, 1080],
    ['16:9 4K', 3840, 2160],
    ['16:9 small', 1280, 720],
    ['21:9 ultrawide', 2560, 1080],
    ['2.39:1 scope', 2048, 858],
    ['4:3', 1440, 1080],
    ['square', 1080, 1080],
  ]

  for (const [fw, fh] of TALL) {
    for (const [label, w, h] of WIDE) {
      it(`${label} in ${fw} x ${fh}: covers every edge, centred, aspect ratio exact`, () => {
        const src = asset('w', w, h)
        const frame = seqOf([], fw, fh)
        const sq = seqOf([landed(src, frame)], fw, fh)
        const r = drawn(sq, src)
        // No bar: the picture reaches past all four edges of the frame.
        expect(r.minX).toBeLessThanOrEqual(1e-6)
        expect(r.minY).toBeLessThanOrEqual(1e-6)
        expect(r.maxX).toBeGreaterThanOrEqual(fw - 1e-6)
        expect(r.maxY).toBeGreaterThanOrEqual(fh - 1e-6)
        // Centred.
        expect(r.cx).toBeCloseTo(fw / 2, 6)
        expect(r.cy).toBeCloseTo(fh / 2, 6)
        // Not stretched: the picture drawn has the source's own shape, to float noise.
        expect(r.w / r.h).toBeCloseTo(w / h, 9)
        // And it is a COVER, not a bigger zoom than the frame needs: one axis lands exactly on the frame.
        const exactAxis = Math.abs(r.w - fw) < 1e-6 || Math.abs(r.h - fh) < 1e-6
        expect(exactAxis, `${r.w} x ${r.h} in ${fw} x ${fh}`).toBe(true)
      })
    }
  }

  it('16:9 into 1080 x 1920 is the cover over the contain, 3.1605x', () => {
    // 1920x1080 contained in 1080x1920 is 0.5625 (the width runs out); covered it is 1.7778 (the height).
    const d = frameFitDims({ width: 1080, height: 1920 }, asset('w', 1920, 1080))
    expect(fillScale(d)).toBeCloseTo(1.7777777777777777 / 0.5625, 12)
  })

  it('a circle stays a circle: the width and the height of the drawn picture scale by the same factor', () => {
    const src = asset('w', 1920, 1080)
    for (const [fw, fh] of TALL) {
      const clip = landed(src, seqOf([], fw, fh))
      const r = drawn(seqOf([clip], fw, fh), src)
      const sx = r.w / src.width!
      const sy = r.h / src.height!
      expect(sx / sy).toBeCloseTo(1, 12)
    }
  })
})

describe('footage that is not wider than the frame', () => {
  it('taller than the frame fills it too, cropping top and bottom', () => {
    const src = asset('t', 1080, 2400)
    const r = drawn(seqOf([landed(src, seqOf([], 1080, 1920))], 1080, 1920), src)
    expect(r.minX).toBeLessThanOrEqual(1e-6)
    expect(r.maxX).toBeGreaterThanOrEqual(1080 - 1e-6)
    expect(r.minY).toBeLessThan(0)
    expect(r.maxY).toBeGreaterThan(1920)
    expect(r.w / r.h).toBeCloseTo(1080 / 2400, 9)
  })

  it('the same shape keeps its settings: the very same clip comes back', () => {
    for (const [w, h] of [
      [1080, 1920],
      [540, 960],
      [2160, 3840],
    ]) {
      const src = asset('s', w, h)
      const made = newClipFromAsset(src, 0)
      expect(fitNewClipToFrame(made, src, seqOf([], 1080, 1920)), `${w}x${h}`).toBe(made)
    }
    const phone = asset('p', 1080, 2112)
    const made = newClipFromAsset(phone, 0)
    expect(fitNewClipToFrame(made, phone, seqOf([], 1080, 2112))).toBe(made)
  })

  it('footage already in the frame shape within float noise is left as it is', () => {
    // 1080 x 1920 against 1080 x 1920 is exact; a 1080 x 1919 file is a pixel short and still covers.
    const src = asset('s', 1080, 1919)
    const r = drawn(seqOf([landed(src, seqOf([], 1080, 1920))], 1080, 1920), src)
    expect(r.minY).toBeLessThanOrEqual(1e-6)
    expect(r.maxY).toBeGreaterThanOrEqual(1920 - 1e-6)
    expect(r.minX).toBeLessThanOrEqual(1e-6)
    expect(r.maxX).toBeGreaterThanOrEqual(1080 - 1e-6)
  })
})

describe('odd sizes', () => {
  it('odd widths and heights still cover, centred', () => {
    for (const [w, h] of [
      [1921, 1081],
      [641, 479],
      [1919, 1079],
      [3, 7],
      [1, 1],
      [4097, 17],
    ]) {
      const src = asset('o', w, h)
      for (const [fw, fh] of TALL) {
        const r = drawn(seqOf([landed(src, seqOf([], fw, fh))], fw, fh), src)
        const label = `${w}x${h} in ${fw}x${fh}`
        expect(r.minX, label).toBeLessThanOrEqual(1e-6)
        expect(r.minY, label).toBeLessThanOrEqual(1e-6)
        expect(r.maxX, label).toBeGreaterThanOrEqual(fw - 1e-6)
        expect(r.maxY, label).toBeGreaterThanOrEqual(fh - 1e-6)
        expect(r.cx, label).toBeCloseTo(fw / 2, 6)
        expect(r.cy, label).toBeCloseTo(fh / 2, 6)
        expect(r.w / r.h, label).toBeCloseTo(w / h, 9)
      }
    }
  })

  it('footage whose size is not known yet is never blown up by a guess', () => {
    for (const dims of [
      { width: undefined, height: undefined },
      { width: 0, height: 0 },
      { width: 1920, height: 0 },
      { width: Number.NaN, height: 1080 },
    ]) {
      const src: MediaAsset = { ...asset('u', 1, 1), ...dims }
      const made = newClipFromAsset(src, 0)
      expect(fitNewClipToFrame(made, src, seqOf([], 1080, 1920))).toBe(made)
    }
  })
})

describe('phone footage that carries a rotation', () => {
  // A phone held upright writes 1920 x 1080 pixels and a rotation of 90 degrees. The picture he sees,
  // and the one the app probes (the playing element reports the upright size) and exports (the reader
  // turns each frame upright), is 1080 x 1920. The fill is measured on THAT shape, never on the coded
  // one: measured on the coded one a gym clip would be cropped as if it were wide.
  it('lands as 9:16 footage in a 9:16 frame: scale 1, nothing to fill', () => {
    const upright = asset('rot', 1080, 1920)
    const made = newClipFromAsset(upright, 0)
    expect(fitNewClipToFrame(made, upright, seqOf([], 1080, 1920))).toBe(made)
  })

  it('and grows to cover the Phone shape by the same 1.1 any upright 1080 x 1920 file does', () => {
    const upright = asset('rot', 1080, 1920)
    const clip = landed(upright, seqOf([], 1080, 2112))
    expect(clip.transform.scale).toBeCloseTo(2112 / 1920, 12)
  })

  it('measured on the coded shape it would be wrong, which is why the probe size is the display size', () => {
    const coded = asset('rot', 1920, 1080)
    const clip = landed(coded, seqOf([], 1080, 1920))
    // 3.16x: a wide clip's cover. An upright phone clip must never get this.
    expect(clip.transform.scale).toBeGreaterThan(3)
  })
})

describe('the rules for a clip he has placed himself', () => {
  const src = asset('w', 1920, 1080)
  const tall = seqOf([], 1080, 1920)
  const placedBy = (over: Partial<Clip['transform']>): Clip => ({
    ...newClipFromAsset(src, 0),
    transform: { ...defaultTransform(), ...over },
  })

  it('a moved clip is never touched', () => {
    for (const t of [{ x: 40 }, { y: -25 }, { x: 10, y: 10 }]) {
      const c = placedBy(t)
      expect(fitNewClipToFrame(c, src, tall)).toBe(c)
      expect(refitClipToFill(c, { w: src }, 1080, 1920, 1920, 1080)).toBe(c)
    }
  })

  it('a clip he scaled by hand is never touched, on a shape change either', () => {
    for (const scale of [0.8, 1.3, 2, 3.2]) {
      const c = placedBy({ scale })
      expect(refitClipToFill(c, { w: src }, 1080, 1920, 1920, 1080)).toBe(c)
    }
  })

  it('a stretched clip already fills any frame, so it is not grown', () => {
    const c = placedBy({ fit: 'stretch' })
    expect(fitNewClipToFrame(c, src, tall)).toBe(c)
    expect(refitClipToFill(c, { w: src }, 1080, 1920, 1920, 1080)).toBe(c)
  })

  it('a clip whose position is animated is never touched', () => {
    const c: Clip = {
      ...newClipFromAsset(src, 0),
      keyframes: { posX: [{ t: 0, value: 0, ease: 'linear' }, { t: 2, value: 100, ease: 'linear' }] },
    }
    expect(refitClipToFill(c, { w: src }, 1080, 1920, 1920, 1080)).toBe(c)
  })

  it('the fill a previous shape gave is recognised as ours, so wide to tall to wide restores it', () => {
    const wide = seqOf([newClipFromAsset(src, 0)], 1920, 1080)
    const tallSeq = setSequenceFormat(wide, { w: src }, 1080, 1920)
    expect(tallSeq.tracks[0].clips[0].transform.scale).toBeCloseTo(1.7777777777777777 / 0.5625, 9)
    const back = setSequenceFormat(tallSeq, { w: src }, 1920, 1080)
    expect(back.tracks[0].clips[0].transform.scale).toBeCloseTo(1, 9)
  })
})
