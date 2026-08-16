import { afterEach, describe, expect, it } from 'vitest'

import { EASE_SECONDS, setEaseSeconds, useSettings } from './settings'

const DEFAULT = 0.5

afterEach(() => {
  setEaseSeconds(DEFAULT)
})

describe('ease length', () => {
  it('starts at half a second', () => {
    expect(useSettings.getState().easeSeconds).toBe(DEFAULT)
  })

  it('keeps the length he dialled in', () => {
    // The point of the whole setting: the ease row used to be component state,
    // so this number died with the card the moment he clicked the next clip.
    setEaseSeconds(1.25)
    expect(useSettings.getState().easeSeconds).toBe(1.25)
  })

  it('holds it inside the field envelope', () => {
    setEaseSeconds(999)
    expect(useSettings.getState().easeSeconds).toBe(EASE_SECONDS.max)
    setEaseSeconds(0)
    expect(useSettings.getState().easeSeconds).toBe(EASE_SECONDS.min)
    setEaseSeconds(-3)
    expect(useSettings.getState().easeSeconds).toBe(EASE_SECONDS.min)
  })

  it('ignores a value that is not a number', () => {
    setEaseSeconds(2)
    setEaseSeconds(Number.NaN)
    expect(useSettings.getState().easeSeconds).toBe(DEFAULT)
  })
})
