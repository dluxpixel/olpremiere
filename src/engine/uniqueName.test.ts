import { describe, expect, it } from 'vitest'
import { nextFreeName } from './uniqueName'

describe('nextFreeName', () => {
  it('keeps the name when nothing has it', () => {
    expect(nextFreeName('Untitled Project', new Set(['Green']))).toBe('Untitled Project')
  })
  it('numbers it _1, _2 like Photoshop when it is taken', () => {
    expect(nextFreeName('Untitled Project', new Set(['Untitled Project']))).toBe('Untitled Project_1')
    expect(nextFreeName('Untitled Project', new Set(['Untitled Project', 'Untitled Project_1']))).toBe('Untitled Project_2')
  })
  it('fills the first gap rather than counting past it', () => {
    expect(nextFreeName('BC', new Set(['BC', 'BC_2']))).toBe('BC_1')
  })
})
