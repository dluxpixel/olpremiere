import { FolderOpen, Plus, Sparkles } from 'lucide-react'
import { useStore, type LeftTab } from '../state/store'
import { useToasts } from '../state/toasts'
import { Button } from '../ui/Button'

function Tab({ tab, label }: { tab: LeftTab; label: string }) {
  const active = useStore((s) => s.ui.leftTab === tab)
  const setUI = useStore((s) => s.setUI)
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => setUI({ leftTab: tab })}
      className={`h-6 rounded-[4px] px-2.5 text-[12px] font-medium transition-colors duration-[120ms] ${
        active ? 'bg-accent-quiet text-accent' : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  )
}

function MediaTab() {
  const show = useToasts((s) => s.show)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-2 py-2">
        <Button variant="secondary" onClick={() => show('Media import lands in Phase 1.')}>
          <Plus size={16} strokeWidth={1.5} />
          Import
        </Button>
      </div>
      <div
        data-testid="media-empty"
        className="m-2 mt-0 flex flex-1 flex-col items-center justify-center gap-2 rounded-[6px] border border-dashed border-border-strong text-center"
      >
        <FolderOpen size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
        <div className="text-[13px] text-text-secondary">Import media to begin</div>
        <div className="text-[11px] text-text-muted">Drop files here or click + Import</div>
      </div>
    </div>
  )
}

function EffectsTab() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <Sparkles size={24} strokeWidth={1.5} className="text-text-muted" aria-hidden />
      <div className="text-[13px] text-text-secondary">Effects &amp; transitions</div>
      <div className="text-[11px] text-text-muted">Arriving in Phase 4</div>
    </div>
  )
}

export function LeftPanel({ width }: { width: number }) {
  const leftTab = useStore((s) => s.ui.leftTab)
  return (
    <aside
      data-testid="panel-left"
      className="flex min-h-0 shrink-0 flex-col bg-bg-panel"
      style={{ width }}
    >
      <div role="tablist" className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Tab tab="media" label="Media" />
        <Tab tab="effects" label="Effects" />
      </div>
      {leftTab === 'media' ? <MediaTab /> : <EffectsTab />}
    </aside>
  )
}
