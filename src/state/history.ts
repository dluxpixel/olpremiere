// Command history for undo/redo. Commands capture before/after snapshots of
// the Project document; immutable updates give structural sharing, so a
// snapshot costs one object reference, not a deep copy.

import type { Project } from '../engine/types'

export interface Command {
  label: string
  before: Project
  after: Project
}

export interface History {
  undo: Command[]
  redo: Command[]
}

export const MAX_HISTORY = 200

export const emptyHistory = (): History => ({ undo: [], redo: [] })

/** Push a new command: truncates redo (a new edit forks history). */
export function pushCommand(h: History, cmd: Command): History {
  const undo = [...h.undo, cmd]
  return { undo: undo.length > MAX_HISTORY ? undo.slice(undo.length - MAX_HISTORY) : undo, redo: [] }
}

export function undoCommand(h: History): { history: History; project: Project; label: string } | null {
  const cmd = h.undo[h.undo.length - 1]
  if (!cmd) return null
  return {
    history: { undo: h.undo.slice(0, -1), redo: [...h.redo, cmd] },
    project: cmd.before,
    label: cmd.label,
  }
}

export function redoCommand(h: History): { history: History; project: Project; label: string } | null {
  const cmd = h.redo[h.redo.length - 1]
  if (!cmd) return null
  return {
    history: { undo: [...h.undo, cmd], redo: h.redo.slice(0, -1) },
    project: cmd.after,
    label: cmd.label,
  }
}
