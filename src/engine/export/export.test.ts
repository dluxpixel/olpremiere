// Pure export math (node env): PCM slicing, contain-fit, frame ranges,
// codec fallback. The worker/DOM paths are covered by the Playwright golden
// export test, not here.

import { describe, expect, it } from 'vitest'
import {
  AUDIO_CHUNK_FRAMES,
  AV1_CODECS,
  EXPORT_DECODER_OPTIONS,
  H264_CODECS,
  HEVC_CODECS,
  clipFrameRange,
  containRect,
  effectiveAudioBitrate,
  effectiveRateControl,
  effectiveVideoCodec,
  firstSupported,
  isHdRaster,
  keyframeStride,
  packPlanarChunk,
  pcmChunks,
  quantizerFor,
  videoCodecLadder,
  videoEncoderConfig,
} from './messages'

describe('pcmChunks', () => {
  it('slices into full chunks plus a partial tail', () => {
    const chunks = pcmChunks(10_000, 4800, 48_000)
    expect(chunks).toEqual([
      { offset: 0, frames: 4800, timestampUs: 0 },
      { offset: 4800, frames: 4800, timestampUs: 100_000 },
      { offset: 9600, frames: 400, timestampUs: 200_000 },
    ])
  })

  it('has no tail when total is an exact multiple', () => {
    const chunks = pcmChunks(9600, 4800, 48_000)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toEqual({ offset: 4800, frames: 4800, timestampUs: 100_000 })
  })

  it('returns nothing for zero frames', () => {
    expect(pcmChunks(0, 4800, 48_000)).toEqual([])
  })

  it('rounds timestamps at non-integral chunk durations', () => {
    // 1000 frames at 44.1 kHz = 22675.7… µs per chunk
    const chunks = pcmChunks(3000, 1000, 44_100)
    expect(chunks.map((c) => c.timestampUs)).toEqual([0, 22_676, 45_351])
  })

  it('AUDIO_CHUNK_FRAMES is 0.1 s at 48 kHz', () => {
    expect(AUDIO_CHUNK_FRAMES / 48_000).toBeCloseTo(0.1, 10)
  })
})

describe('packPlanarChunk', () => {
  it('packs channel slices consecutively (f32-planar)', () => {
    const ch0 = Float32Array.from([0, 1, 2, 3, 4])
    const ch1 = Float32Array.from([10, 11, 12, 13, 14])
    const out = packPlanarChunk([ch0, ch1], 2, 3)
    expect(Array.from(out)).toEqual([2, 3, 4, 12, 13, 14])
  })

  it('handles a single channel and zero offset', () => {
    const out = packPlanarChunk([Float32Array.from([5, 6, 7])], 0, 2)
    expect(Array.from(out)).toEqual([5, 6])
  })
})

