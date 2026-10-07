// Writing what he typed in a text field into the project WITHOUT taking him out
// of the field. No imports, so the keymap, the save and the fields can all use it.
//
// ⛔ WHY: caption, title, name and number fields write to the project when they
// lose focus. Before 2026-10-07 Ctrl+S from inside one (and the save a close
// waits for) BLURRED the field to get his words into the save, which left the
// focus on the page: his next keys were shortcuts, not letters. Backspace deleted
// the clip he was typing a title for, C cut it, Space played. Putting the focus
// back afterwards was not enough either, because a caption row is rebuilt once
// its words are written, so the field he was in was gone.
//
// So the field is told it was left (the focus-out its onBlur listens to) while
// the caret stays exactly where it is. A field whose blur also CLOSES it (a time
// that turns back into a button, a number field that goes back to scrubbing)
// asks isCommitInPlace and stays open.

const inPlace = new WeakSet<Event>()

/** Have `el` write what he typed, as if he had left it, and leave him in it. */
export function commitField(el: HTMLElement): void {
  // A real focus change fires blur on the field, then focusout, which bubbles
  // and is the one React's onBlur listens to.
  for (const ev of [new FocusEvent('blur'), new FocusEvent('focusout', { bubbles: true })]) {
    inPlace.add(ev)
    el.dispatchEvent(ev)
  }
}

/** The field he is in, if any, writes what he typed. The caret does not move. */
export function commitFocusedField(): void {
  if (typeof document === 'undefined') return
  const el = document.activeElement
  if (el instanceof HTMLElement && el !== document.body) commitField(el)
}

/**
 * True for the focus-out commitField sends: write, and stay open. A field that
 * closes when it is left checks this in its onBlur.
 */
export function isCommitInPlace(e: { nativeEvent: Event }): boolean {
  return inPlace.has(e.nativeEvent)
}
