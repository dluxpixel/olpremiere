/**
 * @vitest-environment jsdom
 *
 * jsdom rather than node, for the page's clipboard.
 */

// Shorts auto fill, the paste half. A wide clip dropped, added or switched into a tall
// frame already fills it (fitNewClipToFrame, setSequenceFormat). A wide clip COPIED from
// a wide edit and pasted into a tall one kept the scale it had there, so it landed with
// bars above and below: the one road in that did not fill. These pin the paste to the same
// math as the other roads, and leave everything hand placed alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fitNewClipToFrame, pasteClips, recomputeDuration, serializeClips } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newClipFromAsset,
  newProject,
  newTitleClip,
  type Clip,
  type MediaAsset,
  type Project,
} from '../engine/types'
import { copySelection, pasteAtPlayhead } from './clipboard'
import { updateActiveSequence, useStore } from './store'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

const seq = () => activeSequence(useStore.getState().project)
const clips = (): Clip[] => seq().tracks.flatMap((t) => t.clips)

const footage: MediaAsset = {
  id: 'wide-footage',
  name: 'gameplay.mp4',
  kind: 'video',
  blobKey: 'asset/wide-footage',
  durationS: 30,
  hasAudio: false,
  hasVideo: true,
  width: 1920,
  height: 1080,
}

// Other pictures: a 4:3 clip, a tall phone clip, a square one, and a still.
const fourByThree: MediaAsset = { ...footage, id: 'four-by-three', name: 'old-camera.mp4', blobKey: 'asset/four-by-three', width: 1440, height: 1080 }
const portrait: MediaAsset = { ...footage, id: 'portrait', name: 'phone.mp4', blobKey: 'asset/portrait', width: 1080, height: 1920 }
const square: MediaAsset = { ...footage, id: 'square', name: 'square.mp4', blobKey: 'asset/square', width: 1080, height: 1080 }
const still: MediaAsset = {
  id: 'still',
  name: 'poster.png',
  kind: 'image',
  blobKey: 'asset/still',
  durationS: 0,
  hasAudio: false,
  hasVideo: true,
  width: 1200,
  height: 800,
}

// What a 1920x1080 picture needs to cover a frame, over what it needs to sit inside it.
const coverFor = (w: number, h: number): number =>
  Math.max(w / 1920, h / 1080) / Math.min(w / 1920, h / 1080)

/** The same for a picture of any size. */
const coverOf = (src: MediaAsset, w: number, h: number): number => {
  const rw = w / src.width!
  const rh = h / src.height!
  return Math.max(rw, rh) / Math.min(rw, rh)
}

/** A project whose edit is w x h, holding the footage record and any `extra` media. */
function projectOf(name: string, w: number, h: number, withFootage = true, extra: MediaAsset[] = []): Project {
  const p = newProject(name)
  const sq = activeSequence(p)
  p.sequences[sq.id] = { ...sq, width: w, height: h }
  p.settings = { ...p.settings, width: w, height: h }
  if (withFootage) p.assets = { [footage.id]: footage }
  for (const a of extra) p.assets = { ...p.assets, [a.id]: a }
  return p
}

/** Put clips on tracks by index. newProject() is [V1, V2, A1, A2]. */
function lay(byTrack: Record<number, Clip[]>): void {
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (byTrack[i] ? { ...t, clips: byTrack[i] } : t)) }),
  )
}

/**
 * Copy `clip` (or several, side by side on V1) out of an edit of w x h, then open an edit of tw x th and
 * paste at 0. `extra` is media besides the footage that both edits know about.
 */
function copyAcross(
  clip: Clip | Clip[],
  from: [number, number],
  to: [number, number],
  opts: { toHasFootage?: boolean; extra?: MediaAsset[] } = {},
): void {
  const picked = Array.isArray(clip) ? clip : [clip]
  useStore.getState().setProject(projectOf('from', from[0], from[1], true, opts.extra))
  lay({ 0: picked })
  useStore.getState().setUI({ selection: picked.map((c) => c.id) })
  expect(copySelection()).toBe(true)
  useStore.getState().setProject(projectOf('to', to[0], to[1], opts.toHasFootage ?? true, opts.extra))
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  pasteAtPlayhead()
}

/** A clip of `asset` as it comes out of the bin: scale 1, centred, nothing done to it. */
const plain = (asset: MediaAsset, id: string, startS = 0): Clip => ({ ...newClipFromAsset(asset, startS), id })

beforeEach(() => {
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true })
  show.mockClear()
})

afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'clipboard')
})

