// The phone screen frame, 1080 x 2112 (his ask, 2026-10-05: "find the exact ratio of TikTok and
// Instagram because they use both the same one, and just give me that"), through every part of the
// engine that has to cope with a shape the three old presets never were.
//
// What matters, in his order: a phone clip fills it with no black rows or columns, in the SAME
// numbers the preview and the export both draw from; a caption keeps its place when he switches
// to it; and the things that bake the frame in (the slide and rise presets) follow it.

import { describe, expect, it } from 'vitest'
import { fitCanvasBox } from '../components/monitorSizing'
import { applyAppearanceToClip } from './anim/appearance'
import { contentBox } from './contentFrame'
import { channelKeyframes } from './effects/channels'
import { computeQuad } from './render/mat'
import { resolveFrame } from './render/resolve'
import { titleLayout } from './render/titleRaster'
import { fitNewClipToFrame, refitClipToFill, setSequenceFormat } from './timeline'
import {
  activeSequence,
  defaultTitleDef,
  defaultTransform,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type Clip,
  type MediaAsset,
  type Sequence,
  type TitleDef,
} from './types'

const PHONE_W = 1080
const PHONE_H = 2112

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

/** A one-track sequence of the given size holding these clips. */
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

const pictureClip = (assetId: string): Clip => ({
  ...newTitleClip(defaultTitleDef('x'), 0, 5),
  title: undefined,
  assetId,
})

/**
 * Where the renderer puts the picture: the corners of the first picture layer in sequence pixels, from the
 * same resolver and the same quad maths the preview and the export both draw with.
 */
