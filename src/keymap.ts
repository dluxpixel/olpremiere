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

import { commitField } from './fieldCommit'
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
   * Also runs while he is typing in a text field, after that field has written
   * what he typed to the project, and he stays in the field. Only Ctrl+S wants
   * it: a save that does nothing from inside a caption is the moment he trusts
   * it most.
   */
  inFields?: boolean
  /**
   * Keep working while a window or a menu is open over the edit. Only for keys that do not
   * touch the edit itself: saving it and reloading the app.
   */
  overWindows?: boolean
  /**
   * A key that means something only while it is held (the Before picture). `run` starts it, and
   * this ends it: when the key comes up, or the window loses the focus with the key still down
   * (a keyup then goes to nobody, and the hold would never end). `run` has to be safe to call
   * twice, since a held key repeats.
   */
  onRelease?: () => void
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

/** Is a window or a menu open over the edit? Its keys, and Ctrl+V's paste event, wait while one is. */
export function windowOverTheEdit(): boolean {
  return typeof document !== 'undefined' && document.querySelector(OVER_THE_EDIT) !== null
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

/** The keys whose place on the keyboard is what a binding means, by `KeyboardEvent.code`. */
const PLACES: Record<string, string> = {
  Slash: '/',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
}

/** What the key at this place types on a US keyboard, or null for a key no binding uses. */
function keyAtPlace(code: string | undefined): string | null {
  if (!code) return null
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  return PLACES[code] ?? null
}

/**
 * Every combo a key press can mean, best first: what he typed; then that character without
 * the Shift or AltGr his layout needed to make it; then the key at that place on the keyboard.
 *
 * ⛔ ON A CZECH KEYBOARD THE NUMBER KEYS, LOOP, THE KEYFRAME JUMPS AND ZOOM TO FIT COULD NOT BE
 * PRESSED (found 2026-10-06). The bindings are written as characters, and Czech QWERTZ types
 * `+ ě š č ř ž ý á í é` on the number row (the digits need Shift), `/` is Shift+ú, `[ ] \` need
 * AltGr (which arrives as Ctrl+Alt), and AltGr+C and AltGr+V type `& @`. So "1", "/", "[" and
 * Ctrl+Alt+C arrived as something no binding has. The cut help sheet once knew this for `?`.
 * A US keyboard is unchanged: what it types matches first, and nothing falls through to a
 * second binding.
 */
export function combosFromEvent(e: KeyboardEvent): string[] {
  const out = [comboFromEvent(e)]
  const key = e.key
  // Windows and Linux report AltGr as Ctrl and Alt held together. But AltGr never types a digit:
  // where AltGr exists the digits are on the number row, with or without Shift. So a digit under
  // Ctrl+Alt is Ctrl+Alt and a digit, which no binding has. Without this, Ctrl+Alt+1 on a US
  // keyboard ran Move 1, a key that had never done anything (found 2026-10-08).
  const altGr = !isMac && e.ctrlKey && e.altKey && !/^[0-9]$/.test(key)
  if (key.length === 1 && key !== ' ' && !/\p{L}/u.test(key) && (altGr || e.shiftKey)) {
    const parts: string[] = []
    if (!altGr && (isMac ? e.metaKey : e.ctrlKey)) parts.push('mod')
    if (!altGr && e.altKey) parts.push('alt')
    parts.push(key)
    out.push(parts.join('+'))
  }
  const place = keyAtPlace(e.code)
  if (place) {
    out.push(
      comboFromEvent({ key: place, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey } as KeyboardEvent),
    )
  }
  return [...new Set(out)]
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
  //
  // ⛔ AND THE CLICK ENDS WHEN THE FOCUS LEAVES THE CONTROL (found 2026-10-08). "Clicked" outlived
  // the click: he clicked the volume slider, clicked the timeline (which takes no focus), and when he
  // later reached the slider with Tab it still counted as clicked, so the arrows stepped frames
  // instead of moving it. The other way round, a slider he reached with Tab and THEN clicked was never
  // marked, because a click on a control that already has the focus fires no focusin: Right still
  // turned the volume up.
  let pointing = false
  let clicked: HTMLElement | null = null
  const onPointerDown = (e: PointerEvent) => {
    pointing = true
    const control = e.target instanceof HTMLElement ? controlOf(e.target) : null
    if (control && control === document.activeElement) clicked = control
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
  const onFocusOut = (e: FocusEvent) => {
    const was = clicked
    if (!was) return
    const to = e.relatedTarget
    // Into its own open list: the same click.
    if (to instanceof Node && was.contains(to)) return
    if (to) {
      clicked = null
      return
    }
    // Focus going nowhere named: a click on something that takes no focus, or the whole window
    // losing the focus. The window keeps its focused element, so only the first lets go.
    setTimeout(() => {
      const now = document.activeElement
      if (clicked === was && !(now && was.contains(now))) clicked = null
    }, 0)
  }
  const keysStayIn = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false
    if (isEditableTarget(target)) return true
    const control = controlOf(target)
    if (!control) return false
    return isOpenList(control) || control !== clicked
  }
  // The key being held for a binding that has an `onRelease`, by the place it sits on the keyboard.
  let held: { code: string; binding: Binding } | null = null
  const release = () => {
    const was = held
    held = null
    was?.binding.onRelease?.()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const inField = isEditableTarget(e.target)
    const combo = combosFromEvent(e).find((c) => byCombo.has(c))
    const binding = combo === undefined ? undefined : byCombo.get(combo)
    if (!combo || !binding) return
    // A text field, a clicked-away slider, tick box or select keep their keys. The one binding
    // that says `inFields` (Ctrl+S) is not a key of any of them, so it runs from all of them.
    if (!binding.inFields && keysStayIn(e.target)) return
    // A window or a menu open over the edit keeps its keys too, unless the binding says
    // `overWindows` (saving, reloading): those leave the edit alone.
    if (!binding.overWindows && windowOverTheEdit()) return
    if (!binding.allowDefault) e.preventDefault()
    // Caption, title and name fields write to the project when they lose focus,
    // so the field is told it was left, which puts his last words in the save.
    // ⛔ TOLD, NOT LEFT: a real blur put his next keys on the editor, and the
    // Backspace after Ctrl+S deleted the clip he was typing for. See fieldCommit.ts.
    if (inField) commitField(e.target as HTMLElement)
    // The usage log: which key, and what it is for. Before the run, so the log reads in order.
    noteShortcut(combo, binding.description, e.repeat)
    binding.run(e)
    if (binding.onRelease) held = { code: e.code || e.key, binding }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (held && (e.code || e.key) === held.code) release()
  }
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onAnyKey, true)
  window.addEventListener('focusin', onFocusIn, true)
  window.addEventListener('focusout', onFocusOut, true)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', release)
  return () => {
    release()
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onAnyKey, true)
    window.removeEventListener('focusin', onFocusIn, true)
    window.removeEventListener('focusout', onFocusOut, true)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', release)
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
        // The keyframe lane's tooltip read "Alt+Arrowleft", a key no keyboard has.
        case 'arrowleft':
          return 'Left'
        case 'arrowright':
          return 'Right'
        case 'arrowup':
          return 'Up'
        case 'arrowdown':
          return 'Down'
        case 'escape':
          return 'Esc'
        default:
          return part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)
      }
    })
    .join('+')
}
