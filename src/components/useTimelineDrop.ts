import { useEffect, useRef, useState, type DragEvent, type MutableRefObject } from 'react'
import { sfxAssetName, sfxById } from '../engine/sfx/sfx'
import type { Id, MediaAsset, Sequence, Track } from '../engine/types'
import {
  ASSET_MIME,
  LIBRARY_MIME,
  SFX_MIME,
  TITLE_MIME,
  clearDragRecord,
  dragHasType,
  getDragRecord,
  type DragRecord,
} from '../state/dnd'
import { addLibraryItemToTimeline, useLibrary } from '../state/library'
import { insertSfxAtPlayhead } from '../state/sfxActions'
import { updateActiveSequence, useStore } from '../state/store'
import { addTitleFromShelf } from '../state/titleActions'
import { titleLookById } from '../state/titleShelf'
import { useToasts } from '../state/toasts'
import {
  assetDropGhosts,
  assetDropTrack,
  dropKinds,
  insertDroppedAsset,
  laneTakesDrop,
  sfxDropGhosts,
  sfxDropTrack,
  snappedDropTime,
  titleDropGhosts,
  type DropGhost,
  type DropPreview,
} from './timelineDrop'
import { frameAtOffset } from './timelineZoom'

type Pointer = { clientX: number; clientY: number }

/** No ghost: the plain line only. A shared array so an unchanged preview stays the same object. */
const NO_GHOSTS: DropGhost[] = []

/** What the drag carries, read off its types. */
interface DragFlags {
  isAsset: boolean
  isSfx: boolean
  isTitle: boolean
  isLibrary: boolean
}

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
 * onto the lanes: the ghost clip (and the line at its start) while hovering,
 * and the one edit on release.
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
  dropPreview: DropPreview | null
  setDropPreview: (p: DropPreview | null) => void
  handleDragOver: (e: DragEvent<HTMLDivElement>) => void
  handleDragLeave: (e: DragEvent<HTMLDivElement>) => void
  handleDrop: (e: DragEvent<HTMLDivElement>) => void
} {
  const show = useToasts((s) => s.show)
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null)
  /** The last ghosts worked out, and what they were worked out from: see ghostsFor. */
  const ghostCache = useRef<{ key: string; seq: Sequence; assets: Record<Id, MediaAsset>; ghosts: DropGhost[] } | null>(
    null,
  )

  /**
   * A drag from the bins that ends without a drop here.
   *
   * ⛔ THE EDGE SCROLL STOPS WITH IT. A hover near a side of the lanes starts the
   * scroll loop, and only the drop used to stop it: a drag that left the lanes
   * (back to the bin, or Esc) left the timeline running by itself to the start
   * or the end of the edit, and the next pointer drag inherited the stale step.
   */
  const endHover = () => {
    stopEdgeScroll()
    lastDragPointer.current = null
    setDropPreview(null)
    setSnapIndicatorT(null)
  }
  const endHoverRef = useRef(endHover)
  endHoverRef.current = endHover

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // Only a leave out of the lanes, not one into a lane or clip inside them.
    if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) endHover()
  }

  // Esc, or a drop somewhere else, ends the drag with a dragend on its source.
  useEffect(() => {
    // The record goes only here and on the drop, never on a leave: the drag can
    // come back over the lanes, and the ghost needs to know what it is carrying.
    const onEnd = (): void => {
      clearDragRecord()
      endHoverRef.current()
    }
    window.addEventListener('dragend', onEnd)
    return () => window.removeEventListener('dragend', onEnd)
  }, [])

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
    const ghosts = ghostsFor(getDragRecord(), { isAsset, isSfx, isTitle, isLibrary }, lane, t)
    // The same lane, time and ghosts is the same preview: no new object, no repaint.
    setDropPreview((prev) =>
      prev && prev.trackId === lane.id && prev.tS === t && prev.ghosts === ghosts ? prev : { trackId: lane.id, tS: t, ghosts },
    )
  }

  /**
   * The ghost clips for what is being dragged, read off the SAME pure inserts
   * the drop runs (timelineDrop.ts) on the current sequence, committing nothing.
   * So when the insert moves the clip to a free line or lands linked audio on
   * A1, the ghost shows exactly that. Worked out again only when the lane, the
   * snapped time, the item or the edit changes, not on every pointer event.
   *
   * Needs the record (state/dnd.ts): the browser shows only a drag's TYPES until
   * the drop. No record, or one of another kind than the drag carries, or a
   * length that is not known right now: no ghost, and the line shows as before.
   * A length is never guessed.
   */
  const ghostsFor = (rec: DragRecord | null, k: DragFlags, lane: Track, t: number): DropGhost[] => {
    if (!rec) return NO_GHOSTS
    const key = `${rec.kind}:${rec.id}|${lane.id}|${t}`
    const hit = ghostCache.current
    if (hit && hit.key === key && hit.seq === seq && hit.assets === assets) return hit.ghosts
    const ghosts = computeGhosts(rec, k, lane, t)
    ghostCache.current = { key, seq, assets, ghosts }
    return ghosts
  }

  const computeGhosts = (rec: DragRecord, k: DragFlags, lane: Track, t: number): DropGhost[] => {
    if (rec.kind === 'asset' && k.isAsset) {
      const asset = assets[rec.id]
      return asset ? assetDropGhosts(seq, asset, lane, t) : NO_GHOSTS
    }
    if (rec.kind === 'sfx' && k.isSfx) {
      const def = sfxById(rec.id)
      if (!def) return NO_GHOSTS
      // The project's copy when it has one (what the sound inserter reuses), else
      // the asset it would make: the bundled sound's own length.
      const own = Object.values(assets).find((a) => a.kind === 'audio' && a.name === sfxAssetName(def))
      const asset: MediaAsset = own ?? {
        id: 'drop-ghost',
        name: def.name,
        kind: 'audio',
        blobKey: '',
        durationS: def.durationS,
        hasAudio: true,
        hasVideo: false,
      }
      return sfxDropGhosts(seq, { ...asset, name: def.name }, lane, t)
    }
    if (rec.kind === 'title' && k.isTitle) {
      const look = titleLookById(rec.id)
      return look ? titleDropGhosts(seq, look.durationS, look.name, t) : NO_GHOSTS
    }
    if (rec.kind === 'library' && k.isLibrary) {
      const item = useLibrary.getState().items.find((i) => i.id === rec.id)
      if (!item) return NO_GHOSTS
      // What addLibraryItemToTimeline lays down: the project's own copy of the
      // media when it has one, else a fresh copy with the item's own length.
      const reused = Object.values(assets).find(
        (a) => a.kind === item.kind && a.name === item.name && a.durationS === item.durationS,
      )
      const asset: MediaAsset = reused ?? {
        id: 'drop-ghost',
        name: item.name,
        kind: item.kind,
        blobKey: '',
        durationS: item.durationS,
        hasAudio: item.hasAudio,
        hasVideo: item.hasVideo,
      }
      return assetDropGhosts(seq, asset, lane, t)
    }
    return NO_GHOSTS
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
    clearDragRecord()
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
    // The one insert the ghost ran while he hovered (insertDroppedAsset): a video
    // with audio splits its sound to a linked clip on A1, and nothing lands on top
    // of anything.
    updateActiveSequence(`Add ${asset.name}`, (sq) => insertDroppedAsset(sq, asset, target, t).seq)
  }

  return { dropPreview, setDropPreview, handleDragOver, handleDragLeave, handleDrop }
}
