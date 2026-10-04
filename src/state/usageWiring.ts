// Connects the usage log (usageLog.ts) to the running app: the sink that writes it,
// ONE delegated listener at the document for every button, tab, menu item and
// toggle he uses, and the store subscriptions that turn playing, zooming, opening a
// project, recording, captioning, toasts and errors into events. Called once from
// main.tsx; nothing else in the app talks to this file.
//
// The edits and the shortcuts do NOT come through here. They are one-line calls
// from the places that already know (store.dispatch, installKeymap, the export
// job; see usageNotes.ts), which is what makes "every undoable edit" true without
// a second copy of the list of edits to keep in step.
//
// ⛔ ZERO LAG. Every handler here starts with `usage.isEnabled()` and does a few
// property reads. The store subscription runs on every store write, playback ticks
// included, so it compares references and stops: it never builds an object, never
// allocates a closure and never touches the DOM. The measured cost is in the
// commit message and in e2e/usage-log.spec.ts, which keeps measuring it.

import { APP_VERSION } from '../appVersion'
import { getCaptionLanguage } from '../engine/captions/transcribeConfig'
import { isElectron, olApi } from '../platform'
import { isPhoneLayout } from '../ui/phoneLayout'
import { useCaptionStyles } from './captionStyles'
import { useLibrary } from './library'
import { useSettings } from './settings'
import { useStore } from './store'
import { useToasts } from './toasts'
import { useTranscribe } from './transcribeActions'
import { usage, type UsageSink } from './usageLog'
import { dialogName, INTERACTIVE, maskMessage, panelOf, setKnownNames, testIdName, uiName, type KnownName } from './usageNames'
import { appendWebUsage } from './usageStoreWeb'
import { useRecorder } from './voiceRecorder'

/**
 * Only what HE did. A click or a change the page made itself (a hidden file input, a download
 * link, a script) is not him pressing something. jsdom cannot make a trusted event, so the
 * tests of this file switch the check off, and nothing else does.
 */
let real = (e: Event): boolean => e.isTrusted

export function countScriptEventsForTests(): void {
  real = () => true
}

/** Boot screens are not something he opened. */
const IGNORED_DIALOGS = new Set(['boot-splash', 'boot-loading-card'])
/** Floods of the same error (a render loop) must not fill the log: this many a minute, no more. */
const MAX_ERRORS_PER_MINUTE = 20

function pickSink(): UsageSink {
  const api = olApi
  if (api?.usageAppend) return (day, lines) => api.usageAppend(day, lines)
  return appendWebUsage
}

// --- The names of his own material, for masking ------------------------------------

let namesCache: {
  assets: unknown
  tracks: unknown
  items: unknown
  presets: unknown
  styles: unknown
  project: string
  list: KnownName[]
} | null = null

/**
 * Cached by reference: a drag rewrites the clips on every move, but the assets and
 * the track list are the same objects until something really changes them, so the
 * list is built once and handed back, not rebuilt per event.
 */
function knownNames(): readonly KnownName[] {
  const { project } = useStore.getState()
  const tracks = project.sequences[project.activeSequenceId]?.tracks
  const { items, presets } = useLibrary.getState()
  const styles = useCaptionStyles.getState().saved
  const c = namesCache
  if (
    c &&
    c.assets === project.assets &&
    c.tracks === tracks &&
    c.items === items &&
    c.presets === presets &&
    c.styles === styles &&
    c.project === project.name
  ) {
    return c.list
  }
  const list: KnownName[] = []
  for (const id in project.assets) list.push({ name: project.assets[id]!.name, as: 'media' })
  for (const t of tracks ?? []) list.push({ name: t.name, as: 'track' })
  for (const i of items) list.push({ name: i.name, as: 'item' })
  for (const p of presets) list.push({ name: p.name, as: 'item' })
  for (const st of styles) list.push({ name: st.name, as: 'item' })
  list.push({ name: project.name, as: 'project' })
  list.sort((a, b) => b.name.length - a.name.length)
  namesCache = { assets: project.assets, tracks, items, presets, styles, project: project.name, list }
  return list
}

// --- The document listener: buttons, tabs, menu items, toggles -----------------------

