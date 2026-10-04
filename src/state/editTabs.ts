// Edit tabs: several edits open at once, and only the one he is on loaded.
//
// His words, 2026-10-03: *"make it so I can copy things from edit to edit like if
// im editing something different ... Also, make it so it has to load when I click
// each one, or maybe make only some load. I don't know, because we have to figure
// out how to make it not lag so much."* Asked how, he picked tabs: several edits
// open across the top, copy between them, and only the tab he is on loaded.
//
// ⛔ ASLEEP MEANS SAVED AND LET GO. A sleeping tab is a project id, its name, and
// what he left on screen as plain data: playhead, zoom, scroll, selection and the
// undo history. Its document is in the store and in its file, written the moment
// he left it. Its decoders, frames, decoded sound and preview elements are let go
// (projectResources.ts). Waking it is opening a project, the path the Projects
// dialog always took, which is why that dialog's Open now lands here too.
//
// ⛔ THE UNDO HISTORY IS KEPT ONLY WHILE IT STILL DESCRIBES THE DOCUMENT. It is a
// list of whole-project snapshots, so it is only true of the exact document it was
// recorded against. When the stored copy has changed since he left (a file opened
// over it, a recovery), the history is dropped rather than letting one Ctrl+Z put
// back a project that never existed.
//
// Copying between tabs needs nothing here: the clip clipboard lives for the whole
// session and carries the media records with the clips (clipboard.ts), so a paste
// into a woken tab is the same paste as a paste into another project.

import { create } from 'zustand'
import { useCollab } from '../collab/collabControl'
import type { Id, Project } from '../engine/types'
import { emptyHistory, type History } from './history'
import { listProjects, loadProjectById, rememberOpenProject, saveSettled, settleAfterLoad } from './persistence'
import { pausePlayback } from './playbackControl'
import { releaseClosedEdit, releaseSleepingEdit, type Released } from './projectResources'
import { useStore, type AppState, type UIState } from './store'
import { useToasts } from './toasts'

export interface EditTab {
  id: Id
  name: string
}

interface EditTabsState {
  /** Left to right, as on screen. */
  tabs: EditTab[]
  /** The edit being woken while a switch is on its way, for the strip to show. */
  waking: Id | null
}

const TABS_KEY = 'olpremiere:editTabs'

function readTabs(): EditTab[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(TABS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: EditTab[] = []
    for (const t of parsed as Partial<EditTab>[]) {
      if (!t || typeof t.id !== 'string' || seen.has(t.id)) continue
      seen.add(t.id)
      out.push({ id: t.id, name: typeof t.name === 'string' ? t.name : 'Untitled Project' })
    }
    return out
  } catch {
    // A list that will not read opens on the one project the app boots with.
    return []
  }
}

function writeTabs(tabs: readonly EditTab[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
  } catch {
    // Private mode or a full disk: the tabs still work for this run.
  }
}

export const useEditTabs = create<EditTabsState>(() => ({ tabs: readTabs(), waking: null }))

// Every change to the list is written as it happens, so the next start, a crash
// included, opens on the same tabs.
useEditTabs.subscribe((s, prev) => {
  if (s.tabs !== prev.tabs) writeTabs(s.tabs)
})

/** `tabs` with `p` in it under its current name. The same array when nothing changed. */
function withTab(tabs: EditTab[], p: { id: Id; name: string }): EditTab[] {
  const at = tabs.findIndex((t) => t.id === p.id)
  if (at < 0) return [...tabs, { id: p.id, name: p.name }]
  if (tabs[at].name === p.name) return tabs
  return tabs.map((t, i) => (i === at ? { id: p.id, name: p.name } : t))
}

const isTab = (id: Id): boolean => useEditTabs.getState().tabs.some((t) => t.id === id)

/** Put `p` in the strip if it is not there, and keep its name current. */
export function ensureTab(p: { id: Id; name: string }): void {
  useEditTabs.setState((s) => {
    const tabs = withTab(s.tabs, p)
    return tabs === s.tabs ? s : { tabs }
  })
}

// ---------------------------------------------------------------------------
// What a sleeping tab keeps

