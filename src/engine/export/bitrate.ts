// Near-lossless ("1:1 to source") H.264 target bitrate for the Maximum export
// quality. Kept pure + separate from the dialog so it is unit-tested directly.

/**
 * A visually-lossless H.264 target for a raster, in bits/second: ~0.5 bits per
 * pixel per frame, which is indistinguishable from the source for typical
 * footage. Floored so it is never below the High preset (24 Mbps) and ceiled so
 * a 4K / high-fps timeline can't ask for a rate the encoder won't honour.
 */
export function losslessBitrate(width: number, height: number, fps: number): number {
  const BITS_PER_PIXEL = 0.5
  const raw = Math.round(width * height * Math.max(1, fps) * BITS_PER_PIXEL)
  return Math.min(150_000_000, Math.max(24_000_000, raw))
}

/**
 * A YouTube-tuned upload bitrate: roughly DOUBLE YouTube's own recommended SDR
 * upload numbers, so their re-encode (VP9/AV1) has clean headroom and the result
 * isn't mushy. ~0.28 bits/pixel/frame lands near 2× their table across
 * resolutions — e.g. 1080p30 ≈ 17 Mbps (their rec is 8), 1440p30 ≈ 31 Mbps
 * (16), 2160p30 ≈ 70 Mbps (35–45). A browser export is IPPP (no B-frames), so
 * the extra bitrate also offsets that ~5–10% efficiency gap. The floor scales
 * with the raster (2 Mbps minimum — a flat 12 Mbps floor made an SD export
 * larger than the explicit Low preset); ceiled so 8K/high-fps stays sane.
 */
export function youtubeBitrate(width: number, height: number, fps: number): number {
  const BITS_PER_PIXEL = 0.28
  const raw = Math.round(width * height * Math.max(1, fps) * BITS_PER_PIXEL)
  return Math.min(120_000_000, Math.max(2_000_000, raw))
}