/**
 * The project whose events these are. Held HERE and not read off the store, for two
 * reasons: the store starts on a throwaway placeholder until his project loads (and on a
 * brand new profile that placeholder simply BECOMES his project, with no change of id to
 * notice), and the line that says a project was closed must carry the project that
 * closed, not the one that has already replaced it.
 *
 * So it is adopted from the store on his first real input, or the moment the id changes.
 */
let currentProject: string | undefined
let openedAt = 0
let projectsSeen = 0
let inputSeen = false

function openProject(id: string): void {
  const now = Date.now()
  // Leaving a project is a line of its own, with how long it was open.
  if (openedAt > 0) usage.record('project', 'close', undefined, now - openedAt)
  openedAt = now
  currentProject = id
  usage.record('project', projectsSeen === 0 ? 'open' : 'switch', { clips: clipCount() })
  projectsSeen += 1
}

/** Which project, for a line being written now. His first input is what says the editor is up. */
function projectForEvent(): string | undefined {
  if (currentProject === undefined && inputSeen) openProject(useStore.getState().project.id)
  return currentProject
}

let lateScan = 0
const openDialogs = new Map<string, number>()

/** Who is on screen as a dialog now, against who was: the difference is an open or a close. */
function scanDialogs(at: number): void {
  if (!usage.isEnabled()) return
  const present = new Set<string>()
  for (const el of document.querySelectorAll('[role="dialog"]')) {
    const name = dialogName(el)
    if (IGNORED_DIALOGS.has(name)) continue
    present.add(name)
    if (!openDialogs.has(name)) {
      openDialogs.set(name, at)
      usage.record('dialog', name, { op: 'open' }, undefined, at)
    }
  }
  for (const [name, since] of openDialogs) {
    if (present.has(name)) continue
    openDialogs.delete(name)
    usage.record('dialog', name, { op: 'close' }, Math.max(0, at - since), at)
  }
}

/**
 * A dialog opened or closed because of something he did: look right after it (React has
 * committed by the next task), and once more shortly after for one that opens behind a
 * promise. Never on every DOM change. Stamped with when HE acted, not when the page was
 * free to look, because a repaint can keep a timer waiting for a third of a second.
 */
function scheduleDialogScan(): void {
  const at = Date.now()
  setTimeout(() => scanDialogs(at), 0)
  if (at - lateScan > 300) {
    lateScan = at
    setTimeout(() => scanDialogs(at), 300)
  }
}

function onClick(e: MouseEvent): void {
  // A click the page made itself (a hidden file input, a download link) is not him pressing something.
  if (!real(e) || !usage.isEnabled()) return
  inputSeen = true
  const target = e.target
  if (!(target instanceof Element)) return
  const el = target.closest(INTERACTIVE)
  if (!el) return
  const { a, role } = uiName(el)
  let on: boolean | undefined
  if (el instanceof HTMLInputElement) on = el.checked
  else if (el.hasAttribute('aria-pressed')) on = el.getAttribute('aria-pressed') !== 'true'
  else if (el.hasAttribute('aria-checked')) on = el.getAttribute('aria-checked') !== 'true'
  usage.record('ui', a, { panel: panelOf(el), role, on })
  scheduleDialogScan()
}

/**
 * Things that are pressed and dragged but are not buttons: a clip, a trim handle, a
 * keyframe, the splitters, the picture. One line per press, never per move. A real
 * button is left to `onClick`, which sees it once.
 */
function onPointerDown(e: PointerEvent): void {
  if (!real(e) || e.button !== 0 || !usage.isEnabled()) return
  inputSeen = true
  const target = e.target
  if (!(target instanceof Element) || target.closest(`${INTERACTIVE}, input, textarea, select`)) return
  const el = target.closest('[data-testid]')
  const id = el?.getAttribute('data-testid')
  if (!el || !id) return
  usage.record('ui', testIdName(id), { panel: panelOf(el), role: 'pointer' })
}

/** Which text field he clicked into (never what is in it, and never one line per key). */
function onFocusIn(e: FocusEvent): void {
  if (!real(e) || !usage.isEnabled()) return
  const el = e.target
  const text =
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !/^(checkbox|radio|range|file|button|submit|reset|color)$/.test(el.type))
  if (!text) return
  usage.record('ui', uiName(el).a, { panel: panelOf(el), role: 'text' })
}