/** Where he was in an edit, as plain data. */
export interface TabView {
  playheadS: number
  pxPerS: number
  selection: Id[]
  motionSelection: UIState['motionSelection']
  motionPicks: UIState['motionPicks']
  /** The timeline's scroll, in px. */
  scrollLeft: number
  scrollTop: number
}

interface Asleep {
  history: History
  view: TabView
  /** The document's updatedAt as it was written when he left. */
  savedAt: number
}

const asleep = new Map<Id, Asleep>()

/** The timeline's scrolling lanes, read for the scroll a tab remembers. */
function lanes(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>('[data-testid="timeline-lanes"]')
}

function stash(s: Pick<AppState, 'project' | 'history' | 'ui'>): void {
  const el = lanes()
  asleep.set(s.project.id, {
    history: s.history,
    savedAt: s.project.updatedAt,
    view: {
      playheadS: s.ui.playheadS,
      pxPerS: s.ui.pxPerS,
      selection: s.ui.selection,
      motionSelection: s.ui.motionSelection,
      motionPicks: s.ui.motionPicks,
      scrollLeft: el?.scrollLeft ?? 0,
      scrollTop: el?.scrollTop ?? 0,
    },
  })
}

/** The clip ids of every sequence in `p`, to keep a remembered selection honest. */
function clipIds(p: Project): Set<Id> {
  const ids = new Set<Id>()
  for (const seq of Object.values(p.sequences)) for (const t of seq.tracks) for (const c of t.clips) ids.add(c.id)
  return ids
}

/**
 * Put the timeline back where he left it, once the woken edit has laid itself
 * out at its own zoom.
 *
 * In the next frame, not from a timer: reading the scroll forces a layout, and a
 * timer forced the whole new editor's layout early, once more than the frame
 * would anyway (measured 33 ms on Green). The timer is only the fallback for a
 * window that is not drawing frames.
 */
function restoreScroll(view: TabView): void {
  if (typeof window === 'undefined') return
  let done = false
  const apply = (): void => {
    if (done) return
    done = true
    const el = lanes()
    if (!el) return
    if (Math.abs(el.scrollLeft - view.scrollLeft) > 1) el.scrollLeft = view.scrollLeft
    if (Math.abs(el.scrollTop - view.scrollTop) > 1) el.scrollTop = view.scrollTop
  }
  if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(apply)
  window.setTimeout(apply, 250)
}

/** True while adopt() is replacing the project, so the foreign-change listener stays out of it. */
let adopting = false

/**
 * Swap `p` in for the open edit, in ONE store write: the document, its own undo
 * history if it still applies, and where he was in it. Then let go of what the
 * edit he left was holding.
 */
function adopt(p: Project): { asleep: Asleep | undefined; released: Released } {
  const before = useStore.getState()
  const prev = before.project
  // The edit he leaves stays in the strip: it is one of his open edits now.
  useEditTabs.setState((s) => ({ tabs: withTab(withTab(s.tabs, prev), p) }))
  stash(before)
  const mem = asleep.get(p.id)
  asleep.delete(p.id)
  const history = mem && mem.savedAt === p.updatedAt ? mem.history : emptyHistory()
  const alive = mem ? clipIds(p) : new Set<Id>()
  adopting = true
  try {
    useStore.setState((s) => ({
      project: p,
      history,
      ui: {
        ...s.ui,
        selection: [],
        motionSelection: null,
        motionPicks: [],
        motionGroupDeltaS: null,
        playheadS: 0,
        playing: false,
        saveState: 'saved' as const,
        ...(mem
          ? {
              playheadS: mem.view.playheadS,
              pxPerS: mem.view.pxPerS,
              selection: mem.view.selection.filter((id) => alive.has(id)),
              // The rail's picks are moments on the selected clip, so they only
              // come back with a history that still describes that clip.
              motionSelection: history === mem.history ? mem.view.motionSelection : null,
              motionPicks: history === mem.history ? mem.view.motionPicks : [],
            }
          : {}),
      },
    }))
  } finally {
    adopting = false
  }
  // It was read from storage a moment ago: there is nothing to write back.
  settleAfterLoad()
  return { asleep: mem, released: releaseSleepingEdit(prev, p) }
}

