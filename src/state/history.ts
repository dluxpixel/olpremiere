// Command history for undo/redo. Commands capture before/after snapshots of
// the Project document; immutable updates give structural sharing, so a
// snapshot costs one object reference, not a deep copy.

import type { Project } from '../engine/types'

export interface Command {
  label: string
  before: Project
  after: Project
  /**
   * Commands sharing a merge key COALESCE into a single undo step while they
   * keep arriving. Typing is the case that matters: one command per keystroke
   * meant a sentence cost thirty undo steps, and ~200 characters silently
   * pushed every other edit of the session off the end of MAX_HISTORY. The key
   * identifies the run (the field AND the clip), so moving to another clip
   * starts a new step.
   */
  mergeKey?: string
  /** Wall-clock ms; only used to decide whether a merge run is still live. */
  at?: number
}

export interface History {
  undo: Command[]
  redo: Command[]
}

export const MAX_HISTORY = 200

/**
 * A pause this long ends a merge run, so undo lands on the natural pauses in
 * typing rather than swallowing an entire session's edits into one step.
 */
export const MERGE_WINDOW_MS = 1000

export const emptyHistory = (): History => ({ undo: [], redo: [] })

/**
 * Push a new command: truncates redo (a new edit forks history). Consecutive
 * commands with the same merge key, arriving within MERGE_WINDOW_MS of each
 * other, fold into the previous step, keeping its `before` (so one undo goes
 * back to where the run started) and taking the newest `after`.
 */
export function pushCommand(h: History, cmd: Command): History {
  const top = h.undo[h.undo.length - 1]
  if (
    cmd.mergeKey !== undefined &&
    top !== undefined &&
    top.mergeKey === cmd.mergeKey &&
    (cmd.at ?? 0) - (top.at ?? 0) <= MERGE_WINDOW_MS
  ) {
    const merged: Command = { ...top, after: cmd.after, at: cmd.at }
    return { undo: [...h.undo.slice(0, -1), merged], redo: [] }
  }
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

/**
 * Pop the next undo/redo command WITHOUT applying its snapshot. Collab rooms
 * use this: restoring a whole-project snapshot would clobber every edit other
 * people made since, so the session re-applies just this command's own delta
 * (rebased onto the current shared state) instead.
 */
export function popCommand(h: History, dir: 'undo' | 'redo'): { history: History; command: Command } | null {
  const stack = h[dir]
  const cmd = stack[stack.length - 1]
  if (!cmd) return null
  return {
    history:
      dir === 'undo'
        ? { undo: h.undo.slice(0, -1), redo: [...h.redo, cmd] }
        : { undo: [...h.undo, cmd], redo: h.redo.slice(0, -1) },
    command: cmd,
  }
}
