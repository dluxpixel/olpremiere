// The TikTok / Reels guides, drawn over the preview: three tinted areas where the app covers the
// picture (engine/appGuides.ts has the numbers and where they came from). An overlay and nothing
// more: it ignores the pointer, sits over the canvas box like the safe margins do, and is never
// in the export.

import { appGuideRegions, type AppGuideApp } from '../engine/appGuides'
import { useCanvasBox } from './useCanvasBox'

interface Props {
  canvas: HTMLCanvasElement | null
  /** The sequence's own size, which the regions are worked out in. */
  width: number
  height: number
  app: AppGuideApp
}

export function AppGuidesOverlay({ canvas, width, height, app }: Props) {
  const box = useCanvasBox(canvas)
  const regions = appGuideRegions(width, height, app)
  if (!box || box.w === 0 || !regions) return null
  return (
    <div
      data-testid="app-guides"
      data-app={app}
      className="pointer-events-none absolute"
      style={{ width: box.w, height: box.h }}
    >
      {regions.map((r) => (
        <div
          key={r.key}
          data-testid={`app-guide-${r.key}`}
          className="absolute overflow-hidden border border-ember/50 bg-ember-quiet"
          style={{
            left: `${(r.x / width) * 100}%`,
            top: `${(r.y / height) * 100}%`,
            width: `${(r.w / width) * 100}%`,
            height: `${(r.h / height) * 100}%`,
          }}
        >
          <span
            className="block whitespace-nowrap px-1 py-0.5 text-[10px] leading-none text-ember"
            style={r.key === 'right' ? { writingMode: 'vertical-rl' } : undefined}
          >
            {r.label}
          </span>
        </div>
      ))}
    </div>
  )
}
