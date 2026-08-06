// Shared right-click menu builders for a clip, used by BOTH the timeline clip
// menu and the preview-monitor menu, so "how it appears", the font, and the size
// are reachable from wherever you click.

import { DEFAULT_APPEARANCE_DUR, ENTRANCE_PRESETS, EXIT_PRESETS } from '../engine/anim/appearance'
import { TITLE_FONT_OPTIONS } from '../engine/render/titleFonts'
import { isTitleClip, type Clip } from '../engine/types'
import { clipDurationS } from '../engine/timeline'
import {
  appearanceDurFor,
  saveClipAppearanceAsDefault,
  setClipsAppearance,
  setClipsAppearanceDur,
} from './appearanceActions'
import { splitTitleIntoWordCaptions } from './captionActions'
import type { MenuItem } from './contextMenu'
import { setTitlesFontSize, updateTitles } from './titleActions'
import { useStore } from './store'

const TITLE_SIZE_PRESETS = [
  { label: 'Small', px: 48 },
  { label: 'Medium', px: 96 },
  { label: 'Large', px: 160 },
  { label: 'Huge', px: 240 },
]

// FIVE rungs, not seven, and every one a SHARE of the clip.
//
// His words, 2026-08-06: "some speeds are just not actually very slow, and the
// very fast is really, really fast. There are just too many options. Just make
// it simpler and better. More accurate."
//
// Seven absolute-second rungs collapsed to four distinct results on a per-word
// caption (see appearanceDurFor). These fractions are spaced so that every rung
// is visibly different from its neighbours on a third-of-a-second word AND on a
// two-second title, and the slowest stays under the half-clip ceiling so an
// entrance can never run into its own exit.
const APPEARANCE_SPEEDS: { label: string; spec: 'auto' | { frac: number } }[] = [
  { label: 'Auto (fit each word)', spec: 'auto' },
  { label: 'Snappy', spec: { frac: 0.12 } },
  { label: 'Normal', spec: { frac: 0.22 } },
  { label: 'Smooth', spec: { frac: 0.34 } },
  { label: 'Slow', spec: { frac: 0.46 } },
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
    onClick: () => setTitlesFontSize(ids, s.px),
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
 * Entrance / Exit / speed appearance controls. Actions apply to `ids` (the
 * selected clips when several are selected), so choosing an animation on ONE
 * right-clicked clip applies to the rest of the selection.
 * Shown for TITLES and still IMAGES: both "appear" on screen, so a fade/pop/slide
 * entrance suits them. Empty for VIDEO and audio: video animates via transitions
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
          // The tick compares against what this rung would MEAN for this clip,
          // since the same rung is a different number of seconds on a long title
          // and a short word.
          checked:
            s.spec !== 'auto' && Math.abs(curDur - appearanceDurFor(s.spec.frac, clipDurationS(clip))) < 1e-3,
          onClick: () => setClipsAppearanceDur(ids, s.spec),
        }))
      : []),
    // "Save as default for new text" is text-specific, so titles only.
    ...(isTitle
      ? [{ label: 'Save as default for new text', separator: true, onClick: () => saveClipAppearanceAsDefault(clip.id) }]
      : []),
    { label: 'Clear animation', separator: !isTitle, disabled: !clip.appearance, onClick: () => setClipsAppearance(ids, { in: undefined, out: undefined }) },
  ]
  // "Fade in + out" used to sit on top of these as a fourth row for the same
  // idea, and its whole job is Entrance = Fade in plus Exit = Fade out, which are
  // the first item in each list right below it. Cut, 2026-07-28: "there is an
  // entrance and a transition in the text tab. This is a lot of bloat."
  return [
    { label: `Entrance${suffix}`, separator: true, submenu: entranceSub },
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
