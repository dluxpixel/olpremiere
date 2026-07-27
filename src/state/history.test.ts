import { describe, expect, it } from 'vitest'
import { newProject } from '../engine/types'
import {
  emptyHistory,
  MAX_HISTORY,
  MERGE_WINDOW_MS,
  pushCommand,
  redoCommand,
  undoCommand,
  type History,
} from './history'

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

describe('coalescing a continuous edit', () => {
  const p0 = newProject('')
  /** One keystroke: appends a character to the name. */
  const type = (h: History, before: ReturnType<typeof newProject>, ch: string, at: number, key = 'text') => {
    const after = { ...before, name: before.name + ch }
    return { history: pushCommand(h, { label: 'Edit title', before, after, mergeKey: key, at }), project: after }
  }

  const typeAll = (word: string, gapMs = 120, key = 'text') => {
    let h = emptyHistory()
    let p = p0
    ;[...word].forEach((ch, i) => {
      const s = type(h, p, ch, 1000 + i * gapMs, key)
      h = s.history
      p = s.project
    })
    return { history: h, project: p }
  }

  it('a typed word is ONE undo step that goes back to before the word', () => {
    const { history, project } = typeAll('hello')
    expect(project.name).toBe('hello')
    expect(history.undo).toHaveLength(1)

    const u = undoCommand(history)!
    expect(u.project.name).toBe('')
    expect(undoCommand(u.history)).toBeNull()

    // and redo puts the whole word back at once
    expect(redoCommand(u.history)!.project.name).toBe('hello')
  })

  it('a long paragraph no longer evicts the session, so it stays one step', () => {
    const { history } = typeAll('x'.repeat(MAX_HISTORY + 50))
    expect(history.undo).toHaveLength(1)
  })

  it('a pause ends the run, so undo lands on the natural breaks', () => {
    let s = type(emptyHistory(), p0, 'a', 1000)
    s = type(s.history, s.project, 'b', 1000 + MERGE_WINDOW_MS + 1) // long pause
    expect(s.history.undo).toHaveLength(2)
    expect(undoCommand(s.history)!.project.name).toBe('a')
  })

  it('a different field or clip starts its own step', () => {
    let s = type(emptyHistory(), p0, 'a', 1000, 'title:text:clip1')
    s = type(s.history, s.project, 'b', 1050, 'title:color:clip1')
    s = type(s.history, s.project, 'c', 1100, 'title:text:clip2')
    expect(s.history.undo).toHaveLength(3)
  })

  it('an un-keyed edit between two runs breaks them apart', () => {
    let s = type(emptyHistory(), p0, 'a', 1000)
    const mid = { ...s.project, name: s.project.name + '!' }
    s = {
      history: pushCommand(s.history, { label: 'Split clip', before: s.project, after: mid, at: 1050 }),
      project: mid,
    }
    s = type(s.history, s.project, 'b', 1100)
    expect(s.history.undo).toHaveLength(3)
  })

  it('merging still forks history: redo is dropped', () => {
    const first = typeAll('ab')
    const u = undoCommand(first.history)!
    expect(u.history.redo).toHaveLength(1)
    const next = type(u.history, u.project, 'z', 5000)
    expect(next.history.redo).toHaveLength(0)
  })
})
