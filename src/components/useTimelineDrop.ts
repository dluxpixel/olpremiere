import { useState, type DragEvent, type MutableRefObject } from 'react'
import { addClipFromAsset, addClipWithLinkedAudio } from '../engine/timeline'
import { audioTracks, type Id, type MediaAsset, type Sequence, type Track } from '../engine/types'
import { ASSET_MIME, LIBRARY_MIME, SFX_MIME, TITLE_MIME, dragHasType } from '../state/dnd'
import { addLibraryItemToTimeline, useLibrary } from '../state/library'
import { insertSfxAtPlayhead } from '../state/sfxActions'
import { updateActiveSequence, useStore } from '../state/store'
import { addTitleFromShelf } from '../state/titleActions'
import { useToasts } from '../state/toasts'
import { assetDropTrack, dropKinds, laneTakesDrop, sfxDropTrack, snappedDropTime } from './timelineDrop'
import { frameAtOffset } from './timelineZoom'

type Pointer = { clientX: number; clientY: number }

/** What the lanes hand the drop handlers: the geometry and the edge scroll they share with pointer drags. */
export interface TimelineDropContext {
  seq: Sequence
  assets: Record<Id, MediaAsset>
  pxPerS: number
  snapping: boolean
  contentPoint: (e: Pointer) => { x: number; y: number }
  laneAt: (y: number) => Track | null
  /** Snap a time and draw (or clear) the snap line for it. */
  snapWithIndicator: (tS: number) => number
  setSnapIndicatorT: (t: number | null) => void
  lastDragPointer: MutableRefObject<Pointer | null>
  maybeEdgeScroll: (onStep: (p: Pointer) => void) => void
  stopEdgeScroll: () => void
  /** What the edge-scroll loop re-runs each frame (the lanes' pointermove). */
  onEdgeStep: (p: Pointer) => void
}

/**
 * Drops from the media bin, the Library, the sound shelf and the title shelf
 * onto the lanes: the preview line while hovering, and the one edit on release.
 */
export function useTimelineDrop({
  seq,
  assets,
  pxPerS,
  snapping,
  contentPoint,
  laneAt,
  snapWithIndicator,
  setSnapIndicatorT,
  lastDragPointer,
  maybeEdgeScroll,
  stopEdgeScroll,
  onEdgeStep,
}: TimelineDropContext): {
  dropPreview: { trackId: Id; tS: number } | null
  setDropPreview: (p: { trackId: Id; tS: number } | null) => void
  handleDragOver: (e: DragEvent<HTMLDivElement>) => void
  handleDrop: (e: DragEvent<HTMLDivElement>) => void
} {
  const show = useToasts((s) => s.show)
  const [dropPreview, setDropPreview] = useState<{ trackId: Id; tS: number } | null>(null)

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    const { isAsset, isSfx, isTitle } = dropKinds(e.dataTransfer.types)
    // A Library item hovers exactly like bin media: any lane shows the line,
    // and the drop picks the right kind of lane for it.
    const isLibrary = dragHasType(e.dataTransfer.types, LIBRARY_MIME)
    if (!isAsset && !isSfx && !isTitle && !isLibrary) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    // Bin drags edge-scroll too (the loop only scrolls here - the preview line
    // is content-anchored, and dragover re-fires on the next mouse move).
    lastDragPointer.current = { clientX: e.clientX, clientY: e.clientY }
    maybeEdgeScroll(onEdgeStep)
    const { x, y } = contentPoint(e)
    const lane = laneAt(y)
    if (!laneTakesDrop(lane, isSfx, isTitle)) {
      setDropPreview(null)
      return
    }
    const t = snapWithIndicator(frameAtOffset(x, pxPerS, seq.fps))
    setDropPreview({ trackId: lane.id, tS: t })
  }

  const dropTimeAt = (x: number): number =>
    snappedDropTime(frameAtOffset(x, pxPerS, seq.fps), seq, snapping, useStore.getState().ui.playheadS, pxPerS)

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    const sfxId = e.dataTransfer.getData(SFX_MIME)
    const assetId = e.dataTransfer.getData(ASSET_MIME)
    const lookId = e.dataTransfer.getData(TITLE_MIME)
    const libraryId = e.dataTransfer.getData(LIBRARY_MIME)
    stopEdgeScroll()
    lastDragPointer.current = null
    setDropPreview(null)
    setSnapIndicatorT(null)
    // A shelf title lands at the drop time, on the track every title goes to.
    if (lookId) {
      e.preventDefault()
      const { x } = contentPoint(e)
      addTitleFromShelf(lookId, dropTimeAt(x))
      return
    }
    // A dragged SFX lands on the hovered audio lane at the drop time.
    if (sfxId) {
      e.preventDefault()
      const { x, y } = contentPoint(e)
      const lane = laneAt(y)
      const target = sfxDropTrack(lane, seq)
      const t = dropTimeAt(x)
      void insertSfxAtPlayhead(sfxId, { atS: t, ...(target ? { trackId: target.id } : {}) })
      return
    }
    // A Library item lands where it was aimed, the same way bin media does. The
    // time and lane are read NOW, while the drop is still readable; the copy
    // into the project happens after.
    if (libraryId) {
      e.preventDefault()
      const item = useLibrary.getState().items.find((i) => i.id === libraryId)
      if (!item) return
      const wantKind = item.kind === 'audio' ? 'audio' : 'video'
      const { x, y } = contentPoint(e)
      const target = assetDropTrack(laneAt(y), seq, wantKind)
      if (!target) {
        show(`No unlocked ${wantKind} track for ${item.name}`, 'danger')
        return
      }
      void addLibraryItemToTimeline(item.id, { atS: dropTimeAt(x), trackId: target.id, exact: true })
      return
    }
    if (!assetId) return
    e.preventDefault()
    const asset = assets[assetId]
    if (!asset) return
    const wantKind = asset.kind === 'audio' ? 'audio' : 'video'
    const { x, y } = contentPoint(e)
    const hovered = laneAt(y)
    const target = assetDropTrack(hovered, seq, wantKind)
    if (!target) {
      show(`No unlocked ${wantKind} track for ${asset.name}`, 'danger')
      return
    }
    const t = dropTimeAt(x)
    // Dropping a video with audio splits its sound to a linked audio clip on A1.
    if (asset.kind === 'video' && asset.hasAudio) {
      const audioTrack = audioTracks(seq).find((tr) => !tr.locked) ?? null
      // Exactly when he dropped it, and never on top of anything: a lane that is
      // taken there passes it to the next free line (his pick, 2026-09-28: a
      // finished recording dropped on V4 used to delete what V4 had under it).
      updateActiveSequence(`Add ${asset.name}`, (sq) =>
        addClipWithLinkedAudio(sq, target.id, audioTrack?.id ?? null, asset, t, { exact: true }).seq,
      )
      return
    }
    updateActiveSequence(`Add ${asset.name}`, (sq) =>
      addClipFromAsset(sq, target.id, asset, t, { exact: true }).seq,
    )
  }

  return { dropPreview, setDropPreview, handleDragOver, handleDrop }
}
