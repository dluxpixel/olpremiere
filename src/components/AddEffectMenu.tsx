// The inspector's Add effect control: a button, a search box, and rows.
//
// ⛔ THIS MENU WAS BUILT ONCE AND TAKEN BACK OUT, and the note that matters is
// WHY, so it does not go back in the same way. The popup did not open reliably,
// four end to end runs failed in a different test each time, and the shape that
// does that is a document listener registered while the opening click is still
// travelling. React's own handlers run at the root, and the document sits ABOVE
// the root on the way up, so a `document.addEventListener('mousedown', close)`
// added inside the button's own handler still receives that very click and shuts
// the menu the instant it opens. It depends on timing, which is why it looked
// like flakiness rather than a bug.
//
// So there is no document listener here at all. An outside click is caught by a
// backdrop element that only exists while the menu is open, and it cannot exist
// during the click that opened it. Nothing about that is timing dependent.
//
// The rows, the filtering and the keyboard arithmetic are in
// `engine/effects/addMenu.ts`, where unit tests can drive them without a browser.

import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { addMenuRows, highlightedRow, nextHighlight } from '../engine/effects/addMenu'
import { applyEffect } from '../state/clipEdits'
import { useRecentEffects } from '../state/recentEffects'

export function AddEffectMenu({ clipId }: { clipId: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLButtonElement>(null)
  const recentTypes = useRecentEffects((s) => s.types)
  const rows = addMenuRows(query, recentTypes)

  // Focus is taken in an effect rather than with autoFocus, so it happens after
  // the input is really in the document instead of during the render that put it
  // there.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Keeps the highlighted row on screen when the arrows walk past the fold.
  useEffect(() => {
    rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  function close(): void {
    setOpen(false)
    setQuery('')
    setHighlight(0)
  }

  function choose(type: string): void {
    applyEffect(clipId, type)
    close()
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="Add effect"
        aria-expanded={open}
        data-testid="inspector-add-effect"
        onClick={() => (open ? close() : setOpen(true))}
        // ⛔ WHILE THE MENU IS OPEN THE BUTTON HAS TO SIT ABOVE THE BACKDROP.
        // Without this the backdrop covers its own button, the second click
        // lands on the backdrop instead, and the button stops being a toggle.
        className={`h-6 cursor-default rounded-field bg-bg-input px-1.5 text-ui-sm text-text-secondary hover:text-text-primary ${
          open ? 'relative z-50' : ''
        }`}
      >
        + Add effect…
      </button>
      {open && (
        <>
          {/* The outside click. It is a real element rather than a listener on
              purpose, see the note at the top of this file. */}
          <div className="fixed inset-0 z-40" data-testid="add-effect-backdrop" onMouseDown={close} />
          <div
            className="absolute right-0 top-[calc(100%+4px)] z-50 flex w-64 flex-col rounded-field border border-border-strong bg-bg-elevated shadow-pop"
            data-testid="add-effect-menu"
          >
            <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
              <Search size={12} strokeWidth={1.75} className="shrink-0 text-text-muted" aria-hidden />
              <input
                ref={inputRef}
                type="text"
                value={query}
                placeholder="Search effects"
                aria-label="Search effects"
                data-testid="add-effect-search"
                onChange={(e) => {
                  setQuery(e.target.value)
                  // A new list is a new first row, and Enter has to mean the row
                  // he can see rather than wherever the old highlight sat.
                  setHighlight(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    close()
                    return
                  }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    setHighlight((h) => nextHighlight(rows.length, h, e.key === 'ArrowDown' ? 1 : -1))
                    return
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const row = highlightedRow(rows, highlight)
                    if (row) choose(row.type)
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-ui-sm text-text-primary outline-none placeholder:text-text-muted"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {rows.length === 0 && (
                <p className="px-2 py-1.5 text-ui-sm text-text-muted">Nothing matches that.</p>
              )}
              {rows.map((row, i) => {
                const isHot = i === highlight
                return (
                  <button
                    key={`${row.group}-${row.type}`}
                    ref={isHot ? rowRef : undefined}
                    type="button"
                    data-testid="add-effect-row"
                    data-type={row.type}
                    data-group={row.group}
                    data-highlighted={isHot ? 'true' : undefined}
                    // The pointer moving over a row is him aiming at it, so the
                    // highlight follows the mouse and Enter never means a row he
                    // stopped looking at.
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => choose(row.type)}
                    className={`flex w-full flex-col items-start gap-0.5 px-2 py-1 text-left ${
                      isHot ? 'bg-accent-quiet text-accent' : 'text-text-primary'
                    }`}
                  >
                    <span className="flex w-full items-center gap-1.5 text-ui-sm">
                      {row.label}
                      {row.group === 'recent' && (
                        <span className="ml-auto text-ui-xs text-text-muted">recent</span>
                      )}
                    </span>
                    {/* The description is the whole reason the search is worth
                        having, so it is on the row rather than in a tooltip. */}
                    <span className="line-clamp-2 text-ui-xs text-text-muted">{row.description}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </span>
  )
}
