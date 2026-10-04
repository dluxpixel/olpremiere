// The hooks the app calls into the usage log, driven through the real store: an
// edit, an undo, a shortcut and an export each land as ONE small line, and none of
// them carries a name of his.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type MediaAsset } from '../engine/types'
import { useStore } from './store'
import { usage, type UsageEvent } from './usageLog'
import { noteExportEnd, noteExportStart, noteShortcut } from './usageNotes'
import { setKnownNames } from './usageNames'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const lines: string[] = []
const written = (): UsageEvent[] => lines.flatMap((l) => l.trim().split('\n')).filter(Boolean).map((l) => JSON.parse(l) as UsageEvent)

async function drain(): Promise<UsageEvent[]> {
  await usage.flush()
  return written()
}

const asset = (id: string, name: string): MediaAsset =>
  ({ id, name, kind: 'video', blobKey: `asset/${id}`, durationS: 4, hasAudio: true, hasVideo: true }) as MediaAsset

beforeEach(async () => {
  lines.length = 0
  await usage.setEnabled(true)
  usage.attach(async (_day, text) => {
    lines.push(text)
  })
  await usage.flush()
  lines.length = 0
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ tool: 'select', selection: [] })
})

afterEach(() => {
  setKnownNames(() => [])
})

describe('an undoable edit', () => {
  it('is one line with its label, how many clips were selected, and a tool when it was not the usual one', async () => {
    useStore.getState().setUI({ selection: ['a', 'b'] })
    useStore.getState().dispatch('Split clip', (p) => ({ ...p, name: 'x' }))
    useStore.getState().setUI({ tool: 'razor', selection: [] })
    useStore.getState().dispatch('Move clip', (p) => ({ ...p, name: 'y' }))
    const events = await drain()
    expect(events.map((e) => [e.k, e.a, e.d])).toEqual([
      ['edit', 'Split clip', { sel: 2 }],
      ['edit', 'Move clip', { tool: 'razor' }],
    ])
  })

  it('is nothing at all when the edit changed nothing', async () => {
    useStore.getState().dispatch('Nothing', (p) => p)
    expect(await drain()).toEqual([])
  })

  it('folds a typed run into one line with a count, and a pause starts a new one', async () => {
    vi.useFakeTimers()
    try {
      const type = (s: string): void => useStore.getState().dispatch('Edit title', (p) => ({ ...p, name: s }), 'title:c1')
      type('h')
      type('he')
      type('hel')
      await vi.advanceTimersByTimeAsync(3_000)
      type('hello')
      const events = await drain()
      expect(events.map((e) => [e.a, e.d?.rep, e.d?.run])).toEqual([
        ['Edit title', 2, true],
        ['Edit title', undefined, true],
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never carries the name of a file, a track or a project in its label', async () => {
    setKnownNames(() => [
      { name: 'secret holiday.mp4', as: 'media' },
      { name: 'My private track', as: 'track' },
    ])
    useStore.getState().dispatch('Add secret holiday.mp4', (p) => ({ ...p, name: '1' }))
    useStore.getState().dispatch('Delete My private track', (p) => ({ ...p, name: '2' }))
    useStore.getState().dispatch('Sync My private track', (p) => ({ ...p, name: '3' }))
    const events = await drain()
    expect(events.map((e) => e.a)).toEqual(['Add <media>', 'Delete <track>', 'Sync track'])
    expect(JSON.stringify(events)).not.toMatch(/secret|holiday|private/)
  })

  it('records an import as a count and the kinds of file, never their names', async () => {
    useStore.getState().dispatch('Import 2 file(s)', (p) => ({
      ...p,
      assets: { ...p.assets, a1: asset('a1', 'Beach day take 2.mp4'), a2: asset('a2', 'ambience.WAV') },
    }))
    const events = await drain()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ k: 'import', a: 'Import files', d: { n: 2, exts: 'mp4:1 wav:1' } })
    expect(JSON.stringify(events)).not.toMatch(/Beach|ambience/)
  })

  it('is not recorded while the log is off', async () => {
    await usage.setEnabled(false)
    useStore.getState().dispatch('Split clip', (p) => ({ ...p, name: 'z' }))
    expect(await drain()).toEqual([])
  })
})

describe('undo and redo', () => {
  it('says what was taken back and how long after it was made', async () => {
    useStore.getState().dispatch('Split clip', (p) => ({ ...p, name: 'a' }))
    useStore.getState().undo()
    useStore.getState().redo()
    const events = await drain()
    expect(events.map((e) => [e.k, e.a, e.d?.of])).toEqual([
      ['edit', 'Split clip', undefined],
      ['history', 'undo', 'Split clip'],
      ['history', 'redo', 'Split clip'],
    ])
    // A step undone at once carries a small age, in seconds; a redo carries none.
    expect(events[1]!.d?.age).toBeLessThan(1)
    expect(events[2]!.d?.age).toBeUndefined()
  })

  it('is nothing when there was nothing to undo', async () => {
    useStore.getState().undo()
    expect(await drain()).toEqual([])
  })
})

describe('a shortcut', () => {
  it('is the key and what it is for, and a held key is one line with a count', async () => {
    noteShortcut('c', 'Split at playhead', false)
    noteShortcut('arrowright', 'Step 1 frame forward', false)
    noteShortcut('arrowright', 'Step 1 frame forward', true)
    noteShortcut('arrowright', 'Step 1 frame forward', true)
    const events = await drain()
    expect(events.map((e) => [e.k, e.a, e.d])).toEqual([
      ['key', 'c', { cmd: 'Split at playhead' }],
      ['key', 'arrowright', { cmd: 'Step 1 frame forward', rep: 2 }],
    ])
  })
})

describe('an export', () => {
  const note = { width: 1080, height: 1920, fps: 30, seconds: 41.6, encoder: 'x264', qp: 18, loudness: true, workArea: false, background: true }

  it('is one line for the whole run: what was asked for, how it ended and how long it took', async () => {
    vi.useFakeTimers()
    try {
      noteExportStart(note)
      await vi.advanceTimersByTimeAsync(90_000)
      noteExportEnd('done', { sizeBytes: 31_400_000, fileName: 'Gym day 4 final.mp4' })
      const events = await drain()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        k: 'export',
        a: 'export',
        ms: 90_000,
        d: { w: 1080, h: 1920, fps: 30, sec: 42, enc: 'x264', qp: 18, loud: true, area: false, bg: true, outcome: 'done', mb: 31.4, ext: 'mp4' },
      })
      expect(JSON.stringify(events)).not.toContain('Gym')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a run that another run replaced, and keeps a failure short and free of file names', async () => {
    noteExportStart(note)
    noteExportStart(note)
    noteExportEnd('failed', { error: 'Could not write C:\\Users\\skyle\\Videos\\private cut.mp4: disk full' })
    noteExportEnd('cancelled')
    const events = await drain()
    expect(events.map((e) => e.d?.outcome)).toEqual(['restarted', 'failed'])
    expect(JSON.stringify(events)).not.toMatch(/skyle|private/)
  })
})
