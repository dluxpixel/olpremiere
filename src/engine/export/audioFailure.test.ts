// An export that quietly drops the sound is the worst outcome this codebase can
// produce: he only finds out after uploading.
//
// His report, 2026-08-05: "to export audio doesn't work. It just didn't export
// the audio." planAudioMix returned null when every audible clip failed to
// decode, and BOTH export paths read null as "this timeline has no audio" and
// wrote a silent video. The decode warnings went to a console he never opens.
//
// These pin the distinction that matters:
//   nothing audible on the timeline  -> null, video-only, correct and silent
//   audible clips that will NOT read -> THROW, so he is told which files

import { beforeAll, describe, expect, it, vi } from 'vitest'

// planAudioMix bails to null with no AudioEncoder (older Safari, and node).
// Without this stub every test here would pass for the WRONG reason.
beforeAll(() => {
  ;(globalThis as { AudioEncoder?: unknown }).AudioEncoder ??= class {}
})

vi.mock('../audio', async () => {
  const actual = await vi.importActual<typeof import('../audio')>('../audio')
  return {
    ...actual,
    // Every decode fails: the exact condition that used to produce a silent file.
    clipAudioBuffer: vi.fn(async () => null),
  }
})

const { planAudioMix } = await import('./audioRender')
const { newId } = await import('../types')
import type { MediaAsset, Sequence } from '../types'

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'a1',
  name: 'take-one.mp4',
  kind: 'video',
  blobKey: 'asset/a1',
  durationS: 10,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true,
  ...over,
})

function seqWithAudioClip(): Sequence {
  return {
    id: 's1',
    name: 'Seq',
    fps: 30,
    width: 1920,
    height: 1080,
    durationS: 10,
    tracks: [
      {
        id: 't1',
        kind: 'audio',
        name: 'A1',
        clips: [
          {
            id: newId(),
            assetId: 'a1',
            startS: 0,
            inS: 0,
            outS: 5,
            speed: 1,
            enabled: true,
            transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5, crop: { l: 0, r: 0, t: 0, b: 0 } },
            opacity: 1,
            blendMode: 'normal',
            audioGainDb: 0,
            fadeInS: 0,
            fadeOutS: 0,
            effects: [],
          },
        ],
      },
    ],
  } as unknown as Sequence
}

describe('an export must never quietly lose the sound', () => {
  it('THROWS, naming the file, when every audible clip fails to decode', async () => {
    const seq = seqWithAudioClip()
    await expect(planAudioMix(seq, { a1: asset() }, 0, 10)).rejects.toThrow(/take-one\.mp4/)
  })

  it('the message tells him what to do, not just that something broke', async () => {
    const seq = seqWithAudioClip()
    await expect(planAudioMix(seq, { a1: asset() }, 0, 10)).rejects.toThrow(/Re-import/)
  })

  it('still returns null (video-only, no error) when there is genuinely nothing audible', async () => {
    // No audio on the asset at all: a silent timeline is not a failure.
    const seq = seqWithAudioClip()
    const plan = await planAudioMix(seq, { a1: asset({ hasAudio: false }) }, 0, 10)
    expect(plan).toBeNull()
  })

  it('still returns null for an empty timeline', async () => {
    const empty = { ...seqWithAudioClip(), tracks: [] } as unknown as Sequence
    expect(await planAudioMix(empty, { a1: asset() }, 0, 10)).toBeNull()
  })
})
