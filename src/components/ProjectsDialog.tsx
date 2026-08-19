// The Projects picker: every edit lives side by side. Open another one,
// start fresh, or delete an old one, without ever nuking current work.

import { Archive, ArchiveRestore, Clapperboard, Clock, FolderOpen, LifeBuoy, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  activeProjects,
  archivedProjects,
  laterProjects,
  listProjects,
  type ProjectSummary,
} from '../state/persistence'
import { listBackups, readBackup, restoreBackup, type BackupContents, type BackupRow } from '../state/backupRestore'
import { createProject, openProject, removeProject, setArchived, setLater } from '../state/projectActions'
import { useStore } from '../state/store'
import { Button, IconButton } from '../ui/Button'

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/**
 * Which shelf the dialog is showing.
 *
 * THREE, not two, since 2026-08-05. His words: "separate projects that are there
 * in the background that I will work on in the future and projects that I'm
 * working on right now". Both of those are LIVE work, which is why parking is
 * its own flag and not a second meaning for Finished.
 *   active  = what he is on now
 *   later   = live, parked, will come back to it
 *   archived = finished, filed away, never deleted
 */
export type ProjectsView = 'active' | 'later' | 'archived' | 'backups'

export function ProjectsDialog({ onClose, view = 'active' }: { onClose: () => void; view?: ProjectsView }) {
  const currentId = useStore((s) => s.project.id)
  const [all, setAll] = useState<ProjectSummary[] | null>(null)
  const [tab, setTab] = useState<ProjectsView>(view)
  // Two-step delete: first click arms, second click within the same render
  // actually deletes. No modal-on-modal.
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  // ⛔ THE SAFETY NET HAD NO WAY BACK UP UNTIL 2026-08-19. The app has been
  // writing the whole edit to a plain file every couple of minutes since July,
  // and the only thing it ever offered him was a button that opens the folder.
  // So on the evening his projects were not in the picker, forty copies of his
  // work were sitting on his disk and there was no way to open one.
  const [backups, setBackups] = useState<BackupRow[] | null>(null)
  // What each file turns out to hold. Forty near-identical names say nothing;
  // "115 clips, 40 media" is what tells him which afternoon this is.
  const [inside, setInside] = useState<Record<string, BackupContents | null>>({})
  const [recovering, setRecovering] = useState<string | null>(null)

  const refresh = () =>
    void listProjects()
      .then(setAll)
      .catch((err) => console.error('OL Premiere: projects list failed', err))
  useEffect(refresh, [])

  // Only when he asks for them: reading forty files is not free, and nobody
  // opening the picker to switch projects should pay for it.
  useEffect(() => {
    if (tab !== 'backups' || backups !== null) return
    void listBackups().then(async (rows) => {
      setBackups(rows)
      for (const row of rows) {
        const contents = await readBackup(row.path)
        setInside((prev) => ({ ...prev, [row.path]: contents }))
      }
    })
  }, [tab, backups])

  const archivedCount = all ? archivedProjects(all).length : 0
  const laterCount = all ? laterProjects(all).length : 0
  const projects =
    all === null
      ? null
      : tab === 'archived'
        ? archivedProjects(all)
        : tab === 'later'
          ? laterProjects(all)
          : activeProjects(all)

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
        className="olp-pop flex max-h-[70vh] w-[520px] flex-col rounded-dialog border border-border bg-bg-elevated shadow-pop"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          {/* Three shelves of the same list. Finished work is never deleted,
              just filed, so both counts are always on show. */}
          {(['active', 'later', 'archived', 'backups'] as const).map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`projects-tab-${id}`}
              aria-pressed={tab === id}
              onClick={() => {
                setTab(id)
                setArmedDelete(null)
              }}
              className={`rounded-field px-2 py-1 text-ui font-semibold transition-colors duration-[120ms] ${
                tab === id ? 'text-text-primary' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {id === 'active'
                ? 'Working on'
                : id === 'later'
                  ? `Later${laterCount ? ` (${laterCount})` : ''}`
                  : id === 'archived'
                    ? `Finished${archivedCount ? ` (${archivedCount})` : ''}`
                    : 'Recover'}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {tab === 'backups' ? (
              <Button
                variant="secondary"
                data-testid="backups-reveal"
                title="They are ordinary files. Copy them anywhere you like."
                onClick={() => void window.api?.backupReveal?.()}
              >
                <FolderOpen size={14} strokeWidth={1.5} />
                Open the folder
              </Button>
            ) : (
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
            )}
            <IconButton label="Close" onClick={onClose}>
              <X size={16} strokeWidth={1.5} />
            </IconButton>
          </div>
        </div>

        <div key={tab} className="olp-swap min-h-0 flex-1 overflow-y-auto p-2">
          {tab === 'backups' ? (
            <BackupList
              rows={backups}
              inside={inside}
              recovering={recovering}
              onRecover={(path) => {
                setRecovering(path)
                void restoreBackup(path).then((ok) => {
                  setRecovering(null)
                  if (ok) onClose()
                })
              }}
            />
          ) : projects === null ? (
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
                  {tab !== 'archived' && (
                    <button
                      type="button"
                      data-testid={tab === 'later' ? 'project-unpark' : 'project-park'}
                      aria-label={tab === 'later' ? `Bring ${p.name} back to now` : `Park ${p.name} for later`}
                      title={
                        tab === 'later'
                          ? 'Bring it back to what you are working on'
                          : 'Not working on it right now? Park it under Later.'
                      }
                      onClick={() => void setLater(p.id, tab !== 'later').then(refresh)}
                      className="rounded-field p-1.5 text-text-muted opacity-0 transition-[color,opacity] duration-150 hover:text-text-primary group-hover/proj:opacity-100"
                    >
                      {tab === 'later' ? (
                        <ArchiveRestore size={14} strokeWidth={1.5} />
                      ) : (
                        <Clock size={14} strokeWidth={1.5} />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={tab === 'archived' ? 'project-unarchive' : 'project-archive'}
                    aria-label={tab === 'archived' ? `Put ${p.name} back` : `Mark ${p.name} finished`}
                    title={
                      tab === 'archived'
                        ? 'Put it back in your projects'
                        : 'Finished with it? File it away. Nothing is deleted.'
                    }
                    onClick={() => void setArchived(p.id, tab !== 'archived').then(refresh)}
                    className="rounded-field p-1.5 text-text-muted opacity-0 transition-colors duration-[120ms] hover:text-text-primary group-hover/proj:opacity-100"
                  >
                    {tab === 'archived' ? (
                      <ArchiveRestore size={14} strokeWidth={1.5} />
                    ) : (
                      <Archive size={14} strokeWidth={1.5} />
                    )}
                  </button>
                  <button
                    type="button"
                    data-testid="project-delete"
                    aria-label={armedDelete === p.id ? 'Confirm delete' : `Delete ${p.name}`}
                    title={
                      armedDelete === p.id
                        ? 'Click again to delete for good'
                        : isOpen
                          ? 'Delete this project. It will open another one first.'
                          : 'Delete project'
                    }
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
                </div>
              )
            })
          )}
          {projects !== null && tab === 'archived' && projects.length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] text-text-muted">
              Nothing finished yet. When an edit is done, file it here instead of deleting it.
            </div>
          )}
          {tab !== 'backups' && projects !== null && tab === 'active' && projects.length <= 1 && (
            <div className="px-3 py-4 text-center text-[11px] text-text-muted">
              Each edit lives here. Start a new project any time, your current one stays put.{' '}
              <button
                type="button"
                data-testid="projects-missing"
                onClick={() => setTab('backups')}
                className="underline decoration-dotted underline-offset-2 hover:text-text-primary"
              >
                Missing a project?
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function whenSaved(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? `Today ${clock}` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${clock}`
}

/**
 * Every automatic copy of his work, newest first.
 *
 * Recovering NEVER overwrites: it lands as a new project, so picking the wrong
 * one costs him a click and nothing else. That is why there is no confirmation
 * step here, and why there should not be one.
 */
function BackupList({
  rows,
  inside,
  recovering,
  onRecover,
}: {
  rows: BackupRow[] | null
  inside: Record<string, BackupContents | null>
  recovering: string | null
  onRecover: (path: string) => void
}) {
  if (rows === null) return <div className="py-8 text-center text-[11px] text-text-muted">Looking…</div>
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-[11px] text-text-muted">
        No copies yet. The app starts saving one every couple of minutes as soon as you edit something.
      </div>
    )
  }
  return (
    <>
      <div className="px-3 pb-2 pt-1 text-[11px] text-text-muted">
        Your edit is copied to a file every couple of minutes, on its own. Open any of them: it comes back as a new
        project and nothing you have now is touched.
      </div>
      {rows.map((row) => {
        const contents = inside[row.path]
        const busy = recovering === row.path
        return (
          <div
            key={row.path}
            data-testid="backup-row"
            className="flex items-center gap-3 rounded-overlay border border-transparent px-3 py-2 transition-colors duration-[120ms] hover:border-border hover:bg-bg-panel"
          >
            <LifeBuoy size={18} strokeWidth={1.5} className="shrink-0 text-text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-text-primary">
                {contents?.project.name ?? row.name.replace(/\.olpbak$/, '')}
              </div>
              <div className="text-[11px] text-text-muted">
                {whenSaved(row.savedAtMs)}
                {contents === undefined
                  ? ' · reading…'
                  : contents === null
                    ? ' · could not be read'
                    : ` · ${contents.clipCount} clip${contents.clipCount === 1 ? '' : 's'} · ${contents.assetCount} media`}
              </div>
            </div>
            <Button
              variant="secondary"
              data-testid="backup-recover"
              disabled={busy || contents === null}
              onClick={() => onRecover(row.path)}
            >
              {busy ? 'Recovering…' : 'Recover'}
            </Button>
          </div>
        )
      })}
    </>
  )
}