function onChange(e: Event): void {
  if (!real(e) || !usage.isEnabled()) return
  const el = e.target
  if (el instanceof HTMLInputElement && el.type === 'file') {
    // A file picker: how many he chose, never which.
    usage.record('ui', uiName(el).a, { panel: panelOf(el), role: 'file', n: el.files?.length })
    return
  }
  if (!(el instanceof HTMLSelectElement) && !(el instanceof HTMLInputElement && el.type === 'range')) return
  // That it changed, never to what: a select can hold a device or a style he named.
  const { a } = uiName(el)
  usage.record('ui', a, { panel: panelOf(el), role: el instanceof HTMLSelectElement ? 'select' : 'slider' })
}

function onContextMenu(e: MouseEvent): void {
  if (!real(e) || !usage.isEnabled()) return
  const target = e.target
  if (!(target instanceof Element)) return
  const named = target.closest('[data-testid]')?.getAttribute('data-testid')
  usage.record('ui', 'context-menu', { on: named ? testIdName(named) : 'app', panel: panelOf(target) })
}

function onKeyDown(e: KeyboardEvent): void {
  if (real(e)) inputSeen = true
  // Escape and Enter are what close and confirm dialogs; a click is handled where it lands.
  if (e.key === 'Escape' || e.key === 'Enter') scheduleDialogScan()
}

// --- Errors ---------------------------------------------------------------------------

let errorWindowStart = 0
let errorsInWindow = 0

function onUncaught(message: string): void {
  if (!usage.isEnabled()) return
  const now = Date.now()
  if (now - errorWindowStart > 60_000) {
    errorWindowStart = now
    errorsInWindow = 0
  }
  if (++errorsInWindow > MAX_ERRORS_PER_MINUTE) return
  usage.record('error', maskMessage(message) || 'error', { src: 'uncaught' })
}

// --- The store: projects, playing, zooming ---------------------------------------------

function clipCount(): number {
  const { project } = useStore.getState()
  let n = 0
  for (const t of project.sequences[project.activeSequenceId]?.tracks ?? []) n += t.clips.length
  return n
}

function watchStores(): Array<() => void> {
  const stops: Array<() => void> = []
  let playStart = 0
  let playFrom = 0
  let zoomFrom = 0
  let zoomTimer: ReturnType<typeof setTimeout> | null = null

  // ⛔ THIS ONE RUNS ON EVERY STORE WRITE, playback ticks included, so it compares
  // references and nothing else on the way past: no object, no closure, no DOM.
  stops.push(
    useStore.subscribe((s, prev) => {
      if (s.project !== prev.project && s.project.id !== prev.project.id && usage.isEnabled()) openProject(s.project.id)
      if (s.ui === prev.ui) return
      if (s.ui.playing !== prev.ui.playing && usage.isEnabled()) {
        if (s.ui.playing) {
          playStart = Date.now()
          playFrom = s.ui.playheadS
        } else if (playStart > 0) {
          const ms = Date.now() - playStart
          playStart = 0
          // A press-and-release is not watching anything.
          if (ms >= 200) {
            usage.record('play', 'playback', { sec: Math.round(Math.abs(s.ui.playheadS - playFrom) * 10) / 10, loop: s.ui.loop }, ms)
          }
        }
      }
      if (s.ui.pxPerS !== prev.ui.pxPerS && usage.isEnabled()) {
        // One line for a whole zoom gesture: where it started, where it settled.
        if (zoomTimer === null) {
          zoomFrom = prev.ui.pxPerS
          zoomTimer = setTimeout(() => {
            zoomTimer = null
            const to = useStore.getState().ui.pxPerS
            if (to !== zoomFrom) usage.record('zoom', 'timeline-zoom', { from: Math.round(zoomFrom), to: Math.round(to) })
          }, 600)
        }
      }
    }),
  )

  let recordStart = 0
  stops.push(
    useRecorder.subscribe((s, prev) => {
      if (s.recording === prev.recording || !usage.isEnabled()) return
      if (s.recording) recordStart = Date.now()
      else if (recordStart > 0) {
        usage.record('record', 'voiceover', undefined, Date.now() - recordStart)
        recordStart = 0
      }
    }),
  )

  let runStart = 0
  let runClips = 0
  stops.push(
    useTranscribe.subscribe((s, prev) => {
      if (!usage.isEnabled()) return
      if (prev.status === 'idle' && s.status !== 'idle') {
        runStart = Date.now()
        runClips = 1
      }
      if (s.queue && s.queue.total > runClips) runClips = s.queue.total
      if (prev.status !== 'idle' && s.status === 'idle' && runStart > 0) {
        usage.record('caption', 'transcribe-run', { clips: runClips, lang: getCaptionLanguage() }, Date.now() - runStart)
        runStart = 0
      }
    }),
  )

  // Toasts: what he was shown. The two that echo an Undo or a Redo are already a
  // line of their own (history), so they are not written twice.
  // Only what is shown from here on: a toast already up when this started is not news.
  let lastToast = useToasts.getState().toasts.reduce((n, t) => Math.max(n, t.id), 0)
  stops.push(
    useToasts.subscribe((s) => {
      for (let i = s.toasts.length - 1; i >= 0; i--) {
        const t = s.toasts[i]!
        if (t.id <= lastToast) break
        if (usage.isEnabled() && !/^(Undo|Redo): /.test(t.message)) {
          const msg = maskMessage(t.message)
          if (t.kind === 'danger') usage.record('error', msg, { src: 'toast' })
          else usage.record('toast', msg, { level: t.kind, act: t.action?.label })
        }
      }
      const newest = s.toasts[s.toasts.length - 1]
      if (newest && newest.id > lastToast) lastToast = newest.id
    }),
  )

  stops.push(() => {
    if (zoomTimer !== null) clearTimeout(zoomTimer)
  })
  return stops
}

