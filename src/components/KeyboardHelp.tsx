import { X } from 'lucide-react'
import { useEffect } from 'react'
import { comboLabel, type Binding } from '../keymap'
import { useStore } from '../state/store'
import { IconButton } from '../ui/Button'

/**
 * Shortcuts overlay (press `?`). Renders the live keymap so it can never drift
 * from the actual bindings. Dedupes by description (e.g. Undo has mod+z + mod+y).
 */
export function KeyboardHelp({ bindings }: { bindings: Binding[] }) {
  const open = useStore((s) => s.ui.helpOpen)
  const setUI = useStore((s) => s.setUI)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUI({ helpOpen: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setUI])

  if (!open) return null

  const seen = new Set<string>()
  const rows = bindings.filter((b) => {
    if (seen.has(b.description)) return false
    seen.add(b.description)
    return true
  })

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6"
      data-testid="keyboard-help"
      onClick={() => setUI({ helpOpen: false })}
    >
      <div
        className="max-h-[80vh] w-[560px] max-w-full overflow-y-auto rounded-[8px] border border-border bg-bg-panel shadow-pop"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-bg-panel px-4 py-3">
          <h2 className="text-[13px] font-semibold text-text-primary">Keyboard shortcuts</h2>
          <IconButton label="Close shortcuts" onClick={() => setUI({ helpOpen: false })}>
            <X size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 p-4 sm:grid-cols-2">
          {rows.map((b) => (
            <div key={b.combo} className="flex items-center justify-between gap-3 text-[12px]">
              <span className="truncate text-text-secondary">{b.description}</span>
              <kbd className="shrink-0 rounded-[4px] border border-border bg-bg-input px-1.5 py-0.5 text-[11px] tabular-nums text-text-primary">
                {comboLabel(b.combo)}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
