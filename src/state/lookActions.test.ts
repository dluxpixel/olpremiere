import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, videoTracks } from '../engine/types'
import { applyJettismLook, jettismGradeEffects } from './lookActions'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: () => {} }) },
}))
vi.mock('./persistence', () => ({
  db: vi.fn(async () => ({ put: async () => {}, get: async () => undefined, delete: async () => {} })),
}))

const seq = () => activeSequence(useStore.getState().project)

/** A plain (non-title) video clip on V1. */
function seedFootage(startS: number, durS: number): string {
  const clip = { ...newTitleClip(defaultTitleDef('x'), startS, durS) }
  delete (clip as { title?: unknown }).title
  updateActiveSequence('seed', (sq) => ({
    ...sq,
    tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
  }))
  return clip.id
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
})

describe('applyJettismLook', () => {
  it('sets 9:16 and appends the punch grade to every footage clip in one undo step', () => {
    seedFootage(0, 5)
    seedFootage(5, 3)
    applyJettismLook()

    const s = seq()
    expect([s.width, s.height]).toEqual([1080, 1920])
    for (const clip of videoTracks(s)[0].clips) {
      const types = clip.effects.map((e) => e.type)
      expect(types).toEqual(expect.arrayContaining(['exposure', 'brightnessContrast', 'saturation']))
      const sat = clip.effects.find((e) => e.type === 'saturation')!
      expect(sat.params.saturation).toBe(0.13)
    }

    useStore.getState().undo()
    const back = seq()
    expect(back.width).not.toBe(1080)
    expect(videoTracks(back)[0].clips.every((c) => c.effects.length === 0)).toBe(true)
  })

  it('leaves title clips clean and does not stack the grade twice', () => {
    seedFootage(0, 5)
    updateActiveSequence('seed title', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 1 ? { ...t, clips: [newTitleClip(defaultTitleDef('CAP'), 1, 1)] } : t,
      ),
    }))
    applyJettismLook()
    applyJettismLook()

    const tracks = videoTracks(seq())
    expect(tracks[0].clips[0].effects).toHaveLength(3) // not 6
    expect(tracks[1].clips[0].effects).toHaveLength(0) // captions stay clean
  })

  it('grade instances get fresh ids per call', () => {
    const a = jettismGradeEffects()
    const b = jettismGradeEffects()
    expect(a.map((e) => e.id)).not.toEqual(b.map((e) => e.id))
  })
})
