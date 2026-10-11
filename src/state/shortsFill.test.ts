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

// What a 1920x1080 picture needs to cover a frame, over what it needs to sit inside it.
const coverFor = (w: number, h: number): number =>
  Math.max(w / 1920, h / 1080) / Math.min(w / 1920, h / 1080)

/** A project whose edit is w x h, holding the footage record. */
function projectOf(name: string, w: number, h: number, withFootage = true): Project {
  const p = newProject(name)
  const sq = activeSequence(p)
  p.sequences[sq.id] = { ...sq, width: w, height: h }
  p.settings = { ...p.settings, width: w, height: h }
  if (withFootage) p.assets = { [footage.id]: footage }
  return p
}

/** Put clips on tracks by index. newProject() is [V1, V2, A1, A2]. */
function lay(byTrack: Record<number, Clip[]>): void {
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (byTrack[i] ? { ...t, clips: byTrack[i] } : t)) }),
  )
}

/** Copy `clip` out of an edit of w x h, then open an edit of tw x th and paste at 0. */
function copyAcross(clip: Clip, from: [number, number], to: [number, number], opts: { toHasFootage?: boolean } = {}): void {
  useStore.getState().setProject(projectOf('from', from[0], from[1]))
  lay({ 0: [clip] })
  useStore.getState().setUI({ selection: [clip.id] })
  expect(copySelection()).toBe(true)
  useStore.getState().setProject(projectOf('to', to[0], to[1], opts.toHasFootage ?? true))
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  pasteAtPlayhead()
}

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
