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
