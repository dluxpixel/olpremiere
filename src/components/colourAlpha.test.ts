import { describe, expect, it } from 'vitest'
import { joinColour, splitColour } from './colourAlpha'

describe('splitColour / joinColour', () => {
  it('splits every form a stored colour takes', () => {
    expect(splitColour('rgba(0,0,0,0.6)')).toEqual({ hex: '#000000', alpha: 0.6 })
    expect(splitColour('rgb(51, 51, 51)')).toEqual({ hex: '#333333', alpha: 1 })
    expect(splitColour('#FFD400')).toEqual({ hex: '#ffd400', alpha: 1 })
    expect(splitColour('#fff')).toEqual({ hex: '#ffffff', alpha: 1 })
    expect(splitColour('#00000080')).toEqual({ hex: '#000000', alpha: 0.5 })
    expect(splitColour('not a colour')).toEqual({ hex: '#000000', alpha: 1 })
  })

  it('joins back to a plain hex when solid and rgba() when see through', () => {
    expect(joinColour('#333333', 1)).toBe('#333333')
    expect(joinColour('#333333', 0.6)).toBe('rgba(51,51,51,0.6)')
    expect(joinColour('#ff0000', 0)).toBe('rgba(255,0,0,0)')
  })

  it('round trips a see through colour', () => {
    const { hex, alpha } = splitColour('rgba(12,34,56,0.35)')
    expect(joinColour(hex, alpha)).toBe('rgba(12,34,56,0.35)')
  })
})
