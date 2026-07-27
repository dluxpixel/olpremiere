// Text-style presets: a reusable bundle of caption styling (font, case, colour,
// OUTLINE, position) plus an entrance/exit ANIMATION. Persisted in localStorage
// so it survives across projects and sessions. One applier patches the title
// def AND recompiles the appearance across a whole selection in ONE undo step,
// which is what powers: bulk outline edits, the Captions-dialog style picker,
// and the right-click "apply animation to all".

import { create } from 'zustand'
import { applyAppearanceToClip } from '../engine/anim/appearance'
import { activeSequence, type AppearanceSpec, type Clip, type TitleDef } from '../engine/types'
import { updateActiveSequence, useStore } from './store'

export interface TextStylePreset {
  id: string
  name: string
  /** Visual style patched onto each title's def (everything but the text). */
  style: Partial<TitleDef>
  /** Entrance/exit animation compiled onto the clip's keyframes. */
  appearance?: AppearanceSpec
  builtin?: boolean
}

// The Jettism house style: lowercase word, fat black outline, lower-third
// position, pop in + pop out (the "two write animations").
const BUILTINS: TextStylePreset[] = [
  {
    id: 'builtin-jettism',
    name: 'Jettism caption',
    builtin: true,
    style: {
      textCase: 'lower',
      color: '#ffffff',
      outline: { color: '#000000', widthPx: 12 },
      vAlign: 'bottom',
      offsetYPx: -220,
    },
    appearance: { in: 'pop', out: 'popOut', durS: 0.14 },
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
/** The house style, and what an unset install gets. */
export const DEFAULT_CAPTION_PRESET_ID = 'builtin-jettism'

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
  return { id: freshId(), name, style, appearance: clip.appearance }
}
