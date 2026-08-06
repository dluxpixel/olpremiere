import { describe, expect, it } from 'vitest'

import { formatTimecode, parseTimecode, quantizeToFrame } from '../engine/timecode'
import { createPendingEdit } from './pendingEdit'

// The fault this covers, his words: "when I click on a clip and set the volume
// and then go to another clip, it automatically saves without me needing to
// click Enter." Leaving a half-typed field must SAVE the number, to the clip it
// was typed for - never to the clip that was selected next, never nowhere.

/** The volume field's spec: -60..+12 dB in half-dB steps. */
const clampRound = (v: number): number => {
  const r = Math.round(v / 0.5) * 0.5
  return r < -60 ? -60 : r > 12 ? 12 : r
}

interface Write {
  clipId: string
  v: number
}

/**
 * ScrubField's handlers, in the order the DOM fires them, driving the same
 * holder the real field does. `select` is the only unusual one: it is what a
 * re-render for ANOTHER clip does to the field, swapping `value` and `onCommit`
 * under an edit that is still open.
 */
function field(writes: Write[]) {
  const pending = createPendingEdit()
  let clipId = 'clip-a'
  let value = 0
  return {
    /** The panel re-rendered for a different clip. No unmount: same field. */
    select(id: string, v: number) {
      clipId = id
      value = v
    },
    /** Click or tab into the field (ScrubField.enterEdit). */
    focus() {
      const owner = clipId
      pending.begin({ onCommit: (v) => writes.push({ clipId: owner, v }), base: value, normalize: clampRound })
    },
    type(text: string) {
      pending.type(text)
    },
    /** Escape. */
    abandon() {
      pending.cancel()
    },
    /** An arrow nudge, which commits on its own and then re-baselines. */
    nudge(next: number) {
      writes.push({ clipId, v: next })
      pending.settle(next)
    },
    /** Focus left the field (click elsewhere, Enter). */
    blur() {
      pending.flush()
    },
    /** The panel went away with the field still focused. Fires no blur. */
    unmount() {
      pending.flush()
    },
  }
}

describe('pendingEdit (ScrubField commit-on-leave)', () => {
  it('commits a typed value when the field unmounts without blurring', () => {
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.type('-6')
    f.unmount()
    expect(writes).toEqual([{ clipId: 'clip-a', v: -6 }])
  })

  it('writes the typed value to the ORIGINAL clip after the selection moved on', () => {
    // The dangerous failure: selecting clip B re-renders the field with B's
    // value and B's onCommit, and only THEN does the blur arrive. The number
    // was typed for A, so it must land on A and A alone.
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.type('-6')
    f.select('clip-b', 0)
    f.blur()
    expect(writes).toEqual([{ clipId: 'clip-a', v: -6 }])
    expect(writes.some((w) => w.clipId === 'clip-b')).toBe(false)
  })

  it('writes nothing when the edit was abandoned with Escape, even on unmount', () => {
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.type('-6')
    f.abandon()
    f.blur()
    f.unmount()
    expect(writes).toEqual([])
  })

  it('writes nothing when the field was opened and closed without an edit', () => {
    // An empty commit still rebuilds the sequence, which would put a do-nothing
    // entry on the undo stack for merely clicking a field.
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.unmount()
    expect(writes).toEqual([])
  })

  it('writes nothing when the typed text is the value already there', () => {
    const writes: Write[] = []
    const f = field(writes)
    f.select('clip-a', -6)
    f.focus()
    f.type('-6')
    f.blur()
    expect(writes).toEqual([])
  })

  it('writes nothing for text that is not a number', () => {
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.type('abc')
    f.unmount()
    expect(writes).toEqual([])
  })

  it('commits once only - the unmount after a blur is silent', () => {
    // Enter blurs the input, and a panel can unmount right after: neither may
    // turn one typed number into two undo steps.
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.type('-6')
    f.blur()
    f.unmount()
    expect(writes).toEqual([{ clipId: 'clip-a', v: -6 }])
  })

  it('clamps and step-rounds with the spec the edit started under', () => {
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.type('-6.4')
    f.blur()
    f.focus()
    f.type('9999')
    f.blur()
    expect(writes).toEqual([
      { clipId: 'clip-a', v: -6.5 },
      { clipId: 'clip-a', v: 12 },
    ])
  })

  it('keeps the first owner and the typed text when edit is re-entered', () => {
    // Focus opens the edit, a double-click to select-all opens it again. That
    // must not re-point the edit at whatever clip is selected by then.
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.type('-6')
    f.select('clip-b', 0)
    f.focus()
    f.blur()
    expect(writes).toEqual([{ clipId: 'clip-a', v: -6 }])
  })

  it('does not commit an arrow nudge a second time on blur', () => {
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.nudge(0.5)
    f.blur()
    expect(writes).toEqual([{ clipId: 'clip-a', v: 0.5 }])
  })

  it('still commits text typed after an arrow nudge', () => {
    const writes: Write[] = []
    const f = field(writes)
    f.focus()
    f.nudge(0.5)
    f.type('-3')
    f.blur()
    expect(writes).toEqual([
      { clipId: 'clip-a', v: 0.5 },
      { clipId: 'clip-a', v: -3 },
    ])
  })

  it('returns what it wrote, and null when it wrote nothing', () => {
    const p = createPendingEdit()
    p.begin({ onCommit: () => {}, base: 0, normalize: clampRound })
    p.type('-6')
    expect(p.flush()).toBe(-6)
    expect(p.flush()).toBe(null)
  })
})

