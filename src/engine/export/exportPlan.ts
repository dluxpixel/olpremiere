// What the app decides when you press Export.
//
// There is one button and no settings. Every dial the dialog used to offer is a
// rule here instead, computed from the sequence — so the answer is the same
// every time and there is nothing to get wrong. Pure: no React, no DOM, no
// store, so it is unit-testable and both start paths read the same plan.
//
// The choices, and why each one is the best available rather than merely a
// default:
//   QUALITY   constant-quality (QP 14) — the only mode whose picture does not
//             degrade with content. A bitrate target is either wasteful on a
//             static shot or starving on a busy one. 14 is visually lossless;
//             below it the file grows for something no eye resolves.
//   CODEC     H.264. At constant quality the codec changes file SIZE, not
//             picture; H.264 is the one family every player, phone, NLE and
//             upload pipeline accepts. HEVC in MP4 is hardware-gated in Chrome.
//   RASTER    the sequence's own size, raised one tier to the 1440p box when
//             the timeline is HD or better. Uploading above 1080p escapes
//             YouTube's bitrate-starved 1080p tier and comes back visibly
//             cleaner. SD footage is NOT upscaled — interpolating 360p to 1440p
//             adds no detail, only minutes of encoding.
//   FPS       the sequence's own rate. Every other value throws frames away.
//   AUDIO     AAC 320 kbps — transparent, and universally playable.
//   RANGE     the work area when in/out points are set, the whole sequence
//             otherwise. Marking I/O already said which part you meant.

import { losslessBitrate } from './bitrate'
import type { ExportSettings } from './index'
import type { NativeEncoder } from '../../../electron/ipc-types'
import type { Sequence } from '../types'
import { workArea } from '../workArea'

/**
 * Constant-quality target (H.264/HEVC QP scale, lower = better). Visually
 * lossless: this is the value the shipped "Highest" preset already used, and
 * the level the desktop pipeline's `-crf` runs at.
 */
export const EXPORT_QP = 14

/** AAC at 320 kbps is transparent, and matches what the desktop ffmpeg emits. */
export const EXPORT_AUDIO_BITRATE = 320_000

/** Two seconds is the GOP length every upload platform expects. */
export const EXPORT_KEYFRAME_S = 2

/** x264 veryslow: the best quality-per-bit of any encoder we bundle. */
export const EXPORT_NATIVE_ENCODER: NativeEncoder = 'x264'

/** Only sequences at least this tall (in their short dimension) are upscaled. */
const UPSCALE_FLOOR_PX = 720

/** The upload-tier box the raster is raised into, as [long side, short side]. */
const UPSCALE_BOX: [number, number] = [2560, 1440]

/** An upscale has to be worth it — under 2% bigger is noise. */
const UPSCALE_MIN_GAIN = 1.02

/**
 * Largest even-dimension box that fits seq within (boxW×boxH), keeping aspect.
 * With `allowUpscale`, seq may be scaled UP to fill the box; otherwise it only
 * ever scales down. Even dimensions are a hard requirement of yuv420p.
 */
function evenFit(
  seqW: number,
  seqH: number,
  boxW: number,
  boxH: number,
  allowUpscale = false,
): { width: number; height: number } {
  const fit = Math.min(boxW / seqW, boxH / seqH)
  const s = allowUpscale ? fit : Math.min(1, fit)
  return {
    width: Math.max(2, Math.round((seqW * s) / 2) * 2),
    height: Math.max(2, Math.round((seqH * s) / 2) * 2),
  }
}

/**
 * The resolution to export at. The sequence's own size, except that an HD-or-
 * better timeline is raised into the 1440p box: uploading one tier above 1080p
 * is the well-documented way to escape YouTube's bitrate-starved 1080p tier,
 * and it preserves the sequence aspect, so a 9:16 Short exports 1440×2560 and
 * never a stretched landscape frame.
 *
 * Sequences below HD keep their own size — upscaling 360p invents no detail and
 * would multiply the encode time for a worse-looking result.
 */
export function exportRaster(seqW: number, seqH: number): { width: number; height: number } {
  const native = evenFit(seqW, seqH, seqW, seqH)
  if (Math.min(seqW, seqH) < UPSCALE_FLOOR_PX) return native

  const portrait = seqH > seqW
  const [boxW, boxH] = portrait ? [UPSCALE_BOX[1], UPSCALE_BOX[0]] : UPSCALE_BOX
  const raised = evenFit(seqW, seqH, boxW, boxH, true)
  const gain = (raised.width * raised.height) / (native.width * native.height)
  return gain > UPSCALE_MIN_GAIN ? raised : native
}

export interface ExportPlan {
  settings: ExportSettings
  /** Desktop only: which bundled ffmpeg encoder renders the file. */
  nativeEncoder: NativeEncoder
  /** Desktop only: the container extension that encoder writes. */
  nativeExt: string
  /** Constant-quality target, shared by both pipelines. */
  qp: number
  /** True when in/out points narrowed the export to part of the timeline. */
  usingWorkArea: boolean
}

/** Everything the export needs, decided. */
export function planExport(seq: Sequence): ExportPlan {
  const raster = exportRaster(seq.width, seq.height)
  const area = workArea(seq)
  const fps = seq.fps

  return {
    settings: {
      width: raster.width,
      height: raster.height,
      fps,
      // Constant quality is the rate control; this bitrate is only the encoder's
      // fallback if it rejects or ignores QP (the worker drops to VBR at exactly
      // this rate), and the primary rate on an SD raster, where the engine
      // deliberately keeps the classic VBR path.
      videoBitrate: losslessBitrate(raster.width, raster.height, fps),
      startS: area.startS,
      endS: area.endS,
      rateControl: 'quantizer',
      quantizer: EXPORT_QP,
      videoCodec: 'avc',
      keyframeIntervalS: EXPORT_KEYFRAME_S,
      audioBitrate: EXPORT_AUDIO_BITRATE,
      audioCodecPref: 'aac',
      // Constant quality is only honoured reliably by the software encoder, and
      // the worker pins software for it anyway — asking for it here keeps the
      // encoder in its high-quality latency mode on the VBR fallback too.
      hardwareAcceleration: 'prefer-software',
    },
    nativeEncoder: EXPORT_NATIVE_ENCODER,
    nativeExt: 'mp4',
    qp: EXPORT_QP,
    usingWorkArea: area.active,
  }
}
