import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import { MAX_HISTORY } from './history'
import { updateActiveSequence, useStore } from './store'
import { updateTitle } from './titleActions'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clips = () => seq().tracks[0].clips
const titleOf = (id: string) => clips().find((c) => c.id === id)!.title!
const undoDepth = () => useStore.getState().history.undo.length

function seedTitle(text: string): Clip {
  const clip = newTitleClip(defaultTitleDef(text), 0, 5)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

/** Type `text` into the title one character at a time, as the textarea does. */
function typeText(clipId: string, text: string): void {
  for (let i = 1; i <= text.length; i++) updateTitle(clipId, { text: text.slice(0, i) }, 'text')
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

describe('typing into a title', () => {
  it('is ONE undo step, and undo restores the text you started from', () => {
    const clip = seedTitle('Hi')
    const base = undoDepth()

    typeText(clip.id, 'Hello world')
    expect(titleOf(clip.id).text).toBe('Hello world')
    expect(undoDepth()).toBe(base + 1) // eleven keystrokes, one step

    useStore.getState().undo()
    expect(titleOf(clip.id).text).toBe('Hi')
  })

  it('does not evict the rest of the session from the undo stack', () => {
    // The bug: a command per keystroke meant a couple of paragraphs silently
    // pushed every other edit of the session off the end of MAX_HISTORY.
    const clip = seedTitle('start')
    typeText(clip.id, 'x'.repeat(MAX_HISTORY + 50))

    expect(undoDepth()).toBeLessThan(10)
    useStore.getState().undo() // the whole typed run
    expect(titleOf(clip.id).text).toBe('start')
    useStore.getState().undo() // and the seed is still reachable
    expect(clips()).toHaveLength(0)
  })

  it('keeps a different FIELD as its own step', () => {
    const clip = seedTitle('Hi')
    typeText(clip.id, 'Hey')
    const afterText = undoDepth()
    updateTitle(clip.id, { color: '#ff0000' }, 'color')
    expect(undoDepth()).toBe(afterText + 1)

    useStore.getState().undo()
    expect(titleOf(clip.id).color).not.toBe('#ff0000')
    expect(titleOf(clip.id).text).toBe('Hey') // the typing survives
  })

  it('keeps a different CLIP as its own step', () => {
    const a = seedTitle('A')
    const b = seedTitle('B')
    typeText(a.id, 'aa')
    const afterA = undoDepth()
    typeText(b.id, 'bb')
    expect(undoDepth()).toBe(afterA + 1)
  })

  it('leaves discrete edits alone, so they stay one step each', () => {
    const clip = seedTitle('Hi')
    const base = undoDepth()
    updateTitle(clip.id, { bold: true })
    updateTitle(clip.id, { italic: true })
    expect(undoDepth()).toBe(base + 2)
  })
})
