// The single Zustand store. Project mutations ALWAYS go through dispatch()
// so they land on the undo stack; UI state (tool, playhead, zoom, selection)
// is not undoable by design.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { newProject, type Id, type Project, type Sequence } from '../engine/types'
import {
  emptyHistory,
  pushCommand,
  redoCommand,
  undoCommand,
  type History,
} from './history'

export type Tool = 'select' | 'razor' | 'hand' | 'zoom'
export type SaveState = 'saved' | 'saving' | 'unsaved'
export type LeftTab = 'media' | 'effects'

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
}

export interface ReelState {
  project: Project
  history: History
  ui: UIState
  /** Apply an undoable edit to the project document. */
  dispatch: (label: string, fn: (p: Project) => Project) => void
  undo: () => void
  redo: () => void
  /** Replace the project without touching history (hydration from disk). */
  setProject: (p: Project) => void
  setUI: (patch: Partial<UIState>) => void
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
    },

    dispatch(label, fn) {
      const { project, history, ui } = get()
      const mutated = fn(project)
      if (mutated === project) return
      const after: Project = { ...mutated, updatedAt: Date.now() }
      set({
        project: after,
        history: pushCommand(history, { label, before: project, after }),
        ui: { ...ui, saveState: 'unsaved' },
      })
    },

    undo() {
      const { history, ui } = get()
      const r = undoCommand(history)
      if (!r) return
      set({ project: r.project, history: r.history, ui: { ...ui, saveState: 'unsaved' } })
    },

    redo() {
      const { history, ui } = get()
      const r = redoCommand(history)
      if (!r) return
      set({ project: r.project, history: r.history, ui: { ...ui, saveState: 'unsaved' } })
    },

    setProject(p) {
      set({ project: p, history: emptyHistory() })
    },

    setUI(patch) {
      set((s) => ({ ui: { ...s.ui, ...patch } }))
    },
  })),
)

/** Apply an undoable edit scoped to the active sequence. No-op if unchanged. */
export function updateActiveSequence(label: string, fn: (seq: Sequence) => Sequence): void {
  useStore.getState().dispatch(label, (p) => {
    const seq = p.sequences[p.activeSequenceId]
    const next = fn(seq)
    return next === seq ? p : { ...p, sequences: { ...p.sequences, [seq.id]: next } }
  })
}

export const zoomIn = () => {
  const { ui, setUI } = useStore.getState()
  setUI({ pxPerS: Math.min(MAX_PX_PER_S, ui.pxPerS * 1.4) })
}

export const zoomOut = () => {
  const { ui, setUI } = useStore.getState()
  setUI({ pxPerS: Math.max(MIN_PX_PER_S, ui.pxPerS / 1.4) })
}