// ---------------------------------------------------------------------------
// Leaving an edit

/** Switching projects inside a collab room would tear the room's doc out from
 * under the peers, so leave first (Leave already restores your solo project).
 * Opening a project FILE replaces the document exactly the same way. */
export function guardRoom(): boolean {
  if (useCollab.getState().session !== null) {
    useToasts.getState().show('Leave the room before switching projects', 'danger')
    return false
  }
  return true
}

/**
 * Work still landing in the open edit when it finishes. Captions, a voice take
 * and an import each write into whatever edit is open when they end, so leaving
 * mid way would put them in the wrong one. Null when nothing is running.
 *
 * Read through dynamic imports: each of those modules drags in its whole engine,
 * and a module that will not load has nothing running.
 */
async function whatKeepsThisEditOpen(): Promise<string | null> {
  try {
    const [{ useTranscribe }, { useRecorder }, { useImportProgress }] = await Promise.all([
      import('./transcribeActions'),
      import('./voiceRecorder'),
      import('./mediaActions'),
    ])
    if (useTranscribe.getState().status !== 'idle') {
      return 'Captions are still being made for this edit, so it stays open until they land'
    }
    const take = useRecorder.getState()
    if (take.recording || take.pendingTake !== null || take.keeping) {
      return 'A voice take is still in the studio, so this edit stays open until it is kept or binned'
    }
    if (useImportProgress.getState().total > 0) {
      return 'Media is still coming into this edit, so it stays open until the import finishes'
    }
  } catch {
    // Nothing that cannot load is running.
  }
  return null
}

/**
 * Flush the open project before it is put away. Returns false when the write
 * failed: switching would then drop every unsaved edit, so the caller must abort
 * rather than "autosave first" in name only.
 */
export async function flushOutgoing(always = false): Promise<boolean> {
  try {
    await saveSettled(always)
    return true
  } catch {
    useToasts.getState().show('Could not save this project. Staying here so nothing is lost', 'danger')
    return false
  }
}

/** How the last switch went: how long it took and what it let go of. */
export interface SwitchStats {
  id: Id
  ms: number
  released: Released
  keptHistory: boolean
}
let lastSwitch: SwitchStats | null = null
export const lastSwitchStats = (): SwitchStats | null => lastSwitch

export type SwitchResult = 'ok' | 'refused' | 'missing'

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Open `target` in its tab: focus it when it is already open, wake it when it is
 * asleep, add it when it is new. A Project is adopted as it is (a brand new one,
 * a file just opened); an id is read from the store, which is what waking is.
 *
 * The edit he leaves is saved first and nothing happens when that fails. Never
 * two at once: a click on another tab while one is waking is ignored.
 */
export async function switchTo(
  target: Id | Project,
  opts: { announce?: boolean } = {},
): Promise<SwitchResult> {
  const id = typeof target === 'string' ? target : target.id
  const current = useStore.getState().project
  if (id === current.id) {
    ensureTab(current)
    return 'ok'
  }
  if (useEditTabs.getState().waking) return 'refused'
  if (!guardRoom()) return 'refused'
  // Claimed BEFORE the first await, or two quick clicks both get past the check
  // above and wake two edits over each other.
  useEditTabs.setState({ waking: id })
  const t0 = now()
  try {
    const busy = await whatKeepsThisEditOpen()
    if (busy) {
      useToasts.getState().show(busy, 'info')
      return 'refused'
    }
    pausePlayback()
    // An edit with no tab yet may never have been written at all (the blank one a
    // first ever start opens on), and it is about to become a tab of its own.
    if (!(await flushOutgoing(!isTab(current.id)))) return 'refused'
    const p = typeof target === 'string' ? await loadProjectById(id) : target
    if (!p) {
      useToasts.getState().show('That edit could not be opened, so its tab was closed', 'danger')
      forgetTab(id)
      return 'missing'
    }
    // An edit he made while that was loading is written too, before it is let go.
    if (!(await flushOutgoing())) return 'refused'
    const { asleep: mem, released } = adopt(p)
    if (typeof target === 'string') void rememberOpenProject(p.id).catch(() => undefined)
    if (mem) restoreScroll(mem.view)
    lastSwitch = { id, ms: Math.round(now() - t0), released, keptHistory: !!mem && mem.savedAt === p.updatedAt }
    if (opts.announce) useToasts.getState().show(`Opened “${p.name}”`, 'success')
    return 'ok'
  } finally {
    useEditTabs.setState({ waking: null })
  }
}

