// The single central keymap. Every shortcut in the app registers here so the
// full map can be audited. "mod" is Ctrl on Windows/Linux and Cmd on macOS.
//
// ⛔ NOTHING RENDERS THIS LIST ANY MORE. The command palette and the shortcut
// sheet were both cut on 2026-08-17, on his word, when he was asked which of the
// features are useless: two surfaces answering one question, so at most one of
// them earned its place and he took both. **A shortcut still reaches him**, on
// the tooltip of the button that shares it, which is what `comboLabel` is for
// and why it survived the cut with its three callers. → D114
//
// So the search, the grouping and the fuzzy matcher went with them, along with
// the two domain tables that only they read. What is left is the shape, the
// dispatch and the label.

import { noteShortcut } from './state/usageNotes'

/**
 * What a shortcut is FOR. ⛔ Unread since 2026-08-17, because the two surfaces that
 * rendered it were cut that day. Kept at one word per binding: it is the only thing
 * this file has to say what a key is about, and the keyframe work adds a seventh
 * group to it. First thing to delete if that work lands without needing it.
 */
export type BindingDomain = 'transport' | 'selection' | 'trim' | 'tools' | 'view' | 'project' | 'motion'

export interface Binding {
  combo: string
  description: string
  domain: BindingDomain
  run: (e: KeyboardEvent) => void
  /**
   * Let the browser's own action for the key run as well. Only Ctrl+V wants it:
   * a copied picture arrives on the browser's paste event, and Chromium fires
   * that event ONLY when the keydown was left alone (state/picturePaste.ts).
   */
  allowDefault?: boolean
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')
  let key = e.key.toLowerCase()
  if (key === ' ') key = 'space'
  parts.push(key)
  return parts.join('+')
}

/** A text field, where typing and pasting belong to the field and never to a shortcut. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

/** Install the keymap on window. Returns an uninstall function. */
export function installKeymap(bindings: Binding[]): () => void {
  const byCombo = new Map(bindings.map((b) => [b.combo, b]))
  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return
    const combo = comboFromEvent(e)
    const binding = byCombo.get(combo)
    if (!binding) return
    if (!binding.allowDefault) e.preventDefault()
    // The usage log: which key, and what it is for. Before the run, so the log reads in order.
    noteShortcut(combo, binding.description, e.repeat)
    binding.run(e)
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}

/**
 * One row per command: aliases (same description, e.g. Redo on mod+shift+z and
 * mod+y, or the three '?' interpretations) collapse to their first combo.
 */
export function comboLabel(combo: string): string {
  return combo
    .split('+')
    .map((part) => {
      switch (part) {
        case 'mod':
          return isMac ? '⌘' : 'Ctrl'
        case 'shift':
          return 'Shift'
        case 'alt':
          return isMac ? '⌥' : 'Alt'
        case 'space':
          return 'Space'
        default:
          return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)
      }
    })
    .join('+')
}
