import { useEffect, useState } from 'react'

/**
 * The size the program canvas is shown at, in CSS pixels, kept current as the panel resizes or
 * the shape changes. The overlays that sit exactly over the picture (safe margins, the app
 * guides, the Before badge) size themselves to it.
 *
 * ResizeObserver, not a rAF poll: the canvas CSS size only changes on panel resize / format
 * switch, so polling it every frame was pure overhead. The size is read from the style the draw
 * loop sets, which is the letterboxed size the picture really has.
 */
export function useCanvasBox(canvas: HTMLCanvasElement | null): { w: number; h: number } | null {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const w = parseFloat(canvas.style.width) || 0
      const h = parseFloat(canvas.style.height) || 0
      setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [canvas])
  return box
}
