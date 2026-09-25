import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { clipEndS } from '../engine/timeline'
import { transitionMarkSpans } from '../engine/transitionMarks'
import type { Clip, Id, MediaAsset, Track } from '../engine/types'
import { setClipFade } from '../state/clipEdits'
import type { Tool } from '../state/store'
import { ClipView } from './ClipView'
import { laneHoverClass } from './timelineLanes'

/**
 * One track's lane: the clips inside the virtualization window, the drop
 * preview line, and the tint that says whether a cross-track move can land
 * here. The clip handlers must be stable (useStableCallback) or every
 * ClipView memo() is defeated.
 */
export function TimelineLane({
  track,
  tint,
  fps,
  assets,
  pxPerS,
  selection,
  tool,
  seenClipIds,
  winStartS,
  winEndS,
  hoverLane,
  dropPreview,
  silenced,
  onLanePointerDown,
  onClipPointerDown,
  onTrimPointerDown,
  onClipContextMenu,
  onFadePreview,
}: {
  track: Track
  /** The alternating lane wash. */
  tint: string
  fps: number
  assets: Record<Id, MediaAsset>
  pxPerS: number
  selection: Id[]
  tool: Tool
  /** Clip ids of the previous commit: a clip not in it is new and pops. */
  seenClipIds: Set<string>
  winStartS: number
  winEndS: number
  hoverLane: { trackId: Id; valid: boolean } | null
  dropPreview: { trackId: Id; tS: number } | null
  /** Muted, or another lane is soloed: drawn desaturated. */
  silenced: boolean
  onLanePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onClipPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => void
  onTrimPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip, edge: 'in' | 'out') => void
  onClipContextMenu: (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => void
  onFadePreview: (tip: { x: number; y: number; text: string } | null) => void
}) {
  const hovClass = laneHoverClass(hoverLane?.trackId === track.id ? hoverLane : null)
  return (
    <div
      className={`relative border-b border-border ${tint} ${hovClass} ${track.locked ? 'opacity-60' : ''}`}
      // ⛔ DESATURATE, NEVER FADE. Opacity is already spoken for twice on this
      // surface, by a locked lane just above and by a disabled clip inside, and
      // those two compound to about 0.24, at which point a third meaning is
      // indistinguishable from the other two. Draining the colour says "not
      // being heard" without touching the channel either of them uses, and it
      // leaves the clip's edges exactly as crisp for trimming.
      style={{ height: track.height, filter: silenced ? 'saturate(0.15)' : undefined }}
      onPointerDown={onLanePointerDown}
    >
      {track.clips.map((clip, i) => {
        if (clipEndS(clip) < winStartS || clip.startS > winEndS) return null
        // A transition belongs to the CUT, not to one clip, so its geometry
        // needs both neighbours. Resolved here and handed down as plain
        // numbers so ClipView's memo() keeps comparing by value.
        const marks = transitionMarkSpans(
          clip,
          track.clips[i - 1] as Clip | undefined,
          track.clips[i + 1] as Clip | undefined,
          fps,
        )
        return (
          <ClipView
            key={clip.id}
            clip={clip}
            asset={assets[clip.assetId]}
            trackKind={track.kind}
            trackHeight={track.height}
            pxPerS={pxPerS}
            selected={selection.includes(clip.id)}
            locked={track.locked}
            interactive={tool === 'select' && !track.locked}
            pop={!seenClipIds.has(clip.id)}
            transitionHeadS={marks.headS}
            transitionTailS={marks.tailS}
            onClipPointerDown={onClipPointerDown}
            onTrimPointerDown={onTrimPointerDown}
            onClipContextMenu={onClipContextMenu}
            onFadeCommit={setClipFade}
            onFadePreview={onFadePreview}
          />
        )
      })}
      {dropPreview?.trackId === track.id && (
        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-[2px] bg-accent"
          style={{ left: dropPreview.tS * pxPerS }}
        />
      )}
    </div>
  )
}
