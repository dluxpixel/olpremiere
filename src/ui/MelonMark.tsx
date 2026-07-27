// The pixel-melon mascot as an SVG: crisp at any size, from the 24px topbar mark
// to the boot splash hero. Its own module so the loading card and the splash can
// both draw it without importing each other.

import { MELON_H, MELON_W, melonPixels } from './melon'

export function MelonMark({
  className,
  pixels,
  size,
}: {
  className?: string
  pixels?: ReturnType<typeof melonPixels>
  size?: number
}) {
  const px = pixels ?? melonPixels()
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
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={1} height={1} fill={p.color} />
      ))}
    </svg>
  )
}
