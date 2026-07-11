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
