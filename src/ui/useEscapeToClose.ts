import { useEffect, useRef } from 'react'

// Escape closes a dialog (2026-10-03). The Projects dialog and the Recording studio did not listen
// for it at all, and the ones that did each had a private window listener, so two dialogs open at
// once (Settings, then the name prompt it opens) both closed on one press.
//
// One listener, and a stack of the dialogs that are open, newest last. Escape goes to the newest
// only, and only when nothing inside it has a claim on the key first:
//
//   - a menu or popover that is open (marked data-esc-owner) closes itself on this same press, so
//     the dialog under it must not;
//   - a field that handles Escape itself (cancel an edit, back out of a rename) stops the event
//     where it is, the way NamePrompt does, and it never gets here. preventDefault is NOT the
//     signal: the global keymap preventDefaults every key it owns, Escape included, before this
//     listener runs, so reading it would make every dialog deaf to the key;
//   - a text field being typed in lets go first: the first Escape leaves the field, the next one
//     closes the dialog, so a pasted script or a half-typed name is not lost to a stray key.

interface Layer {
  close: () => void
}

const layers: Layer[] = []
let installed = false

/**
 * Whether a menu was open at the moment the key went down, written by a listener that runs
 * before everyone else's. A menu closes itself on this same press and React can take it off the
 * page between two listeners, so asking again later would find it gone and close the dialog too.
 */
let menuAtKeydown: { event: Event; open: boolean } | null = null
const MENU = '[data-esc-owner]'

function noteMenu(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuAtKeydown = { event: e, open: document.querySelector(MENU) !== null }
}

/** Fields that take typing. Checkboxes, ranges, buttons and the like do not count. */
const TYPING = [
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  ...['text', 'search', 'number', 'email', 'url', 'tel', 'password'].map((t) => `input[type="${t}"]`),
  'input:not([type])',
].join(',')

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const top = layers[layers.length - 1]
  if (!top) return
  if (menuAtKeydown?.event === e ? menuAtKeydown.open : document.querySelector(MENU) !== null) return
  const target = e.target
  if (target instanceof HTMLElement && target.matches(TYPING)) {
    target.blur()
    e.preventDefault()
    return
  }
  e.preventDefault()
  top.close()
}

/**
 * Close this dialog on Escape while `active` (default: while mounted). `close` may be a new
 * function every render; the latest one is the one called.
 */
export function useEscapeToClose(close: () => void, active = true): void {
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!active) return
    const layer: Layer = { close: () => latest.current() }
    layers.push(layer)
    if (!installed) {
      window.addEventListener('keydown', noteMenu, true)
      window.addEventListener('keydown', onKeyDown)
      installed = true
    }
    return () => {
      const at = layers.indexOf(layer)
      if (at >= 0) layers.splice(at, 1)
    }
  }, [active])
}

/** How many dialogs are listening. For tests. */
export function openEscapeLayers(): number {
  return layers.length
}
