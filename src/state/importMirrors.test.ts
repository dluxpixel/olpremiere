// EVERY IMPORT WRITES A SECOND COPY TO DISK.
//
// ⛔ THE HOLE THAT COST HIM TWO DAYS. 2026-08-23: the whole recovery story rests
// on a mirror folder beside the database, and `mirrorAsset` was called from
// exactly two places, `backfillMirror` at boot and the hand relink. NOT FROM
// IMPORT. So every clip he ever brought in lived in IndexedDB and nowhere else,
// and `backfillMirror` could only copy out what IndexedDB still had. When the
// engine rebuilt its database there was nothing left to copy, and his app read
// `ENOENT: no such file or directory, scandir '...\OL Premiere\media'` while a
// recovery designed entirely around that folder tried to open it.
//
// A second copy that is only ever made FROM the first copy is not a second copy.
// This file exists so that can never be true again.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../engine/types'

const mirrored = vi.hoisted(() => ({ ids: [] as string[], bytes: [] as number[], fail: false }))
const stored = vi.hoisted(() => ({ keys: [] as string[] }))

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

vi.mock('./mediaMirror', () => ({
  mirrorAsset: (id: string, bytes: Blob) => {
    if (mirrored.fail) return Promise.reject(new Error('no disk'))
    mirrored.ids.push(id)
    mirrored.bytes.push(bytes.size)
    return Promise.resolve(true)
  },
  backfillMirror: () => Promise.resolve(0),
  mirrorApi: () => null,
}))

vi.mock('./persistence', () => ({
  putBlob: (key: string) => {
    stored.keys.push(key)
    return Promise.resolve()
  },
  getBlob: () => Promise.resolve(null),
}))

vi.mock('../engine/remuxSource', () => ({
  canImport: () => true,
  remuxIfNeeded: (file: File) => Promise.resolve({ file }),
}))

vi.mock('../engine/probe', () => ({
  probeFile: () =>
    Promise.resolve({
      kind: 'video',
      durationS: 5,
      width: 1920,
      height: 1080,
      hasAudio: true,
      hasVideo: true,
      fps: 30,
      thumbnailBlob: undefined,
    }),
}))

vi.mock('../engine/proxyMedia', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureProxies: () => Promise.resolve(),
}))

import { importFiles } from './mediaActions'
import { useStore } from './store'

const file = (name: string, bytes = 2048): File => new File([new Uint8Array(bytes)], name, { type: 'video/mp4' })

beforeEach(() => {
  mirrored.ids.length = 0
  mirrored.bytes.length = 0
  mirrored.fail = false
  stored.keys.length = 0
  useStore.setState({ project: newProject() })
})

describe('an imported file exists somewhere other than the database', () => {
  it('writes his capture to the disk mirror, not only to IndexedDB', async () => {
    await importFiles([file('2026-08-15 17-21-38.mp4')])
    expect(stored.keys.some((k) => k.startsWith('asset/'))).toBe(true)
    expect(mirrored.ids).toHaveLength(1)
    expect(mirrored.bytes[0]).toBe(2048)
  })

  it('mirrors under the ASSET ID, which is the name the repair looks for', async () => {
    await importFiles([file('clip.mp4')])
    const assetKey = stored.keys.find((k) => k.startsWith('asset/'))
    expect(assetKey).toBe('asset/' + mirrored.ids[0])
  })

  it('mirrors every file of a multi-file import', async () => {
    await importFiles([file('a.mp4'), file('b.mp4'), file('c.mp4')])
    expect(mirrored.ids).toHaveLength(3)
    expect(new Set(mirrored.ids).size).toBe(3)
  })

  it('still imports when the disk mirror cannot be written', async () => {
    mirrored.fail = true
    await importFiles([file('a.mp4')])
    expect(useStore.getState().project.assets).not.toEqual({})
    expect(stored.keys.some((k) => k.startsWith('asset/'))).toBe(true)
  })
})
