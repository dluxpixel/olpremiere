// Captioning what he selected: every clip, in one pass and one undo step.
//
// His words, 2026-10-03: *"right-clicking and selecting multiple clips just
// says 'Caption this clip,' and it captions only one."* What is proven here is
// the plumbing from a selection to one caption track; the recogniser is stood
// in for through `captionEars`, the same seam the end to end suite uses.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mem = vi.hoisted(() => {
  const data = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  }
  return { data }
})

const toasted: string[] = []
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (m: string) => void toasted.push(m) }) },
}))

import { AUTO_SHAPE, cleanShape } from '../engine/captions/captionStyle'
import type { CaptionWord } from '../engine/captions/captions'
import { clipEndS } from '../engine/timeline'
import {
  activeSequence,
  newClipFromAsset,
  newProject,
  videoTracks,
  type Clip,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { CAPTION_TRACK_NAME, captionsOn } from './captionActions'
import { captionJobProgress, captionLabel, captionTargets, captionTheseClips } from './captionRun'
import { reloadCaptionStyles, saveNewCaptionStyle, setDefaultCaptionStyle } from './captionStyles'
import { updateActiveSequence, useStore } from './store'
import { captionEars, useTranscribe } from './transcribeActions'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const asset = (id: string, kind: MediaAsset['kind'] = 'audio'): MediaAsset => ({
  id,
  name: id,
  kind,
  blobKey: 'b',
  durationS: 10,
  hasAudio: true,
  hasVideo: kind === 'video',
})

/** What each clip "says": three words, back to back, from where it sits. */
const heard: string[] = []
captionEars.wordsForClip = async (clip: Clip): Promise<CaptionWord[]> => {
  heard.push(clip.id)
  await Promise.resolve()
  return ['one', 'two', 'three'].map((t, i) => ({
    text: `${t}${clip.id.slice(-1)}`,
    startS: clip.startS + i * 0.25,
    endS: clip.startS + (i + 1) * 0.25,
  }))
}

/** Three voice clips on A1, and a picture on V1 linked to the first. */
function seed(): { a: string; b: string; c: string; pic: string } {
  const s = useStore.getState()
  s.setProject({ ...s.project, assets: { a: asset('a'), b: asset('b'), c: asset('c'), v: asset('v', 'video') } })
  updateActiveSequence('seed', (sq) => {
    const v1 = sq.tracks.find((t) => t.kind === 'video')!.id
    const a1 = sq.tracks.find((t) => t.kind === 'audio')!.id
    const clip = (id: string, assetId: string, startS: number, linkId?: string): Clip => ({
      ...newClipFromAsset(asset(assetId), startS),
      id,
      outS: 1,
      ...(linkId ? { linkId } : {}),
    })
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === a1
          ? { ...t, clips: [clip('clip-a', 'a', 0, 'L'), clip('clip-b', 'b', 3), clip('clip-c', 'c', 6)] }
          : t.id === v1
            ? { ...t, clips: [{ ...clip('pic-a', 'a', 0, 'L'), assetId: 'a' }] }
            : t,
      ),
    }
  })
  return { a: 'clip-a', b: 'clip-b', c: 'clip-c', pic: 'pic-a' }
}

beforeEach(() => {
  mem.data.clear()
  reloadCaptionStyles()
  heard.length = 0
  toasted.length = 0
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })
})

describe('captioning a selection', () => {
  it('captions ALL the selected clips, onto one track, in one undo step', async () => {
    const { a, b, c } = seed()
    const before = videoTracks(seq()).length
    await captionTheseClips([a, b, c])
    expect(heard).toEqual([a, b, c])
    const captions = captionsOn(seq())
    // One caption from each clip's words, each inside its own clip.
    for (const [id, at] of [['a', 0], ['b', 3], ['c', 6]] as const) {
      const mine = captions.filter(({ clip }) => clip.title!.text.includes(id))
      expect(mine.length).toBeGreaterThan(0)
      expect(mine.every(({ clip }) => clip.startS >= at - 1e-9 && clipEndS(clip) <= at + 1 + 0.5)).toBe(true)
    }
    expect(videoTracks(seq()).filter((t) => t.name === CAPTION_TRACK_NAME)).toHaveLength(1)

    useStore.getState().undo()
    expect(videoTracks(seq())).toHaveLength(before)
    expect(captionsOn(seq())).toHaveLength(0)
  })

  it('says where it is while it works: clip 1 of 3, then 2, then 3', async () => {
    const { a, b, c } = seed()
    const seen: string[] = []
    const off = useTranscribe.subscribe((s) => {
      if (s.queue) seen.push(`${s.queue.index}/${s.queue.total}`)
    })
    await captionTheseClips([a, b, c])
    off()
    expect([...new Set(seen)]).toEqual(['1/3', '2/3', '3/3'])
    expect(useTranscribe.getState().status).toBe('idle')
  })

  it('counts a picture and its own sound as one take, and the label says so', () => {
    const { a, b, pic } = seed()
    expect(captionTargets([pic])).toEqual([a])
    expect(captionTargets([pic, a])).toEqual([a])
    expect(captionTargets([pic, a, b])).toEqual([a, b])
    expect(captionLabel(1)).toBe('Caption this clip')
    expect(captionLabel(3)).toBe('Caption 3 clips')
  })

  it('one clip goes through the single clip door, with no queue', async () => {
    const { b } = seed()
    const queues: unknown[] = []
    const off = useTranscribe.subscribe((s) => void queues.push(s.queue))
    await captionTheseClips([b])
    off()
    expect(heard).toEqual([b])
    expect(queues.every((q) => q === null)).toBe(true)
    expect(captionsOn(seq()).length).toBeGreaterThan(0)
  })

  it('uses the default caption style, length and all', async () => {
    const { a, b, c } = seed()
    const three = saveNewCaptionStyle({
      name: 'Three',
      look: { fontSizePx: 150 },
      refHeight: seq().height,
      shape: cleanShape({ ...AUTO_SHAPE, length: 'fixed', maxWords: 3, charsPerLine: 40 }),
      emphasisColor: '#FFD400',
    })
    setDefaultCaptionStyle(three.id)
    await captionTheseClips([a, b, c])
    expect(captionsOn(seq()).map(({ clip }) => clip.title!.text)).toEqual(['onea twoa threea', 'oneb twob threeb', 'onec twoc threec'])
    expect(captionsOn(seq()).every(({ clip }) => clip.title!.fontSizePx === 150)).toBe(true)
  })
})

describe('the job progress', () => {
  it('moves one clip at a time and never runs past the clip it is on', () => {
    expect(captionJobProgress('reading', null, { index: 1, total: 4 })).toBeCloseTo(0.0125, 6)
    expect(captionJobProgress('listening', null, { index: 2, total: 4 })).toBeCloseTo(0.4, 6)
    expect(captionJobProgress('listening', null, { index: 4, total: 4 })!).toBeLessThan(1)
    expect(captionJobProgress('listening', null, null)).toBeNull()
    expect(captionJobProgress('model', 50, null)).toBeCloseTo(0.35, 6)
  })
})
