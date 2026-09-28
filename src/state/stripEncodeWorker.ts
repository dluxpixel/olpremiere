// JPEG-encodes a finished filmstrip off the main thread. See filmstrips.ts.

self.onmessage = async (e: MessageEvent<{ id: number; bitmap: ImageBitmap }>) => {
  const { id, bitmap } = e.data
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('bitmaprenderer')
    if (!ctx) throw new Error('no bitmaprenderer')
    ctx.transferFromImageBitmap(bitmap)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 })
    ;(self as unknown as Worker).postMessage({ id, blob })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
