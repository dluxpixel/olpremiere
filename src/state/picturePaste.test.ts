// @vitest-environment jsdom
//
// Pasting SEVERAL files at once. Five Battle Cats unit pictures copied in
// Explorer used to ask about the first and drop the other four without a word,
// and a copied song or clip pasted the clips copied in the app an hour before.
// jsdom for the object URLs and the desktop shell on `window`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CutoutResult } from '../../electron/ipc-types'
import { activeSequence, newId, newProject, type MediaAsset } from '../engine/types'

// The import itself, cut down to what a paste reads back: each file becomes an
// asset in the open project, in the order it came, in one undo step.
vi.mock('./mediaActions', async () => {
  const { useStore } = await import('./store')
  return {
    importFiles: async (files: File[]) => {
      const assets: MediaAsset[] = files.map((f) => ({
        id: newId(),
        name: f.name,
        kind: f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audio' : 'video',
        blobKey: `asset/${f.name}`,
        durationS: f.type.startsWith('image/') ? 0 : 4,
        hasAudio: !f.type.startsWith('image/'),
        hasVideo: !f.type.startsWith('audio/'),
      }))
      useStore.getState().dispatch('Import', (p) => ({
        ...p,
        assets: { ...p.assets, ...Object.fromEntries(assets.map((a) => [a.id, a])) },
      }))
      return assets.map((a) => a.id)
    },
  }
})
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { cancelPicturePaste, keepBackground, offerPictures, pasteMediaFiles, removeBackground, usePastePicture } =
  await import('./picturePaste')
const { useStore } = await import('./store')

const pic = (name: string): File => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
const seq = () => activeSequence(useStore.getState().project)
const placed = () =>
  seq().tracks.flatMap((t) =>
    t.clips.map((c) => ({ line: t.name, at: c.startS, name: useStore.getState().project.assets[c.assetId]?.name })),
  )

beforeEach(() => {
  useStore.getState().setProject(newProject('BC'))
  useStore.getState().setUI({ playheadS: 2, selection: [] })
  URL.createObjectURL = vi.fn(() => 'blob:pasted')
  URL.revokeObjectURL = vi.fn()
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.readAsArrayBuffer(this)
      })
    }
  }
})

afterEach(() => {
  cancelPicturePaste()
  delete (window as { api?: unknown }).api
})

describe('several pictures in one paste', () => {
  it('asks once for all of them, and Keep background places every one in order, in one paste step', async () => {
    offerPictures([pic('cat.png'), pic('dog.png'), pic('cow.png')])
    expect(usePastePicture.getState().picture?.file.name).toBe('cat.png')
    expect(usePastePicture.getState().more.map((f) => f.name)).toEqual(['dog.png', 'cow.png'])
    const undoBefore = useStore.getState().history.undo.length

    await keepBackground()

    // One after another from the playhead, on V2 above his footage, five seconds each.
    expect(placed()).toEqual([
      { line: 'V2', at: 2, name: 'cat.png' },
      { line: 'V2', at: 7, name: 'dog.png' },
      { line: 'V2', at: 12, name: 'cow.png' },
    ])
    // The import and the paste: the same two steps one picture takes.
    expect(useStore.getState().history.undo.length - undoBefore).toBe(2)
    expect(useStore.getState().ui.selection).toHaveLength(3)
    expect(usePastePicture.getState().picture).toBeNull()
  })

  it('Remove background cuts them one at a time, says which one, and carries on after a stop', async () => {
    const answers: ((r: CutoutResult) => void)[] = []
    ;(window as { api?: unknown }).api = {
      isElectron: true,
      removeBackground: () => new Promise<CutoutResult>((resolve) => answers.push(resolve)),
    }
    offerPictures([pic('cat.png'), pic('dog.png'), pic('cow.png')])
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer

    const run = removeBackground()
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    expect(usePastePicture.getState().workingOn).toBe(1)
    answers[0]!({ ok: true, png })
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    expect(usePastePicture.getState().workingOn).toBe(2)
    // CutStudio stops on the second one.
    answers[1]!({ ok: false, reason: 'failed', detail: 'x' })
    await run
    expect(usePastePicture.getState().phase).toBe('failed')
    expect(placed()).toEqual([])

    // Tried again, it starts at the one it stopped on, not the first.
    const again = removeBackground()
    await vi.waitFor(() => expect(answers).toHaveLength(3))
    expect(usePastePicture.getState().workingOn).toBe(2)
    answers[2]!({ ok: true, png })
    await vi.waitFor(() => expect(answers).toHaveLength(4))
    answers[3]!({ ok: true, png })
    await again

    expect(placed().map((p) => p.name)).toEqual([
      'cat no background.png',
      'dog no background.png',
      'cow no background.png',
    ])
  })
})

describe('a copied video or song', () => {
  it('goes in and onto the timeline at the playhead, no question, not selected', async () => {
    const song = new File([new Uint8Array([1])], 'song.mp3', { type: 'audio/mpeg' })
    const clip = new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' })

    await pasteMediaFiles([song, clip])

    expect(usePastePicture.getState().picture).toBeNull()
    const s = seq()
    const all = s.tracks.flatMap((t) => t.clips)
    const byName = (n: string) => all.find((c) => useStore.getState().project.assets[c.assetId]?.name === n && !c.linkId)
    expect(placed()).toContainEqual({ line: 'A1', at: 2, name: 'song.mp3' })
    // The video lands after the song, on V1, with its sound linked under it.
    expect(placed()).toContainEqual({ line: 'V1', at: 6, name: 'clip.mp4' })
    expect(all.filter((c) => c.linkId)).toHaveLength(2)
    expect(byName('song.mp3')).toBeTruthy()
    expect(useStore.getState().ui.selection).toEqual([])
  })
})
