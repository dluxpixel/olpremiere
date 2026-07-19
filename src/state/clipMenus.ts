// Shared right-click menu builders for a clip — used by BOTH the timeline clip
// menu and the preview-monitor menu, so "how it appears", the font, and the size
// are reachable from wherever you click.

import { DEFAULT_APPEARANCE_DUR, ENTRANCE_PRESETS, EXIT_PRESETS } from '../engine/anim/appearance'
import { TITLE_FONT_OPTIONS } from '../engine/render/titleFonts'
import { isTitleClip, type Clip } from '../engine/types'
import {
  saveClipAppearanceAsDefault,
  setClipsAppearance,
  setClipsAppearanceDur,
} from './appearanceActions'
import { splitTitleIntoWordCaptions } from './captionActions'
import type { MenuItem } from './contextMenu'
import { updateTitles } from './titleActions'

const TITLE_SIZE_PRESETS = [
  { label: 'Small', px: 48 },
  { label: 'Medium', px: 96 },
  { label: 'Large', px: 160 },
  { label: 'Huge', px: 240 },
]

// More granular speed ladder + an Auto option that sizes each word's animation
// to its own length (long words slower, short words snappier).
const APPEARANCE_SPEEDS: { label: string; durS: number | 'auto' }[] = [
  { label: 'Auto (fit each word)', durS: 'auto' },
  { label: 'Instant', durS: 0.1 },
  { label: 'Very fast', durS: 0.18 },
  { label: 'Fast', durS: 0.25 },
  { label: 'Normal', durS: 0.5 },
  { label: 'Slow', durS: 0.8 },
  { label: 'Slower', durS: 1.3 },
  { label: 'Very slow', durS: 2 },
]

/**
 * Font + size quick-picks for a title clip. Actions apply to `ids` (the whole
 * selection when several are selected), so right-clicking one selected caption
 * restyles them all. Empty for non-title clips.
 */
export function titleFontSizeItems(clip: Clip, ids: string[] = [clip.id]): MenuItem[] {
  const def = clip.title
  if (!def) return []
  const suffix = ids.length > 1 ? ` · all ${ids.length}` : ''
  const fontSub: MenuItem[] = TITLE_FONT_OPTIONS.map((f) => ({
    label: f.label,
    checked: def.fontFamily === f.value,
    onClick: () => updateTitles(ids, { fontFamily: f.value }),
  }))
  const sizeSub: MenuItem[] = TITLE_SIZE_PRESETS.map((s) => ({
    label: `${s.label} (${s.px}px)`,
    checked: def.fontSizePx === s.px,
    onClick: () => updateTitles(ids, { fontSizePx: s.px }),
  }))
  return [
    { label: `Font${suffix}`, separator: true, submenu: fontSub },
    { label: `Size${suffix}`, submenu: sizeSub },
    // Jettism-style captions: one pop-in title per word (single clip only).
    ...(ids.length <= 1
      ? [{ label: 'Split into word captions', onClick: () => splitTitleIntoWordCaptions(clip.id) }]
      : []),
  ]
}

/**
 * Entrance / Exit / speed appearance controls. Actions apply to `ids` — the
 * selected TITLES when several are selected — so choosing an animation or
 * speed on ONE right-clicked caption applies to every caption you selected.
 * Empty for non-title clips: video already has transitions + the Motion
 * submenu, and this lineup (Pop/Bang, Bounce…) is caption-flavored.
 */
export function appearanceMenuItems(clip: Clip, ids: string[] = [clip.id]): MenuItem[] {
  if (!isTitleClip(clip)) return []
  const inId = clip.appearance?.in
  const outId = clip.appearance?.out
  const hasAppearance = !!(inId || outId)
  const curDur = clip.appearance?.durS ?? DEFAULT_APPEARANCE_DUR
  const suffix = ids.length > 1 ? ` · all ${ids.length}` : ''

  const entranceSub: MenuItem[] = [
    { label: 'None', checked: !inId, onClick: () => setClipsAppearance(ids, { in: undefined }) },
    ...ENTRANCE_PRESETS.map((p, i) => ({
      label: p.label,
      separator: i === 0,
      checked: inId === p.id,
      onClick: () => setClipsAppearance(ids, { in: p.id }),
    })),
  ]
  const exitSub: MenuItem[] = [
    { label: 'None', checked: !outId, onClick: () => setClipsAppearance(ids, { out: undefined }) },
    ...EXIT_PRESETS.map((p, i) => ({
      label: p.label,
      separator: i === 0,
      checked: outId === p.id,
      onClick: () => setClipsAppearance(ids, { out: p.id }),
    })),
  ]
  // Entrance / Exit stay top-level; the rest fold into one Animation submenu
  // (the menu only renders ONE submenu level, so Speed flattens in as leaves).
  const animationSub: MenuItem[] = [
    ...(hasAppearance
      ? APPEARANCE_SPEEDS.map((s, i) => ({
          label: `Speed: ${s.label}`,
          separator: i === 0,
          checked: typeof s.durS === 'number' && Math.abs(curDur - s.durS) < 1e-6,
          onClick: () => setClipsAppearanceDur(ids, s.durS),
        }))
      : []),
    { label: 'Save as default for new text', separator: true, onClick: () => saveClipAppearanceAsDefault(clip.id) },
    { label: 'Clear animation', disabled: !clip.appearance, onClick: () => setClipsAppearance(ids, { in: undefined, out: undefined }) },
  ]
  return [
    { label: `Entrance${suffix}`, separator: true, submenu: entranceSub },
    { label: `Exit${suffix}`, submenu: exitSub },
    { label: 'Animation', submenu: animationSub },
  ]
}

/** The focused menu shown when right-clicking a clip IN the preview monitor. */
export function previewClipMenu(clip: Clip): MenuItem[] {
  const items = [...titleFontSizeItems(clip), ...appearanceMenuItems(clip)]
  // Never a leading divider at the very top of the menu.
  if (items.length > 0) items[0] = { ...items[0], separator: false }
  return items
}
