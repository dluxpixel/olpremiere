// Drag-and-drop MIME contract between the Effects browser and the timeline.
//
// Custom MIME types (rather than text/plain) so a drop target can tell WHAT is
// being dragged during dragover, before the payload is readable. Browsers only
// expose dataTransfer.types during a drag, not the data itself.

export const ASSET_MIME = 'application/x-olpremiere-asset'
export const EFFECT_MIME = 'application/x-olpremiere-effect'
export const TRANSITION_MIME = 'application/x-olpremiere-transition'
export const SFX_MIME = 'application/x-olpremiere-sfx'
/** A ready made title off the shelf (titleShelf.ts), dropped onto the timeline at a time. */
export const TITLE_MIME = 'application/x-olpremiere-title'
/**
 * A saved Library item, by its Library id. Its own MIME, not ASSET_MIME: it is
 * not in the project yet, so the timeline has to copy it in before placing it,
 * and a category row takes the same drag to file it.
 */
export const LIBRARY_MIME = 'application/x-olpremiere-library'
/**
 * An effect CARD being dragged within one clip's stack, to reorder it.
 *
 * Its own MIME, deliberately not EFFECT_MIME: the inspector's effect area
 * already accepts that one from the browser panel and would answer a card drag
 * by applying a second copy of the effect instead of moving the one he grabbed.
 */
export const EFFECT_CARD_MIME = 'application/x-olpremiere-effect-card'

export const dragHasType = (types: readonly string[], mime: string): boolean => types.includes(mime)

/** What a drag from the bins is carrying, by the id its source put in the dataTransfer. */
export type DragKind = 'asset' | 'sfx' | 'title' | 'library'
export interface DragRecord {
  kind: DragKind
  id: string
}

/**
 * WHAT IS BEING DRAGGED, readable while it is still being dragged.
 *
 * The browser hides a drag's DATA until the drop and only shows its MIME types
 * during dragover, so the timeline could not know WHICH clip was over it, only
 * that "some media" was. A source sets this on dragstart; the timeline reads it
 * to draw the ghost clip, and clears it on drop and on dragend. Plain module
 * state: nothing subscribes, nothing re-renders on it. It is only a hint for the
 * preview. The dataTransfer stays the source of truth for the DROP itself, so a
 * drag nobody recorded (or a stale record) still drops correctly and only loses
 * the ghost.
 */
let dragRecord: DragRecord | null = null
export const setDragRecord = (kind: DragKind, id: string): void => {
  dragRecord = { kind, id }
}
export const getDragRecord = (): DragRecord | null => dragRecord
export const clearDragRecord = (): void => {
  dragRecord = null
}

/**
 * Which edge of a clip a transition drop lands on. Dropping past the midpoint
 * means the outgoing edge. Matches how an editor reaches for the cut nearest
 * the cursor.
 */
export const edgeForOffset = (offsetX: number, width: number): 'in' | 'out' =>
  offsetX < width / 2 ? 'in' : 'out'
