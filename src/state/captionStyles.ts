// The caption styles he saves, which one new captions use, and where they live.
//
// His ask, 2026-10-03: *"make it so I can somehow save caption styles,
// including caption length, how big it is, and stuff like that."* What a style
// IS lives in engine/captions/captionStyle.ts; this file keeps the list.
//
// ⛔ TWO HOMES, THE WAY THE LIBRARY HAS TWO. localStorage is the quick copy every
// caption door reads synchronously, and it sits in the same browser profile the
// engine has wiped under him four times since July. So every change is ALSO
// written to `Caption styles.json` beside his project files
// (electron/captionStylesFile.ts), and a launch that comes up with none of his
// styles reads that file back. Whichever copy was saved last wins, so a file
// left over from an older session can never undo a change he just made.
//
// ⛔ NOTHING HE SAVED BEFORE IS LOST. Looks saved before this file existed sat
// under 'olpremiere:textPresets' with the pick under 'olpremiere:captions:style'.
// The first launch reads both and turns each look into a style that makes the
// same captions it made then (styleFromLegacyPreset). The old keys are left
// where they are, untouched, as a copy of last resort.

import { create } from 'zustand'
import {
  BUILTIN_CAPTION_STYLES,
  HOUSE_STYLE_ID,
  captionDefFor,
  cleanStyle,
  lookOfTitle,
  styleFromLegacyPreset,
  type CaptionStyle,
  type LegacyTextPreset,
} from '../engine/captions/captionStyle'
import { activeSequence, newId } from '../engine/types'
import { useStore } from './store'
import { useToasts } from './toasts'

export const STYLES_KEY = 'olpremiere:captions:styles'
/** Where looks were saved before 2026-10-03. Read once, never written. */
export const LEGACY_PRESETS_KEY = 'olpremiere:textPresets'
/** Which of them new captions used. Read once, never written. */
export const LEGACY_DEFAULT_KEY = 'olpremiere:captions:style'

/** What both homes hold. `kind` and `version` let a reader refuse anything else. */
export interface CaptionStylesSnapshot {
  kind: 'ol-premiere-caption-styles'
  version: 1
  savedAt: number
  styles: CaptionStyle[]
  defaultId: string
}

interface CaptionStylesState {
  /** His styles, oldest first. The built in ones are not in here. */
  saved: CaptionStyle[]
  /** The style every new caption run uses. */
  defaultId: string
  /** When this list last changed. Decides which home is newer. */
  savedAt: number
}

const BUILTIN_IDS = new Set(BUILTIN_CAPTION_STYLES.map((s) => s.id))
const EMPTY: CaptionStylesState = { saved: [], defaultId: HOUSE_STYLE_ID, savedAt: 0 }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** A snapshot from either home, or null for anything that is not one. A bad style is dropped, never the list. */
export function parseCaptionStyles(raw: string | null): CaptionStylesSnapshot | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const r = v as Partial<CaptionStylesSnapshot> | null
  if (!r || r.kind !== 'ol-premiere-caption-styles' || r.version !== 1) return null
  const styles = (Array.isArray(r.styles) ? r.styles : [])
    .map(cleanStyle)
    .filter((s): s is CaptionStyle => !!s && !BUILTIN_IDS.has(s.id))
  const known = new Set([...BUILTIN_IDS, ...styles.map((s) => s.id)])
  return {
    kind: 'ol-premiere-caption-styles',
    version: 1,
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
    styles,
    defaultId: typeof r.defaultId === 'string' && known.has(r.defaultId) ? r.defaultId : HOUSE_STYLE_ID,
  }
}

const snapshotOf = (s: CaptionStylesState): CaptionStylesSnapshot => ({
  kind: 'ol-premiere-caption-styles',
  version: 1,
  savedAt: s.savedAt,
  styles: s.saved,
  defaultId: s.defaultId,
})

/** True when there is something of his in it: a style, or a default he picked. */
const hasHis = (s: Pick<CaptionStylesState, 'saved' | 'defaultId'>): boolean =>
  s.saved.length > 0 || s.defaultId !== HOUSE_STYLE_ID
const snapshotHasHis = (s: CaptionStylesSnapshot): boolean => hasHis({ saved: s.styles, defaultId: s.defaultId })

/**
 * The looks saved before caption styles existed, as caption styles, and the
 * one he had picked. Pure, so the migration is proven without a browser.
 */
