// The TikTok / Reels guides, drawn over the preview: three tinted areas where the app covers the
// picture (engine/appGuides.ts has the numbers and where they came from). An overlay and nothing
// more: it ignores the pointer, sits over the canvas box like the safe margins do, and is never
// in the export.
//
// In TikTok text mode a region turns to the danger colour while the selected title overlaps it, at
// rest and while it is dragged. The gizmo already knows where the title is, so it publishes which
// regions are hit (GuideHitsPublisher) and this reads them; nothing here touches the playhead.

import { useEffect } from 'react'
import { create } from 'zustand'
import { appGuideRegions, effectiveAppGuides, type AppGuideApp, type GuideRegion } from '../engine/appGuides'
import { useSettings } from '../state/settings'
import { useCanvasBox } from './useCanvasBox'

type GuideKey = GuideRegion['key']

/** The guide regions the selected title overlaps right now. Local UI state: nothing is saved with the project. */
export const useGuideHits = create<{ hits: readonly GuideKey[] }>(() => ({ hits: [] }))

/**
 * Mounted by the gizmo while it has a title to report on: puts `hits` where the overlay reads them
 * and takes them away again on the way out, so a tint never outlives the title or the gizmo.
 */
export function GuideHitsPublisher({ hits }: { hits: readonly GuideKey[] }) {
  const key = hits.join(',')
  useEffect(() => {
    useGuideHits.setState({ hits: key === '' ? [] : (key.split(',') as GuideKey[]) })
  }, [key])
  useEffect(() => () => useGuideHits.setState({ hits: [] }), [])
  return null
}

interface Props {
  canvas: HTMLCanvasElement | null
  /** The sequence's own size, which the regions are worked out in. */
  width: number
  height: number
  app: AppGuideApp
  /** Regions to tint with the danger colour, because the selected title overlaps them. */
  hits?: readonly GuideKey[]
}

/**
 * The guides as the monitor shows them: his own choice, or TikTok text mode, whichever asks (his
 * saved choice is read and never written), and for TikTok while the mode is on.
 */
export function ProgramAppGuides({ canvas, width, height }: Omit<Props, 'app' | 'hits'>) {
  const appGuides = useSettings((s) => s.appGuides)
  const appGuidesApp = useSettings((s) => s.appGuidesApp)
  const tiktokMode = useSettings((s) => s.tiktokMode)
  const hits = useGuideHits((s) => s.hits)
  const { show, app } = effectiveAppGuides(appGuides, appGuidesApp, tiktokMode)
  if (!show) return null
  return <AppGuidesOverlay canvas={canvas} width={width} height={height} app={app} hits={tiktokMode ? hits : undefined} />
}

export function AppGuidesOverlay({ canvas, width, height, app, hits }: Props) {
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
      {regions.map((r) => {
        const hit = hits?.includes(r.key) === true
        return (
          <div
            key={r.key}
            data-testid={`app-guide-${r.key}`}
            data-hit={hit ? 'true' : undefined}
            className={`absolute overflow-hidden border ${hit ? 'border-danger/70 bg-danger/25' : 'border-ember/50 bg-ember-quiet'}`}
            style={{
              left: `${(r.x / width) * 100}%`,
              top: `${(r.y / height) * 100}%`,
              width: `${(r.w / width) * 100}%`,
              height: `${(r.h / height) * 100}%`,
            }}
          >
            <span
              className={`block whitespace-nowrap px-1 py-0.5 text-[10px] leading-none ${hit ? 'text-danger' : 'text-ember'}`}
              style={r.key === 'right' ? { writingMode: 'vertical-rl' } : undefined}
            >
              {r.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
