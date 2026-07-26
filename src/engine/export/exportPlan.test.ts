import { describe, expect, it } from 'vitest'
import type { Sequence } from '../types'
import { effectiveAudioBitrate, effectiveRateControl } from './messages'
import {
  EXPORT_AUDIO_BITRATE,
  EXPORT_KEYFRAME_S,
  EXPORT_QP,
  SD_AUDIO_BITRATE,
  exportRaster,
  planExport,
} from './exportPlan'

const seq = (over: Partial<Sequence> = {}): Sequence => ({
  id: 'seq',
  name: 'Test',
  fps: 30,
  width: 1920,
  height: 1080,
  sampleRate: 48000,
  durationS: 10,
  tracks: [],
  markers: [],
  ...over,
})

describe('exportRaster', () => {
  it('raises an HD landscape timeline one tier, into the 1440p box', () => {
    expect(exportRaster(1920, 1080)).toEqual({ width: 2560, height: 1440 })
  })

  it('raises a Shorts timeline into the PORTRAIT box, never a stretched landscape one', () => {
    expect(exportRaster(1080, 1920)).toEqual({ width: 1440, height: 2560 })
  })

  it('keeps a square timeline square', () => {
    expect(exportRaster(1080, 1080)).toEqual({ width: 1440, height: 1440 })
  })

  it('leaves a timeline that is already 1440p or bigger alone', () => {
    expect(exportRaster(2560, 1440)).toEqual({ width: 2560, height: 1440 })
    expect(exportRaster(3840, 2160)).toEqual({ width: 3840, height: 2160 })
  })

  it('does NOT upscale sub-HD footage — interpolation invents no detail', () => {
    expect(exportRaster(640, 360)).toEqual({ width: 640, height: 360 })
    expect(exportRaster(1280, 720)).toEqual({ width: 2560, height: 1440 }) // 720 is the floor, inclusive
    expect(exportRaster(1280, 718)).toEqual({ width: 1280, height: 718 }) // just below it
  })

  it('always emits EVEN dimensions, which yuv420p requires', () => {
    for (const [w, h] of [
      [641, 361],
      [1919, 1079],
      [333, 777],
    ]) {
      const r = exportRaster(w, h)
      expect(r.width % 2).toBe(0)
      expect(r.height % 2).toBe(0)
    }
  })
})

describe('planExport', () => {
  it('picks constant quality, H.264 and transparent audio on any HD-or-better timeline', () => {
    const p = planExport(seq())
    expect(p.settings.rateControl).toBe('quantizer')
    expect(p.settings.quantizer).toBe(EXPORT_QP)
    expect(p.settings.videoCodec).toBe('avc')
    expect(p.settings.keyframeIntervalS).toBe(EXPORT_KEYFRAME_S)
    // Absent fields fall back to 192 kbps in the worker, so this must be explicit.
    expect(p.settings.audioBitrate).toBe(EXPORT_AUDIO_BITRATE)
    expect(p.settings.audioCodecPref).toBe('aac')
    // Hardware FIRST, because the caller's B-frame retry escapes to software.
    // Asking for software here inverted that retry into the broken encoder.
    expect(p.settings.hardwareAcceleration).toBe('prefer-hardware')
    expect(p.nativeEncoder).toBe('x264')
    expect(p.nativeExt).toBe('mp4')
  })

  // Below HD the worker coerces rate control and audio no matter what it is
  // handed, to hold the golden 640×360 export byte-stable. The plan used to ask
  // for QP 14 and 320 kbps anyway and be silently overridden — so it described a
  // file the app was never going to write.
  it('states the SD truth rather than a quality the worker would override', () => {
    const p = planExport(seq({ width: 640, height: 360 }))
    expect(p.settings.rateControl).toBe('variable')
    expect(p.settings.audioBitrate).toBe(SD_AUDIO_BITRATE)
    // ...and it is HONESTY, not a behaviour change: what reaches the encoder is
    // identical to what the fence produced from the old, untrue plan.
    expect(effectiveRateControl(p.settings, false)).toBe('variable')
    expect(effectiveAudioBitrate(p.settings, false)).toBe(SD_AUDIO_BITRATE)
    expect(effectiveRateControl({ rateControl: 'quantizer' }, false)).toBe('variable')
    expect(effectiveAudioBitrate({ audioBitrate: EXPORT_AUDIO_BITRATE }, false)).toBe(SD_AUDIO_BITRATE)
  })

  it('exports at the sequence frame rate, never below it', () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      expect(planExport(seq({ fps })).settings.fps).toBe(fps)
    }
  })

  it('carries a fallback bitrate for an encoder that will not honour QP', () => {
    expect(planExport(seq()).settings.videoBitrate).toBeGreaterThan(0)
  })

  it('exports the whole sequence when no in/out points are set', () => {
    const p = planExport(seq({ durationS: 12.5 }))
    expect(p.settings.startS).toBe(0)
    expect(p.settings.endS).toBe(12.5)
    expect(p.usingWorkArea).toBe(false)
  })

  it('exports only the work area when in/out points are set', () => {
    const p = planExport(seq({ durationS: 12.5, inPointS: 1.2, outPointS: 4 }))
    expect(p.settings.startS).toBeCloseTo(1.2, 9)
    expect(p.settings.endS).toBeCloseTo(4, 9)
    expect(p.usingWorkArea).toBe(true)
  })

  it('survives a degenerate work area rather than rendering zero frames', () => {
    const p = planExport(seq({ durationS: 10, inPointS: 8, outPointS: 8 }))
    expect(p.settings.startS).toBe(0)
    expect(p.settings.endS).toBe(10)
  })

  it('renders a Shorts timeline at the portrait raster', () => {
    const p = planExport(seq({ width: 1080, height: 1920 }))
    expect(p.settings.width).toBe(1440)
    expect(p.settings.height).toBe(2560)
  })
})