const FPS = 30

interface Move {
  clipId: string
  s: number
}

/**
 * Inspector's EditableTimecodeRow, driven the way the DOM drives it. Its commit
 * runs moveGroup, so the same stale-closure fault the volume field had MOVES A
 * CLIP here: `select` is the re-render for another clip, which swaps `onCommit`
 * under an edit that is still open, and the blur only arrives after it (the
 * timeline selects on pointerdown, the browser moves focus afterwards).
 */
function timecodeRow(moves: Move[]) {
  const pending = createPendingEdit()
  let clipId = 'clip-a'
  let seconds = 0
  return {
    /** The panel re-rendered for a different clip. No unmount: same row. */
    select(id: string, s: number) {
      clipId = id
      seconds = s
    },
    /** Click the timecode to type an exact one (EditableTimecodeRow.beginEdit).
     *  The input it opens is seeded with the time already shown, which is text
     *  the user did not type and so is not an edit. */
    click() {
      const owner = clipId
      pending.begin({
        onCommit: (s) => moves.push({ clipId: owner, s }),
        base: quantizeToFrame(seconds, FPS),
        normalize: (v) => quantizeToFrame(v, FPS),
        parse: (t) => {
          const parsed = parseTimecode(t, FPS)
          return parsed !== null && parsed >= 0 ? parsed : null
        },
      })
    },
    type(text: string) {
      pending.type(text)
    },
    /** Escape. */
    abandon() {
      pending.cancel()
    },
    /** Focus left the input (Enter, or a click elsewhere). */
    blur() {
      pending.flush()
    },
    /** The clip was deselected with the input still focused. Fires no blur. */
    unmount() {
      pending.flush()
    },
  }
}

describe('pendingEdit (Inspector timecode row)', () => {
  it('moves the ORIGINAL clip when the row unmounts with a time still typed', () => {
    const moves: Move[] = []
    const row = timecodeRow(moves)
    row.click()
    row.type('00:00:04:12')
    row.unmount()
    expect(moves).toEqual([{ clipId: 'clip-a', s: 4.4 }])
  })

  it('moves the ORIGINAL clip after the selection moved on', () => {
    // The dangerous failure, and worse here than on a number field: the typed
    // time would have travelled to clip B and dragged it across the timeline.
    const moves: Move[] = []
    const row = timecodeRow(moves)
    row.click()
    row.type('00:00:04:12')
    row.select('clip-b', 30)
    row.blur()
    expect(moves).toEqual([{ clipId: 'clip-a', s: 4.4 }])
    expect(moves.some((m) => m.clipId === 'clip-b')).toBe(false)
  })

  it('moves nothing when the edit was abandoned with Escape, even on unmount', () => {
    const moves: Move[] = []
    const row = timecodeRow(moves)
    row.click()
    row.type('00:00:04:12')
    row.abandon()
    row.blur()
    row.unmount()
    expect(moves).toEqual([])
  })

  it('moves nothing when the row was opened and closed without an edit', () => {
    const moves: Move[] = []
    const row = timecodeRow(moves)
    row.select('clip-a', 12)
    row.click()
    row.unmount()
    expect(moves).toEqual([])
  })

  it('moves nothing for a timecode it cannot parse, rather than moving the clip to 0', () => {
    for (const bad of ['nope', '', '00:ab:00', '::', '-1']) {
      const moves: Move[] = []
      const row = timecodeRow(moves)
      row.select('clip-a', 12)
      row.click()
      row.type(bad)
      row.unmount()
      expect(moves, bad).toEqual([])
    }
  })

  it('moves nothing when the time typed is the time already shown', () => {
    const moves: Move[] = []
    const row = timecodeRow(moves)
    row.select('clip-a', 4.4)
    row.click()
    row.type(formatTimecode(4.4, FPS))
    row.blur()
    expect(moves).toEqual([])
  })

  it('moves once only - the unmount after Enter is silent', () => {
    const moves: Move[] = []
    const row = timecodeRow(moves)
    row.click()
    row.type('00:00:04:12')
    row.blur()
    row.unmount()
    expect(moves).toEqual([{ clipId: 'clip-a', s: 4.4 }])
  })
})
