// ⛔ MOST OF THIS FILE IS ABOUT WHAT COMES BACK OUT OF STORAGE, not what goes in.
//
// A saved move is untrusted text on the way back, and it lands in the renderer's
// transform maths. This codebase has already paid for that once: an unknown
// value reached the ease switch, returned undefined, NaNed the transform and
// rendered a BLACK FRAME. So the sanitiser is the thing under test.

import { beforeEach, describe, expect, it } from 'vitest'
import type { MoveDef } from '../engine/moves'
import { getMyMove, listMyMoves, removeMyMove, saveMyMove } from './myMoves'

const KEY = 'olpremiere:my-moves'

const def = (over: Partial<MoveDef> = {}): MoveDef => ({
  id: 'mym-draft',
  name: 'x',
  hint: 'x',
  window: 'clip',
  beats: [
    { at: { frac: 0 }, d: 0, aim: { x: 0.5, y: 0.5 }, shift: { x: -0.1, y: 0 }, curve: 'linear' },
    { at: { frac: 1 }, d: 1, aim: { x: 0.5, y: 0.5 }, shift: { x: 0.1, y: 0 }, curve: 'smooth' },
  ],
  recordedDepth: 1.2,
  ...over,
})

/** A localStorage that behaves, for the node environment the suite runs in. */
class MemStore {
  private map = new Map<string, string>()
  getItem = (k: string): string | null => this.map.get(k) ?? null
  setItem = (k: string, v: string): void => void this.map.set(k, v)
  removeItem = (k: string): void => void this.map.delete(k)
  clear = (): void => this.map.clear()
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStore()
})

describe('saving a move he performed', () => {
  it('keeps it, and hands it back with everything it needs to rebuild', () => {
    const saved = saveMyMove('  My push  ', def())
    expect(saved).not.toBeNull()
    expect(saved!.name, 'trimmed').toBe('My push')
    const back = listMyMoves()
    expect(back).toHaveLength(1)
    expect(back[0].def.beats).toHaveLength(2)
    expect(back[0].def.beats[1].shift).toEqual({ x: 0.1, y: 0 })
    expect(back[0].def.recordedDepth).toBeCloseTo(1.2, 9)
    expect(getMyMove(saved!.id)?.name).toBe('My push')
  })

  it('refuses a nameless save and an empty recording, rather than keeping junk', () => {
    expect(saveMyMove('   ', def())).toBeNull()
    expect(saveMyMove('fine', def({ beats: [] }))).toBeNull()
    expect(listMyMoves()).toHaveLength(0)
  })

  // A second tile with the same label is one he cannot tell from the first.
  it('replaces a move he saves under a name he has already used', () => {
    saveMyMove('Reveal', def())
    saveMyMove('reveal', def({ window: 'moment' }))
    const all = listMyMoves()
    expect(all).toHaveLength(1)
    expect(all[0].def.window).toBe('moment')
  })

  it('newest first, and drops the oldest past the cap', () => {
    for (let i = 0; i < 30; i++) saveMyMove(`m${i}`, def())
    const all = listMyMoves()
    expect(all).toHaveLength(24)
    expect(all[0].name).toBe('m29')
    expect(all.some((m) => m.name === 'm0'), 'the oldest is gone').toBe(false)
  })

  it('removes one by id and leaves the rest', () => {
    const a = saveMyMove('a', def())!
    saveMyMove('b', def())
    removeMyMove(a.id)
    expect(listMyMoves().map((m) => m.name)).toEqual(['b'])
  })
})

describe('⛔ what comes back out of storage is not trusted', () => {
  const put = (v: unknown) => localStorage.setItem(KEY, JSON.stringify(v))

  it('survives text that is not even a list', () => {
    localStorage.setItem(KEY, 'not json at all')
    expect(listMyMoves()).toEqual([])
    put({ nope: true })
    expect(listMyMoves()).toEqual([])
  })

  it('drops ONE corrupt move and keeps the rest of his shelf', () => {
    const good = saveMyMove('good', def())!
    put([{ id: 'bad', name: 'bad', def: { window: 'clip', beats: 'not a list' } }, good])
    const back = listMyMoves()
    expect(back).toHaveLength(1)
    expect(back[0].name).toBe('good')
  })

  /**
   * The one that matters. Every one of these reaches a multiply in the transform
   * if it gets through, and NaN there is a black frame rather than a wrong one.
   */
  it('rejects a move carrying a number that is not a number', () => {
    const bad = (beat: unknown) => {
      put([{ id: 'x', name: 'x', def: { window: 'clip', beats: [beat] } }])
      expect(listMyMoves(), JSON.stringify(beat)).toHaveLength(0)
    }
    bad({ at: { frac: 0 }, d: Number.NaN, aim: { x: 0.5, y: 0.5 }, curve: 'linear' })
    bad({ at: { frac: 0 }, d: 0, aim: { x: 'left', y: 0.5 }, curve: 'linear' })
    bad({ at: { frac: 0 }, d: 0, aim: { x: 0.5, y: 0.5 }, shift: { x: null, y: 0 }, curve: 'linear' })
    bad({ at: {}, d: 0, aim: { x: 0.5, y: 0.5 }, curve: 'linear' })
    bad({ at: { frac: 0 }, d: 0, aim: { x: 0.5, y: 0.5 }, curve: 'springy' })
    bad({ at: { frac: 0 }, d: 0, curve: 'linear' })
  })

  it('rejects a window it does not recognise', () => {
    put([{ id: 'x', name: 'x', def: { window: 'forever', beats: def().beats } }])
    expect(listMyMoves()).toHaveLength(0)
  })

  it('leaves shift off entirely when the stored move never had one', () => {
    const noShift = def({
      beats: [{ at: { frac: 0 }, d: 1, aim: { x: 0.3, y: 0.5 }, curve: 'snapIn' }],
    })
    saveMyMove('aim only', noShift)
    expect(listMyMoves()[0].def.beats[0].shift).toBeUndefined()
  })
})
