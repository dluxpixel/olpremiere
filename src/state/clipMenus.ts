// Shared right-click menu builders for a clip — used by BOTH the timeline clip
// menu and the preview-monitor menu, so "how it appears", the font, and the size
// are reachable from wherever you click.

import { DEFAULT_APPEARANCE_DUR, ENTRANCE_PRESETS, EXIT_PRESETS } from '../engine/anim/appearance'
import { TITLE_FONT_OPTIONS } from '../engine/render/titleFonts'
import type { Clip } from '../engine/types'
import { clearClipAppearance, saveClipAppearanceAsDefault, setClipAppearance } from './appearanceActions'
import { splitTitleIntoWordCaptions } from './captionActions'
import type { MenuItem } from './contextMenu'
import { updateTitle } from './titleActions'

const TITLE_SIZE_PRESETS = [
  { label: 'Small', px: 48 },
  { label: 'Medium', px: 96 },
  { label: 'Large', px: 160 },
  { label: 'Huge', px: 240 },
]

const APPEARANCE_SPEEDS = [
  { label: 'Fast', durS: 0.25 },
  { label: 'Normal', durS: 0.5 },
  { label: 'Slow', durS: 1 },
]

/** Font + size quick-picks for a title clip (empty for non-title clips). */
export function titleFontSizeItems(clip: Clip): MenuItem[] {
  const def = clip.title
  if (!def) return []
  const fontSub: MenuItem[] = TITLE_FONT_OPTIONS.map((f) => ({
    label: f.label,
    checked: def.fontFamily === f.value,
    onClick: () => updateTitle(clip.id, { fontFamily: f.value }),
  }))
  const sizeSub: MenuItem[] = TITLE_SIZE_PRESETS.map((s) => ({
    label: `${s.label} (${s.px}px)`,
    checked: def.fontSizePx === s.px,
    onClick: () => updateTitle(clip.id, { fontSizePx: s.px }),
  }))
  return [
    { label: 'Font', separator: true, submenu: fontSub },
    { label: 'Size', submenu: sizeSub },
    // Jettism-style captions: one pop-in title per word, spread over the clip.
    { label: 'Split into word captions', onClick: () => splitTitleIntoWordCaptions(clip.id) },
  ]
}

/** Entrance / Exit / speed appearance controls for any clip. */
export function appearanceMenuItems(clip: Clip): MenuItem[] {
  const inId = clip.appearance?.in
  const outId = clip.appearance?.out
  const hasAppearance = !!(inId || outId)
  const curDur = clip.appearance?.durS ?? DEFAULT_APPEARANCE_DUR

  const entranceSub: MenuItem[] = [
    { label: 'None', checked: !inId, onClick: () => setClipAppearance(clip.id, { in: undefined }) },
    ...ENTRANCE_PRESETS.map((p, i) => ({
      label: p.label,
      separator: i === 0,
      checked: inId === p.id,
      onClick: () => setClipAppearance(clip.id, { in: p.id }),
    })),
  ]
  const exitSub: MenuItem[] = [
    { label: 'None', checked: !outId, onClick: () => setClipAppearance(clip.id, { out: undefined }) },
    ...EXIT_PRESETS.map((p, i) => ({
      label: p.label,
      separator: i === 0,
      checked: outId === p.id,
      onClick: () => setClipAppearance(clip.id, { out: p.id }),
    })),
  ]
  // Entrance / Exit stay top-level (the taste-picking hot path); the rest of
  // the animation controls fold into one Animation submenu so the clip menu
  // doesn't wall up. Speed flattens INTO it as leaves — the menu only renders
  // ONE submenu level, so a nested Speed submenu would never open.
  const animationSub: MenuItem[] = [
    ...(hasAppearance
      ? APPEARANCE_SPEEDS.map((s, i) => ({
          label: `Speed: ${s.label}`,
          separator: i === 0,
          checked: Math.abs(curDur - s.durS) < 1e-6,
          onClick: () => setClipAppearance(clip.id, { durS: s.durS }),
        }))
      : []),
    { label: 'Save as default for new text', separator: true, onClick: () => saveClipAppearanceAsDefault(clip.id) },
    { label: 'Clear animation', disabled: !clip.appearance, onClick: () => clearClipAppearance(clip.id) },
  ]
  return [
    { label: 'Entrance', separator: true, submenu: entranceSub },
    { label: 'Exit', submenu: exitSub },
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
