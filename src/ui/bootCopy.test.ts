import { describe, expect, it } from 'vitest'
import { BACKGROUND_TITLE, GATING_TITLE, MARK, cursorIndex, splitRows } from './bootCopy'
import type { BootStepState } from './bootProgress'

const states = (...s: BootStepState[]): BootStepState[] => s

describe('cursorIndex picks the one row the eye lands on', () => {
  it('is the newest row to have moved, so the light walks down the list', () => {
    expect(cursorIndex(states('done', 'done', 'pending', 'pending'))).toBe(1)
    expect(cursorIndex(states('done', 'done', 'done', 'pending'))).toBe(2)
  })

  it('lights nothing before the first row has moved', () => {
    // A bright row over an untouched list would be claiming something happened.
    expect(cursorIndex(states('pending', 'pending', 'pending'))).toBe(-1)
    expect(cursorIndex([])).toBe(-1)
  })

  it('lights nothing once the whole list has landed', () => {
    // The footer says "Ready" at this point. A row still shouting would be saying
    // it is busy while the card is on its way out.
    expect(cursorIndex(states('done', 'done', 'done'))).toBe(-1)
  })

  it('keeps the last row lit while it is genuinely still running', () => {
    // The caption model can honestly download for minutes after everything above
    // it landed. That row IS what is happening, so it stays the bright one.
    expect(cursorIndex(states('done', 'done', 'active'))).toBe(2)
  })

  it('lights a failure like any other row that moved, and the styling shouts it', () => {
    expect(cursorIndex(states('done', 'failed', 'pending'))).toBe(1)
  })
})

describe('splitRows draws the line the card draws', () => {
  it('splits on optional, which is exactly "does not hold the app shut"', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'net', optional: true }]
    const { gating, background } = splitRows(rows)
    expect(gating.map((r) => r.id)).toEqual(['a', 'b'])
    expect(background.map((r) => r.id)).toEqual(['net'])
  })

  it('keeps display order inside each group', () => {
    const rows = [{ id: 'a', optional: true }, { id: 'b' }, { id: 'c', optional: true }]
    expect(splitRows(rows).background.map((r) => r.id)).toEqual(['a', 'c'])
  })

  it('treats a row with no optional flag as gating', () => {
    // Annotated rather than inferred: with a one-element literal TypeScript infers
    // T from the constraint alone, and then rejects `id` as an excess property.
    const rows: { id: string; optional?: boolean }[] = [{ id: 'a' }]
    expect(splitRows(rows).gating).toHaveLength(1)
  })
})

describe('the words the two cards share', () => {
  it('names the second group out loud, because the app really does not wait for it', () => {
    expect(GATING_TITLE).toBe('Starting up')
    expect(BACKGROUND_TITLE.toLowerCase()).toContain('background')
  })

  it('has a glyph for every state, so no row can render blank', () => {
    for (const state of ['pending', 'active', 'done', 'failed'] as BootStepState[]) {
      expect(MARK[state]).toBeTruthy()
    }
  })
})
