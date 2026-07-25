import { useEffect, useRef, useState } from 'react'
import { getAssetPeaks, slicePeaks } from '../engine/waveform'
import type { Clip, MediaAsset } from '../engine/types'

/**
 * Center-mirrored waveform for an audio clip, drawn from the asset's cached
 * peaks over the clip's trimmed window. Pointer-transparent so the clip's own
 * drag/trim/context handlers still fire. Redraws on resize/trim; the peaks load
 * async (once per asset) so it shows nothing until the audio has decoded.
 */
export function ClipWaveform({
  clip,
  asset,
  width,
  height,
}: {
  clip: Clip
  asset: MediaAsset
  width: number
  height: number
}) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    void getAssetPeaks(asset).then((p) => {
      if (alive) setPeaks(p)
    })
    return () => {
      alive = false
    }
  }, [asset])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks || asset.durationS <= 0 || width < 2 || height < 2) return
    const dpr = window.devicePixelRatio || 1
    const cols = Math.max(1, Math.round(width))
    const pw = Math.max(1, Math.round(width * dpr))
    const ph = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== pw) canvas.width = pw
    if (canvas.height !== ph) canvas.height = ph
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, pw, ph)
    ctx.fillStyle = 'rgba(233,245,255,0.62)'
    const sliced = slicePeaks(peaks, asset.durationS, clip.inS, clip.outS, cols)
    // slicePeaks always walks the source left-to-right; a reversed clip PLAYS it
    // the other way (engine/audio.ts reverseAboutContainer). Drawing the source
    // order put the picture out of step with the sound, so razoring on a visible
    // transient cut nowhere near it. Same step filmstrip.ts already does.
    if (clip.speed < 0) sliced.reverse()
    const mid = ph / 2
    const colW = pw / cols
    const maxHalf = Math.max(1, (ph - 2 * dpr) / 2)
    for (let x = 0; x < cols; x++) {
      // Center-mirrored bars with a visible baseline floor so quiet passages
      // still read as a thin line rather than vanishing.
      const half = Math.max(0.6 * dpr, sliced[x] * maxHalf)
      ctx.fillRect(x * colW, mid - half, Math.max(1, colW - 0.4 * dpr), half * 2)
    }
  }, [peaks, width, height, clip.inS, clip.outS, clip.speed, asset.durationS])

  return (
    <canvas
      ref={canvasRef}
      data-testid="clip-waveform"
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    />
  )
}
