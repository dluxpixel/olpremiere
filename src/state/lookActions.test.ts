import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateClipEffects } from '../engine/effects/migrate'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, videoTracks } from '../engine/types'
import { applyJettismLook, applyPunchyGrade, applyPunchyGradeToClips, jettismGradeEffects } from './lookActions'
import { setActiveSequenceFormat, updateActiveSequence, useStore } from './store'

const toasts: string[] = []
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (m: string) => toasts.push(m) }) },
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
  toasts.length = 0
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
      expect(types).toEqual(expect.arrayContaining(['exposure', 'contrast', 'saturation']))
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

  it('applyPunchyGrade grades just the one clip: no 9:16, no double-apply', () => {
    const a = seedFootage(0, 5)
    seedFootage(5, 3)
    const before = seq().width
    applyPunchyGrade(a)
    applyPunchyGrade(a)
    const clips = videoTracks(seq())[0].clips
    expect(clips[0].effects).toHaveLength(3)
    expect(clips[1].effects).toHaveLength(0)
    expect(seq().width).toBe(before) // format untouched
  })

  it('does not stack the grade on a clip graded BEFORE the brightness split', () => {
    // The end of the chain migrate.test.ts starts. The old punch grade deposited
    // `brightnessContrast { brightness: 0, contrast: 0.1 }` on every clip it
    // touched. `hasJettismGrade` recognises an already-graded clip by matching
    // type + JSON.stringify(params) against what `jettismGradeEffects()` emits
    // TODAY, which is the standalone `contrast`. The load-time migration is the
    // only thing keeping those clips recognisable. Break it and a second click
    // stacks the grade twice and blows out footage he has already published.
    const id = seedFootage(0, 5)
    updateActiveSequence('seed a pre-split punch grade', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0
          ? {
              ...t,
              clips: t.clips.map((c) =>
                c.id === id
                  ? {
                      ...c,
                      effects: [
                        { id: 'old_e', type: 'exposure' as const, enabled: true, params: { exposure: 0.1 } },
                        { id: 'old_bc', type: 'brightnessContrast' as const, enabled: true, params: { brightness: 0, contrast: 0.1 } },
                        { id: 'old_s', type: 'saturation' as const, enabled: true, params: { saturation: 0.13 } },
                      ],
                    }
                  : c,
              ),
            }
          : t,
      ),
    }))

    // Exactly what load does (persistence.ts, projectFile.ts).
    updateActiveSequence('load migration', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map(migrateClipEffects) })),
    }))

    applyPunchyGrade(id)
    applyPunchyGrade(id)

    const clip = videoTracks(seq())[0].clips.find((c) => c.id === id)!
    expect(clip.effects).toHaveLength(3) // not 6
    expect(clip.effects.map((e) => e.type)).toEqual(['exposure', 'contrast', 'saturation'])
    // Still the ORIGINAL instances, rewritten in place: nothing was appended.
    expect(clip.effects.map((e) => e.id)).toEqual(['old_e', 'old_bc', 'old_s'])
  })

  it('keeps a Phone video Phone, and still grades it', () => {
    // His ask, 2026-10-05: Phone (1080x2112) is the frame for TikTok and Reels.
    setActiveSequenceFormat(1080, 2112)
    seedFootage(0, 5)
    applyJettismLook()
    const s = seq()
    expect([s.width, s.height]).toEqual([1080, 2112])
    // The next new video starts Phone too, not 9:16.
    const settings = useStore.getState().project.settings
    expect([settings.width, settings.height]).toEqual([1080, 2112])
    expect(videoTracks(s)[0].clips[0].effects).toHaveLength(3)
    expect(toasts.at(-1)).toBe('Jettism look: kept the Phone frame, punch grade on 1 clip, pop titles')
  })

  it('still turns a wide video into 9:16', () => {
    setActiveSequenceFormat(1920, 1080)
    seedFootage(0, 5)
    applyJettismLook()
    expect([seq().width, seq().height]).toEqual([1080, 1920])
  })

  it('leaves a clip on a locked track alone', () => {
    seedFootage(0, 5)
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)),
    }))
    applyJettismLook()
    expect(videoTracks(seq())[0].clips[0].effects).toHaveLength(0)
  })

  it('a second double click with nothing left to do adds no undo step', () => {
    seedFootage(0, 5)
    applyJettismLook()
    const depth = useStore.getState().history.undo.length
    applyJettismLook()
    expect(useStore.getState().history.undo.length).toBe(depth)
  })

  it('Punchy Grade with nothing selected says what to do', () => {
    applyPunchyGradeToClips([])
    expect(toasts).toEqual(['Select a clip first'])
  })

  it('grade instances get fresh ids per call', () => {
    const a = jettismGradeEffects()
    const b = jettismGradeEffects()
    expect(a.map((e) => e.id)).not.toEqual(b.map((e) => e.id))
  })
})
