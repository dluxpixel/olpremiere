import { describe, expect, it } from 'vitest'
import { pickDecoderOptions, type ConfigCheck } from './decoderChoice'
import { EXPORT_DECODER_OPTIONS } from './messages'

// His export died 2026-09-28: "Unsupported configuration. Check
// isConfigSupported() prior to calling configure()". Chromium has no software
// HEVC decoder, and the export asked for software on every file.
const HEVC: VideoDecoderConfig = { codec: 'hvc1.2.4.L153.B0', codedWidth: 1920, codedHeight: 1080 }
const AVC: VideoDecoderConfig = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 }

/** Like Chromium on Windows: H.264 in software and hardware, HEVC in hardware only. */
const chromium: ConfigCheck = async (c) =>
  c.codec.startsWith('avc1') || (c.codec.startsWith('hvc1') && c.hardwareAcceleration !== 'prefer-software')

describe('pickDecoderOptions', () => {
  it('keeps software decode for a file software can open (the NVDEC tearing fix stays)', async () => {
    expect(await pickDecoderOptions(AVC, chromium)).toEqual(EXPORT_DECODER_OPTIONS)
  })

  it('takes the hardware decoder for HEVC, which has no software decoder', async () => {
    expect(await pickDecoderOptions(HEVC, chromium)).toEqual({ hardwareAcceleration: 'no-preference' })
  })

  it('keeps the software ask when nothing can open it, so the error names the file', async () => {
    expect(await pickDecoderOptions(HEVC, async () => false)).toEqual(EXPORT_DECODER_OPTIONS)
  })

  it('keeps the software ask when the check itself throws or there is no config', async () => {
    expect(
      await pickDecoderOptions(AVC, async () => {
        throw new Error('no WebCodecs')
      }),
    ).toEqual(EXPORT_DECODER_OPTIONS)
    expect(await pickDecoderOptions(null, chromium)).toEqual(EXPORT_DECODER_OPTIONS)
  })
})
