// App-level preferences: the things you ARE, as opposed to the things you DO
// (those live on the command palette). One persisted home so preferences stop
// breeding in the corners of dialogs and dropdown chevrons.

import { create } from 'zustand'

export type ThemeChoice = 'dark' | 'light' | 'system' | 'claude'

/** The concrete themes that map to a data-theme attribute (dark is the default). */
export type ResolvedTheme = 'dark' | 'light' | 'claude'

/** Preview render scale. 1 = full sequence resolution. */
export type PreviewQuality = 1 | 0.5 | 0.25

interface SettingsState {
  theme: ThemeChoice
  /** Preview quality, shared by the Settings dialog and the monitor's own picker. */
  previewQuality: PreviewQuality
  /**
   * How long an effect's Ease In / Ease Out runs, in seconds.
   *
   * A TOOL setting, like a brush size, not a fact about any one clip. It used to
   * be component state inside the ease row, so it snapped back to 0.5 every time
   * the card went away: click the next clip, fold the panel, and the length he
   * had just dialled in was gone. Living here it survives the panel and the
   * session, and it stays off the project file and out of the undo stack, where
   * a tool setting has no business being.
   */
  easeSeconds: number
}

/** The ease field's own envelope. Shared by the store clamp and the scrub field. */
export const EASE_SECONDS = { min: 0.05, max: 5, step: 0.05, sens: 0.02 } as const
const EASE_DEFAULT = 0.5

// Auto-keyframe used to live here as a persisted global. It does not any more:
// whether a drag animates is now a fact about the CLIP, derived from whether any
// of posX, posY, scale or rotation already carries keyframes. A preference that
// outlived the clip it was set for meant the same drag meant two different
// things on two different nights, and it could desync from what actually
// rendered. Derived, it is always visible in the lanes and can never lie.

const THEME_KEY = 'olpremiere:settings:theme'
const QUALITY_KEY = 'olpremiere:settings:preview-quality'
const EASE_KEY = 'olpremiere:settings:ease-seconds'

function read(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Private mode / quota: the in-memory choice still applies for this run.
  }
}

function loadTheme(): ThemeChoice {
  const v = read(THEME_KEY)
  return v === 'light' || v === 'system' || v === 'claude' ? v : 'dark'
}

function loadQuality(): PreviewQuality {
  const v = Number(read(QUALITY_KEY))
  return v === 0.5 || v === 0.25 ? v : 1
}

/** Clamp to the field's own envelope, so a hand-edited key can never wedge it. */
function clampEase(v: number): number {
  if (!Number.isFinite(v)) return EASE_DEFAULT
  return Math.min(EASE_SECONDS.max, Math.max(EASE_SECONDS.min, v))
}

function loadEaseSeconds(): number {
  const raw = read(EASE_KEY)
  if (raw === null) return EASE_DEFAULT
  return clampEase(Number(raw))
}

export const useSettings = create<SettingsState>(() => ({
  theme: loadTheme(),
  previewQuality: loadQuality(),
  easeSeconds: loadEaseSeconds(),
}))

/** The theme actually in force: 'system' resolves against the OS preference. */
export function resolvedTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== 'system') return choice
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * Stamp the resolved theme on <html>. Light and Claude each key off their own
 * data-theme value; dark is the token default, so the attribute is REMOVED
 * rather than set, keeping dark the zero-config baseline.
 */
function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return
  const resolved = resolvedTheme(choice)
  if (resolved === 'dark') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = resolved
}

export function setTheme(choice: ThemeChoice): void {
  useSettings.setState({ theme: choice })
  write(THEME_KEY, choice === 'dark' ? null : choice)
  applyTheme(choice)
}

export function setPreviewQuality(q: PreviewQuality): void {
  useSettings.setState({ previewQuality: q })
  write(QUALITY_KEY, q === 1 ? null : String(q))
}

/** Remember the ease length he last dialled in, for every effect card after it. */
export function setEaseSeconds(seconds: number): void {
  const next = clampEase(seconds)
  useSettings.setState({ easeSeconds: next })
  write(EASE_KEY, next === EASE_DEFAULT ? null : String(next))
}

/**
 * Apply the stored theme at boot and follow the OS while the choice is
 * 'system'. Called once from main.tsx before React mounts, so there is no
 * flash of the wrong ground.
 */
export function initSettings(): void {
  applyTheme(useSettings.getState().theme)
  if (typeof window === 'undefined' || !window.matchMedia) return
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  mq.addEventListener?.('change', () => {
    if (useSettings.getState().theme === 'system') applyTheme('system')
  })
}
