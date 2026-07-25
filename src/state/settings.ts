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
   * Auto-keyframe: moving or scaling a clip in the monitor ANIMATES it instead
   * of moving the whole clip. Off by default — a drag should not secretly start
   * an animation until you have asked for that mode.
   */
  autoKeyframe: boolean
}

const THEME_KEY = 'reel:settings:theme'
const QUALITY_KEY = 'reel:settings:preview-quality'
const AUTOKEY_KEY = 'reel:settings:auto-keyframe'

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

export const useSettings = create<SettingsState>(() => ({
  theme: loadTheme(),
  previewQuality: loadQuality(),
  autoKeyframe: read(AUTOKEY_KEY) === '1',
}))

export function setAutoKeyframe(on: boolean): void {
  useSettings.setState({ autoKeyframe: on })
  write(AUTOKEY_KEY, on ? '1' : null)
}

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
