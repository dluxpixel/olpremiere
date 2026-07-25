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
import { useStore } from './store'

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
  { label: 'Fast', durS: 0.18 },
  { label: 'Normal', durS: DEFAULT_APPEARANCE_DUR },
  { label: 'Relaxed', durS: 0.4 },
  { label: 'Slow', durS: 0.6 },
  { label: 'Very slow', durS: 1 },
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

/** A still-image clip (not a title, not an adjustment layer): asset kind 'image'. */
function isStillImageClip(clip: Clip): boolean {
  if (clip.title !== undefined || clip.adjustment) return false
  return useStore.getState().project.assets[clip.assetId]?.kind === 'image'
}

/**
 * Entrance / Exit / speed appearance controls. Actions apply to `ids` — the
 * selected clips when several are selected — so choosing an animation on ONE
 * right-clicked clip applies to the rest of the selection.
 * Shown for TITLES and still IMAGES: both "appear" on screen, so a fade/pop/slide
 * entrance suits them. Empty for VIDEO and audio — video animates via transitions
 * + the Motion submenu (its own set), which is the deliberate split.
 */
export function appearanceMenuItems(clip: Clip, ids: string[] = [clip.id]): MenuItem[] {
  const isTitle = isTitleClip(clip)
  if (!isTitle && !isStillImageClip(clip)) return []
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
    // "Save as default for new text" is text-specific, so titles only.
    ...(isTitle
      ? [{ label: 'Save as default for new text', separator: true, onClick: () => saveClipAppearanceAsDefault(clip.id) }]
      : []),
    { label: 'Clear animation', separator: !isTitle, disabled: !clip.appearance, onClick: () => setClipsAppearance(ids, { in: undefined, out: undefined }) },
  ]
  return [
    // One-click fade: nothing -> in -> hold -> out -> nothing (entrance + exit at once).
    { label: 'Fade in + out', separator: true, onClick: () => setClipsAppearance(ids, { in: 'fadeIn', out: 'fadeOut' }) },
    { label: `Entrance${suffix}`, submenu: entranceSub },
    { label: `Exit${suffix}`, submenu: exitSub },
    { label: 'Animation', submenu: animationSub },
  ]
}

/** The focused menu shown when right-clicking a clip IN the preview monitor. */
export function previewClipMenu(clip: Clip, ids?: string[]): MenuItem[] {
  const items = [...titleFontSizeItems(clip, ids), ...appearanceMenuItems(clip, ids)]
  // Never a leading divider at the very top of the menu.
  if (items.length > 0) items[0] = { ...items[0], separator: false }
  return items
}
