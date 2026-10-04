// The browser build's home for the usage log: its own database, a batch per write,
// whole days dropped past the rotation, and a log that still works in memory when the
// browser will not give us a database at all.

import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Row {
  id: number
  day: string
  lines: string
}

let rows: Row[] = []
let nextId = 1
let openFails = false

vi.mock('idb', () => ({
  openDB: async () => {
    if (openFails) throw new Error('no storage here')
    return {
      add: async (_store: string, v: { day: string; lines: string }) => {
        rows.push({ id: nextId++, ...v })
      },
      getAll: async () => rows.map((r) => ({ ...r })),
      transaction: () => ({
        store: {
          delete: (id: number) => {
            rows = rows.filter((r) => r.id !== id)
            return Promise.resolve()
          },
        },
        done: Promise.resolve(),
      }),
    }
  },
}))

beforeEach(() => {
  rows = []
  nextId = 1
  openFails = false
  vi.resetModules()
})

const load = () => import('./usageStoreWeb')

describe('the browser log', () => {
  it('keeps every batch and hands the days back oldest first, joined', async () => {
    const m = await load()
    await m.appendWebUsage('2026-10-05', 'b1\n')
    await m.appendWebUsage('2026-10-04', 'a1\n')
    await m.appendWebUsage('2026-10-04', 'a2\n')
    expect(await m.readWebUsage()).toEqual([
      { day: '2026-10-04', text: 'a1\na2\n' },
      { day: '2026-10-05', text: 'b1\n' },
    ])
  })

  it('does the day arithmetic on the calendar', async () => {
    const m = await load()
    expect(m.cutoffDay('2026-10-04', 90)).toBe('2026-07-06')
    expect(m.cutoffDay('2024-03-01', 1)).toBe('2024-02-29')
    expect(m.WEB_KEEP_DAYS).toBe(90)
  })

  it('drops whole days older than the rotation and keeps the rest', async () => {
    const m = await load()
    await m.appendWebUsage('2026-07-05', 'old\n')
    await m.appendWebUsage('2026-07-06', 'edge\n')
    await m.appendWebUsage('2026-10-04', 'now\n')
    await m.pruneWebUsage('2026-10-04')
    expect((await m.readWebUsage()).map((d) => d.day)).toEqual(['2026-07-06', '2026-10-04'])
  })

  it('rotates by itself on the first write of a day', async () => {
    const m = await load()
    await m.appendWebUsage('2025-01-01', 'ancient\n')
    await m.appendWebUsage('2026-10-04', 'today\n')
    for (let i = 0; i < 50 && rows.some((r) => r.day === '2025-01-01'); i++) await new Promise((r) => setTimeout(r, 10))
    expect((await m.readWebUsage()).map((d) => d.day)).toEqual(['2026-10-04'])
  })

  it('falls back to memory when there is no database, and still never throws', async () => {
    openFails = true
    const m = await load()
    await expect(m.appendWebUsage('2026-10-04', 'x\n')).resolves.toBeUndefined()
    await expect(m.appendWebUsage('2026-10-04', 'y\n')).resolves.toBeUndefined()
    expect(await m.readWebUsage()).toEqual([{ day: '2026-10-04', text: 'x\ny\n' }])
    await expect(m.pruneWebUsage('2026-10-04')).resolves.toBeUndefined()
  })
})
