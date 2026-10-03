// A NEW HDR phone clip comes into the bin as its SDR master, and a conversion
// that fails never costs him the clip.
//
// ⛔ HIS WORDS, 2026-09-29: "make sure, because I input a lot of videos from my
// iPhone, that the iPhone videos are fucking perfect, especially with the
// export." What ffmpeg does to the picture is proven in
// electron/sdrMaster.test.ts; this is the import around it: the master is what
// gets stored, mirrored and probed, he sees it convert, and a failure lands the
// original exactly the way every import did before, with one plain message.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '../engine/types'

const seen = vi.hoisted(() => ({
  stored: [] as { key: string; name: string; size: number }[],
  mirrored: [] as number[],
  probed: [] as string[],
  toasts: [] as { message: string; kind: string }[],
  progress: [] as { step: string; frac: number }[],
  master: 'ok' as 'ok' | 'fail' | 'sdr',
  probeFails: false,
}))

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (message: string, kind = 'info') => seen.toasts.push({ message, kind }) }) },
}))

vi.mock('./mediaMirror', () => ({
  mirrorAsset: (_id: string, bytes: Blob) => {
    seen.mirrored.push(bytes.size)
    return Promise.resolve(true)
  },
  backfillMirror: () => Promise.resolve(0),
  mirrorApi: () => null,
}))

vi.mock('./persistence', () => ({
  putBlob: (key: string, blob: Blob) => {
    seen.stored.push({ key, name: blob instanceof File ? blob.name : '', size: blob.size })
    return Promise.resolve()
  },
  getBlob: () => Promise.resolve(null),
}))

vi.mock('../engine/remuxSource', () => ({
  canImport: () => true,
  remuxIfNeeded: (file: File) => Promise.resolve({ file }),
  canRescue: () => true,
  rescueByRemux: () => Promise.reject(new Error('the conversion lost 16 of 405 frames')),
  // The master of a 4096 byte clip, smaller like the real ones (72 MB from 104).
  sdrMasterIfHdr: async (file: File, onProgress?: (frac: number) => void) => {
    if (seen.master === 'sdr') return null
    onProgress?.(0.5)
    if (seen.master === 'fail') throw new Error('Device creation failed: -12.')
    return { file: new File([new Uint8Array(3000)], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' }), copied: false }
  },
}))

vi.mock('../engine/probe', () => ({
  probeFile: (file: File) => {
    seen.probed.push(file.name)
    if (seen.probeFails) return Promise.reject(new Error('media error while seeking poster frame'))
    return Promise.resolve({ kind: 'video', durationS: 13.5, width: 1080, height: 1920, hasAudio: true, hasVideo: true, fps: 30 })
  },
}))

vi.mock('../engine/proxyMedia', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureProxies: () => Promise.resolve(),
}))

import { importFiles, useImportProgress } from './mediaActions'
import { useStore } from './store'

const iphone = (name: string): File => new File([new Uint8Array(4096)], name, { type: 'video/quicktime' })

beforeEach(() => {
  seen.stored.length = 0
  seen.mirrored.length = 0
  seen.probed.length = 0
  seen.toasts.length = 0
  seen.progress.length = 0
  seen.master = 'ok'
  seen.probeFails = false
  useStore.setState({ project: newProject() })
})

useImportProgress.subscribe((s) => seen.progress.push({ step: s.step, frac: s.frac }))

describe('a new HDR clip is stored as its SDR master', () => {
  it('stores, mirrors and probes the master, never the HLG original', async () => {
    const [id] = await importFiles([iphone('IMG_5001.MOV')])
    const asset = useStore.getState().project.assets[id]
    expect(asset.name).toBe('IMG_5001.mp4')
    expect(seen.stored.find((s) => s.key.startsWith('asset/'))?.size).toBe(3000)
    expect(seen.mirrored).toEqual([3000])
    expect(seen.probed).toEqual(['IMG_5001.mp4'])
    // No second blob for the original: see mediaActions.ts for why.
    expect(seen.stored.filter((s) => s.key.startsWith('asset/'))).toHaveLength(1)
    expect(seen.toasts).toEqual([{ message: 'Imported 1 file(s)', kind: 'success' }])
  })

  it('shows the conversion in the import strip while it runs, and clears it after', async () => {
    await importFiles([iphone('IMG_5002.MOV')])
    expect(seen.progress).toContainEqual({ step: 'Converting HDR colour', frac: 0.5 })
    expect(useImportProgress.getState()).toMatchObject({ total: 0, step: '', frac: 0 })
  })

  it('leaves an ordinary clip exactly as it was', async () => {
    seen.master = 'sdr'
    const [id] = await importFiles([iphone('IMG_0001.MOV')])
    expect(useStore.getState().project.assets[id].name).toBe('IMG_0001.MOV')
    expect(seen.stored.find((s) => s.key.startsWith('asset/'))?.size).toBe(4096)
  })
})

describe('a conversion that fails is never a lost import', () => {
  it('imports the original the way it always did, and says so once, plainly', async () => {
    seen.master = 'fail'
    const [id] = await importFiles([iphone('IMG_5001.MOV')])
    expect(useStore.getState().project.assets[id].name).toBe('IMG_5001.MOV')
    expect(seen.stored.find((s) => s.key.startsWith('asset/'))?.size).toBe(4096)
    expect(seen.toasts).toContainEqual({
      message: 'IMG_5001.MOV: imported, but its HDR colour could not be converted, so it may look darker than on your phone',
      kind: 'info',
    })
    // Never the "unsupported" or "could not be converted" failures: the clip is in.
    expect(seen.toasts.filter((t) => t.kind === 'danger')).toEqual([])
  })

  it('never says "imported" about a clip that then did not import at all', async () => {
    // No master, then the browser refuses the original and the rescue fails too
    // (a machine with no HEVC decoder and no working conversion): the clip is
    // not in his bin, so only the conversion failure may be said.
    seen.master = 'fail'
    seen.probeFails = true
    const ids = await importFiles([iphone('IMG_5001.MOV')])
    expect(ids).toEqual([])
    expect(seen.toasts.map((t) => t.message)).toEqual([
      'IMG_5001.MOV: this recording could not be converted. It may still be being written, or the end of it is damaged',
    ])
  })

  it('says it ONCE for a whole batch, never once per clip', async () => {
    seen.master = 'fail'
    const ids = await importFiles([iphone('IMG_5001.MOV'), iphone('IMG_5002.MOV'), iphone('IMG_5003.MOV')])
    expect(ids).toHaveLength(3)
    const hdr = seen.toasts.filter((t) => /HDR/.test(t.message))
    expect(hdr).toEqual([
      { message: '3 HDR clips imported without their colour conversion, so they may look darker than on your phone', kind: 'info' },
    ])
  })
})
