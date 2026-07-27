// The Projects picker: every edit lives side by side. Open another one,
// start fresh, or delete an old one, without ever nuking current work.

import { Clapperboard, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { listProjects, type ProjectSummary } from '../state/persistence'
import { createProject, openProject, removeProject } from '../state/projectActions'
import { useStore } from '../state/store'
import { Button, IconButton } from '../ui/Button'

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const currentId = useStore((s) => s.project.id)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  // Two-step delete: first click arms, second click within the same render
  // actually deletes. No modal-on-modal.
  const [armedDelete, setArmedDelete] = useState<string | null>(null)

  const refresh = () =>
    void listProjects()
      .then(setProjects)
      .catch((err) => console.error('OL Studio: projects list failed', err))
  useEffect(refresh, [])

  const open = async (id: string) => {
    await openProject(id)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Projects"
        data-testid="projects-dialog"
        className="flex max-h-[70vh] w-[520px] flex-col rounded-dialog border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="text-ui font-semibold text-text-primary">Projects</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="secondary"
              data-testid="project-new"
              onClick={() => {
                void createProject().then(onClose)
              }}
            >
              <Plus size={14} strokeWidth={1.5} />
              New project
            </Button>
            <IconButton label="Close" onClick={onClose}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {projects === null ? (
            <div className="py-8 text-center text-[11px] text-text-muted">Loading…</div>
          ) : (
            projects.map((p) => {
              const isOpen = p.id === currentId
              return (
                <div
                  key={p.id}
                  data-testid="project-row"
                  role="button"
                  tabIndex={0}
                  onDoubleClick={() => !isOpen && void open(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isOpen) void open(p.id)
                  }}
                  className={`group/proj flex items-center gap-3 rounded-overlay border px-3 py-2 transition-colors duration-[120ms] ${
                    isOpen
                      ? 'border-accent/50 bg-accent-quiet'
                      : 'border-transparent hover:border-border hover:bg-bg-panel'
                  }`}
                >
                  <Clapperboard size={18} strokeWidth={1.5} className="shrink-0 text-text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text-primary">
                      {p.name}
                      {isOpen && <span className="ml-2 text-[10px] font-normal text-accent">open</span>}
                    </div>
                    <div className="text-[11px] text-text-muted">
                      {ago(p.updatedAt)} · {p.clipCount} clip{p.clipCount === 1 ? '' : 's'} ·{' '}
                      {p.assetCount} media
                    </div>
                  </div>
                  {!isOpen && (
                    <Button variant="secondary" data-testid="project-open" onClick={() => void open(p.id)}>
                      Open
                    </Button>
                  )}
                  {!isOpen && (
                    <button
                      type="button"
                      data-testid="project-delete"
                      aria-label={armedDelete === p.id ? 'Confirm delete' : `Delete ${p.name}`}
                      title={armedDelete === p.id ? 'Click again to delete for good' : 'Delete project'}
                      onClick={() => {
                        if (armedDelete === p.id) {
                          setArmedDelete(null)
                          void removeProject(p.id).then(refresh)
                        } else {
                          setArmedDelete(p.id)
                        }
                      }}
                      onBlur={() => setArmedDelete(null)}
                      className={`rounded-field p-1.5 transition-colors duration-[120ms] ${
                        armedDelete === p.id
                          ? 'bg-danger/20 text-danger'
                          : 'text-text-muted opacity-0 hover:text-danger group-hover/proj:opacity-100'
                      }`}
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              )
            })
          )}
          {projects !== null && projects.length <= 1 && (
            <div className="px-3 py-4 text-center text-[11px] text-text-muted">
              Each edit lives here. Start a new project any time, your current one stays put.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
