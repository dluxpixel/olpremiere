import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { create } from 'zustand'
import {
  comboLabel,
  DOMAIN_LABELS,
  groupBindings,
  searchBindings,
  type Binding,
} from '../keymap'

interface PaletteState {
  open: boolean
  setOpen: (open: boolean) => void
}

/**
 * Palette open state lives in its own tiny store (same pattern as the context
 * menu) so the keymap can toggle it from outside React without widening the
 * main UI store.
 */
export const usePalette = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

export function togglePalette(): void {
  usePalette.setState((s) => ({ open: !s.open }))
}

/**
 * Command palette (Ctrl/Cmd+K): a fuzzy-searchable list of every keymap
 * command with its shortcut. Arrow keys move the highlight, Enter runs the
 * command, Escape closes. Rendered entirely from the live keymap so it can
 * never drift from the real bindings.
 */
export function CommandPalette({ bindings }: { bindings: Binding[] }) {
  const open = usePalette((s) => s.open)
  const setOpen = usePalette((s) => s.setOpen)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const hasQuery = query.trim() !== ''
  // Empty query: grouped by domain with headers. With a query: one flat list
  // ranked by fuzzy score. `rows` is the flat keyboard-navigation order in
  // both modes and always matches the visual order.
  const groups = useMemo(
    () => (hasQuery ? null : groupBindings(bindings)),
    [bindings, hasQuery],
  )
  const rows = useMemo(
    () => (groups ? groups.flatMap((g) => g.rows) : searchBindings(bindings, query)),
    [groups, bindings, query],
  )

  // Fresh state per open.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
  }, [open])

  // Escape closes from anywhere, in CAPTURE phase, so the global keymap's
  // Escape (deselect all) never also fires while the palette owns the keys.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen])

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active, rows])

  if (!open) return null

  const run = (b: Binding | undefined) => {
    if (!b) return
    setOpen(false)
    b.run(new KeyboardEvent('keydown', { key: 'Enter' }))
  }

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(rows[active])
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      // mod+k toggles: pressing it again with the field focused closes.
      e.preventDefault()
      setOpen(false)
    }
  }

  // Row index across groups so arrows walk the whole list.
  let flat = -1
  const renderRow = (b: Binding) => {
    flat += 1
    const i = flat
    const isActive = i === active
    return (
      <button
        key={b.description}
        id={`palette-opt-${i}`}
        role="option"
        aria-selected={isActive}
        data-active={isActive || undefined}
        className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left text-ui transition-colors duration-[120ms] ${
          isActive ? 'bg-accent-quiet text-accent' : 'text-text-primary'
        }`}
        onMouseMove={() => setActive(i)}
        onClick={() => run(b)}
      >
        <span className="truncate">{b.description}</span>
        <span className="flex shrink-0 items-center gap-2">
          {hasQuery && (
            <span className="text-dense text-text-muted">{DOMAIN_LABELS[b.domain]}</span>
          )}
          <kbd className="rounded-[4px] border border-border bg-bg-input px-1.5 py-0.5 font-numeric text-dense text-text-secondary">
            {comboLabel(b.combo)}
          </kbd>
        </span>
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex justify-center bg-black/60 pt-[12vh]"
      data-testid="command-palette"
      onPointerDown={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="flex h-fit max-h-[64vh] w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-dialog border border-border bg-bg-panel shadow-pop animate-[fade-in_120ms_ease-out]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search size={16} strokeWidth={1.5} className="shrink-0 text-text-muted" />
          <input
            autoFocus
            data-testid="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows.length > 0 ? `palette-opt-${active}` : undefined}
            placeholder="Type a command"
            className="w-full bg-transparent text-ui text-text-primary outline-none placeholder:text-text-muted"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="shrink-0 rounded-[4px] border border-border bg-bg-input px-1.5 py-0.5 font-numeric text-dense text-text-muted">
            Esc
          </kbd>
        </div>

        <div id="palette-list" ref={listRef} role="listbox" aria-label="Commands" className="min-h-0 overflow-y-auto py-1">
          {rows.length === 0 && (
            <div className="px-3 py-4 text-center text-ui text-text-muted">No matching commands</div>
          )}
          {groups
            ? groups.map((g) => (
                <div key={g.domain}>
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                    {g.label}
                  </div>
                  {g.rows.map(renderRow)}
                </div>
              ))
            : rows.map(renderRow)}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-dense text-text-muted">
          <span>Up/Down to navigate</span>
          <span>Enter to run</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  )
}
