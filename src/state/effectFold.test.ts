import { beforeEach, describe, expect, it } from 'vitest'

import { allFolded, setEffectsFolded, toggleEffectFold, useEffectFold } from './effectFold'

beforeEach(() => {
  useEffectFold.setState({ folded: {} })
})

describe('allFolded', () => {
  it('is false when there is nothing to fold', () => {
    // Empty must read as NOT folded, or the header button would offer to open a
    // stack with no cards in it.
    expect(allFolded({}, [])).toBe(false)
  })

  it('needs every id, not just one', () => {
    expect(allFolded({ a: true }, ['a', 'b'])).toBe(false)
    expect(allFolded({ a: true, b: true }, ['a', 'b'])).toBe(true)
  })
})

describe('folding', () => {
  it('a card he has never touched is open', () => {
    expect(useEffectFold.getState().folded['e1']).toBeUndefined()
  })

  it('toggles one card without touching its neighbour', () => {
    toggleEffectFold('e1')
    expect(useEffectFold.getState().folded).toEqual({ e1: true })
    toggleEffectFold('e1')
    expect(useEffectFold.getState().folded).toEqual({})
  })

  it('folds and opens a whole stack at once', () => {
    setEffectsFolded(['e1', 'e2', 'e3'], true)
    expect(allFolded(useEffectFold.getState().folded, ['e1', 'e2', 'e3'])).toBe(true)
    setEffectsFolded(['e1', 'e2', 'e3'], false)
    expect(useEffectFold.getState().folded).toEqual({})
  })

  it('leaves cards outside the stack alone', () => {
    // Two clips can have cards folded at once; opening one clip's stack must not
    // reach into the other's.
    toggleEffectFold('other')
    setEffectsFolded(['e1'], true)
    setEffectsFolded(['e1'], false)
    expect(useEffectFold.getState().folded).toEqual({ other: true })
  })
})
