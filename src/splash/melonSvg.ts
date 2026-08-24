// The pixel melon as one SVG string, for the pages that draw it without React.
//
// It was inline in splash.ts until the update window needed the same fruit. Two
// copies of a `<rect>` loop over MELON_ROWS is exactly the drift melon.test.ts
// exists to prevent, so it is one function, and melon.ts stays the only art.

import { MELON_H, MELON_W, melonPixels } from '../ui/melon'

/**
 * `bite` carves the chomp out of the top right, the same mark the topbar wears
 * once a check has found something.
 */
export function melonSvg(className = 'melon', opts?: { bite?: boolean }): string {
  const rects = melonPixels(opts)
    .map((p) => `<rect x="${p.x}" y="${p.y}" width="1" height="1" fill="${p.color}"/>`)
    .join('')
  return `<svg class="${className}" viewBox="0 0 ${MELON_W} ${MELON_H}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`
}
