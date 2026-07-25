// The single Zustand store. Project mutations ALWAYS go through dispatch()
// so they land on the undo stack; UI state (tool, playhead, zoom, selection)
// is not undoable by design.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { setSequenceFormat } from '../engine/timeline'
import { newProject, type Id, type Project, type Sequence } from '../engine/types'
import {
  emptyHistory,
  popCommand,
  pushCommand,
  redoCommand,
  undoCommand,
  type Command,
  type History,
} from './history'

export type Tool = 'select' | 'razor' | 'hand'
export type SaveState = 'saved' | 'saving' | 'unsaved'
export type LeftTab = 'media' | 'effects' | 'library'

export interface UIState {
  tool: Tool
  snapping: boolean
  playheadS: number
  /** Timeline zoom: pixels per second. */
  pxPerS: number
  selection: Id[]
  leftTab: LeftTab
  saveState: SaveState
  playing: boolean
  /** Loop playback over the in/out range (or the whole sequence). */
  loop: boolean
  /** Chosen punch-in / zoom depth (target scale) used by P and the Zoom control. */
  punchDepth: number
  /** Keyboard-shortcuts help overlay. */
  helpOpen: boolean
}

export interface ReelState {
  project: Project
  history: History
  ui: UIState
  /**
   * Apply an undoable edit to the project document. Passing a `mergeKey` folds
   * this edit into the previous one when they share the key and arrive close
   * together — that is what makes a typed sentence ONE undo step.
   */
  dispatch: (label: string, fn: (p: Project) => Project, mergeKey?: string) => void
  /** Returns the undone/redone command's label, or null when there was nothing. */
  undo: () => string | null
  redo: () => string | null
  /** Replace the project without touching history (hydration from disk). */
  setProject: (p: Project) => void
  /**
   * Apply a REMOTE collaborator's state: replaces the project but PRESERVES
   * local history (a remote edit must not wipe your undo stack) and prunes the
   * selection down to clips that still exist.
   */
  applyRemoteProject: (p: Project) => void
  /** Pop an undo/redo command WITHOUT applying it (collab rebased undo). */
  popHistory: (dir: 'undo' | 'redo') => Command | null
  setUI: (patch: Partial<UIState>) => void
  /** Switch the active sequence. Deliberately NOT undoable (tab switching). */
  setActiveSequenceId: (id: Id) => void
}

export const MIN_PX_PER_S = 4
export const MAX_PX_PER_S = 800

export const useStore = create<ReelState>()(
  subscribeWithSelector((set, get) => ({
    project: newProject(),
    history: emptyHistory(),
    ui: {
      tool: 'select',
      snapping: true,
      playheadS: 0,
      pxPerS: 60,
      selection: [],
      leftTab: 'media',
      saveState: 'saved',
      playing: false,
      loop: false,
      punchDepth: 1.2,
      helpOpen: false,
    },

    dispatch(label, fn, mergeKey) {
      const { project, history, ui } = get()
      const mutated = fn(project)
      if (mutated === project) return
      const at = Date.now()
      const after: Project = { ...mutated, updatedAt: at }
      set({
        project: after,
        history: pushCommand(history, { label, before: project, after, mergeKey, at }),
        ui: { ...ui, saveState: 'unsaved' },
      })
    },

    // Return the command label (or null when there's nothing to undo/redo) so
    // the caller can surface it — keeps the store free of any toast dependency.
    undo() {
      const { history, ui } = get()
      const r = undoCommand(history)
      if (!r) return null
      set({ project: r.project, history: r.history, ui: { ...ui, saveState: 'unsaved' } })
      return r.label
    },

    redo() {
      const { history, ui } = get()
      const r = redoCommand(history)
      if (!r) return null
      set({ project: r.project, history: r.history, ui: { ...ui, saveState: 'unsaved' } })
      return r.label
    },

    setProject(p) {
      set({ project: p, history: emptyHistory() })
    },

    applyRemoteProject(p) {
      set((s) => {
        const seq = p.sequences[p.activeSequenceId]
        const alive = new Set(seq ? seq.tracks.flatMap((t) => t.clips.map((c) => c.id)) : [])
        return {
          project: p,
          // Adopting a DIFFERENT project (joining a room) invalidates history by
          // definition — stale commands recorded against the old project would
          // otherwise rebase its meta (id/name!) into the room and let autosave
          // overwrite the user's own project.
          ...(p.id !== s.project.id ? { history: emptyHistory() } : {}),
          ui: { ...s.ui, selection: s.ui.selection.filter((id) => alive.has(id)), saveState: 'unsaved' as const },
        }
      })
    },

    popHistory(dir) {
      const { history } = get()
      const r = popCommand(history, dir)
      if (!r) return null
      set({ history: r.history })
      return r.command
    },

    setUI(patch) {
      set((s) => ({ ui: { ...s.ui, ...patch } }))
    },

    setActiveSequenceId(id) {
      set((s) => {
        if (!s.project.sequences[id] || s.project.activeSequenceId === id) return s
        return {
          project: { ...s.project, activeSequenceId: id, updatedAt: Date.now() },
          ui: { ...s.ui, playheadS: 0, selection: [], playing: false, saveState: 'unsaved' as const },
        }
      })
    },
  })),
)

/** Apply an undoable edit scoped to the active sequence. No-op if unchanged. */
export function updateActiveSequence(
  label: string,
  fn: (seq: Sequence) => Sequence,
  mergeKey?: string,
): void {
  useStore.getState().dispatch(
    label,
    (p) => {
      const seq = p.sequences[p.activeSequenceId]
      const next = fn(seq)
      return next === seq ? p : { ...p, sequences: { ...p.sequences, [seq.id]: next } }
    },
    mergeKey,
  )
}

/**
 * Reformat the active sequence (aspect/resolution, e.g. 9:16 Shorts) and refit
 * its clips to fill. Also updates the project default so new sequences inherit
 * it. One undoable edit.
 */
export function setActiveSequenceFormat(width: number, height: number, refit = true): void {
  useStore.getState().dispatch('Set aspect ratio', (p) => {
    const seq = p.sequences[p.activeSequenceId]
    const next = setSequenceFormat(seq, p.assets, width, height, refit)
    if (next === seq) return p
    return {
      ...p,
      sequences: { ...p.sequences, [seq.id]: next },
      settings: { ...p.settings, width, height },
    }
  })
}

// Zoom is anchored by the Timeline (playhead-if-visible, else view center) so
// the view never drifts while zooming — raw pxPerS writes slide toward t=0.
// The event keeps this store DOM-free; with no timeline mounted it's a no-op.
export const zoomIn = () => {
  window.dispatchEvent(new CustomEvent('reel:zoom', { detail: { factor: 1.4 } }))
}

export const zoomOut = () => {
  window.dispatchEvent(new CustomEvent('reel:zoom', { detail: { factor: 1 / 1.4 } }))
}
