import { describe, expect, it } from 'vitest'
import { plural } from './plural'

describe('plural', () => {
  it('says one of a thing in the singular', () => {
    expect(plural(1, 'clip')).toBe('1 clip')
    expect(plural(1, 'media file')).toBe('1 media file')
  })

  it('says every other count in the plural, nought included', () => {
    expect(plural(0, 'clip')).toBe('0 clips')
    expect(plural(2, 'clip')).toBe('2 clips')
    expect(plural(24, 'track')).toBe('24 tracks')
  })

  it('takes the plural of a noun that does not just add an s', () => {
    expect(plural(1, 'copy', 'copies')).toBe('1 copy')
    expect(plural(3, 'copy', 'copies')).toBe('3 copies')
  })
})
