import { Plus } from 'lucide-react'
import type { RefObject } from 'react'
import { addTrack } from '../engine/timeline'
import type { Track } from '../engine/types'
import { updateActiveSequence } from '../state/store'
import { ADD_TRACK_ROW_H, HEADERS_W, PHONE_HEADERS_W, RULER_H } from './timelineGeometry'
import { TrackHeader } from './TrackHeaderControls'
import { TrackPresetMenuButton } from './TrackPresetMenuButton'

/**
 * The column left of the lanes: a header per track, video on top (in the
 * lanes' order) and audio below, then the add-track row. Its vertical scroll
 * is driven by the lanes' onScroll through `columnRef`.
 */
export function TimelineTrackHeaders({
  columnRef,
  lanesRef,
  phone,
  vTracks,
  aTracks,
}: {
  columnRef: RefObject<HTMLDivElement>
  lanesRef: RefObject<HTMLDivElement | null>
  phone: boolean
  vTracks: Track[]
  aTracks: Track[]
}) {
  return (
    <div
      ref={columnRef}
      data-testid="track-headers"
      // One step up from the lanes, so the headers read as a column of
      // controls and the lanes as the surface the clips sit on (2026-09-20,
      // the dark theme pass: on the old ladder both were one sheet).
      className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-bg-elevated"
      // On a phone the column keeps only the track's name: the controls
      // would take half the screen from the clips.
      style={{ width: phone ? PHONE_HEADERS_W : HEADERS_W }}
      // The headers column is overflow-hidden (no scrollbar of its own) and is
      // kept in sync by the lanes' onScroll. But a wheel over the headers must
      // still scroll: forward it to the lanes, which mirrors back here. Without
      // this, scrolling only works with the cursor over the lanes - "can't
      // scroll on the left" once there are more tracks than fit.
      onWheel={(e) => {
        if (lanesRef.current) lanesRef.current.scrollTop += e.deltaY
      }}
    >
      <div className="shrink-0 border-b border-border" style={{ height: RULER_H }} />
      {vTracks.map((t) => (
        <TrackHeader key={t.id} track={t} />
      ))}
      <div className="h-[2px] shrink-0 bg-border-strong" />
      {aTracks.map((t) => (
        <TrackHeader key={t.id} track={t} />
      ))}
      {/* Blank space below the tracks: buttons to add a video or audio track.
          Fixed height, mirrored by a spacer in the lanes so the shared scroll
          can always bring these into view (see ADD_TRACK_ROW_H). */}
      <div
        className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-2"
        style={{ height: ADD_TRACK_ROW_H }}
      >
        <button
          type="button"
          data-testid="add-video-track"
          className="flex flex-1 items-center justify-center gap-1 rounded-[4px] border border-border py-1 text-[11px] font-medium text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary"
          onClick={() => updateActiveSequence('Add video track', (sq) => addTrack(sq, 'video'))}
          title="Add a video track"
        >
          <Plus size={12} strokeWidth={1.75} />
          Video
        </button>
        <button
          type="button"
          data-testid="add-audio-track"
          className="flex flex-1 items-center justify-center gap-1 rounded-[4px] border border-border py-1 text-[11px] font-medium text-text-secondary transition-colors duration-[120ms] hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary"
          onClick={() => updateActiveSequence('Add audio track', (sq) => addTrack(sq, 'audio'))}
          title="Add an audio track"
        >
          <Plus size={12} strokeWidth={1.75} />
          Audio
        </button>
        <TrackPresetMenuButton />
      </div>
    </div>
  )
}