// --- Start up -------------------------------------------------------------------------

let stopAll: (() => void) | null = null

/**
 * Start the usage log. Called once, right after the settings are read, so the
 * switch in Settings is honoured from the very first event: off at boot means
 * anything already waiting is thrown away and nothing more is kept.
 *
 * Returns a function that takes all of it down again. The app never calls it; the
 * tests do, and so does the page that measures what the wiring itself costs.
 */
export function initUsageLog(): () => void {
  if (stopAll) return stopAll
  if (typeof document === 'undefined') return () => undefined
  usage.attach(pickSink(), projectForEvent)
  setKnownNames(knownNames)

  const sessionStart = Date.now()
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    usage.record('session', 'end', undefined, Date.now() - sessionStart)
    void usage.flush()
  }

  if (!useSettings.getState().usageLog) void usage.setEnabled(false, { discard: true })
  else {
    usage.record('session', 'start', { v: APP_VERSION, shell: isElectron ? 'desktop' : 'web', phone: isPhoneLayout() })
  }

  const stops: Array<() => void> = []

  // The switch in Settings. Turning it off writes a last line first, so the report
  // can say when the log was off; turning it on starts a line of its own.
  stops.push(
    useSettings.subscribe((s, prev) => {
      if (s.usageLog === prev.usageLog) return
      if (s.usageLog) {
        void usage.setEnabled(true)
        usage.record('session', 'log-on')
      } else {
        usage.record('session', 'log-off')
        void usage.setEnabled(false)
      }
    }),
  )

  const listen = <T extends EventTarget>(target: T, type: string, fn: (e: never) => void, capture = false): void => {
    target.addEventListener(type, fn as EventListener, capture)
    stops.push(() => target.removeEventListener(type, fn as EventListener, capture))
  }
  listen(document, 'click', onClick, true)
  listen(document, 'pointerdown', onPointerDown, true)
  listen(document, 'focusin', onFocusIn, true)
  listen(document, 'change', onChange, true)
  listen(document, 'contextmenu', onContextMenu, true)
  listen(document, 'keydown', onKeyDown, true)
  listen(window, 'error', (e: ErrorEvent) => onUncaught(e.message))
  listen(window, 'unhandledrejection', (e: PromiseRejectionEvent) => onUncaught(e.reason instanceof Error ? e.reason.message : String(e.reason)))
  // As the window goes away, and whenever it is hidden (the last chance on a phone).
  listen(window, 'pagehide', end)
  // beforeunload can be answered with Stay, so it only writes what is waiting; the end is pagehide.
  listen(window, 'beforeunload', () => void usage.flush())
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') void usage.flush()
  })

  stops.push(...watchStores())

  stopAll = () => {
    for (const stop of stops.splice(0)) stop()
    // A fresh start is a fresh log: nothing of this run's project or dialogs carries over.
    currentProject = undefined
    openedAt = 0
    projectsSeen = 0
    inputSeen = false
    openDialogs.clear()
    lateScan = 0
    stopAll = null
  }
  return stopAll
}
