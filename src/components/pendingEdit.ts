/**
 * The uncommitted text of a number field, and WHO it belongs to.
 *
 * A field's `onCommit` prop is rebuilt on every render and closes over whatever
 * clip was selected at THAT render, so selecting another clip swaps the callback
 * out from under a field that is still mid-edit: the typed text belongs to the
 * old clip, the live callback writes to the new one. Clicking the next clip
 * blurs the field AFTER that swap, which is how a typed volume used to land on
 * the wrong clip (or vanish when the panel unmounted without ever blurring).
 *
 * So the commit callback - and the value the edit started from - are frozen the
 * instant the edit opens. Whatever ends the edit first (blur, Enter, unmount)
 * flushes ONCE, against the clip the number was typed for.
 */

/** What an open edit writes to. Frozen when the edit opened. */
export interface EditOwner {
  /** Writes to the clip that owned the field when typing started. */
  onCommit: (v: number) => void
  /** The value on screen when the edit opened - an untouched field writes nothing. */
  base: number
  /** Clamp + step-round, exactly as the field itself would. */
  normalize: (v: number) => number
  /** Text to number, for a field whose text is not a plain number (a timecode
   *  row types "00:00:04:12"). null rejects the edit and writes nothing.
   *  Omitted: Number(), which is what a numeric field wants. */
  parse?: (text: string) => number | null
}

export interface PendingEdit {
  /** Open an edit. A second call while one is open keeps the FIRST owner. */
  begin: (owner: EditOwner) => void
  /** Remember the text as typed. Ignored when no edit is open. */
  type: (text: string) => void
  /** Re-baseline after a path that already committed (an arrow nudge), so the
   *  blur that follows does not write the same value a second time. */
  settle: (base: number) => void
  /** Escape: abandon. Everything after this writes nothing. */
  cancel: () => void
  /** Commit the typed text to its owner, at most once. Returns what it wrote. */
  flush: () => number | null
}

export function createPendingEdit(): PendingEdit {
  let owner: EditOwner | null = null
  // null = opened but never typed into. Distinct from '', which the field has
  // always committed as 0.
  let text: string | null = null

  return {
    begin(next) {
      // Re-entering edit on an already-open field (focus, then a double-click
      // to select-all) must not drop what is already typed, nor re-point the
      // edit at whatever clip is selected now.
      if (owner) return
      owner = next
      text = null
    },

    type(next) {
      if (owner) text = next
    },

    settle(base) {
      if (!owner) return
      owner = { ...owner, base }
      text = null
    },

    cancel() {
      owner = null
      text = null
    },

    flush() {
      const o = owner
      const typed = text
      // One-shot: Enter blurs, and a blur after an unmount-flush must be silent.
      owner = null
      text = null
      if (!o || typed === null) return null
      const n = o.parse ? o.parse(typed) : Number(typed)
      // Unparseable text writes nothing. It must never fall through as 0, which
      // on a timecode row would move the clip to the head of the sequence.
      if (n === null || !Number.isFinite(n)) return null
      const next = o.normalize(n)
      // Unchanged writes nothing at all: mapClip rebuilds the sequence even for
      // an identical clip, so a no-op commit would land an empty undo step.
      if (Math.abs(next - o.base) <= 1e-9) return null
      o.onCommit(next)
      return next
    },
  }
}
