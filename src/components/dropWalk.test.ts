import { describe, expect, it } from 'vitest'
import { entriesOf, filesOf, type DropEntry } from './dropWalk'

const fileEntry = (name: string): DropEntry => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok(new File(['x'], name)),
})

/** A folder that pages its listing the way a real reader does: two, then the rest, then empty. */
const dirEntry = (name: string, kids: DropEntry[]): DropEntry => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let i = 0
    return {
      readEntries: (ok) => {
        const page = kids.slice(i, i + 2)
        i += 2
        ok(page)
      },
    }
  },
})

describe('filesOf', () => {
  it('walks a dropped folder in full, pages and nested folders included, and skips the hidden files', async () => {
    const shoot = dirEntry('shoot', [
      fileEntry('a.mp4'),
      fileEntry('b.mp4'),
      fileEntry('desktop.ini'),
      dirEntry('day2', [fileEntry('c.mov'), fileEntry('.DS_Store')]),
      fileEntry('d.wav'),
    ])
    const files = await filesOf([shoot, fileEntry('loose.png')])
    expect(files.map((f) => f.name)).toEqual(['a.mp4', 'b.mp4', 'c.mov', 'd.wav', 'loose.png'])
  })

  it('is empty for nothing', async () => {
    expect(await filesOf([])).toEqual([])
  })
})

describe('entriesOf', () => {
  it('falls back to the plain files when the browser gives no entries', () => {
    const f = new File(['x'], 'plain.mp4')
    const dt = { items: [{ webkitGetAsEntry: () => null }], files: [f] } as unknown as DataTransfer
    expect(entriesOf(dt)).toEqual({ entries: [], files: [f] })
    expect(entriesOf(null)).toEqual({ entries: [], files: [] })
  })

  it('prefers the entries when they exist', () => {
    const e = fileEntry('a.mp4')
    const dt = { items: [{ webkitGetAsEntry: () => e }], files: [new File(['x'], 'a.mp4')] } as unknown as DataTransfer
    expect(entriesOf(dt).entries).toEqual([e])
    expect(entriesOf(dt).files).toEqual([])
  })
})
