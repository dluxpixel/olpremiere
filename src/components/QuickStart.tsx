// First-run quick start (spec 3.3): three dismissible steps that walk a brand
// new user from empty project to exported video. Steps check themselves off
// from real app state, so the card is a live checklist, not a tour. Shown once
// ever: any dismissal (the X, or finishing all steps, or the app opening on a
// project that is already mid-edit) writes localStorage and it never re-nags.

import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { IconButton } from '../ui/Button'

const KEY = 'olpremiere:quickstart'

/** How long to wait for the saved project to hydrate before deciding whether
 *  this launch is actually a first run. A returning editor's project loads
 *  with media and clips already placed; teaching them "import media" would be
 *  a nag, so the card retires silently instead. */
const HYDRATE_DEFER_MS = 600

/** Lingers this long after the last step completes so the final check is
 *  seen, then retires forever. */
const ALL_DONE_LINGER_MS = 2200

type StepId = 'import' | 'timeline' | 'export'

const STEPS: { id: StepId; label: string; hint: string }[] = [
  { id: 'import', label: 'Import media', hint: 'Drop files or click Import in the Media panel' },
  { id: 'timeline', label: 'Drag to the timeline', hint: 'Pull a clip from the bin onto a track' },
  { id: 'export', label: 'Export your video', hint: 'Press Export in the top right' },
]

interface Stored {
  dismissed?: boolean
  /** Steps the user checked off by hand (auto-detected ones recompute live). */
  done?: StepId[]
}

function load(): Stored {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    if (!raw) return {}
    const v: unknown = JSON.parse(raw)
    return typeof v === 'object' && v !== null ? (v as Stored) : {}
  } catch {
    return {}
  }
}

function save(patch: Stored) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(KEY, JSON.stringify({ ...load(), ...patch }))
  } catch {
    // Storage full or blocked: worst case the card shows again next launch.
  }
}

/** Forget the "seen" flag so the intro returns on the next load (Settings). */
export function resetQuickStart(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  } catch {
    // Private mode / quota: nothing to forget.
  }
}

export function QuickStart() {
  const [phase, setPhase] = useState<'defer' | 'show' | 'gone'>(() =>
    load().dismissed ? 'gone' : 'defer',
  )

  useEffect(() => {
    if (phase !== 'defer') return
    const id = window.setTimeout(() => {
      const s = useStore.getState()
      const hasMedia = Object.keys(s.project.assets).length > 0
      const hasClips = Object.values(s.project.sequences).some((sq) =>
        sq.tracks.some((t) => t.clips.length > 0),
      )
      if (hasMedia && hasClips) {
        // Not a first run: an edit is already in flight. Retire without ever
        // showing; a human cannot import AND place clips inside the defer.
        save({ dismissed: true })
        setPhase('gone')
      } else {
        setPhase('show')
      }
    }, HYDRATE_DEFER_MS)
    return () => window.clearTimeout(id)
  }, [phase])

  if (phase !== 'show') return null
  return <QuickStartCard onRetire={() => setPhase('gone')} />
}

/** Mounted only while visible so its store subscriptions cost nothing after
 *  dismissal (which for every user past the first session is always). */
function QuickStartCard({ onRetire }: { onRetire: () => void }) {
  const hasMedia = useStore((s) => Object.keys(s.project.assets).length > 0)
  const hasClips = useStore((s) =>
    Object.values(s.project.sequences).some((sq) => sq.tracks.some((t) => t.clips.length > 0)),
  )
  const [manual, setManual] = useState<StepId[]>(() => load().done ?? [])
  const [exported, setExported] = useState(false)

  // Latch a finished export from the toast stream: the export pipeline's one
  // observable completion signal that needs no wiring into ExportDialog. If
  // the toast copy ever changes the step simply stops auto-checking; the row
  // stays click-to-dismiss and the card stays fully dismissible.
  useEffect(
    () =>
      useToasts.subscribe((s) => {
        if (s.toasts.some((t) => t.kind === 'success' && t.message.startsWith('Exported '))) {
          setExported(true)
        }
      }),
    [],
  )

  const done: Record<StepId, boolean> = {
    import: hasMedia || manual.includes('import'),
    timeline: hasClips || manual.includes('timeline'),
    export: exported || manual.includes('export'),
  }
  const allDone = done.import && done.timeline && done.export

  useEffect(() => {
    if (!allDone) return
    const id = window.setTimeout(() => {
      save({ dismissed: true })
      onRetire()
    }, ALL_DONE_LINGER_MS)
    return () => window.clearTimeout(id)
  }, [allDone, onRetire])

  const dismiss = () => {
    save({ dismissed: true })
    onRetire()
  }

  const markDone = (id: StepId) => {
    if (done[id]) return
    const next = [...manual, id]
    setManual(next)
    save({ done: next })
  }

  return (
    <section
      aria-label="Quick start"
      data-testid="quick-start"
      // Floating overlay, so shadow-pop is allowed. Sits under the TopBar's
      // Export button (which step 3 points at) and over the Inspector's empty
      // first-run placeholder; below dialogs and toasts (z-100).
      className="fixed right-3 top-14 z-[90] w-[272px] animate-[toast-in_140ms_ease-out] rounded-overlay border border-border bg-bg-elevated shadow-pop"
    >
      <div className="flex items-center justify-between border-b border-border py-1.5 pl-3 pr-1.5">
        <h2 className="flex items-center gap-1.5 text-ui font-semibold text-text-primary">
          {allDone && <Check size={14} strokeWidth={2} className="text-success" />}
          {allDone ? 'All set' : 'Quick start'}
        </h2>
        <IconButton label="Dismiss quick start" size="compact" onClick={dismiss}>
          <X size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-1.5">
        {STEPS.map((step, i) => {
          const isDone = done[step.id]
          return (
            <li key={step.id}>
              <button
                data-testid={`quick-start-step-${step.id}`}
                aria-label={isDone ? `${step.label} (done)` : `${step.label}, mark as done`}
                disabled={isDone}
                onClick={() => markDone(step.id)}
                title={isDone ? undefined : 'Click to mark as done'}
                className="flex w-full cursor-default items-start gap-2.5 rounded-field px-1.5 py-1.5 text-left transition-colors duration-[120ms] ease-out enabled:hover:bg-bg-input"
              >
                <span
                  aria-hidden="true"
                  className={`mt-px inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                    isDone
                      ? 'border-success/60 text-success'
                      : 'border-border-strong text-text-secondary'
                  }`}
                >
                  {isDone ? <Check size={11} strokeWidth={2.5} /> : i + 1}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className={`text-ui-sm font-medium ${isDone ? 'text-text-muted' : 'text-text-primary'}`}
                  >
                    {step.label}
                  </span>
                  {!isDone && <span className="text-dense text-text-muted">{step.hint}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
