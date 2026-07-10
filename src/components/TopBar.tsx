import { Clapperboard, Download, Keyboard, Redo2, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { comboLabel } from '../keymap'
import { useStore } from '../state/store'
import { Button, IconButton } from '../ui/Button'
import { ExportDialog } from './ExportDialog'

function SaveIndicator() {
  const saveState = useStore((s) => s.ui.saveState)
  const dot =
    saveState === 'saved' ? 'bg-success' : saveState === 'saving' ? 'bg-warning' : 'bg-text-muted'
  const label = saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved'
  return (
    <span
      data-testid="save-state"
      className="flex items-center gap-1.5 text-[11px] text-text-secondary"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

function ProjectName() {
  const name = useStore((s) => s.project.name)
  const dispatch = useStore((s) => s.dispatch)
  const [draft, setDraft] = useState(name)

  useEffect(() => setDraft(name), [name])

  const commit = () => {
    const next = draft.trim()
    if (next === '' || next === name) {
      setDraft(name)
      return
    }
    dispatch('Rename project', (p) => ({ ...p, name: next }))
  }

  return (
    <input
      data-testid="project-name"
      aria-label="Project name"
      className="h-7 w-52 rounded-[4px] border border-transparent bg-transparent px-2 text-[13px] font-medium text-text-primary transition-colors duration-[120ms] hover:bg-bg-elevated focus:border-accent focus:bg-bg-input focus:outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(name)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

export function TopBar() {
  const canUndo = useStore((s) => s.history.undo.length > 0)
  const canRedo = useStore((s) => s.history.redo.length > 0)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const setUI = useStore((s) => s.setUI)
  const [exporting, setExporting] = useState(false)

  return (
    <header
      data-testid="topbar"
      className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg-panel px-3"
    >
      <div className="flex items-center gap-2">
        <Clapperboard size={18} className="text-accent" aria-hidden />
        <span className="text-[13px] font-semibold tracking-[0.08em]">OL Premiere</span>
      </div>
      <div className="h-4 w-px bg-border" />
      <ProjectName />
      <SaveIndicator />

      <div className="ml-auto flex items-center gap-1">
        <IconButton
          label="Undo"
          shortcut={comboLabel('mod+z')}
          onClick={undo}
          disabled={!canUndo}
          data-testid="undo"
        >
          <Undo2 size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton
          label="Redo"
          shortcut={comboLabel('mod+shift+z')}
          onClick={redo}
          disabled={!canRedo}
          data-testid="redo"
        >
          <Redo2 size={16} strokeWidth={1.5} />
        </IconButton>
        <IconButton
          label="Keyboard shortcuts"
          shortcut="?"
          onClick={() => setUI({ helpOpen: true })}
          data-testid="help-open"
        >
          <Keyboard size={16} strokeWidth={1.5} />
        </IconButton>
        <div className="mx-2 h-4 w-px bg-border" />
        <Button variant="primary" data-testid="export-open" onClick={() => setExporting(true)}>
          <Download size={16} strokeWidth={1.5} />
          Export
        </Button>
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </header>
  )
}
