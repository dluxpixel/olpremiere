/**
 * @vitest-environment jsdom
 *
 * jsdom rather than node, for the page's clipboard and the toast store's `window`.
 */

// A clip copy marks the SYSTEM clipboard, 2026-09-28. Copied clips live inside
// the app where nothing else can see them, so without a mark an older picture
// sitting on the system clipboard would hijack the next Ctrl+V meant for them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { defaultTitleDef, newProject, newTitleClip } from '../engine/types'
import { clipMarkerLost, clipMarkerOnSystemClipboard, copySelection, cutSelection } from './clipboard'
import { clipMarker } from './pasteRules'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())

function seedSelectedClips(count: number): void {
  const clips = Array.from({ length: count }, (_, i) => newTitleClip(defaultTitleDef(`t${i}`), i * 5, 5))
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, ...clips] } : t)),
    }),
  )
  useStore.getState().setUI({ selection: clips.map((c) => c.id) })
}

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [] })
})

afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'clipboard')
})

describe('a clip copy marks the system clipboard', () => {
  it('Copy writes the marker, and remembers it', () => {
    seedSelectedClips(2)
    expect(copySelection()).toBe(true)
    expect(writeText).toHaveBeenCalledWith(clipMarker(2))
    expect(clipMarkerOnSystemClipboard()).toBe(clipMarker(2))
  })

  it('Cut writes it too, because a cut is a copy as well', () => {
    seedSelectedClips(1)
    cutSelection()
    expect(writeText).toHaveBeenCalledWith(clipMarker(1))
  })

  it('a clipboard the page may not write to still copies the clips', () => {
    writeText.mockImplementationOnce(() => Promise.reject(new DOMException('Document is not focused')))
    seedSelectedClips(1)
    expect(copySelection()).toBe(true)
  })

  it('a refused write is remembered, so the next paste takes these clips over an older picture', async () => {
    writeText.mockImplementationOnce(() => Promise.reject(new DOMException('Document is not focused')))
    seedSelectedClips(1)
    copySelection()
    await Promise.resolve()
    await Promise.resolve()
    expect(clipMarkerLost()).toBe(true)
    // And the next copy that does write clears it.
    copySelection()
    expect(clipMarkerLost()).toBe(false)
  })

  it('writes nothing when there was nothing to copy', () => {
    expect(copySelection()).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })
})
