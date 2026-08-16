// Drag-and-drop MIME contract between the Effects browser and the timeline.
//
// Custom MIME types (rather than text/plain) so a drop target can tell WHAT is
// being dragged during dragover, before the payload is readable. Browsers only
// expose dataTransfer.types during a drag, not the data itself.

export const ASSET_MIME = 'application/x-olpremiere-asset'
export const EFFECT_MIME = 'application/x-olpremiere-effect'
export const TRANSITION_MIME = 'application/x-olpremiere-transition'
export const SFX_MIME = 'application/x-olpremiere-sfx'
/**
 * An effect CARD being dragged within one clip's stack, to reorder it.
 *
 * Its own MIME, deliberately not EFFECT_MIME: the inspector's effect area
 * already accepts that one from the browser panel and would answer a card drag
 * by applying a second copy of the effect instead of moving the one he grabbed.
 */
export const EFFECT_CARD_MIME = 'application/x-olpremiere-effect-card'

export const dragHasType = (types: readonly string[], mime: string): boolean => types.includes(mime)

/**
 * Which edge of a clip a transition drop lands on. Dropping past the midpoint
 * means the outgoing edge. Matches how an editor reaches for the cut nearest
 * the cursor.
 */
export const edgeForOffset = (offsetX: number, width: number): 'in' | 'out' =>
  offsetX < width / 2 ? 'in' : 'out'
