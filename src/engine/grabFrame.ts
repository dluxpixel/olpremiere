// A still of the sequence, at the sequence's own size, through the renderer the
// export uses. Not a copy of the monitor canvas.
//
// ⛔ THE MONITOR CANVAS IS NOT THE PICTURE. It is fitted to the panel and to the
// preview tier, so on a 1080x1920 short it is routinely 400 pixels wide, and at
// Half or Quarter it is smaller again. Reading it back and calling the result a
// screenshot would hand him a soft, panel-sized image whose size changes with
// how wide he happened to leave the panel. A preview pixel cannot speak for the
// exported one, and it cannot speak for a still either.
//
// So the grab renders its own frame at seq.width x seq.height, waits for every
// layer to actually resolve, and reads THAT back.

import { currentPreviewScale, setPreviewScale } from './frameCache'
import { renderPreview } from './preview'
import type { Id, MediaAsset, Sequence } from './types'

/** How long to wait for every layer to decode before taking what we have. */
const GRAB_TIMEOUT_MS = 6000
/** Gap between attempts. Long enough for a decode to land, short enough to feel instant. */
const GRAB_POLL_MS = 60

// ONE canvas for the life of the session, reused. A fresh canvas per screenshot
// is a fresh WebGL2 context per screenshot, and a browser hands out about
// sixteen before it starts killing the oldest, which is the context the monitor
// is drawing into. Ten screenshots would have blanked his preview.
let grabCanvas: HTMLCanvasElement | null = null

function canvasFor(w: number, h: number): HTMLCanvasElement {
  if (!grabCanvas) grabCanvas = document.createElement('canvas')
  if (grabCanvas.width !== w) grabCanvas.width = w
  if (grabCanvas.height !== h) grabCanvas.height = h
  return grabCanvas
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface Grab {
  blob: Blob
  width: number
  height: number
  /**
   * Every layer resolved to a real texture. False means a decode never landed
   * inside the timeout, so the still is missing something that is in the
   * sequence, and the caller should say so rather than pass it off as the frame.
   */
  complete: boolean
}

/**
 * Render `seq` at `tS` at full size and hand back a PNG.
 *
 * `tS` is the RAW playhead, not a quantized one: the monitor draws at the raw
 * value, and a still that lands on a different frame from the one he is looking
 * at is the wrong still however defensible the rounding.
 */
export async function grabFrame(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  tS: number,
): Promise<Grab | null> {
  const width = Math.max(2, Math.round(seq.width))
  const height = Math.max(2, Math.round(seq.height))
  const canvas = canvasFor(width, height)

  // Half and Quarter decode SMALL, and a small decode stretched up to 1080 wide
  // is exactly the soft picture this function exists to avoid. Lift to Full for
  // the grab, put his tier back after. Each change costs a frame-cache flush,
  // which is why it only happens when he is not already on Full.
  const tier = currentPreviewScale()
  const lifted = tier < 1
  if (lifted) setPreviewScale(1)

  try {
    const deadline = Date.now() + GRAB_TIMEOUT_MS
    let complete = false
    // renderPreview reports whether every layer resolved this frame. False means
    // something was still decoding, and a still of a half-decoded frame is a
    // still of the wrong picture, so keep drawing until it lands.
    for (;;) {
      complete = renderPreview(canvas, seq, assets, tS, false)
      if (complete || Date.now() >= deadline) break
      await wait(GRAB_POLL_MS)
    }
    // The preview context is created with preserveDrawingBuffer, so the last
    // drawn frame is still there to be read.
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return null
    return { blob, width, height, complete }
  } finally {
    if (lifted) setPreviewScale(tier)
  }
}
