import { describe, expect, it } from 'vitest'
import { newProject } from '../engine/types'
import { emptyHistory, MAX_HISTORY, pushCommand, redoCommand, undoCommand, type History } from './history'

const rename = (h: History, before: ReturnType<typeof newProject>, name: string) => {
  const after = { ...before, name }
  return { history: pushCommand(h, { label: `Rename to ${name}`, before, after }), project: after }
}

describe('history', () => {
  it('undo returns the before state, redo the after state', () => {
    const p0 = newProject('A')
    const { history: h1, project: p1 } = rename(emptyHistory(), p0, 'B')
    expect(p1.name).toBe('B')

    const u = undoCommand(h1)!
    expect(u.project.name).toBe('A')
    expect(u.history.undo).toHaveLength(0)
    expect(u.history.redo).toHaveLength(1)

    const r = redoCommand(u.history)!
    expect(r.project.name).toBe('B')
    expect(r.history.undo).toHaveLength(1)
    expect(r.history.redo).toHaveLength(0)
  })

  it('undo/redo on empty stacks return null', () => {
    expect(undoCommand(emptyHistory())).toBeNull()
    expect(redoCommand(emptyHistory())).toBeNull()
  })

  it('a new command clears the redo stack (history forks)', () => {
    const p0 = newProject('A')
    const s1 = rename(emptyHistory(), p0, 'B')
    const u = undoCommand(s1.history)!
    expect(u.history.redo).toHaveLength(1)
    const s2 = rename(u.history, u.project, 'C')
    expect(s2.history.redo).toHaveLength(0)
    expect(redoCommand(s2.history)).toBeNull()
    // The forked edit itself is still undoable back to the original.
    const u2 = undoCommand(s2.history)!
    expect(u2.project.name).toBe('A')
  })

  it('multi-step undo walks back in order', () => {
    const p0 = newProject('A')
    let h = emptyHistory()
    let p = p0
    for (const name of ['B', 'C', 'D']) {
      const s = rename(h, p, name)
      h = s.history
      p = s.project
    }
    const u1 = undoCommand(h)!
    expect(u1.project.name).toBe('C')
    const u2 = undoCommand(u1.history)!
    expect(u2.project.name).toBe('B')
    const u3 = undoCommand(u2.history)!
    expect(u3.project.name).toBe('A')
    expect(undoCommand(u3.history)).toBeNull()
  })

  it('caps the undo stack at MAX_HISTORY', () => {
    let h = emptyHistory()
    let p = newProject('0')
    for (let i = 1; i <= MAX_HISTORY + 25; i++) {
      const s = rename(h, p, String(i))
      h = s.history
      p = s.project
    }
    expect(h.undo).toHaveLength(MAX_HISTORY)
    // The oldest surviving command is #26 (the first 25 were dropped).
    expect(h.undo[0].after.name).toBe('26')
  })
})
