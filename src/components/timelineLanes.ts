import { clipEndS } from '../engine/timeline'
import type { Id, Track } from '../engine/types'
import type { Tool } from '../state/store'
import { RULER_H } from './timelineGeometry'

/** One lane in content space (below the ruler), for pointer hit tests. */
export interface LaneInfo {
  track: Track
  top: number
}

/** A rectangle in content coordinates, corners in drag order. */
export interface ContentBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The visible slice of the lanes' scroll container, in pixels. */
export interface LanesViewport {
  left: number
  width: number
}

// Lane geometry in content space (below the ruler), for pointer hit tests.
export function buildLaneInfos(vTracks: readonly Track[], aTracks: readonly Track[]): LaneInfo[] {
  const infos: LaneInfo[] = []
  let top = RULER_H
  for (const t of vTracks) {
    infos.push({ track: t, top })
    top += t.height
  }
  top += 2 // video/audio divider
  for (const t of aTracks) {
    infos.push({ track: t, top })
    top += t.height
  }
  return infos
}

export function laneAtY(laneInfos: readonly LaneInfo[], y: number): Track | null {
  for (const { track, top } of laneInfos) {
    if (y >= top && y < top + track.height) return track
  }
  return null
}

/** Every clip whose box overlaps the rectangle, in lane order. */
export function marqueeHitIds(laneInfos: readonly LaneInfo[], pxPerS: number, box: ContentBox): Id[] {
  const loX = Math.min(box.x0, box.x1)
  const hiX = Math.max(box.x0, box.x1)
  const loY = Math.min(box.y0, box.y1)
  const hiY = Math.max(box.y0, box.y1)
  const hits: Id[] = []
  for (const { track, top } of laneInfos) {
    if (top + track.height < loY || top > hiY) continue
    for (const c of track.clips) {
      const cx0 = c.startS * pxPerS
      const cx1 = clipEndS(c) * pxPerS
      if (cx1 >= loX && cx0 <= hiX) hits.push(c.id)
    }
  }
  return hits
}

/** How much timeline the content div spans: the sequence plus a minute of runway, never under two minutes. */
export const timelineLengthS = (durationS: number): number => Math.max(120, durationS + 60)

/**
 * Only clips intersecting the visible time range (+ one full viewport of
 * margin each side, so ordinary scrolling never pops clips in at the edge)
 * are mounted. Until the first measure, everything renders (null viewport).
 */
export function clipWindowS(viewport: LanesViewport | null, pxPerS: number): { winStartS: number; winEndS: number } {
  return {
    winStartS: viewport ? (viewport.left - viewport.width) / pxPerS : -Infinity,
    winEndS: viewport ? (viewport.left + viewport.width * 2) / pxPerS : Infinity,
  }
}

// ⛔ WHETHER A LANE IS BEING HEARD, and until 2026-08-18 nothing on the
// timeline said. Muting a track, or soloing another one, changed the sound and
// left the lanes pixel-identical, so the only record of it was a small button
// in the header he had to go and read.
//
// The rule is the ENGINE's, copied nowhere: `engine/audio.ts` decides
// audibility with exactly this expression, so the picture cannot disagree with
// the mix.
export function silencedTest(tracks: readonly Track[]): (track: Track) => boolean {
  const anySolo = tracks.some((t) => t.solo)
  return (track: Track): boolean => (anySolo ? !track.solo : track.muted)
}

// Drop-target feedback during a cross-track move: green valid, red no-go.
export function laneHoverClass(hov: { valid: boolean } | null): string {
  return hov
    ? hov.valid
      ? 'ring-1 ring-inset ring-accent/50 bg-accent/10'
      : 'ring-1 ring-inset ring-danger/50 bg-danger/10'
    : ''
}

// The pointer always says what a press would do: a razor blade for the
// blade tool, grab that closes to grabbing while a hand-pan is live, zoom
// magnifier (flipped to zoom-out by Alt via CSS on data-mods). Children
// inherit, so the whole lane area speaks the tool. Modifier-hover cursors
// for slip/stretch (Alt) and slide/roll (Ctrl+Alt) key off data-mods below.
export function lanesCursorClass(tool: Tool, dragKind: string | undefined): string {
  return tool === 'razor'
    ? 'cursor-razor'
    : tool === 'hand'
      ? dragKind === 'hand'
        ? 'cursor-grabbing'
        : 'cursor-grab'
      : ''
}

/** The `data-mods` value index.css keys the modifier-hover cursors on. Empty = none held. */
export function modifierMods(ctrl: boolean, alt: boolean): string {
  return ctrl && alt ? 'ctrl-alt' : alt ? 'alt' : ctrl ? 'ctrl' : ''
}
