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
  // The raster is the TIMELINE's size, always. The old rule raised HD timelines
  // into a 1440p box for the upload-tier trick; measured against David's own
  // footage it magnified the source's compression instead of adding detail (his
  // 1080p source was already scaled up 1.78x to fill a vertical frame, and the
  // export scaled it a further 1.33x for 2.37x total, every pixel invented).
  it('exports a vertical timeline at its OWN size, no upscale', () => {
    expect(exportRaster(1080, 1920)).toEqual({ width: 1080, height: 1920 })
  })

  it('exports a landscape timeline at its own size', () => {
    expect(exportRaster(1920, 1080)).toEqual({ width: 1920, height: 1080 })
  })

  it('keeps a square timeline square and its own size', () => {
    expect(exportRaster(1080, 1080)).toEqual({ width: 1080, height: 1080 })
  })

  it('leaves a big timeline exactly as it is', () => {
    expect(exportRaster(2560, 1440)).toEqual({ width: 2560, height: 1440 })
    expect(exportRaster(3840, 2160)).toEqual({ width: 3840, height: 2160 })
  })

  it('never upscales at any size, including the old 720 boundary', () => {
    expect(exportRaster(640, 360)).toEqual({ width: 640, height: 360 })
    expect(exportRaster(1280, 720)).toEqual({ width: 1280, height: 720 })
    expect(exportRaster(1280, 718)).toEqual({ width: 1280, height: 718 })
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
  // for QP 14 and 320 kbps anyway and be silently overridden, so it described a
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

  it('renders a Shorts timeline at the timeline’s own raster', () => {
    const p = planExport(seq({ width: 1080, height: 1920 }))
    expect(p.settings.width).toBe(1080)
    expect(p.settings.height).toBe(1920)
  })
})
