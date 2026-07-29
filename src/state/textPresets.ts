// Text-style presets: a reusable bundle of caption styling (font, case, colour,
// OUTLINE, position) plus an entrance/exit ANIMATION. Persisted in localStorage
// so it survives across projects and sessions. One applier patches the title
// def AND recompiles the appearance across a whole selection in ONE undo step,
// which is what powers: bulk outline edits, the Captions-dialog style picker,
// and the right-click "apply animation to all".

import { create } from 'zustand'
import { applyAppearanceToClip } from '../engine/anim/appearance'
import { CAPTION_FONT_STACK } from '../engine/render/titleFonts'
import { activeSequence, type AppearanceSpec, type Clip, type EffectInstance, type TitleDef } from '../engine/types'
import { updateActiveSequence, useStore } from './store'

export interface TextStylePreset {
  id: string
  name: string
  /** Visual style patched onto each title's def (everything but the text). */
  style: Partial<TitleDef>
  /** Entrance/exit animation compiled onto the clip's keyframes. */
  appearance?: AppearanceSpec
  /**
   * The clip's whole effect stack, carried with the look.
   *
   * His ask, 2026-07-28: "make it so I can save custom effects for each time it
   * makes a new one." A preset used to be font + outline + animation only, so a
   * caption he had graded, blurred or glowed came back plain on the next run and
   * he had to redo it by hand every time.
   */
  effects?: EffectInstance[]
  builtin?: boolean
}

// The Jettism look as a preset, for turning an EXISTING title into a caption.
// A fresh caption run does not need this: it is born in the house style already.
//
// Remeasured 2026-07-29 against the reference channel's own frames, which moved
// three things here. It sat in the lower third and the captions are dead centre.
// It popped in and out and the captions HARD CUT. And it carried no font, so a
// restyled title kept whatever face it had instead of the caption one.
const BUILTINS: TextStylePreset[] = [
  {
    id: 'builtin-jettism',
    name: 'Jettism caption',
    builtin: true,
    style: {
      fontFamily: CAPTION_FONT_STACK,
      textCase: 'lower',
      color: '#ffffff',
      // Absolute pixels, unlike the house style, because a preset is applied to
      // a clip and never sees the sequence height. Sized for 1080x1920.
      outline: { color: '#000000', widthPx: 15 },
      vAlign: 'middle',
      offsetYPx: 0,
    },
  },
  {
    id: 'builtin-yellow-pop',
    name: 'Yellow punch',
    builtin: true,
    style: {
      textCase: 'upper',
      color: '#FFD400',
      outline: { color: '#000000', widthPx: 14 },
    },
    appearance: { in: 'bounce', out: 'popOut', durS: 0.16 },
  },
  {
    id: 'builtin-clean',
    name: 'Clean fade',
    builtin: true,
    style: { textCase: undefined, color: '#ffffff', outline: { color: '#000000', widthPx: 6 } },
    appearance: { in: 'fadeIn', out: 'fadeOut', durS: 0.2 },
  },
]

const KEY = 'olpremiere:textPresets'

function loadSaved(): TextStylePreset[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? (arr as TextStylePreset[]).filter((p) => p && p.id && p.name) : []
  } catch {
    return []
  }
}
function persist(list: TextStylePreset[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* private mode / quota: presets just won't persist */
  }
}

interface PresetState {
  saved: TextStylePreset[]
  add: (p: TextStylePreset) => void
  remove: (id: string) => void
}

let counter = 0
const freshId = (): string => `tp-${counter++}-${loadSaved().length}`

export const useTextPresets = create<PresetState>((set) => ({
  saved: loadSaved(),
  add: (p) =>
    set((s) => {
      const next = [...s.saved.filter((x) => x.name !== p.name), p].slice(-24)
      persist(next)
      return { saved: next }
    }),
  remove: (id) =>
    set((s) => {
      const next = s.saved.filter((x) => x.id !== id)
      persist(next)
      return { saved: next }
    }),
}))

/** The read-only built-in presets (stable reference). */
export function builtinTextPresets(): TextStylePreset[] {
  return BUILTINS
}

/** Built-ins first, then the user's saved presets. */
export function allTextPresets(): TextStylePreset[] {
  return [...BUILTINS, ...useTextPresets.getState().saved]
}

// --- The remembered caption style ------------------------------------------
// The caption LANGUAGE has always been persisted so every caption door agrees
// (transcribeConfig). The STYLE was not, so the Captions dialog defaulted to the
// Jettism look while right-click → Auto-Caption passed no preset at all and fell
// through to raw ALL-CAPS titles in the middle of the frame. Same feature, same
// name, completely different output, and right-click is the one people reach for.

