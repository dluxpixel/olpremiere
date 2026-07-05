// The single central keymap. Every shortcut in the app registers here so the
// full map can be audited (and later rendered as a help sheet). "mod" is Ctrl
// on Windows/Linux and Cmd on macOS.

export interface Binding {
  combo: string
  description: string
  run: (e: KeyboardEvent) => void
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

function isEditableTarget(target: EventTarget | null): boolean {
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
    const binding = byCombo.get(comboFromEvent(e))
    if (!binding) return
    e.preventDefault()
    binding.run(e)
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}

/** Human-readable shortcut label for tooltips, e.g. "Ctrl+Shift+Z". */
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
