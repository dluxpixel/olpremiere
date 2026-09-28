import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/tmp' }, dialog: {} }))
const { numberedFileName } = await import('./saveFiles')

describe('the name an export or a project file is offered', () => {
  it('is the project name when the folder does not have it yet', () => {
    expect(numberedFileName('Green', 'mp4', () => false)).toBe('Green.mp4')
  })
  it('never offers a name that is already there: _1, _2 and on', () => {
    // His words: "Every time I export something, it asks me, Do you want to replace that? Of course not."
    const there = new Set(['Untitled Project.mp4', 'Untitled Project_1.mp4'])
    expect(numberedFileName('Untitled Project', 'mp4', (n) => there.has(n))).toBe('Untitled Project_2.mp4')
  })
  it('numbers per extension, so a video does not push the project file along', () => {
    const there = new Set(['BC.mp4'])
    expect(numberedFileName('BC', 'olstudio', (n) => there.has(n))).toBe('BC.olstudio')
  })
})