/** The other tabs in the order a closed one hands over: the one to its right first, then leftwards. */
export function neighbourTabs(id: Id): Id[] {
  const tabs = useEditTabs.getState().tabs
  const at = tabs.findIndex((t) => t.id === id)
  if (at < 0) return tabs.map((t) => t.id)
  return [...tabs.slice(at + 1), ...tabs.slice(0, at).reverse()].map((t) => t.id)
}

/**
 * Close a tab. The open one hands over to its neighbour first, which saves it on
 * the way out exactly as switching does; a sleeping one was saved when he left it.
 * The last tab never closes: the editor always has an edit open.
 */
export async function closeTab(id: Id): Promise<boolean> {
  const tabs = useEditTabs.getState().tabs
  if (!tabs.some((t) => t.id === id) || tabs.length <= 1) return false
  if (id === useStore.getState().project.id) {
    let landed = false
    for (const next of neighbourTabs(id)) {
      const r = await switchTo(next)
      if (r === 'ok') {
        landed = true
        break
      }
      // A neighbour whose project has gone is skipped; anything else (a failed
      // save, captions still running) means this tab stays exactly as it was.
      if (r === 'refused') return false
    }
    if (!landed) return false
  }
  forgetTab(id)
  return true
}

/** Take a tab out of the strip and out of memory, for a closed tab or a deleted project. */
export function forgetTab(id: Id): void {
  useEditTabs.setState((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id)
    return tabs.length === s.tabs.length ? s : { tabs }
  })
  asleep.delete(id)
  releaseClosedEdit({ id }, useStore.getState().project)
}

// ---------------------------------------------------------------------------
// Boot

/**
 * Follow every project change that did not come through a tab: the boot opening
 * the last project, a collab room swapping its document in, a file restored over
 * the open project. Each gets a tab, the one it replaced keeps its own, and what
 * that one held is let go the same as on a tab switch. Install once, BEFORE the
 * boot hydrates the project, so the first edit gets its tab. Returns the
 * uninstaller.
 */
export function installEditTabs(): () => void {
  return useStore.subscribe((s, prev) => {
    if (adopting) return
    if (s.project.id !== prev.project.id) {
      if (isTab(prev.project.id)) stash(prev)
      asleep.delete(s.project.id)
      ensureTab(s.project)
      releaseSleepingEdit(prev.project, s.project)
    } else if (s.project.name !== prev.project.name) {
      // A rename in the top bar shows on its tab at once.
      if (isTab(s.project.id)) ensureTab(s.project)
    }
  })
}

/**
 * After the boot has opened the last project: drop tabs whose project has gone
 * (deleted on another run, binned by a recovery) and take the names the projects
 * have now. Never throws; a list that will not load leaves the tabs as they are.
 */
export async function reconcileEditTabs(): Promise<void> {
  let all: { id: Id; name: string }[]
  try {
    all = await listProjects()
  } catch {
    return
  }
  const byId = new Map(all.map((p) => [p.id, p.name]))
  const open = useStore.getState().project
  useEditTabs.setState((s) => {
    const tabs = s.tabs
      .filter((t) => byId.has(t.id) || t.id === open.id)
      .map((t) => {
        const name = t.id === open.id ? open.name : (byId.get(t.id) ?? t.name)
        return name === t.name ? t : { id: t.id, name }
      })
    const same = tabs.length === s.tabs.length && tabs.every((t, i) => t === s.tabs[i])
    return same ? s : { tabs }
  })
  if (byId.has(open.id)) ensureTab(open)
}

/** Test seam: an empty strip and no sleeping tabs. */
export function resetEditTabsForTests(): void {
  asleep.clear()
  lastSwitch = null
  useEditTabs.setState({ tabs: [], waking: null })
}

/** Test seam: what a sleeping tab is holding. */
export function sleepingTabForTests(id: Id): Asleep | undefined {
  return asleep.get(id)
}
