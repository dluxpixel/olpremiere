// A colour as a hex the picker can hold plus an opacity, and back. Pure.
//
// An <input type=color> only speaks #rrggbb, so a see through colour such as the
// caption box's rgba(0,0,0,0.6) has to be split before the picker sees it and
// joined again after, or the first colour he picks makes the box solid with no
// way back (2026-10-06). The caption style editor and the title panel share
// these, so the two can never disagree on what a colour means.

/** '#rgb', '#rrggbb', '#rrggbbaa' or 'rgb(a)(r,g,b[,a])' as a hex and an opacity 0 to 1. */
export function splitColour(c: string): { hex: string; alpha: number } {
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim())
  if (h) {
    const x = h[1]!.length === 3 ? [...h[1]!].map((d) => d + d).join('') : h[1]!
    const alpha = x.length === 8 ? Math.round((parseInt(x.slice(6), 16) / 255) * 100) / 100 : 1
    return { hex: `#${x.slice(0, 6).toLowerCase()}`, alpha }
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(c.trim())
  if (m) {
    const hex = [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')
    return { hex: `#${hex}`, alpha: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4]))) }
  }
  return { hex: '#000000', alpha: 1 }
}

/** A hex and an opacity as a colour: the plain hex when solid, rgba() when see through. */
export function joinColour(hex: string, alpha: number): string {
  if (alpha >= 1) return hex
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.round(Math.max(0, alpha) * 100) / 100})`
}
