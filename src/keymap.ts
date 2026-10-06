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
  /**
   * Keep working while a window or a menu is open over the edit. Only for keys that do not
   * touch the edit itself: saving it and reloading the app.
   */
  overWindows?: boolean
}

/**
 * A window or a menu that sits over the edit. While one is open the edit's keys wait for it.
 *
 * ⛔ THEY USED TO GO STRAIGHT THROUGH (found 2026-10-06). With Projects open, the list where he
 * deletes projects, Delete took the selected clip off the timeline behind it; Space played and
 * Ctrl+Z undid edits he could not see. Escape is not lost: every window and menu listens for it
 * itself (ui/useEscapeToClose.ts and the menus' own listeners).
 */
const OVER_THE_EDIT = '[aria-modal="true"], [data-esc-owner]'

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

/** Fields that take typing. Checkboxes, ranges, selects, buttons and the like do not count. */
export const TYPING_FIELD = [
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  ...['text', 'search', 'number', 'email', 'url', 'tel', 'password'].map((t) => `input[type="${t}"]`),
  'input:not([type])',
].join(',')

/** A text field, where typing and pasting belong to the field and never to a shortcut. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.matches(TYPING_FIELD)
}

/** The slider, tick box or select a key landed on, if it landed on one. */
function controlOf(el: HTMLElement): HTMLElement | null {
  return el.closest('select') ?? (el.tagName === 'INPUT' ? el : null)
}

/** A select whose list is open. Its arrows, Enter and Escape move and close the list. */
function isOpenList(control: HTMLElement): boolean {
  if (control.tagName !== 'SELECT') return false
  try {
    return control.matches(':open')
  } catch {
    return false // a browser that cannot tell: the list is not ours to steal from either way
  }
}

/** Install the keymap on window. Returns an uninstall function. */
export function installKeymap(bindings: Binding[]): () => void {
  const byCombo = new Map(bindings.map((b) => [b.combo, b]))
  // ⛔ A CLICKED SLIDER, TICK BOX OR SELECT GIVES THE KEYS BACK TO THE EDIT (2026-10-06). It keeps
  // the focus after the click, and every key used to stay in it: after he set a clip's volume, the
  // two taps of Right he meant as "two frames on" turned the volume up 1 dB as an undo step, and
  // Space did not play. The edit tabs made the same choice (EditTabs.tsx). One he reached with Tab
  // keeps its keys, and an open list always does. Not :focus-visible for "reached with Tab":
  // Chromium turns it on for a clicked control at the first key he presses.
  let pointing = false
  let clicked: HTMLElement | null = null
  const onPointerDown = () => {
    pointing = true
  }
  const onAnyKey = () => {
    pointing = false
  }
  const onFocusIn = (e: FocusEvent) => {
    const control = e.target instanceof HTMLElement ? controlOf(e.target) : null
    // Focus moving between a select and its own open list is still the same click.
    if (control && control === clicked) return
    clicked = pointing ? control : null
  }
  const keysStayIn = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false
    if (isEditableTarget(target)) return true
    const control = controlOf(target)
    if (!control) return false
    return isOpenList(control) || control !== clicked
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (keysStayIn(e.target)) return
    const combo = comboFromEvent(e)
    const binding = byCombo.get(combo)
    if (!binding) return
    if (!binding.overWindows && document.querySelector(OVER_THE_EDIT)) return
    if (!binding.allowDefault) e.preventDefault()
    // The usage log: which key, and what it is for. Before the run, so the log reads in order.
    noteShortcut(combo, binding.description, e.repeat)
    binding.run(e)
  }
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onAnyKey, true)
  window.addEventListener('focusin', onFocusIn, true)
  window.addEventListener('keydown', onKeyDown)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onAnyKey, true)
    window.removeEventListener('focusin', onFocusIn, true)
    window.removeEventListener('keydown', onKeyDown)
  }
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