export function migrateLegacyStyles(
  rawPresets: string | null,
  rawDefault: string | null,
  at: number,
): Pick<CaptionStylesState, 'saved' | 'defaultId'> {
  let list: unknown = []
  try {
    list = rawPresets ? JSON.parse(rawPresets) : []
  } catch {
    list = []
  }
  const saved = (Array.isArray(list) ? (list as LegacyTextPreset[]) : [])
    .map((p) => styleFromLegacyPreset(p, at))
    .filter((s): s is CaptionStyle => !!s && !BUILTIN_IDS.has(s.id))
  // '' was the house look, and so was 'builtin-jettism' in all but its outline
  // maths, which the measured house look already gets right at every size.
  const id = rawDefault ?? ''
  const defaultId =
    id === '' || id === 'builtin-jettism'
      ? HOUSE_STYLE_ID
      : BUILTIN_IDS.has(id) || saved.some((s) => s.id === id)
        ? id
        : HOUSE_STYLE_ID
  return { saved, defaultId }
}

function readLocal(): CaptionStylesState {
  const ls = storage()
  if (!ls) return EMPTY
  try {
    const snap = parseCaptionStyles(ls.getItem(STYLES_KEY))
    if (snap) return { saved: snap.styles, defaultId: snap.defaultId, savedAt: snap.savedAt }
    const now = Date.now()
    const migrated = migrateLegacyStyles(ls.getItem(LEGACY_PRESETS_KEY), ls.getItem(LEGACY_DEFAULT_KEY), now)
    if (!hasHis(migrated)) return EMPTY
    const state = { ...migrated, savedAt: now }
    ls.setItem(STYLES_KEY, JSON.stringify(snapshotOf(state)))
    return state
  } catch {
    return EMPTY
  }
}

function writeLocal(s: CaptionStylesState): void {
  try {
    storage()?.setItem(STYLES_KEY, JSON.stringify(snapshotOf(s)))
  } catch {
    // Quota or private mode. The live list still serves this session, and the file still gets it.
  }
}

export const useCaptionStyles = create<CaptionStylesState>(() => readLocal())

/** Every change goes through here: stamped, kept in memory, written locally, and the file follows. */
function commit(patch: Partial<Pick<CaptionStylesState, 'saved' | 'defaultId'>>): void {
  useCaptionStyles.setState((s) => ({ ...s, ...patch, savedAt: Math.max(Date.now(), s.savedAt + 1) }))
  writeLocal(useCaptionStyles.getState())
}

/** Built in styles first, then his, oldest first. */
export function allCaptionStyles(): CaptionStyle[] {
  return [...BUILTIN_CAPTION_STYLES, ...useCaptionStyles.getState().saved]
}

export function captionStyleById(id: string): CaptionStyle | undefined {
  return allCaptionStyles().find((s) => s.id === id)
}

/** The style new captions use. Never missing: the house style stands in. */
export function defaultCaptionStyle(): CaptionStyle {
  return captionStyleById(useCaptionStyles.getState().defaultId) ?? BUILTIN_CAPTION_STYLES[0]!
}

export function setDefaultCaptionStyle(id: string): void {
  if (!captionStyleById(id) || useCaptionStyles.getState().defaultId === id) return
  commit({ defaultId: id })
}

