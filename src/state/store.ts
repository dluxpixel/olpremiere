// The single Zustand store. Project mutations ALWAYS go through dispatch()
// so they land on the undo stack; UI state (tool, playhead, zoom, selection)
// is not undoable by design.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { MOTION_CURVES, type MotionCurveName } from '../engine/motion'
import { setSequenceFormat } from '../engine/timeline'
import { BACKDROP_ZOOM, BLUR_BACKDROP_ZOOM } from '../engine/render/resolve'
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
  /**
   * How long a punch takes to arrive, in WHOLE frames. 200ms is the number the
   * move was designed around, which is 5 frames at 24fps and 6 at 30.
   */
  punchRiseFrames: number
  /**
   * The curve every drag, field commit and preset writes. Linear is the opt-out,
   * not the default: that single choice is most of the visible quality gap.
   */
  moveCurve: MotionCurveName
  /**
   * Where a zoom converges, in NORMALIZED frame coords (0..1). Sits above the
   * geometric centre because that is a framed talking head's eye line, and
   * zooming at the face rather than the middle of the frame is the whole point.
   */
  zoomAnchor: ZoomAnchor
  /** Keyboard-shortcuts help overlay. */
  helpOpen: boolean
  /**
   * The hand controls under the shelf: the punch buttons, the rail, the lanes
   * and the curve editor. Closed by default, because four ways to do one thing
   * stacked on top of each other is what made the motion desk hard to read. It
   * lives in the UI state rather than in the panel so it stays open across every
   * clip he touches once he has opened it.
   */
  handTuneOpen: boolean
  /**
   * A move is playing itself back after being picked off the shelf. Read like
   * `playing`: anything that would cost a React render per frame stands down for
   * the length of the sweep. Never persisted, never undoable.
   */
  previewingMove: boolean
}

/** A point in normalized frame coords (0..1 across the sequence frame). */
export interface ZoomAnchor {
  x: number
  y: number
}

/** Centre horizontally, eye line vertically. What Reset restores. */
export const DEFAULT_ZOOM_ANCHOR: ZoomAnchor = { x: 0.5, y: 0.4 }

export interface AppState {
  project: Project
  history: History
  ui: UIState
  /**
   * Apply an undoable edit to the project document. Passing a `mergeKey` folds
   * this edit into the previous one when they share the key and arrive close
   * together. That is what makes a typed sentence ONE undo step.
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

// Two of the motion preferences outlive the session, and they live beside the
// saved depth chips under 'olpremiere:zoomPresets'. Both describe how HIS edit
// feels rather than anything about one project, so a project file is the wrong
// home for them: the zoom point he set with a right-click, and the curve every
// move is written with.
const ZOOM_ANCHOR_KEY = 'olpremiere:zoomAnchor'
const MOVE_CURVE_KEY = 'olpremiere:moveCurve'

function readPref(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function writePref(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // Private mode / quota: the choice still applies for the rest of this run.
  }
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

function loadZoomAnchor(): ZoomAnchor {
  try {
    const raw = readPref(ZOOM_ANCHOR_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      const { x, y } = parsed as { x?: unknown; y?: unknown }
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y))
        return { x: clamp01(x), y: clamp01(y) }
    }
  } catch {
    // Corrupt JSON boots on the default rather than on NaN, which would put
    // every punch's focal point off the frame.
  }
  return DEFAULT_ZOOM_ANCHOR
}

function loadMoveCurve(): MotionCurveName {
  const raw = readPref(MOVE_CURVE_KEY)
  // Validated against the one curve table: a name from an older or newer build
  // falls back rather than reaching the builders as undefined.
  return raw && Object.hasOwn(MOTION_CURVES, raw) ? (raw as MotionCurveName) : 'snapIn'
}

export const useStore = create<AppState>()(
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
      punchRiseFrames: 5,
      moveCurve: loadMoveCurve(),
      zoomAnchor: loadZoomAnchor(),
      helpOpen: false,
      handTuneOpen: false,
      previewingMove: false,
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
    // the caller can surface it, which keeps the store free of any toast dependency.
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
          // definition; stale commands recorded against the old project would
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
      // The persisted pair saves through the ONE mutation path, so the monitor's
      // 'Set zoom point here', the panel's curve chips and anything added later
      // all survive a reload without each call site remembering to write.
      if (patch.zoomAnchor) writePref(ZOOM_ANCHOR_KEY, JSON.stringify(patch.zoomAnchor))
      if (patch.moveCurve) writePref(MOVE_CURVE_KEY, patch.moveCurve)
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

/**
 * Fill the empty frame with a blurred copy of the picture instead of black.
 * Undoable like any other edit, because it changes what the video looks like.
 */
export function setActiveSequenceBlurBackground(on: boolean): void {
  useStore.getState().dispatch('Blurred background', (p) => {
    const seq = p.sequences[p.activeSequenceId]
    if ((seq.blurBackground === true) === on) return p
    return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, blurBackground: on } } }
  })
}

/**
 * How tight the blurred band is, per sequence. Undoable, because it changes what
 * the video looks like, and merged into one step per drag the way a scrub should
 * be: a slow pull across the range is one press of undo, not forty.
 */
export function setActiveSequenceBlurBackdropZoom(zoom: number): void {
  const next = Math.min(BLUR_BACKDROP_ZOOM.max, Math.max(BLUR_BACKDROP_ZOOM.min, zoom))
  useStore.getState().dispatch(
    'Blur band tightness',
    (p) => {
      const seq = p.sequences[p.activeSequenceId]
      if ((seq.blurBackdropZoom ?? BACKDROP_ZOOM) === next) return p
      return { ...p, sequences: { ...p.sequences, [seq.id]: { ...seq, blurBackdropZoom: next } } }
    },
    'blur-backdrop-zoom',
  )
}

// Zoom is anchored by the Timeline (playhead-if-visible, else view center) so
// the view never drifts while zooming (raw pxPerS writes slide toward t=0).
// The event keeps this store DOM-free; with no timeline mounted it's a no-op.
export const zoomIn = () => {
  window.dispatchEvent(new CustomEvent('olpremiere:zoom', { detail: { factor: 1.4 } }))
}

export const zoomOut = () => {
  window.dispatchEvent(new CustomEvent('olpremiere:zoom', { detail: { factor: 1 / 1.4 } }))
}
