/**
 * @vitest-environment jsdom
 *
 * jsdom rather than node, because the toast store these actions talk to reaches for
 * `window`. The arithmetic half, `fitMoveKeyframes`, needs nothing and is tested here
 * anyway so the rule and its use sit side by side.
 */

// Copy a move, paste it somewhere else. The interesting half is what happens when
// the target clip is a different length from the one it came off.

import { beforeEach, describe, expect, it } from 'vitest'
import { channelKeyframes } from '../engine/effects/channels'
import { fitMoveKeyframes } from '../engine/moves'
import { newClipFromAsset, newProject, type Keyframe, type MediaAsset, type Project } from '../engine/types'
import { addEffectKeyframeAtPlayhead, applyEffect } from './clipEdits'
import { copyClipMove, hasClipMove, pasteClipMove } from './moveClipboard'
import { useStore } from './store'

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: `asset/${id}`,
  durationS: 20,
  hasAudio: true,
  hasVideo: true,
})

const kf = (t: number, value: number): Keyframe => ({ t, value, ease: 'linear' })

/** Two clips: a 4 second one carrying a move, and a 1 second one that is too short. */
function projectWithTwoClips(): Project {
  const p = newProject('Moves')
  const a = asset('a1')
  p.assets[a.id] = a
  const seq = p.sequences[p.activeSequenceId]
  const video = seq.tracks.find((t) => t.kind === 'video')!
  video.clips.push({
    ...newClipFromAsset(a, 0),
    id: 'long',
    inS: 0,
    outS: 4,
    keyframes: { scale: [kf(0, 1), kf(0.5, 1.4), kf(1, 1)] },
  })
  video.clips.push({ ...newClipFromAsset(a, 4), id: 'short', inS: 0, outS: 1 })
  seq.durationS = 5
  return p
}

const clipById = (id: string) => {
  const p = useStore.getState().project
  const seq = p.sequences[p.activeSequenceId]
  return seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
}

describe('fitMoveKeyframes', () => {
  const move = [kf(0, 1), kf(0.5, 1.4), kf(1, 1)]

  it('keeps its timing when it fits, so a punch stays a punch on a long clip', () => {
    expect(fitMoveKeyframes(move, 10).map((k) => k.t)).toEqual([0, 0.5, 1])
  })

  it('squeezes when it does not fit, rather than dropping what falls off the end', () => {
    const fitted = fitMoveKeyframes(move, 0.5)
    expect(fitted.map((k) => k.t)).toEqual([0, 0.25, 0.5])
    // ⛔ THE LAST KEYFRAME IS THE POINT. Dropping the tail would leave the picture
    // zoomed in at the end of the clip with no keyframe to bring it home.
    expect(fitted[fitted.length - 1].value).toBe(1)
  })

  it('an exact fit is left alone, not scaled by 1.0000001', () => {
    expect(fitMoveKeyframes(move, 1).map((k) => k.t)).toEqual([0, 0.5, 1])
  })

  it('nothing in, nothing out', () => {
    expect(fitMoveKeyframes([], 5)).toEqual([])
    expect(fitMoveKeyframes(move, 0)).toEqual([])
  })
})

describe('copy and paste a move', () => {
  beforeEach(() => {
    useStore.getState().setProject(projectWithTwoClips())
    useStore.getState().setUI({ selection: [] })
  })

  it('copies the move and stamps it on another clip', () => {
    copyClipMove('long')
    expect(hasClipMove()).toBe(true)
    pasteClipMove(['short'])
    expect(channelKeyframes(clipById('short'), 'scale').length).toBe(3)
  })

  it('squeezes it into a clip that is too short, and it still comes home', () => {
    copyClipMove('long')
    pasteClipMove(['short'])
    const kfs = channelKeyframes(clipById('short'), 'scale')
    expect(kfs[kfs.length - 1].t).toBeCloseTo(1, 6) // the short clip is 1 s
    expect(kfs[kfs.length - 1].value).toBe(1)
  })

  it('leaves the source alone', () => {
    copyClipMove('long')
    pasteClipMove(['short'])
    expect(channelKeyframes(clipById('long'), 'scale').map((k) => k.t)).toEqual([0, 0.5, 1])
  })

  it('is ONE undo step, however many clips it touched', () => {
    copyClipMove('long')
    const before = useStore.getState().history.undo.length
    pasteClipMove(['short'])
    expect(useStore.getState().history.undo.length).toBe(before + 1)
    useStore.getState().undo()
    expect(channelKeyframes(clipById('short'), 'scale').length).toBe(0)
  })

  it('REPLACES the target move rather than stacking on it', () => {
    // The short clip gets its own move first, then the pasted one must win outright.
    useStore.getState().dispatch('seed', (p) => {
      const seq = p.sequences[p.activeSequenceId]
      return {
        ...p,
        sequences: {
          ...p.sequences,
          [seq.id]: {
            ...seq,
            tracks: seq.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === 'short' ? { ...c, keyframes: { posX: [kf(0, 0), kf(0.5, 200)] } } : c,
              ),
            })),
          },
        },
      }
    })
    copyClipMove('long')
    pasteClipMove(['short'])
    expect(channelKeyframes(clipById('short'), 'posX').length).toBe(0)
    expect(channelKeyframes(clipById('short'), 'scale').length).toBe(3)
  })

  it('copying from a clip with no move leaves the clipboard ALONE', () => {
    // ⛔ NOT "the clipboard is empty". It is module state that outlives one test, and
    // the property that matters is stronger anyway: a failed copy must not quietly
    // arm a paste that wipes the target, and it must not throw away what he already
    // had on the clipboard either.
    copyClipMove('long')
    copyClipMove('short') // no keyframes on it, so this one refuses
    expect(hasClipMove()).toBe(true)
    pasteClipMove(['short'])
    expect(channelKeyframes(clipById('short'), 'scale').length).toBe(3) // still LONG's move
  })
})

