/**
 * @vitest-environment jsdom
 */
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultTransform, type Clip, type MediaAsset } from '../engine/types'
import { ClipWaveform } from './ClipWaveform'

// A minute of peaks at 60 a second, the resolution the real decode keeps.
vi.mock('../engine/waveform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/waveform')>()),
  getAssetPeaks: () => Promise.resolve(new Float32Array(3600).fill(0.5)),
}))

const song: MediaAsset = { id: 'song', name: 'song.mp3', kind: 'audio', blobKey: 's', durationS: 60, hasAudio: true, hasVideo: false }
const clip: Clip = {
  id: 'c', assetId: 'song', startS: 0, inS: 0, outS: 60, speed: 1, enabled: true, transform: defaultTransform(),
  opacity: 1, blendMode: 'normal', audioGainDb: 0, fadeInS: 0, fadeOutS: 0, effects: [],
}

let bars = 0
beforeEach(() => {
  bars = 0
  vi.stubGlobal('devicePixelRatio', 1.25)
  HTMLCanvasElement.prototype.getContext = (() => ({
    clearRect: () => {},
    fillRect: () => {
      bars += 1
    },
    fillStyle: '',
  })) as unknown as HTMLCanvasElement['getContext']
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ClipWaveform', () => {
  // At 800 px/s a minute of song is 48,000 px wide. A canvas side past 32,767 px
  // draws nothing in Chromium, so the waveform vanished when he zoomed in.
  it('keeps the canvas drawable and the bars few when zoomed far in', async () => {
    const { getByTestId } = render(<ClipWaveform clip={clip} asset={song} width={48000} height={40} />)
    const canvas = getByTestId('clip-waveform') as HTMLCanvasElement
    await waitFor(() => expect(bars).toBeGreaterThan(0))
    expect(canvas.width).toBeLessThanOrEqual(8192)
    expect(bars).toBeLessThanOrEqual(8192)
  })

  it('draws one bar per pixel at normal zoom, as before', async () => {
    const { getByTestId } = render(<ClipWaveform clip={clip} asset={song} width={3600} height={40} />)
    const canvas = getByTestId('clip-waveform') as HTMLCanvasElement
    await waitFor(() => expect(bars).toBeGreaterThan(0))
    expect(canvas.width).toBe(4500)
    expect(bars).toBe(3600)
  })
})