const STYLE_KEY = 'olpremiere:captions:style'
/**
 * What an unset install gets: NO preset, which means the measured house style
 * lands untouched. It used to default to the 'builtin-jettism' preset, and once
 * the house style was measured off the real frames that preset could only make
 * it worse. Its outline is absolute pixels, so it went wrong at any size but
 * 1080x1920, and its blanket lowercase flattened "TNT" to "tnt".
 *
 * An install that stored 'builtin-jettism' explicitly finds no preset by that
 * name in the caption path and falls through to the same house style, which is
 * the right answer, so there is nothing to migrate.
 */
export const DEFAULT_CAPTION_PRESET_ID = ''

let captionPresetId: string | null = null

export function getCaptionPresetId(): string {
  if (captionPresetId !== null) return captionPresetId
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STYLE_KEY) : null
    captionPresetId = v ?? DEFAULT_CAPTION_PRESET_ID
  } catch {
    captionPresetId = DEFAULT_CAPTION_PRESET_ID
  }
  return captionPresetId
}

export function setCaptionPresetId(id: string): void {
  captionPresetId = id
  try {
    if (typeof localStorage === 'undefined') return
    if (id === DEFAULT_CAPTION_PRESET_ID) localStorage.removeItem(STYLE_KEY)
    else localStorage.setItem(STYLE_KEY, id)
  } catch {
    // Private mode / quota. The in-memory value above still applies this run.
  }
}

/** The remembered style, or undefined when the pick was "Plain (no styling)". */
export function rememberedCaptionPreset(): TextStylePreset | undefined {
  return allTextPresets().find((x) => x.id === getCaptionPresetId())
}
/**
 * Apply a preset's style + animation to every selected TITLE clip in ONE undo
 * step. Non-title clips and locked tracks are skipped.
 */
export function applyTextPresetToClips(ids: Iterable<string>, preset: TextStylePreset): void {
  const idSet = new Set(ids)
  if (idSet.size === 0) return
  updateActiveSequence(`Apply "${preset.name}"`, (seq) => {
    let changed = false
    const tracks = seq.tracks.map((t) => {
      if (t.locked || !t.clips.some((c) => idSet.has(c.id) && c.title)) return t
      const clips = t.clips.map((c) => {
        if (!idSet.has(c.id) || !c.title) return c
        changed = true
        let nc: Clip = { ...c, title: { ...c.title, ...preset.style } }
        // Copied per clip, never shared: two captions must not end up pointing at
        // the same effect object, or editing one would silently change the other.
        if (preset.effects?.length) nc = { ...nc, effects: preset.effects.map((e) => ({ ...e })) }
        if (preset.appearance) nc = applyAppearanceToClip(nc, preset.appearance, seq.width, seq.height)
        return nc
      })
      return { ...t, clips }
    })
    return changed ? { ...seq, tracks } : seq
  })
}

/** Apply just an entrance/exit animation to every selected title clip (one undo). */
export function applyAppearanceToClips(ids: Iterable<string>, appearance: AppearanceSpec): void {
  applyTextPresetToClips(ids, { id: 'anim', name: 'animation', style: {}, appearance })
}

/** Build a preset from a clip's current title + appearance (the "Save" action). */
export function captureTextPreset(clipId: string, name: string): TextStylePreset | null {
  const seq = activeSequence(useStore.getState().project)
  const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (!clip?.title) return null
  const d = clip.title
  const style: Partial<TitleDef> = {
    fontFamily: d.fontFamily,
    // SIZE travels with the look. His words for what a preset should hold:
    // "location, font, boldness, and stuff like that" - and a caption at the
    // wrong size is the most obvious way for a saved look to come back wrong.
    fontSizePx: d.fontSizePx,
    bold: d.bold,
    italic: d.italic,
    textCase: d.textCase,
    color: d.color,
    outline: d.outline,
    shadow: d.shadow,
    box: d.box,
    align: d.align,
    vAlign: d.vAlign,
    offsetXPx: d.offsetXPx,
    offsetYPx: d.offsetYPx,
  }
  return {
    id: freshId(),
    name,
    style,
    appearance: clip.appearance,
    // The effect stack travels with the look. Cloned, so the preset can never be
    // mutated later by editing the clip it was captured from.
    ...(clip.effects.length ? { effects: clip.effects.map((e) => ({ ...e })) } : {}),
  }
}

/**
 * Save a preset AND make it the style every new caption gets, in one action.
 *
 * His ask, 2026-07-28: "make it so I can save custom effects for each time it
 * makes a new one." Saving used to only add a row to a dropdown, so the very next
 * auto-caption run still came out in the house style and he had to go and pick it
 * by hand. Saving is the instruction, so it takes effect.
 */
export function saveAsCaptionStyle(clipId: string, name: string): TextStylePreset | null {
  const preset = captureTextPreset(clipId, name)
  if (!preset) return null
  useTextPresets.getState().add(preset)
  setCaptionPresetId(preset.id)
  return preset
}
