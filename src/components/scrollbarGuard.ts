/**
 * True when a pointer at (clientX, clientY) landed on an element's native
 * scrollbar band: inside the element's border box but PAST its client (content)
 * area. `clientWidth`/`clientHeight` exclude the scrollbars, so a horizontal
 * scrollbar occupies clientY in (top + clientHeight, bottom] and a vertical one
 * clientX in (left + clientWidth, right]. Used so clicking the timeline scrollbar
 * doesn't scrub the playhead.
 */
export function pointOnScrollbar(
  rect: { left: number; top: number },
  clientWidth: number,
  clientHeight: number,
  clientX: number,
  clientY: number,
): boolean {
  return clientX > rect.left + clientWidth || clientY > rect.top + clientHeight
}
