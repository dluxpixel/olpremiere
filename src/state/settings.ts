// App-level preferences: the things you ARE, as opposed to the things you DO
// (those live on the command palette). One persisted home so preferences stop
// breeding in the corners of dialogs and dropdown chevrons.

import { create } from 'zustand'

export type ThemeChoice = 'dark' | 'light' | 'system'

/** Preview render scale. 1 = full sequence resolution. */
export type PreviewQuality = 1 | 0.5 | 0.25

interface SettingsState {
  theme: ThemeChoice
  /** Preview quality NEW monitors open at; the monitor's own picker still wins for the session. */
  previewQuality: PreviewQuality
}

const THEME_KEY = 'reel:settings:theme'
const QUALITY_KEY = 'reel:settings:preview-quality'

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
  return v === 'light' || v === 'system' ? v : 'dark'
}

function loadQuality(): PreviewQuality {
  const v = Number(read(QUALITY_KEY))
  return v === 0.5 || v === 0.25 ? v : 1
}

export const useSettings = create<SettingsState>(() => ({
  theme: loadTheme(),
  previewQuality: loadQuality(),
}))

/** The theme actually in force: 'system' resolves against the OS preference. */
export function resolvedTheme(choice: ThemeChoice): 'dark' | 'light' {
  if (choice !== 'system') return choice
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * Stamp the resolved theme on <html>. The light overrides key off
 * data-theme='light'; dark is the token default, so the attribute is REMOVED
 * rather than set, keeping dark the zero-config baseline.
 */
function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return
  const resolved = resolvedTheme(choice)
  if (resolved === 'light') document.documentElement.dataset.theme = 'light'
  else delete document.documentElement.dataset.theme
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
