import { describe, expect, it } from 'vitest'
import { ASSET_MIME, SFX_MIME, TITLE_MIME } from '../state/dnd'
import {
  assetDropGhosts,
  assetDropPreview,
  assetDropTrack,
  dropKinds,
  insertDroppedAsset,
  laneTakesDrop,
  sfxDropGhosts,
  sfxDropPreview,
  sfxDropTrack,
  snappedDropTime,
  titleDropGhosts,
  titleDropTrack,
} from './timelineDrop'
import { makeAsset, makeClip, makeSeq, makeTrack } from './timelineTestFixtures'

describe('dropKinds', () => {
  it('reads what the drag carries', () => {
    expect(dropKinds([ASSET_MIME])).toEqual({ isAsset: true, isSfx: false, isTitle: false })
    expect(dropKinds([SFX_MIME, 'text/plain'])).toEqual({ isAsset: false, isSfx: true, isTitle: false })
    expect(dropKinds([TITLE_MIME])).toEqual({ isAsset: false, isSfx: false, isTitle: true })
    expect(dropKinds(['Files'])).toEqual({ isAsset: false, isSfx: false, isTitle: false })
  })
})

describe('laneTakesDrop', () => {
  const v = makeTrack()
  const a = makeTrack({ kind: 'audio' })
  it('needs a lane', () => {
    expect(laneTakesDrop(null, false, false)).toBe(false)
  })
  it('puts sounds on audio and titles on video', () => {
    expect(laneTakesDrop(a, true, false)).toBe(true)
    expect(laneTakesDrop(v, true, false)).toBe(false)
    expect(laneTakesDrop(v, false, true)).toBe(true)
    expect(laneTakesDrop(a, false, true)).toBe(false)
  })
  it('takes media on any lane', () => {
    expect(laneTakesDrop(v, false, false)).toBe(true)
    expect(laneTakesDrop(a, false, false)).toBe(true)
  })
})

describe('snappedDropTime', () => {
  const seq = makeSeq([makeTrack({ clips: [makeClip({ startS: 0, outS: 2 })] })])
  it('passes the time through with snapping off', () => {
    expect(snappedDropTime(2.05, seq, false, 0, 100)).toBe(2.05)
  })
  it('snaps to a clip edge inside 8px', () => {
    // 100px/s: 8px is 0.08s.
    expect(snappedDropTime(2.05, seq, true, 10, 100)).toBe(2)
    expect(snappedDropTime(2.2, seq, true, 10, 100)).toBe(2.2)
  })
  it('snaps to the playhead', () => {
    expect(snappedDropTime(4.97, seq, true, 5, 100)).toBe(5)
  })
})

describe('drop targets', () => {
  const v1 = makeTrack()
  const vLocked = makeTrack({ locked: true })
  const a1Locked = makeTrack({ kind: 'audio', locked: true })
  const a2 = makeTrack({ kind: 'audio' })
  const seq = makeSeq([vLocked, v1, a1Locked, a2])

  it('lands a sound on the hovered unlocked audio lane, else the first unlocked one', () => {
    const a3 = makeTrack({ kind: 'audio' })
    expect(sfxDropTrack(a3, seq)).toBe(a3)
    expect(sfxDropTrack(a1Locked, seq)).toBe(a2)
    expect(sfxDropTrack(v1, seq)).toBe(a2)
    expect(sfxDropTrack(null, seq)).toBe(a2)
  })

  it('lands media on the hovered lane of its kind, else the first unlocked one', () => {
    expect(assetDropTrack(v1, seq, 'video')).toBe(v1)
    expect(assetDropTrack(vLocked, seq, 'video')).toBe(v1)
    expect(assetDropTrack(a2, seq, 'video')).toBe(v1)
    expect(assetDropTrack(null, seq, 'audio')).toBe(a2)
    expect(assetDropTrack(null, makeSeq([vLocked]), 'video')).toBeUndefined()
  })
})