function drawn(seq: Sequence, src: MediaAsset): { minX: number; maxX: number; minY: number; maxY: number } {
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
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

describe('a clip fills the phone frame, with no black rows or columns', () => {
  it('his 1080 x 1920 phone clip: 9:16 to the phone shape grows it to cover, and the picture spills past both sides', () => {
    const phoneClip = asset('p', 1080, 1920)
    const wide = seqOf([pictureClip('p')], 1080, 1920)
    // In 9:16 it already fills: scale 1, nothing to do, the same clip object comes back.
    expect(fitNewClipToFrame(wide.tracks[0].clips[0], phoneClip, wide)).toBe(wide.tracks[0].clips[0])

    const phone = setSequenceFormat(wide, { p: phoneClip }, PHONE_W, PHONE_H)
    expect(phone.width).toBe(PHONE_W)
    expect(phone.height).toBe(PHONE_H)
    // 2112 / 1920 is 1.1: contain is 1.0 (the width runs out first), cover is 1.1.
    expect(phone.tracks[0].clips[0].transform.scale).toBeCloseTo(1.1, 9)

    const r = drawn(phone, phoneClip)
    // Exactly the frame tall, and 54 columns of the picture spill off each side (1188 wide in a 1080 frame).
    expect(r.minY).toBeCloseTo(0, 6)
    expect(r.maxY).toBeCloseTo(PHONE_H, 6)
    expect(r.minX).toBeCloseTo(-54, 6)
    expect(r.maxX).toBeCloseTo(PHONE_W + 54, 6)
  })

  it('every shape of phone footage covers the whole frame, top to bottom and side to side', () => {
    for (const [w, h] of [
      [1080, 1920],
      [720, 1280],
      [2160, 3840],
      [1179, 2556], // an iPhone screen recording
      [1920, 1080],
      [1080, 1080],
      [1440, 1080],
    ]) {
      const src = asset('a', w, h)
      const from = seqOf([pictureClip('a')], 1920, 1080)
      const phone = setSequenceFormat(from, { a: src }, PHONE_W, PHONE_H)
      const r = drawn(phone, src)
      const label = `${w}x${h}`
      expect(r.minX, `${label} left edge`).toBeLessThanOrEqual(1e-6)
      expect(r.minY, `${label} top edge`).toBeLessThanOrEqual(1e-6)
      expect(r.maxX, `${label} right edge`).toBeGreaterThanOrEqual(PHONE_W - 1e-6)
      expect(r.maxY, `${label} bottom edge`).toBeGreaterThanOrEqual(PHONE_H - 1e-6)
    }
  })

  it('a clip added AFTER the switch lands filling it too, the same answer as switching after', () => {
    const src = asset('p', 1080, 1920)
    const empty = seqOf([], PHONE_W, PHONE_H)
    const added = fitNewClipToFrame(pictureClip('p'), src, empty)
    expect(added.transform.scale).toBeCloseTo(1.1, 9)
    const afterSwitch = setSequenceFormat(seqOf([pictureClip('p')], 1080, 1920), { p: src }, PHONE_W, PHONE_H)
    expect(added.transform.scale).toBeCloseTo(afterSwitch.tracks[0].clips[0].transform.scale, 12)
    const r = drawn(seqOf([added], PHONE_W, PHONE_H), src)
    expect(r.minY).toBeLessThanOrEqual(1e-6)
    expect(r.maxY).toBeGreaterThanOrEqual(PHONE_H - 1e-6)
  })

  it('also lands filling it when the clip comes in through the real constructor', () => {
    const src = asset('p', 1080, 1920)
    const made = newClipFromAsset(src, 0)
    const out = fitNewClipToFrame(made, src, seqOf([], PHONE_W, PHONE_H))
    const r = drawn(seqOf([out], PHONE_W, PHONE_H), src)
    expect(r.minX).toBeLessThanOrEqual(1e-6)
    expect(r.maxX).toBeGreaterThanOrEqual(PHONE_W - 1e-6)
    expect(r.minY).toBeLessThanOrEqual(1e-6)
    expect(r.maxY).toBeGreaterThanOrEqual(PHONE_H - 1e-6)
  })

  it('9:16 to phone and back restores the clip, so trying the shape costs nothing', () => {
    const src = asset('p', 1080, 1920)
    const shorts = seqOf([pictureClip('p')], 1080, 1920)
    const phone = setSequenceFormat(shorts, { p: src }, PHONE_W, PHONE_H)
    const back = setSequenceFormat(phone, { p: src }, 1080, 1920)
    expect(back.tracks[0].clips[0].transform.scale).toBeCloseTo(1, 9)
    expect(back.width).toBe(1080)
    expect(back.height).toBe(1920)
  })

  it('16:9 to phone and back restores the clip too', () => {
    const src = asset('l', 1920, 1080)
    const wide = seqOf([pictureClip('l')], 1920, 1080)
    const phone = setSequenceFormat(wide, { l: src }, PHONE_W, PHONE_H)
    expect(phone.tracks[0].clips[0].transform.scale).toBeCloseTo(PHONE_H / 1080 / (PHONE_W / 1920), 9)
    const back = setSequenceFormat(phone, { l: src }, 1920, 1080)
    expect(back.tracks[0].clips[0].transform.scale).toBeCloseTo(1, 9)
  })

  it('leaves a clip he placed by hand alone, as it does for the other shapes', () => {
    const src = asset('p', 1080, 1920)
    const moved: Clip = { ...pictureClip('p'), transform: { ...defaultTransform(), x: 40, y: -20 } }
    expect(refitClipToFill(moved, { p: src }, PHONE_W, PHONE_H, 1080, 1920)).toBe(moved)
  })
})

describe('a caption keeps its place when he switches 9:16 to the phone shape', () => {
  // A measurer that grows with the type, so the wrap and the block height are real.
  const measureFor = (def: TitleDef) => (s: string) => s.length * def.fontSizePx * 0.5

  const def = (over: Partial<TitleDef>): TitleDef => ({
    ...defaultTitleDef('HI THERE'),
    fontSizePx: 105,
    ...over,
  })

  /** The title as the 9:16 frame had it, and as the phone frame has it after the switch. */
  function across(title: TitleDef): { before: TitleDef; after: TitleDef } {
    const clip = newTitleClip(title, 0, 4)
    const out = setSequenceFormat(seqOf([clip], 1080, 1920), {}, PHONE_W, PHONE_H)
    return { before: title, after: out.tracks[0].clips[0].title! }
  }

  /** The line the alignment pins: the top, the middle or the bottom of the text block, as a fraction of the height. */
  function anchored(title: TitleDef, w: number, h: number): number {
    const L = titleLayout(title, w, h, measureFor(title))
    const edge = title.vAlign === 'top' ? L.blockTop : title.vAlign === 'bottom' ? L.blockTop + L.blockH : L.blockTop + L.blockH / 2
    return edge / h
  }

  it('a caption in the lower third sits in the same relative place, whichever way it is anchored', () => {
    for (const [vAlign, offsetYPx] of [
      ['middle', 600], // centred, pushed down into the lower third
      ['bottom', -380], // the caption preset's own resting place
      ['top', 1300],
    ] as const) {
      const { before, after } = across(def({ vAlign, offsetYPx }))
      const was = anchored(before, 1080, 1920)
      const now = anchored(after, PHONE_W, PHONE_H)
      // A pixel or two of rounding on 2112 is 0.001. A caption that jumped would be tenths.
      expect(Math.abs(now - was), `${vAlign} at ${offsetYPx}`).toBeLessThan(0.002)
    }
  })

  it('and keeps it when the bigger type wraps onto another line', () => {
    const long = def({ text: 'THIS IS A LONG CAPTION THAT WRAPS', vAlign: 'bottom', offsetYPx: -380 })
    const { before, after } = across(long)
    expect(Math.abs(anchored(after, PHONE_W, PHONE_H) - anchored(before, 1080, 1920))).toBeLessThan(0.002)
  })

  it('scales the type with the height, the same rule every other format switch uses', () => {
    const { after } = across(def({ vAlign: 'middle', offsetYPx: 600, outline: { color: '#000', widthPx: 10 } }))
    expect(after.fontSizePx).toBe(Math.round(105 * 1.1))
    expect(after.offsetYPx).toBe(660)
    expect(after.outline?.widthPx).toBe(11)
    // The width did not change, so nothing moves sideways.
    expect(after.offsetXPx).toBe(0)
  })

  it('moves a caption sideways by nothing, because the phone frame is as wide as 9:16', () => {
    const { after } = across(def({ vAlign: 'middle', offsetXPx: 120, offsetYPx: 0 }))
    expect(after.offsetXPx).toBe(120)
  })

  it('goes there and back to the same caption', () => {
    const title = def({ vAlign: 'bottom', offsetYPx: -380, fontSizePx: 110 })
    const clip = newTitleClip(title, 0, 4)
    const there = setSequenceFormat(seqOf([clip], 1080, 1920), {}, PHONE_W, PHONE_H)
    const back = setSequenceFormat(there, {}, 1080, 1920)
    const got = back.tracks[0].clips[0].title!
    expect(Math.abs(got.fontSizePx - title.fontSizePx)).toBeLessThanOrEqual(1)
    expect(Math.abs(got.offsetYPx - title.offsetYPx)).toBeLessThanOrEqual(1)
  })
})

describe('the presets that bake the frame in follow it', () => {
  const rising = (): Clip => {
    const base = {
      ...newTitleClip(defaultTitleDef('hi'), 0, 4),
      appearance: { in: 'riseUp', out: 'dropDown', durS: 0.5 },
    }
    return applyAppearanceToClip(base, base.appearance, 1080, 1920)
  }

  it('rise and drop travel 0.35 of the NEW height, not the old one', () => {
    const before = channelKeyframes(rising(), 'posY')
    const out = setSequenceFormat(seqOf([rising()], 1080, 1920), {}, PHONE_W, PHONE_H)
    const after = channelKeyframes(out.tracks[0].clips[0], 'posY')
    expect(after).toHaveLength(before.length)
    const travel = (kfs: typeof before) => Math.max(...kfs.map((k) => Math.abs(k.value)))
    expect(travel(before)).toBeCloseTo(1920 * 0.35, 6)
    expect(travel(after)).toBeCloseTo(PHONE_H * 0.35, 6)
  })

  it('slide travels half the width, and the width did not change', () => {
    const base = {
      ...newTitleClip(defaultTitleDef('hi'), 0, 4),
      appearance: { in: 'slideIn', out: 'slideOut', durS: 0.5 },
    }
    const slid = applyAppearanceToClip(base, base.appearance, 1080, 1920)
    const out = setSequenceFormat(seqOf([slid], 1080, 1920), {}, PHONE_W, PHONE_H)
    expect(channelKeyframes(out.tracks[0].clips[0], 'posX')[0].value).toBeCloseTo(-540, 6)
  })
})

describe('the inner content frame inside the phone frame', () => {
  it('keeps a 9:16 Short whole inside it, with 96 rows of band above and below', () => {
    expect(contentBox(PHONE_W, PHONE_H, 9 / 16)).toEqual({ x: 0, y: 96, w: 1080, h: 1920 })
  })

  it('centres a square the full width of it', () => {
    expect(contentBox(PHONE_W, PHONE_H, 1)).toEqual({ x: 0, y: 516, w: 1080, h: 1080 })
  })

  it('centres a wide strip, and never leaves the frame', () => {
    for (const aspect of [0.4, 0.5625, 0.8, 1, 1.78, 2.39]) {
      const box = contentBox(PHONE_W, PHONE_H, aspect)
      expect(box, String(aspect)).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.w).toBeLessThanOrEqual(PHONE_W + 1e-9)
      expect(box!.y + box!.h).toBeLessThanOrEqual(PHONE_H + 1e-9)
      expect(box!.w / box!.h).toBeCloseTo(aspect, 6)
      expect(box!.x + box!.w / 2).toBeCloseTo(PHONE_W / 2, 6)
      expect(box!.y + box!.h / 2).toBeCloseTo(PHONE_H / 2, 6)
    }
  })

  it('is no inner frame at all when it is the frame typed another way', () => {
    expect(contentBox(PHONE_W, PHONE_H, PHONE_W / PHONE_H)).toBeNull()
    expect(contentBox(PHONE_W, PHONE_H, 0.5114)).toBeNull()
  })
})

describe('the monitor box for the phone frame', () => {
  it('fits a tall panel by its height, keeping the shape to a device pixel', () => {
    const aspect = PHONE_W / PHONE_H
    for (const [pw, ph] of [
      [600, 900],
      [1000, 700],
      [420, 640],
      [1500, 300],
    ]) {
      const box = fitCanvasBox(pw, ph, aspect, 1, 1)
      expect(box.cssW, `${pw}x${ph} fits across`).toBeLessThanOrEqual(pw)
      expect(box.cssH, `${pw}x${ph} fits down`).toBeLessThanOrEqual(ph)
      // The shape is the frame's own, to within one device pixel on the short side.
      expect(Math.abs(box.cssW / box.cssH - aspect) * box.cssH).toBeLessThan(1)
      expect(box.pxW).toBe(box.cssW)
      expect(box.pxH).toBe(box.cssH)
    }
  })

  it('snaps to whole device pixels on a fractional display, as it does for the other shapes', () => {
    const box = fitCanvasBox(640, 800, PHONE_W / PHONE_H, 1.5, 1)
    expect(Number.isInteger(box.cssW * 1.5)).toBe(true)
    expect(Number.isInteger(box.cssH * 1.5)).toBe(true)
  })
})
