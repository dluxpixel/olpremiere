import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recomputeDuration } from '../engine/timeline'
import { defaultTitleDef, newProject, newTitleClip } from '../engine/types'
import { screenshotName, screenshotToMedia } from './screenshot'
import { updateActiveSequence, useStore } from './store'

// The grab and the import are faked: what is tested here is what he is told.
const grab = vi.hoisted(() => vi.fn())
const imported = vi.hoisted(() => vi.fn(async () => []))
const toasts = vi.hoisted(() => [] as string[])
vi.mock('../engine/grabFrame', () => ({ grabFrame: grab }))
vi.mock('./mediaActions', () => ({ importFiles: imported }))
vi.mock('./playbackControl', () => ({ pausePlayback: () => undefined }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: (m: string) => toasts.push(m) }) } }))

describe('screenshotName', () => {
  it('names a still by the frame it was taken on', () => {
    expect(screenshotName(0, 30)).toBe('Frame 00-00-00.00.png')
    expect(screenshotName(12 + 5 / 30, 30)).toBe('Frame 00-00-12.17.png')
    expect(screenshotName(3661.5, 60)).toBe('Frame 01-01-01.50.png')
  })

  it('carries no colon, which Windows cannot put in a filename', () => {
    // The whole reason the clock is dashed. A colon here would come back as
    // an asset he cannot save or drag out of the app.
    expect(screenshotName(3725.25, 24)).not.toContain(':')
    expect(screenshotName(3725.25, 24)).toMatch(/^Frame \d\d-\d\d-\d\d\.\d\d\.png$/)
  })

  it('snaps to a frame of the sequence fps, not a fixed one', () => {
    // 0.51 s is frame 12 (0.50 s) at 24 and frame 31 (0.52 s) at 60. A still
    // named by the wrong fps would sort into the wrong place beside its neighbours.
    expect(screenshotName(0.51, 24)).toBe('Frame 00-00-00.50.png')
    expect(screenshotName(0.51, 60)).toBe('Frame 00-00-00.52.png')
  })

  it('sorts by time once past ten minutes, where an unpadded clock would not', () => {
    const names = [65, 605, 3600].map((t) => screenshotName(t, 30))
    expect([...names].sort()).toEqual(names)
  })
})

describe('taking the screenshot', () => {
  const still = (complete = true) => ({ blob: new Blob(['png']), width: 1080, height: 1920, complete })

  beforeEach(() => {
    toasts.length = 0
    grab.mockReset()
    imported.mockClear()
    useStore.getState().setProject(newProject())
    // Something on the timeline, so there is a frame to photograph.
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({
        ...sq,
        tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [newTitleClip(defaultTitleDef('x'), 0, 5)] } : t)),
      }),
    )
  })

  it('says so when the grab throws, instead of the camera doing nothing', async () => {
    grab.mockRejectedValueOnce(new Error('CONTEXT_LOST_WEBGL'))
    await expect(screenshotToMedia()).resolves.toBeUndefined()
    expect(toasts).toEqual(['Could not take the screenshot. Try again'])
    // And the next press is not locked out by the one that failed.
    grab.mockResolvedValueOnce(still())
    await screenshotToMedia()
    expect(imported).toHaveBeenCalledTimes(1)
  })

  it('says so when there was no picture to grab', async () => {
    grab.mockResolvedValueOnce(null)
    await screenshotToMedia()
    expect(toasts).toEqual(['Could not take the screenshot'])
    expect(imported).not.toHaveBeenCalled()
  })

  it('imports a still that was missing a layer, and then says it may be', async () => {
    grab.mockResolvedValueOnce(still(false))
    await screenshotToMedia()
    expect(imported).toHaveBeenCalledTimes(1)
    expect(toasts).toEqual(['Some footage was still loading, so the screenshot may be missing a layer'])
  })

  it('a second press while the first is still grabbing takes no second picture', async () => {
    let finish: (v: unknown) => void = () => undefined
    grab.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    const first = screenshotToMedia()
    await screenshotToMedia()
    expect(grab).toHaveBeenCalledTimes(1)
    finish(still())
    await first
    expect(imported).toHaveBeenCalledTimes(1)
  })
})