describe('drop ghosts', () => {
  const clip = (startS: number, outS: number) => makeClip({ startS, outS })
  const av = makeAsset({ id: 'av', name: 'cat.mp4', durationS: 8 })
  const still = makeAsset({ id: 'png', name: 'pic.png', kind: 'image', durationS: 0, hasAudio: false })
  const snd = makeAsset({ id: 'snd', name: 'meow.wav', kind: 'audio', durationS: 2, hasVideo: false })

  it('runs the insert a bin drop runs: a pair for video with sound, one clip for the rest', () => {
    const seq = makeSeq([makeTrack(), makeTrack({ kind: 'audio' })])
    const pair = insertDroppedAsset(seq, av, seq.tracks[0]!, 3)
    expect(pair.clipIds).toHaveLength(2)
    expect(pair.seq.tracks.map((t) => t.clips.length)).toEqual([1, 1])
    const one = insertDroppedAsset(seq, still, seq.tracks[0]!, 3)
    expect(one.clipIds).toHaveLength(1)
    // The sequence handed in is never touched: the ghost is only a preview.
    expect(seq.tracks.map((t) => t.clips.length)).toEqual([0, 0])
  })

  it('reads the ghosts off the clips the insert made, one per lane', () => {
    const seq = makeSeq([makeTrack(), makeTrack({ kind: 'audio' })])
    expect(assetDropGhosts(seq, av, seq.tracks[0]!, 3)).toEqual([
      { trackId: seq.tracks[0]!.id, tS: 3, durS: 8, label: 'cat.mp4' },
      { trackId: seq.tracks[1]!.id, tS: 3, durS: 8, label: 'cat.mp4' },
    ])
  })

  it('shows a picture at the default length, and a sound on an audio lane even when hovering video', () => {
    const seq = makeSeq([makeTrack(), makeTrack({ kind: 'audio' })])
    expect(assetDropGhosts(seq, still, seq.tracks[0]!, 1)[0]!.durS).toBe(5)
    expect(assetDropGhosts(seq, snd, seq.tracks[0]!, 1)).toEqual([
      { trackId: seq.tracks[1]!.id, tS: 1, durS: 2, label: 'meow.wav' },
    ])
  })

  it('follows the insert onto the next free lane, and shows nothing for a lane that does not exist yet', () => {
    const v1 = makeTrack({ clips: [clip(0, 20)] })
    const v2 = makeTrack()
    const seq = makeSeq([v1, v2])
    expect(assetDropGhosts(seq, still, v1, 2).map((g) => g.trackId)).toEqual([v2.id])
    const packed = makeSeq([makeTrack({ clips: [clip(0, 20)] })])
    expect(assetDropGhosts(packed, still, packed.tracks[0]!, 2)).toEqual([])
  })

  it('says a drop makes a lane when the clip lands on one that does not exist yet', () => {
    const packed = makeSeq([makeTrack({ clips: [clip(0, 20)] })])
    expect(assetDropPreview(packed, still, packed.tracks[0]!, 2)).toEqual({ ghosts: [], makesLane: true })
    const roomy = makeSeq([makeTrack(), makeTrack()])
    expect(assetDropPreview(roomy, still, roomy.tracks[0]!, 2).makesLane).toBe(false)
    const a1 = makeTrack({ kind: 'audio', clips: [clip(0, 20)] })
    const sndSeq = makeSeq([makeTrack(), a1])
    // A sound is nudged to a gap on its own lane (not `exact`): it never makes one.
    const s = sfxDropPreview(sndSeq, snd, a1, 2)
    expect(s.makesLane).toBe(false)
    expect(s.ghosts.map((g) => g.trackId)).toEqual([a1.id])
  })

  it('keeps the ghost of the clip of a pair that lands on an existing lane', () => {
    // Video lane is free, the only audio lane is taken: the sound goes to a new lane.
    const seq = makeSeq([makeTrack(), makeTrack({ kind: 'audio', clips: [clip(0, 20)] })])
    const r = assetDropPreview(seq, av, seq.tracks[0]!, 3)
    expect(r.ghosts).toEqual([{ trackId: seq.tracks[0]!.id, tS: 3, durS: 8, label: 'cat.mp4' }])
    expect(r.makesLane).toBe(true)
  })

  it('shows nothing when no unlocked lane of the kind is left', () => {
    const seq = makeSeq([makeTrack({ locked: true })])
    expect(assetDropGhosts(seq, still, seq.tracks[0]!, 2)).toEqual([])
  })

  it('puts a sound ghost on the lane a dropped sound takes, nudged to a gap like the sound insert', () => {
    const a1 = makeTrack({ kind: 'audio', clips: [clip(0, 3)] })
    const seq = makeSeq([makeTrack(), a1])
    const [g] = sfxDropGhosts(seq, snd, a1, 1)
    expect(g!.trackId).toBe(a1.id)
    expect(g!.tS).toBe(3)
    expect(g!.durS).toBe(2)
  })

  it('puts a title ghost on the topmost unlocked video lane, nudged to a gap like the title insert', () => {
    const v1 = makeTrack()
    const v2 = makeTrack({ clips: [clip(0, 4)] })
    const v3 = makeTrack({ locked: true })
    const seq = makeSeq([v1, v2, v3])
    expect(titleDropTrack(seq)?.id).toBe(v2.id)
    const [g] = titleDropGhosts(seq, 3, 'Headline', 1)
    expect(g).toEqual({ trackId: v2.id, tS: 4, durS: 3, label: 'Headline' })
    expect(titleDropGhosts(makeSeq([makeTrack({ locked: true })]), 3, 'x', 1)).toEqual([])
  })
})
