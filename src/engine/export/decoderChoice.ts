// Which video decoder the export asks for, per file.
//
// ⛔ SOFTWARE FIRST, BUT NOT SOFTWARE ONLY. EXPORT_DECODER_OPTIONS asks for
// software decode because hardware NVDEC tore his long GOP OBS footage (see
// messages.ts). But Chromium has NO software decoder for HEVC at all, so for an
// HEVC file (his OBS HEVC Main 10 recordings) "prefer-software" is a config the
// browser cannot build, and VideoDecoder.configure throws. His export died on
// 2026-09-28 with exactly that: "Native export failed while rendering video:
// Unsupported configuration. Check isConfigSupported() prior to calling
// configure()." A file that only a hardware decoder can open gets the hardware
// decoder, the same one his preview already plays it with. Every other file
// keeps software decode exactly as before.

import { EXPORT_DECODER_OPTIONS } from './messages'

export type ExportDecoderOptions = { hardwareAcceleration: HardwareAcceleration }

/** Ask the browser whether it can decode `config` with this preference. */
export type ConfigCheck = (config: VideoDecoderConfig) => Promise<boolean>

const HARDWARE_OK: ExportDecoderOptions = { hardwareAcceleration: 'no-preference' }

/**
 * Software when the browser has it for this file, else whatever decoder it has.
 * A file no decoder can open keeps the software ask, so the error it throws
 * later still names the real problem.
 */
export async function pickDecoderOptions(
  config: VideoDecoderConfig | null,
  isSupported: ConfigCheck,
): Promise<ExportDecoderOptions> {
  if (!config) return EXPORT_DECODER_OPTIONS
  try {
    if (await isSupported({ ...config, ...EXPORT_DECODER_OPTIONS })) return EXPORT_DECODER_OPTIONS
    if (await isSupported({ ...config, ...HARDWARE_OK })) return HARDWARE_OK
  } catch {
    // A check that throws says nothing about the file. Keep the old behaviour.
  }
  return EXPORT_DECODER_OPTIONS
}

/** The real check, against this browser's WebCodecs. */
export const browserConfigCheck: ConfigCheck = async (config) =>
  (await VideoDecoder.isConfigSupported(config)).supported === true
