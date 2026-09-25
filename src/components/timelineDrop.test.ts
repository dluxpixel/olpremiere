import { describe, expect, it } from 'vitest'
import { ASSET_MIME, SFX_MIME, TITLE_MIME } from '../state/dnd'
import { assetDropTrack, dropKinds, laneTakesDrop, sfxDropTrack, snappedDropTime } from './timelineDrop'
import { makeClip, makeSeq, makeTrack } from './timelineTestFixtures'

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