/**
 * Widened on 2026-08-18. The pair carried the three move channels only, so a
 * clip whose rotation, crop, fade or colour he had shaped by hand copied as a
 * bare zoom and arrived with all of that missing, and nothing said so.
 */
describe('the channels that are not scale, posX and posY', () => {
  /** The long clip, plus a rotation ramp, a fade and a colour move on it. */
  function seedRichClip(): void {
    const p = projectWithTwoClips()
    const seq = p.sequences[p.activeSequenceId]
    const video = seq.tracks.find((t) => t.kind === 'video')!
    const long = video.clips.find((c) => c.id === 'long')!
    long.keyframes = {
      ...long.keyframes,
      rotation: [kf(0, 0), kf(1, 15)],
      opacity: [kf(0, 0), kf(0.5, 1)],
      cropL: [kf(0, 0), kf(1, 0.2)],
      volume: [kf(0, 0), kf(1, -6)],
    }
    useStore.getState().setProject(p)
    // ⛔ AN EFFECT PARAMETER CANNOT BE SEEDED BY HAND. `saturation` and every
    // other colour channel live in the clip's EFFECT STACK, not in
    // `clip.keyframes`, so writing that bag directly reads back empty and the
    // test would pass for the wrong reason. Effect parameters are the biggest
    // half of the gap this block describes, so it goes in through the app's own
    // door.
    applyEffect('long', 'saturation')
    const fx = clipById('long').effects.find((e) => e.type === 'saturation')!
    useStore.getState().setUI({ playheadS: 0 })
    addEffectKeyframeAtPlayhead('long', fx.id, 'saturation')
    useStore.getState().setUI({ playheadS: 1 })
    addEffectKeyframeAtPlayhead('long', fx.id, 'saturation')
  }

  it('carries rotation, opacity, crop and colour along with the move', () => {
    seedRichClip()
    copyClipMove('long')
    pasteClipMove(['short'])
    const short = clipById('short')
    expect(channelKeyframes(short, 'rotation')).toHaveLength(2)
    expect(channelKeyframes(short, 'opacity')).toHaveLength(2)
    expect(channelKeyframes(short, 'cropL')).toHaveLength(2)
    expect(channelKeyframes(short, 'saturation')).toHaveLength(2)
  })

  it('does NOT carry volume, which is the one audio channel', () => {
    seedRichClip()
    copyClipMove('long')
    pasteClipMove(['short'])
    // Reusing a zoom must not quietly change how loud a clip is.
    expect(channelKeyframes(clipById('short'), 'volume')).toEqual([])
  })

  it('squeezes them onto a shorter clip the same way it squeezes the move', () => {
    seedRichClip()
    copyClipMove('long')
    pasteClipMove(['short']) // 'short' is 1s, the animation spans 1s, so it fits
    expect(channelKeyframes(clipById('short'), 'rotation').map((k) => k.t)).toEqual([0, 1])
  })

  it('⛔ does NOT wipe animation the target had that the copied clip did not', () => {
    const p = projectWithTwoClips()
    const seq = p.sequences[p.activeSequenceId]
    const video = seq.tracks.find((t) => t.kind === 'video')!
    const short = video.clips.find((c) => c.id === 'short')!
    short.keyframes = { rotation: [kf(0, 0), kf(0.5, 30)] }
    useStore.getState().setProject(p)
    copyClipMove('long') // scale only
    pasteClipMove(['short'])
    // The move landed AND his rotation survived: a paste he thinks is about a
    // zoom must not delete animation he made by hand on a different channel.
    expect(channelKeyframes(clipById('short'), 'scale')).toHaveLength(3)
    expect(channelKeyframes(clipById('short'), 'rotation')).toHaveLength(2)
  })

  it('still REPLACES the three move channels, so the lit shelf tile stays honest', () => {
    const p = projectWithTwoClips()
    const seq = p.sequences[p.activeSequenceId]
    const video = seq.tracks.find((t) => t.kind === 'video')!
    const long = video.clips.find((c) => c.id === 'long')!
    long.keyframes = { rotation: [kf(0, 0), kf(1, 15)] } // no move at all
    const short = video.clips.find((c) => c.id === 'short')!
    short.keyframes = { scale: [kf(0, 1), kf(0.5, 2), kf(1, 1)] }
    useStore.getState().setProject(p)
    copyClipMove('long')
    pasteClipMove(['short'])
    expect(channelKeyframes(clipById('short'), 'scale')).toEqual([])
    expect(channelKeyframes(clipById('short'), 'rotation')).toHaveLength(2)
  })

  it('copies a clip that has ONLY non-move animation, instead of refusing it', () => {
    const p = projectWithTwoClips()
    const seq = p.sequences[p.activeSequenceId]
    const video = seq.tracks.find((t) => t.kind === 'video')!
    const long = video.clips.find((c) => c.id === 'long')!
    long.keyframes = { opacity: [kf(0, 0), kf(0.5, 1)] }
    useStore.getState().setProject(p)
    copyClipMove('long')
    // It used to say "That clip has no move on it" and copy nothing at all.
    expect(hasClipMove()).toBe(true)
    pasteClipMove(['short'])
    expect(channelKeyframes(clipById('short'), 'opacity')).toHaveLength(2)
  })
})