describe('a wide clip pasted into a tall edit', () => {
  it('fills the Phone shape instead of keeping the bars it had', () => {
    copyAcross({ ...newClipFromAsset(footage, 0), id: 'c' }, [1920, 1080], [1080, 2112])
    expect(clips()).toHaveLength(1)
    expect(clips()[0]!.transform.scale).toBeCloseTo(coverFor(1080, 2112), 9)
    expect(clips()[0]!.transform.x).toBe(0)
    expect(clips()[0]!.transform.y).toBe(0)
  })

  it('fills 9:16 the same way the drop and the format switch do', () => {
    copyAcross({ ...newClipFromAsset(footage, 0), id: 'c' }, [1920, 1080], [1080, 1920])
    const viaPaste = clips()[0]!.transform.scale
    const viaDrop = fitNewClipToFrame(newClipFromAsset(footage, 0), footage, seq()).transform.scale
    expect(viaPaste).toBeCloseTo(coverFor(1080, 1920), 9)
    expect(viaPaste).toBeCloseTo(viaDrop, 9)
  })

  it('still fills when this edit has never seen the footage: the record comes with the clip', () => {
    copyAcross({ ...newClipFromAsset(footage, 0), id: 'c' }, [1920, 1080], [1080, 2112], { toHasFootage: false })
    expect(useStore.getState().project.assets[footage.id]).toEqual(footage)
    expect(clips()[0]!.transform.scale).toBeCloseTo(coverFor(1080, 2112), 9)
  })

  it('is one undo step', () => {
    copyAcross({ ...newClipFromAsset(footage, 0), id: 'c' }, [1920, 1080], [1080, 2112])
    useStore.getState().undo()
    expect(clips()).toHaveLength(0)
  })
})

