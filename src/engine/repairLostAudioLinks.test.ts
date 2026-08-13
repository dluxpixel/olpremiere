import { describe, expect, it } from 'vitest'
import { defaultTransform, repairLostAudioLinks, type Clip, type Track } from './types'

const clip = (id: string, assetId: string, linkId?: string): Clip => ({
  id,
  assetId,
  startS: 0,
  inS: 0,
  outS: 2,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...(linkId === undefined ? {} : { linkId }),
})

const track = (kind: 'video' | 'audio', name: string, clips: Clip[]): Track => ({
  id: name,
  kind,
  name,
  height: kind === 'video' ? 64 : 60,
  muted: false,
  solo: false,
  locked: false,
  volumeDb: 0,
  pan: 0,
  clips,
})

describe('repairLostAudioLinks', () => {
  // His own 44-clip edit: 14 video clips pointing at partners that were gone,
  // and no audio clip anywhere used that asset. Silent in every render.
  it('frees a video clip whose audio partner was deleted', () => {
    const before = [track('video', 'V1', [clip('v', 'asset-a', 'link-1')]), track('audio', 'A1', [])]
    const after = repairLostAudioLinks(before)
    expect(after).not.toBe(before)
    expect(after[0].clips[0].linkId).toBeUndefined()
  })

  // ⛔ THE ONE THAT STOPS THIS DOUBLING HIS AUDIO. splitClipOnly gives each half
  // its own fresh linkId on purpose, so the halves stay video-only while an
  // untouched audio partner keeps playing their sound.
  it('leaves a deliberate video-only clip alone when its asset still has audio', () => {
    const before = [
      track('video', 'V1', [clip('v1', 'asset-a', 'fresh-1'), clip('v2', 'asset-a', 'fresh-2')]),
      track('audio', 'A1', [clip('a', 'asset-a', 'orig')]),
    ]
    expect(repairLostAudioLinks(before)).toBe(before)
  })

  it('leaves a real linked pair alone', () => {
    const before = [
      track('video', 'V1', [clip('v', 'asset-a', 'pair')]),
      track('audio', 'A1', [clip('a', 'asset-a', 'pair')]),
    ]
    expect(repairLostAudioLinks(before)).toBe(before)
  })

  it('never touches a clip that was already unlinked', () => {
    const before = [track('video', 'V1', [clip('v', 'asset-a')]), track('audio', 'A1', [])]
    expect(repairLostAudioLinks(before)).toBe(before)
  })

  // Unrelated music on the timeline must not vouch for a different asset.
  it('is not fooled by audio from a DIFFERENT asset', () => {
    const before = [
      track('video', 'V1', [clip('v', 'asset-a', 'link-1')]),
      track('audio', 'A1', [clip('music', 'asset-music')]),
    ]
    expect(repairLostAudioLinks(before)[0].clips[0].linkId).toBeUndefined()
  })

  it('returns the same array when there is nothing to repair, so no needless store write', () => {
    const before = [track('video', 'V1', [clip('v', 'asset-a')])]
    expect(repairLostAudioLinks(before)).toBe(before)
  })
})
