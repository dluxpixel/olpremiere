// Saving a copy of the project on the PC: in 8 MB slices, with how far it got,
// and the real reason when the drive is full. His drive is 97% full and a copy
// carries all the footage (mc night is about 2.8 GB).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject, type MediaAsset } from '../engine/types'

const MB = 1024 * 1024
const footage = new Blob([new Uint8Array(20 * MB)], { type: 'video/mp4' })
const shown: string[] = []

vi.mock('./persistence', () => ({
  getBlob: async (key: string) => (key === 'asset/a' ? footage : null),
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => shown.push(m) }) } }))
vi.mock('./mediaMirror', () => ({ backfillMirror: async () => 0 }))
vi.mock('./playbackControl', () => ({ pausePlayback: () => {} }))
vi.mock('../collab/collabControl', () => ({ useCollab: { getState: () => ({ session: null }) } }))

const { exportProjectToFile, isDiskFull } = await import('./projectFile')
const { useStore } = await import('./store')

/** The desktop shell's file writer, keeping what it was handed. */
function shell(opts: { failOn?: number } = {}) {
  const chunks: number[] = []
  const closed: boolean[] = []
  const api = {
    isElectron: true,
    pickSavePath: async () => 'D:/his/GYM.olstudio',
    fileOpenWrite: vi.fn<(target: string, sizeBytes?: number) => Promise<number>>(async () => 7),
    fileWriteChunk: async (_id: number, chunk: ArrayBuffer) => {
      if (opts.failOn === chunks.length) {
        throw new Error("Error invoking remote method 'file:writeChunk': Error: ENOSPC: no space left on device, write")
      }
      chunks.push(chunk.byteLength)
    },
    fileClose: async (_id: number, ok: boolean) => {
      closed.push(ok)
    },
  }
  vi.stubGlobal('window', { api })
  return { api, chunks, closed }
}

beforeEach(() => {
  shown.length = 0
  const asset: MediaAsset = {
    id: 'a',
    name: 'gym.mp4',
    kind: 'video',
    blobKey: 'asset/a',
    durationS: 4,
    hasAudio: true,
    hasVideo: true,
  }
  useStore.getState().setProject({ ...newProject('GYM'), assets: { a: asset } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saving a copy of the project on the PC', () => {
  it('writes a 20 MB project in three 8 MB slices, says how far it got, and keeps the file', async () => {
    const { api, chunks, closed } = shell()
    const progress: number[] = []
    await exportProjectToFile((f) => progress.push(f))
    // The header, then 20 MB of footage: 8 + 8 + the rest.
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toBe(8 * MB)
    expect(chunks[1]).toBe(8 * MB)
    expect(chunks.reduce((a, b) => a + b, 0)).toBeGreaterThan(20 * MB)
    expect(progress.at(-1)).toBe(1)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(closed).toEqual([true])
    // Main is told the size first, so it can check the drive has room.
    expect(api.fileOpenWrite).toHaveBeenCalledWith('D:/his/GYM.olstudio', expect.any(Number))
    expect(vi.mocked(api.fileOpenWrite).mock.calls[0]![1]).toBeGreaterThan(20 * MB)
    expect(shown.at(-1)).toMatch(/^Saved project file/)
  })

  it('⛔ a full drive says so, with the size, and throws the half file away', async () => {
    const { closed } = shell({ failOn: 1 })
    await exportProjectToFile()
    expect(closed).toEqual([false])
    expect(shown.at(-1)).toBe('Not enough space on the drive for this copy (needs 21 MB)')
  })

  it('knows a full drive however the message came', () => {
    expect(isDiskFull(new Error('ENOSPC: not enough space for 9 bytes'))).toBe(true)
    expect(isDiskFull(new Error("Error invoking remote method 'file:openWrite': Error: ENOSPC"))).toBe(true)
    expect(isDiskFull(new Error('EPERM: operation not permitted'))).toBe(false)
  })
})
