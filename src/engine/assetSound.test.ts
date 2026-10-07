// ⛔ AU-10. Media put back mid-session: the picture came back, and the sound and
// the waveform stayed missing until a restart, because the reads made while the
// bytes were gone were remembered as nothing and nothing forgot them.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaAsset } from './types'

const { getBlob, decode, peaks } = vi.hoisted(() => ({ getBlob: vi.fn(), decode: vi.fn(), peaks: vi.fn() }))
vi.mock('../state/persistence', () => ({
  getBlob,
  // The waveform's own store of peaks: empty, so every read goes to the bytes.
  db: async () => ({ get: async () => undefined, put: async () => undefined }),
}))
vi.mock('./audioDecodeClient', () => ({ decodeAudioOffThread: decode, peaksOffThread: peaks }))

class FakeAudioContext {
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (ch: number) => data[ch]!,
      copyToChannel: (src: Float32Array, ch: number) => data[ch]!.set(src),
    }
  }
}
vi.stubGlobal('AudioContext', FakeAudioContext)

const { getAudioRange, isProvedSilent } = await import('./audio')
const { getAssetPeaks, onPeaksForgotten, peaksVersion } = await import('./waveform')
const { ensureBeats, knownBeats } = await import('./beatCache')
const { forgetAssetSound } = await import('./assetSound')

const take = { id: 'a1', name: 'take.webm', kind: 'audio', blobKey: 'asset/a1', hasAudio: true, durationS: 10 } as MediaAsset

beforeEach(() => {
  getBlob.mockReset()
  decode.mockReset()
  peaks.mockReset()
  decode.mockResolvedValue({ kind: 'pcm', planes: [new Float32Array(48_000 * 4).fill(0.1)], sampleRate: 48_000, startS: 0 })
  peaks.mockResolvedValue({ kind: 'peaks', peaks: new Float32Array([0.5, 1]) })
})

describe('forgetAssetSound', () => {
  it('a sound read while the bytes were missing is read again once they are back', async () => {
    getBlob.mockResolvedValue(undefined) // the file is missing at open
    expect(await getAudioRange(take, 0, 2)).toBeNull()
    expect(await getAssetPeaks(take)).toBeNull()
    await ensureBeats(take, 0, 2)
    expect(knownBeats('a1', 0, 2)).toEqual([])

    getBlob.mockResolvedValue(new Blob(['bytes'])) // Find my media put it back
    // Without the forget, every one of these is still the remembered nothing.
    expect(await getAudioRange(take, 0, 2)).toBeNull()

    const heard = vi.fn()
    const stop = onPeaksForgotten(heard)
    const before = peaksVersion('a1')
    forgetAssetSound('a1')
    stop()

    expect(await getAudioRange(take, 0, 2)).not.toBeNull()
    expect(await getAssetPeaks(take)).not.toBeNull()
    expect(knownBeats('a1', 0, 2)).toBeNull()
    // And a waveform already drawn hears that it should ask again.
    expect(heard).toHaveBeenCalled()
    expect(peaksVersion('a1')).toBe(before + 1)
  })

  it('forgets that the old bytes had no sound track, since the file put back may be another one', async () => {
    const clip = { ...take, id: 'a2', blobKey: 'asset/a2' } as MediaAsset
    getBlob.mockResolvedValue(new Blob(['bytes']))
    decode.mockResolvedValueOnce({ kind: 'silent' })
    expect(await getAudioRange(clip, 0, 2)).toBeNull()
    expect(isProvedSilent('a2')).toBe(true)

    forgetAssetSound('a2')

    expect(isProvedSilent('a2')).toBe(false)
  })
})