/** A name nothing else is called, so two styles can never be told apart only by their place in a list. */
export function uniqueStyleName(base: string, exceptId?: string): string {
  const name = base.trim() || 'Caption style'
  const taken = new Set(allCaptionStyles().filter((s) => s.id !== exceptId).map((s) => s.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`
}

/** What a new style is made of. Everything but its id and when it changed. */
export type CaptionStyleDraft = Omit<CaptionStyle, 'id' | 'updatedAt' | 'builtin'>

export function saveNewCaptionStyle(draft: CaptionStyleDraft): CaptionStyle {
  const style: CaptionStyle = {
    ...cleanStyle({ ...draft, id: `cs-${newId()}`, updatedAt: Date.now() })!,
    name: uniqueStyleName(draft.name),
  }
  commit({ saved: [...useCaptionStyles.getState().saved, style] })
  return style
}

/** Change one of his styles. A built in one cannot be changed: saving a copy is the way. */
export function updateCaptionStyle(id: string, draft: Partial<CaptionStyleDraft>): CaptionStyle | null {
  const cur = useCaptionStyles.getState().saved.find((s) => s.id === id)
  if (!cur) return null
  const next = cleanStyle({ ...cur, ...draft, id, updatedAt: Date.now() })
  if (!next) return null
  if (draft.name !== undefined) next.name = uniqueStyleName(draft.name, id)
  commit({ saved: useCaptionStyles.getState().saved.map((s) => (s.id === id ? next : s)) })
  return next
}

export function renameCaptionStyle(id: string, name: string): CaptionStyle | null {
  return updateCaptionStyle(id, { name })
}

/** Remove one of his styles. When it was the default, new captions go back to the house style. */
export function deleteCaptionStyle(id: string): boolean {
  const s = useCaptionStyles.getState()
  if (!s.saved.some((x) => x.id === id)) return false
  commit({
    saved: s.saved.filter((x) => x.id !== id),
    defaultId: s.defaultId === id ? HOUSE_STYLE_ID : s.defaultId,
  })
  return true
}

/**
 * Save the look of a title on the timeline as a style AND make it the one new
 * captions use: the right-click "Save as the caption style". His ask,
 * 2026-07-28: *"make it so I can save custom effects for each time it makes a
 * new one."* Saving is the instruction, so it takes effect.
 *
 * The length settings come from the current default, because a look picked off
 * one caption says nothing about how long captions should be. Saved off the
 * highlighted word, that word's colour becomes the highlight colour and the
 * plain words keep the default's colour, instead of every caption turning yellow.
 */
export function saveCaptionStyleFromClip(clipId: string, name?: string): CaptionStyle | null {
  const seq = activeSequence(useStore.getState().project)
  const clip = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (!clip?.title) return null
  const base = defaultCaptionStyle()
  const look = lookOfTitle(clip.title)
  let emphasisColor = base.emphasisColor
  if (clip.captionEmphasis) {
    emphasisColor = clip.title.color
    look.color = captionDefFor(base, '', seq.height).color
  }
  const style = saveNewCaptionStyle({
    name: name ?? `Style ${useCaptionStyles.getState().saved.length + 1}`,
    look,
    refHeight: seq.height,
    shape: base.shape,
    emphasisColor,
    ...(clip.appearance ? { appearance: clip.appearance } : {}),
    ...(clip.effects.length ? { effects: clip.effects.map((e) => ({ ...e })) } : {}),
  })
  setDefaultCaptionStyle(style.id)
  return style
}

// ---------------------------------------------------------------------------
// The second home: `Caption styles.json` beside his project files.

/** The desktop half: one file, read and written whole. */
export interface CaptionStylesHomeApi {
  captionStylesWrite(json: string): Promise<void>
  captionStylesRead(): Promise<string | null>
}

/** The desktop api, or null in the browser build where there is no disk. */
export function captionStylesHomeApi(): CaptionStylesHomeApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  if (!api || typeof api.captionStylesWrite !== 'function' || typeof api.captionStylesRead !== 'function') return null
  return api
}

/**
 * Which copy wins at launch. The file, when it holds something of his and was
 * saved after the quick copy: that is what a wiped profile looks like, and also
 * a change made in a session whose quick copy did not stick. Otherwise the
 * quick copy is the truth, and the file is brought up to it, but only when there
 * is something of his to write.
 */
export function homeDecision(
  local: Pick<CaptionStylesState, 'saved' | 'defaultId' | 'savedAt'>,
  file: CaptionStylesSnapshot | null,
): 'adopt-file' | 'write-file' | 'nothing' {
  if (file && snapshotHasHis(file) && file.savedAt > local.savedAt) return 'adopt-file'
  return hasHis(local) ? 'write-file' : 'nothing'
}

let homeKept = false
let homeTimer: ReturnType<typeof setTimeout> | undefined

function writeHome(api: CaptionStylesHomeApi): void {
  const json = JSON.stringify(snapshotOf(useCaptionStyles.getState()))
  void api.captionStylesWrite(json).catch((err: unknown) => {
    console.warn('OL Premiere: the caption styles file could not be written', err)
  })
}

/**
 * Read the file back, keep whichever copy is newer, and keep the file current
 * from here on. Run once at launch, behind the card: nothing waits on it.
 *
 * ⛔ A LAUNCH WITH NOTHING OF HIS NEVER WRITES. A profile that came up empty
 * must not overwrite the one file that still holds his styles; it writes only
 * once he changes something himself.
 */
export async function initCaptionStyles(): Promise<void> {
  // The quick copy may have been renamed into place after this module first
  // read it (keyMigration runs at boot), so an empty list asks once more.
  if (!hasHis(useCaptionStyles.getState())) useCaptionStyles.setState(readLocal())
  const api = captionStylesHomeApi()
  if (!api || homeKept) return
  homeKept = true
  const snap = parseCaptionStyles(await api.captionStylesRead().catch(() => null))
  const cur = useCaptionStyles.getState()
  const decision = homeDecision(cur, snap)
  if (decision === 'adopt-file' && snap) {
    const cameBack = cur.saved.length === 0 && snap.styles.length > 0
    useCaptionStyles.setState({ saved: snap.styles, defaultId: snap.defaultId, savedAt: snap.savedAt })
    writeLocal(useCaptionStyles.getState())
    if (cameBack) useToasts.getState().show('Your caption styles came back from their file', 'success')
  } else if (decision === 'write-file') {
    writeHome(api)
  }
  useCaptionStyles.subscribe((next, prev) => {
    if (next.saved === prev.saved && next.defaultId === prev.defaultId) return
    clearTimeout(homeTimer)
    homeTimer = setTimeout(() => writeHome(api), 300)
  })
}

/** Test seam: read the quick copy again, as a fresh launch would. */
export function reloadCaptionStyles(): void {
  useCaptionStyles.setState(readLocal(), true)
}
