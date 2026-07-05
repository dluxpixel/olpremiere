import { SlidersHorizontal } from 'lucide-react'

export function Inspector({ width }: { width: number }) {
  return (
    <aside
      data-testid="panel-right"
      className="flex min-h-0 shrink-0 flex-col bg-bg-panel"
      style={{ width }}
    >
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
          Effect Controls
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <SlidersHorizontal size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
        <div className="text-[12px] text-text-muted">Select a clip to edit its properties</div>
      </div>
    </aside>
  )
}
