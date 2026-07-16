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

  // Mouse gestures are half the editor's power and live in NO keymap, so they
  // are documented by hand here. Keep in sync with Timeline.tsx pointer handlers.
  const gestures: { action: string; how: string }[] = [
    { action: 'Move clip', how: 'Drag clip body' },
    { action: 'Trim edge', how: 'Drag clip edge' },
    { action: 'Ripple trim', how: 'Ctrl + drag edge' },
    { action: 'Rate stretch (retime)', how: 'Alt + drag edge' },
    { action: 'Roll edit (move the cut)', how: 'Ctrl + Alt + drag edge' },
    { action: 'Slip source', how: 'Alt + drag body' },
    { action: 'Slide clip (neighbours absorb)', how: 'Ctrl + Alt + drag body' },
    { action: 'Add / remove to selection', how: 'Shift + click clip' },
    { action: 'Zoom at cursor', how: 'Ctrl + mouse wheel' },
    { action: 'Apply effect / transition', how: 'Drag from Effects panel onto a clip' },
    { action: 'Fade in / out', how: 'Drag a clip top corner' },
    { action: 'Scrub playhead', how: 'Click / drag empty lane' },
  ]

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

        <div className="border-t border-border px-4 pb-4 pt-3">
          <h3 className="pb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-secondary">
            Mouse gestures
          </h3>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {gestures.map((g) => (
              <div key={g.action} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="truncate text-text-secondary">{g.action}</span>
                <span className="shrink-0 text-[11px] text-text-muted">{g.how}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
