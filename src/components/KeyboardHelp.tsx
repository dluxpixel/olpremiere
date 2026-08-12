import { Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { comboLabel, groupBindings, searchBindings, type Binding } from '../keymap'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'

// Mouse gestures are half the editor's power and live in NO keymap, so they are
// documented by hand here.
//
// ⛔ AND BEING HAND-WRITTEN, IT HAD ALREADY FALLEN BEHIND, found 2026-08-12. Two
// shipped gestures were missing: selecting several clips by dragging a box, and
// the right-button drag that does the same thing. **Selecting by dragging is a
// gesture he asked for by name**, and the one screen in the app that lists mouse
// gestures was telling him it did not exist. Every other entry was checked
// against the pointer handlers on the same day and the rest were correct.
//
// This list cannot be generated the way the keyboard half below is, because
// gestures are branches inside pointer handlers rather than entries in a table.
// So it stays hand-written, and it stays a thing to re-read whenever a pointer
// handler grows a new branch.
const GESTURES: { action: string; how: string }[] = [
  { action: 'Move clip', how: 'Drag clip body' },
  { action: 'Trim edge', how: 'Drag clip edge' },
  { action: 'Ripple trim', how: 'Ctrl + drag edge' },
  { action: 'Rate stretch (retime)', how: 'Alt + drag edge' },
  { action: 'Roll edit (move the cut)', how: 'Ctrl + Alt + drag edge' },
  { action: 'Slip source', how: 'Alt + drag body' },
  { action: 'Slide clip (neighbours absorb)', how: 'Ctrl + Alt + drag body' },
  { action: 'Add / remove to selection', how: 'Shift + click clip' },
  { action: 'Select several clips (box)', how: 'Shift + drag empty lane, or right-button drag' },
  { action: 'Add several clips to the selection', how: 'Ctrl + drag empty lane' },
  { action: 'Zoom at cursor', how: 'Ctrl + mouse wheel' },
  { action: 'Apply effect / transition', how: 'Drag from Effects panel onto a clip' },
  { action: 'Fade in / out', how: 'Drag a clip top corner' },
  { action: 'Scrub playhead', how: 'Click / drag empty lane' },
]

/**
 * Shortcuts overlay (press `?`). A searchable cheat sheet grouped by domain,
 * generated from the live keymap so it can never drift from the actual
 * bindings. Aliases (same description) collapse to their first combo.
 */
export function KeyboardHelp({ bindings }: { bindings: Binding[] }) {
  const open = useStore((s) => s.ui.helpOpen)
  const setUI = useStore((s) => s.setUI)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUI({ helpOpen: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setUI])

  const q = query.trim()
  // Grouped always; a query prunes rows inside each group (fuzzy, same
  // matcher as the command palette) and drops emptied groups.
  const groups = useMemo(() => {
    const all = groupBindings(bindings)
    if (q === '') return all
    const keep = new Set(searchBindings(bindings, q).map((b) => b.description))
    return all
      .map((g) => ({ ...g, rows: g.rows.filter((b) => keep.has(b.description)) }))
      .filter((g) => g.rows.length > 0)
  }, [bindings, q])

  const gestures = useMemo(() => {
    if (q === '') return GESTURES
    const needle = q.toLowerCase()
    return GESTURES.filter((g) => `${g.action} ${g.how}`.toLowerCase().includes(needle))
  }, [q])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6"
      data-testid="keyboard-help"
      onClick={() => setUI({ helpOpen: false })}
    >
      <div
        className="flex max-h-[80vh] w-[620px] max-w-full flex-col overflow-hidden rounded-dialog border border-border bg-bg-panel shadow-pop"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-panel px-4 py-3">
          <h2 className="shrink-0 text-ui font-semibold text-text-primary">Keyboard shortcuts</h2>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-field border border-border bg-bg-input px-2 py-1 focus-within:border-border-strong">
            <Search size={14} strokeWidth={1.5} className="shrink-0 text-text-muted" />
            <input
              type="text"
              data-testid="help-search"
              placeholder="Search shortcuts"
              aria-label="Search shortcuts"
              className="w-full bg-transparent text-ui-sm text-text-primary outline-none placeholder:text-text-muted"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <IconButton label="Close shortcuts" onClick={() => setUI({ helpOpen: false })}>
            <X size={16} strokeWidth={1.5} />
          </IconButton>
        </div>

        <div className="min-h-0 overflow-y-auto">
          {groups.length === 0 && gestures.length === 0 && (
            <div className="px-4 py-6 text-center text-ui text-text-muted">
              No shortcuts match
            </div>
          )}

          {groups.map((g) => (
            <div key={g.domain} className="px-4 pt-3 last:pb-4">
              <h3 className="pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
                {g.label}
              </h3>
              <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {g.rows.map((b) => (
                  <div key={b.description} className="flex items-center justify-between gap-3 text-ui-sm">
                    <span className="truncate text-text-secondary">{b.description}</span>
                    <kbd className="shrink-0 rounded-[4px] border border-border bg-bg-input px-1.5 py-0.5 font-numeric text-dense text-text-primary">
                      {comboLabel(b.combo)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {gestures.length > 0 && (
            <div className="mt-3 border-t border-border px-4 pb-4 pt-3">
              <h3 className="pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
                Mouse gestures
              </h3>
              <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {gestures.map((g) => (
                  <div key={g.action} className="flex items-center justify-between gap-3 text-ui-sm">
                    <span className="truncate text-text-secondary">{g.action}</span>
                    <span className="shrink-0 text-dense text-text-muted">{g.how}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
