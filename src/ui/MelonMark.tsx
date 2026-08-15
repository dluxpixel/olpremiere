// The pixel-melon mascot as an SVG: crisp at any size, from the 24px topbar mark
// to the boot splash hero. Its own module so the loading card and the splash can
// both draw it without importing each other.

import { MELON_H, MELON_W, MELON_PALETTE, melonPixels } from './melon'

/**
 * One-colour opacity per palette entry, so the mono melon still reads as a melon.
 *
 * Flattening every pixel to one solid colour turns it into a blob at 16px: the
 * seeds and the rind carry the whole silhouette. These weights keep that
 * structure in a single ink, the way a stencil does.
 */
const MONO_ALPHA: Record<string, number> = {
  [MELON_PALETTE.R]: 1, // flesh, the mass of the shape
  [MELON_PALETTE.r]: 0.82, // its lighter top
  [MELON_PALETTE.S]: 0.28, // seeds punch through as holes
  [MELON_PALETTE.L]: 0.5, // inner rind, the band across the bottom
  [MELON_PALETTE.D]: 0.72, // outer rind, the edge that defines it
}

export function MelonMark({
  className,
  pixels,
  size,
  mono = false,
  bite = false,
}: {
  className?: string
  pixels?: ReturnType<typeof melonPixels>
  size?: number
  /** Draw the shape in the current text colour, so it sits with the other icons. */
  mono?: boolean
  /** Take a chomp out of the top right. Used to say an update was found. */
  bite?: boolean
}) {
  const px = pixels ?? melonPixels(bite ? { bite: true } : undefined)
  return (
    <svg
      className={className}
      viewBox={`0 0 ${MELON_W} ${MELON_H}`}
      width={size}
      height={size ? (size * MELON_H) / MELON_W : undefined}
      shapeRendering="crispEdges"
      style={{ imageRendering: 'pixelated' }}
      aria-hidden="true"
    >
      {px.map((p) => (
        <rect
          key={`${p.x}-${p.y}`}
          x={p.x}
          y={p.y}
          width={1}
          height={1}
          fill={mono ? 'currentColor' : p.color}
          fillOpacity={mono ? (MONO_ALPHA[p.color] ?? 1) : undefined}
        />
      ))}
    </svg>
  )
}