describe('the other way and the same way', () => {
  it('a clip that filled a tall edit goes back to its own size in a wide one', () => {
    const tall = fitNewClipToFrame({ ...newClipFromAsset(footage, 0), id: 'c' }, footage, {
      ...activeSequence(projectOf('x', 1080, 2112)),
    })
    expect(tall.transform.scale).toBeGreaterThan(3)
    copyAcross(tall, [1080, 2112], [1920, 1080])
    expect(clips()[0]!.transform.scale).toBeCloseTo(1, 9)
  })

  it('a paste into an edit of the same shape changes nothing', () => {
    const c = { ...newClipFromAsset(footage, 0), id: 'c' }
    copyAcross(c, [1920, 1080], [1920, 1080])
    expect(clips()[0]!.transform).toEqual(c.transform)
    copyAcross({ ...c, transform: { ...c.transform, scale: 3.4 } }, [1080, 2112], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBe(3.4)
  })

  // The case above passes with the same-shape guard deleted: a clip at 3.4 is not at 1, so it was never
  // going to be refit. These are the ones that are: a 16:9 clip he left at scale 1 in a tall edit, bars
  // and all, is exactly what a refit would grow, and copying it within the edit must not.
  it('a 16:9 clip left at scale 1 in a Phone edit stays at 1 when copied and pasted back', () => {
    copyAcross(plain(footage, 'c'), [1080, 2112], [1080, 2112])
    expect(clips()).toHaveLength(1)
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('the same for 9:16, and for a 4:3 clip in a wide edit', () => {
    copyAcross(plain(footage, 'c'), [1080, 1920], [1080, 1920])
    expect(clips()[0]!.transform.scale).toBe(1)
    copyAcross(plain(fourByThree, 'd'), [1920, 1080], [1920, 1080], { extra: [fourByThree] })
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  // "The same shape" is the same aspect, not the same number of pixels. Each of these is a clip he left
  // at scale 1, pasted into a bigger or smaller edit of the shape it came from.
  it('a 4:3 clip at scale 1 in 1920x1080 pasted into 3840x2160 stays at 1', () => {
    copyAcross(plain(fourByThree, 'c'), [1920, 1080], [3840, 2160], { extra: [fourByThree] })
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('a 16:9 clip at scale 1 in 1080x1920 pasted into 720x1280 stays at 1', () => {
    copyAcross(plain(footage, 'c'), [1080, 1920], [720, 1280])
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('the Phone shape at half and double size is still the Phone shape', () => {
    copyAcross(plain(footage, 'c'), [1080, 2112], [540, 1056])
    expect(clips()[0]!.transform.scale).toBe(1)
    copyAcross(plain(footage, 'c'), [1080, 2112], [2160, 4224])
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('a different shape of about the same size is still refit', () => {
    // 9:16 to Phone is 1080 wide both times and under 10 percent taller: a different shape.
    copyAcross(plain(footage, 'c'), [1080, 1920], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBeCloseTo(coverFor(1080, 2112), 9)
  })
})

describe('a clip he cropped or turned is left alone', () => {
  // The renderer fits the CROPPED picture to the frame (mat.ts croppedSize), so a 1920x1080 clip cropped
  // to a 9:16 slice already fills a 9:16 edit at scale 1. Refitting it from the uncropped source would
  // size it for a picture that is not on screen: 3.16 times too big.
  const slice = 0.5 - (1080 * 9) / 16 / 1920 / 2
  const cropped = (): Clip => {
    const c = plain(footage, 'c')
    return { ...c, transform: { ...c.transform, crop: { t: 0, r: slice, b: 0, l: slice } } }
  }
  const withKeys = (keyframes: Clip['keyframes']): Clip => ({ ...plain(footage, 'c'), keyframes })
  const ramp = (a: number, b: number) => [
    { t: 0, value: a, ease: 'linear' as const },
    { t: 2, value: b, ease: 'linear' as const },
  ]

  it('a clip cropped to a 9:16 slice, at scale 1, pasted into 9:16', () => {
    const c = cropped()
    copyAcross(c, [1920, 1080], [1080, 1920])
    expect(clips()[0]!.transform).toEqual(c.transform)
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('a clip cropped on one side only', () => {
    for (const side of ['t', 'r', 'b', 'l'] as const) {
      const c = plain(footage, 'c')
      const one = { ...c, transform: { ...c.transform, crop: { t: 0, r: 0, b: 0, l: 0, [side]: 0.1 } } }
      copyAcross(one, [1920, 1080], [1080, 2112])
      expect(clips()[0]!.transform.scale, side).toBe(1)
    }
  })

  it('a clip turned a quarter, at scale 1', () => {
    const c = plain(footage, 'c')
    const turned = { ...c, transform: { ...c.transform, rotationDeg: 90 } }
    copyAcross(turned, [1920, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBe(1)
    expect(clips()[0]!.transform.rotationDeg).toBe(90)
  })

  it('a clip turned a little', () => {
    const c = plain(footage, 'c')
    copyAcross({ ...c, transform: { ...c.transform, rotationDeg: -3 } }, [1920, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('a clip whose crop is animated', () => {
    for (const ch of ['cropT', 'cropR', 'cropB', 'cropL'] as const) {
      copyAcross(withKeys({ [ch]: ramp(0, 0.2) }), [1920, 1080], [1080, 2112])
      expect(clips()[0]!.transform.scale, ch).toBe(1)
    }
  })

  it('a clip whose rotation is animated', () => {
    copyAcross(withKeys({ rotation: ramp(0, 15) }), [1920, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('an animated channel with no keyframes in it does not count', () => {
    copyAcross(withKeys({ cropL: [], rotation: [] }), [1920, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBeCloseTo(coverFor(1080, 2112), 9)
  })
})

describe('what a paste fills, beyond one wide clip', () => {
  it('several clips pasted at once each refit to their own picture', () => {
    const picked = [plain(footage, 'a', 0), plain(fourByThree, 'b', 30), plain(square, 'c', 60)]
    copyAcross(picked, [1920, 1080], [1080, 2112], { extra: [fourByThree, square] })
    expect(clips()).toHaveLength(3)
    const scaleOf = (asset: MediaAsset): number => clips().find((c) => c.assetId === asset.id)!.transform.scale
    expect(scaleOf(footage)).toBeCloseTo(coverOf(footage, 1080, 2112), 9)
    expect(scaleOf(fourByThree)).toBeCloseTo(coverOf(fourByThree, 1080, 2112), 9)
    expect(scaleOf(square)).toBeCloseTo(coverOf(square, 1080, 2112), 9)
    // Three different answers, so one clip's fill was not copied onto the others.
    expect(new Set(clips().map((c) => c.transform.scale.toFixed(6))).size).toBe(3)
  })

  it('in one paste a clip he framed stays and the plain ones beside it refit', () => {
    const moved = plain(footage, 'm', 0)
    const picked = [
      { ...moved, transform: { ...moved.transform, x: 80 } },
      plain(fourByThree, 'p', 30),
      plain(square, 's', 60),
    ]
    copyAcross(picked, [1920, 1080], [1080, 2112], { extra: [fourByThree, square] })
    expect(clips().find((c) => c.assetId === footage.id)!.transform.scale).toBe(1)
    expect(clips().find((c) => c.assetId === fourByThree.id)!.transform.scale).toBeCloseTo(coverOf(fourByThree, 1080, 2112), 9)
    expect(clips().find((c) => c.assetId === square.id)!.transform.scale).toBeCloseTo(coverOf(square, 1080, 2112), 9)
  })

  it('a picture (an image asset) refits the same way', () => {
    copyAcross(plain(still, 'i'), [1920, 1080], [1080, 2112], { extra: [still] })
    expect(clips()).toHaveLength(1)
    expect(clips()[0]!.assetId).toBe('still')
    expect(clips()[0]!.transform.scale).toBeCloseTo(coverOf(still, 1080, 2112), 9)
    expect(clips()[0]!.transform.scale).toBeGreaterThan(2)
  })

  it('a square edit into a tall one: a square clip fills the width and the height', () => {
    copyAcross(plain(square, 'c'), [1080, 1080], [1080, 2112], { extra: [square] })
    expect(clips()[0]!.transform.scale).toBeCloseTo(2112 / 1080, 9)
  })

  it('a wide clip left at scale 1 in a square edit fills a tall one', () => {
    copyAcross(plain(footage, 'c'), [1080, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBeCloseTo(coverFor(1080, 2112), 9)
  })

  it('a tall clip pasted into a wide edit refits, the same as a drop of it does', () => {
    copyAcross(plain(portrait, 'c'), [1080, 1920], [1920, 1080], { extra: [portrait] })
    const dropped = fitNewClipToFrame(plain(portrait, 'd'), portrait, activeSequence(projectOf('wide', 1920, 1080)))
    expect(clips()[0]!.transform.scale).toBeCloseTo(coverOf(portrait, 1920, 1080), 9)
    expect(clips()[0]!.transform.scale).toBeCloseTo(dropped.transform.scale, 9)
    expect(clips()[0]!.transform.scale).toBeGreaterThan(3)
  })

  it('a tall clip pasted into an edit of its own shape stays as it was', () => {
    copyAcross(plain(portrait, 'c'), [1080, 1920], [720, 1280], { extra: [portrait] })
    expect(clips()[0]!.transform.scale).toBe(1)
  })
})

describe('what he placed by hand is left alone', () => {
  const placed = (patch: Partial<Clip['transform']>): Clip => {
    const c = { ...newClipFromAsset(footage, 0), id: 'c' }
    return { ...c, transform: { ...c.transform, ...patch } }
  }

  it('a clip he scaled', () => {
    copyAcross(placed({ scale: 1.4 }), [1920, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBe(1.4)
  })

  it('a clip he moved', () => {
    copyAcross(placed({ x: 120 }), [1920, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBe(1)
    expect(clips()[0]!.transform.x).toBe(120)
  })

  it('a stretched clip', () => {
    copyAcross(placed({ fit: 'stretch' }), [1920, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('a clip with an animated position', () => {
    const c: Clip = {
      ...placed({}),
      keyframes: { posX: [{ t: 0, value: 0, ease: 'linear' }, { t: 2, value: 100, ease: 'linear' }] },
    }
    copyAcross(c, [1920, 1080], [1080, 2112])
    expect(clips()[0]!.transform.scale).toBe(1)
  })

  it('a title, which carries no picture to fill', () => {
    useStore.getState().setProject(projectOf('from', 1920, 1080))
    const t = { ...newTitleClip(defaultTitleDef('hello'), 0, 2), id: 't' }
    lay({ 1: [t] })
    useStore.getState().setUI({ selection: ['t'] })
    copySelection()
    useStore.getState().setProject(projectOf('to', 1080, 2112))
    useStore.getState().setUI({ selection: [], playheadS: 0 })
    pasteAtPlayhead()
    expect(clips()[0]!.transform.scale).toBe(1)
  })
})

describe('pasteClips on its own', () => {
  const wideSeq = (): ReturnType<typeof seq> => {
    useStore.getState().setProject(projectOf('a', 1920, 1080))
    const c = { ...newClipFromAsset(footage, 0), id: 'c' }
    lay({ 0: [c] })
    return seq()
  }
  const tallEmpty = () => activeSequence(projectOf('b', 1080, 2112))

  it('serializeClips stamps the frame each clip was copied out of', () => {
    expect(serializeClips(wideSeq(), ['c'])[0]!.frame).toEqual({ w: 1920, h: 1080 })
  })

  it('refits a video clip when it is handed the media records', () => {
    const payload = serializeClips(wideSeq(), ['c'])
    const r = pasteClips(tallEmpty(), payload, 0, undefined, { [footage.id]: footage })
    const pasted = r.seq.tracks.flatMap((t) => t.clips)
    expect(pasted[0]!.transform.scale).toBeCloseTo(coverFor(1080, 2112), 9)
  })

  it('leaves a clip alone without the media records, as it always did', () => {
    const payload = serializeClips(wideSeq(), ['c'])
    const r = pasteClips(tallEmpty(), payload, 0)
    expect(r.seq.tracks.flatMap((t) => t.clips)[0]!.transform.scale).toBe(1)
  })

  it('leaves a clip alone when the clipboard never recorded its frame', () => {
    const payload = serializeClips(wideSeq(), ['c']).map((item) => {
      const bare = { ...item }
      delete bare.frame
      return bare
    })
    const r = pasteClips(tallEmpty(), payload, 0, undefined, { [footage.id]: footage })
    expect(r.seq.tracks.flatMap((t) => t.clips)[0]!.transform.scale).toBe(1)
  })
})