describe('containRect', () => {
  it('matches exactly when aspect ratios agree', () => {
    expect(containRect(1920, 1080, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it('pillarboxes a narrow source, centered', () => {
    expect(containRect(100, 100, 200, 100)).toEqual({ x: 50, y: 0, w: 100, h: 100 })
  })

  it('letterboxes a wide source, centered', () => {
    expect(containRect(200, 100, 100, 100)).toEqual({ x: 0, y: 25, w: 100, h: 50 })
  })

  it('rejects degenerate sources', () => {
    expect(containRect(0, 100, 200, 100)).toBeNull()
    expect(containRect(100, -1, 200, 100)).toBeNull()
  })
})

describe('clipFrameRange', () => {
  it('covers [startS, endS) at exact frame boundaries', () => {
    expect(clipFrameRange(1, 2, 30)).toEqual({ first: 30, end: 60 })
  })

  it('excludes the frame landing exactly on endS', () => {
    expect(clipFrameRange(0, 1, 30).end).toBe(30)
  })

  it('absorbs float error at the start boundary', () => {
    // 0.1 + 0.2 = 0.30000000000000004 → frame 3, not 4, at 10 fps
    expect(clipFrameRange(0.1 + 0.2, 1, 10).first).toBe(3)
  })

  it('clamps negative starts to frame 0', () => {
    expect(clipFrameRange(-1, 0.5, 30)).toEqual({ first: 0, end: 15 })
  })

  it('never returns end < first', () => {
    expect(clipFrameRange(2, 2, 30)).toEqual({ first: 60, end: 60 })
    expect(clipFrameRange(2, 1, 30)).toEqual({ first: 60, end: 60 })
  })
})

describe('firstSupported', () => {
  it('returns the first accepted candidate and stops probing', async () => {
    const tried: string[] = []
    const pick = await firstSupported(['a', 'b', 'c'], async (c) => {
      tried.push(c)
      return c === 'b'
    })
    expect(pick).toBe('b')
    expect(tried).toEqual(['a', 'b'])
  })

  it('returns null when nothing is supported', async () => {
    expect(await firstSupported(['a', 'b'], async () => false)).toBeNull()
  })

  it('prefers High L4.0 first, and carries higher levels for 1440p/4K', () => {
    expect(H264_CODECS[0]).toBe('avc1.640028') // High L4.0, ≤1080p
    expect(H264_CODECS).toContain('avc1.640033') // High L5.1 for 4K uploads
    expect(H264_CODECS.length).toBeGreaterThanOrEqual(4)
  })
})

// The SD golden-byte fence: the whole quality overhaul must be a NO-OP below HD,
// so an SD export emits the exact legacy config. These pure assertions guard that
// far more precisely than the pixel-tolerance e2e ever could.
describe('SD byte-stability gate', () => {
  it('coerces every quality knob to its legacy value below HD', () => {
    expect(effectiveRateControl({ rateControl: 'quantizer' }, false)).toBe('variable')
    expect(effectiveRateControl({ rateControl: 'constant' }, false)).toBe('variable')
    expect(effectiveVideoCodec({ videoCodec: 'hevc' }, false)).toBe('avc')
    expect(effectiveVideoCodec({ videoCodec: 'av1' }, false)).toBe('avc')
    expect(effectiveAudioBitrate({ audioBitrate: 320_000 }, false)).toBe(192_000)
  })

  it('honours the requested knobs at HD+', () => {
    expect(effectiveRateControl({ rateControl: 'quantizer' }, true)).toBe('quantizer')
    expect(effectiveVideoCodec({ videoCodec: 'hevc' }, true)).toBe('hevc')
    expect(effectiveAudioBitrate({ audioBitrate: 320_000 }, true)).toBe(320_000)
    // Absent → legacy defaults on both paths.
    expect(effectiveRateControl({}, true)).toBe('variable')
    expect(effectiveVideoCodec({}, true)).toBe('avc')
    expect(effectiveAudioBitrate({}, true)).toBe(192_000)
  })

  it('builds the SD config with NO bitrateMode key (byte-identical to legacy VBR)', () => {
    const config = videoEncoderConfig({
      codec: 'avc1.640028',
      accel: 'prefer-software',
      width: 640,
      height: 360,
      fps: 30,
      videoBitrate: 5_000_000,
      rateControl: 'variable',
      isHd: false,
    })
    // Deep-equal to exactly what the historical closure produced, key for key.
    expect(config).toEqual({
      codec: 'avc1.640028',
      width: 640,
      height: 360,
      framerate: 30,
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-software',
      bitrate: 5_000_000,
    })
    expect('bitrateMode' in config).toBe(false)
  })

  it('SD keyframe cadence stays fps×2 (keyframeIntervalS defaults to 2)', () => {
    expect(keyframeStride(30, undefined)).toBe(60)
    expect(isHdRaster(640, 360)).toBe(false)
    expect(isHdRaster(1280, 720)).toBe(true)
    expect(isHdRaster(1080, 1920)).toBe(true) // portrait short edge ≥720 via height
  })
})

describe('videoEncoderConfig', () => {
  const base = {
    codec: 'avc1.640028',
    accel: 'prefer-software' as const,
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrate: 24_000_000,
    isHd: true,
  }

  it('quantizer mode sets bitrateMode:quantizer and OMITS bitrate', () => {
    const c = videoEncoderConfig({ ...base, rateControl: 'quantizer' })
    expect(c.bitrateMode).toBe('quantizer')
    expect('bitrate' in c).toBe(false)
  })

  it('constant mode sets bitrateMode:constant + bitrate', () => {
    const c = videoEncoderConfig({ ...base, rateControl: 'constant' })
    expect(c.bitrateMode).toBe('constant')
    expect(c.bitrate).toBe(24_000_000)
  })

  it('variable mode emits bitrate but NEVER a bitrateMode key', () => {
    const c = videoEncoderConfig({ ...base, rateControl: 'variable' })
    expect(c.bitrate).toBe(24_000_000)
    expect('bitrateMode' in c).toBe(false)
  })

  it('keeps the legacy latencyMode rule: quality only on the software HD path', () => {
    expect(videoEncoderConfig({ ...base, rateControl: 'variable' }).latencyMode).toBe('quality')
    expect(videoEncoderConfig({ ...base, accel: 'prefer-hardware', rateControl: 'variable' }).latencyMode).toBe('realtime')
    expect(videoEncoderConfig({ ...base, isHd: false, rateControl: 'variable' }).latencyMode).toBe('realtime')
  })
})

describe('quantizerFor', () => {
  it('passes AVC/HEVC QP straight through (shared 0 to 51 scale)', () => {
    expect(quantizerFor('avc', 17)).toBe(17)
    expect(quantizerFor('hevc', 22)).toBe(22)
  })

  it('rescales the UI QP onto AV1 0 to 255', () => {
    expect(quantizerFor('av1', 0)).toBe(0)
    expect(quantizerFor('av1', 51)).toBe(255)
    expect(quantizerFor('av1', 17)).toBe(Math.round((17 / 51) * 255))
  })

  it('clamps out-of-range / non-finite input', () => {
    expect(quantizerFor('avc', -5)).toBe(0)
    expect(quantizerFor('avc', 99)).toBe(51)
    expect(quantizerFor('avc', NaN)).toBe(18)
  })
})

describe('videoCodecLadder', () => {
  it('returns the family ladder, lowest-level-first', () => {
    expect(videoCodecLadder('avc')).toBe(H264_CODECS)
    expect(videoCodecLadder('hevc')).toBe(HEVC_CODECS)
    expect(videoCodecLadder('av1')).toBe(AV1_CODECS)
    expect(HEVC_CODECS[0]).toContain('L120') // ≤1080p first
    expect(AV1_CODECS[0]).toContain('av01.0.08M') // level 4.0 first
  })
})

describe('export decode contract', () => {
  it('forces SOFTWARE video decode (hardware NVDEC tears inter-frame gameplay footage)', () => {
    // Regression guard for the torn-export bug: real long-GOP OBS footage
    // decoded via the hardware decoder mis-reconstructs high-motion P/B blocks.
    expect(EXPORT_DECODER_OPTIONS.hardwareAcceleration).toBe('prefer-software')
  })
})
