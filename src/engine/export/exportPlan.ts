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
//             EXCEPT below HD, where the browser pipeline deliberately keeps the
//             legacy VBR path and 192 kbps audio so the golden 640×360 export
//             stays byte-stable — that gate is worth more than constant quality
//             on a raster nothing real is authored at. The plan SAYS so rather
//             than claiming a quality the worker would quietly override; the
//             mismatch was the actual defect, not the fence.
//   CODEC     H.264. At constant quality the codec changes file SIZE, not
//             picture; H.264 is the one family every player, phone, NLE and
//             upload pipeline accepts. HEVC in MP4 is hardware-gated in Chrome.
//   RASTER    the sequence's own size, raised one tier to the 1440p box when
//             the timeline is HD or better. Uploading above 1080p escapes
//             YouTube's bitrate-starved 1080p tier and comes back visibly
//             cleaner. SD footage is NOT upscaled — interpolating 360p to 1440p
//             adds no detail, only minutes of encoding.
//   FPS       the sequence's own rate. Every other value throws frames away.
//   AUDIO     AAC 320 kbps — transparent, and universally playable (192 kbps
//             below HD, same byte-stability reason as QUALITY).
//   RANGE     the work area when in/out points are set, the whole sequence
//             otherwise. Marking I/O already said which part you meant.

import { losslessBitrate } from './bitrate'
import { isHdRaster } from './messages'
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

/** What a sub-HD raster actually gets: the legacy rate the golden export pins. */
export const SD_AUDIO_BITRATE = 192_000

/** Two seconds is the GOP length every upload platform expects. */
export const EXPORT_KEYFRAME_S = 2

/** x264 veryslow: the best quality-per-bit of any encoder we bundle. */
export const EXPORT_NATIVE_ENCODER: NativeEncoder = 'x264'

/**
 * Largest even-dimension box that fits seq within (boxW×boxH), keeping aspect,
 * and never scaling UP. Even dimensions are a hard requirement of yuv420p.
 */
function evenFit(seqW: number, seqH: number, boxW: number, boxH: number): { width: number; height: number } {
  const s = Math.min(1, Math.min(boxW / seqW, boxH / seqH))
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
  // NEVER UPSCALE. Removed 2026-07-26 on David's verdict, after comparing his own
  // source against his own export.
  //
  // The old rule raised any HD-or-better timeline into a 1440p box, on the theory
  // that uploading above 1080p escapes YouTube's bitrate-starved 1080p tier. The
  // theory is real but it was applied blind, and on the actual work it cost
  // picture quality instead of buying it:
  //
  //   his source     1920x1080
  //   his sequence   1080x1920 (vertical) -> landscape footage is already scaled
  //                  UP 1.78x just to fill the tall frame
  //   old export     1440x2560            -> scaled up a FURTHER 1.33x
  //   net effect     every real pixel smeared across ~2.37 pixels
  //
  // There is no detail in those extra pixels. Interpolation cannot invent any, so
  // the upscale magnifies whatever compression the source already had — and then
  // spends a third of the bitrate describing invented pixels instead of real
  // ones. Exporting at the timeline's own size is sharper AND smaller.
  //
  // If the upload-tier trick is ever wanted again it belongs behind a choice the
  // user makes about a specific upload, not as a silent default that degrades
  // every export. Do not reinstate it without comparing real frames first.
  return evenFit(seqW, seqH, seqW, seqH)
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
  // Below HD the browser worker coerces rate control to VBR and audio to
  // 192 kbps no matter what it is handed, to keep the golden 640×360 export
  // byte-stable. The plan asks for what it will actually GET: this changes not
  // one byte of any export, it stops the plan describing a file the app was
  // never going to write. A plan that lies is worse than a plan that limits.
  const hd = isHdRaster(raster.width, raster.height)

  return {
    settings: {
      width: raster.width,
      height: raster.height,
      fps,
      // Constant quality is the rate control; this bitrate is only the encoder's
      // fallback if it rejects or ignores QP (the worker drops to VBR at exactly
      // this rate), and the primary rate on an SD raster.
      videoBitrate: losslessBitrate(raster.width, raster.height, fps),
      startS: area.startS,
      endS: area.endS,
      rateControl: hd ? 'quantizer' : 'variable',
      quantizer: EXPORT_QP,
      videoCodec: 'avc',
      keyframeIntervalS: EXPORT_KEYFRAME_S,
      audioBitrate: hd ? EXPORT_AUDIO_BITRATE : SD_AUDIO_BITRATE,
      audioCodecPref: 'aac',
      // Hardware first, with the software retry the caller keeps for the GPU
      // B-frame crash. Constant quality pins software inside the worker anyway;
      // asking for software HERE inverted that retry, so a crash would have
      // escalated INTO the encoder the retry exists to escape.
      hardwareAcceleration: 'prefer-hardware',
    },
    nativeEncoder: EXPORT_NATIVE_ENCODER,
    nativeExt: 'mp4',
    qp: EXPORT_QP,
    usingWorkArea: area.active,
  }
}
