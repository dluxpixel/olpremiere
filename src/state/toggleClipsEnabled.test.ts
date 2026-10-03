// Shift+E switches the whole selection, in one undo step.
//
// MEASURED 2026-10-01 in his GYM: three titles selected, Shift+E, one went off.
// Every other verb on that keyboard acts on everything he picked.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from '../engine/types'
import { toggleClipsEnabled } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const asset: MediaAsset = { id: 'v', name: 'v', kind: 'video', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: true }
const at = (id: string, startS: number, over: Partial<Clip> = {}): Clip => ({
  ...newClipFromAsset(asset, startS),
  id,
  inS: 0,
  outS: 1,
  ...over,
})
const enabled = (): Record<string, boolean> =>
  Object.fromEntries(activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips.map((c) => [c.id, c.enabled])))

/** Three titles on V2 and a linked pair on V1/A1. newProject() is [V1, V2, A1, A2]. */
function seed(over: Partial<Record<'t1' | 't2' | 't3', Partial<Clip>>> = {}, lockV2 = false): void {
  useStore.getState().setProject({ ...newProject(), assets: { v: asset } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) =>
        i === 0
          ? { ...t, clips: [at('vid', 0, { linkId: 'L' })] }
          : i === 1
            ? { ...t, locked: lockV2, clips: [at('t1', 0, over.t1), at('t2', 2, over.t2), at('t3', 4, over.t3)] }
            : i === 2
              ? { ...t, clips: [at('aud', 0, { linkId: 'L' })] }
              : t,
      ),
    }),
  )
}

beforeEach(() => seed())

describe('toggleClipsEnabled (Shift+E)', () => {
  it('switches off EVERY selected clip, as one undo step', () => {
    toggleClipsEnabled(['t1', 't2', 't3'])
    expect(enabled()).toMatchObject({ t1: false, t2: false, t3: false })
    expect(useStore.getState().history.undo.at(-1)?.label).toBe('Disable 3 clips')
    useStore.getState().undo()
    expect(enabled()).toMatchObject({ t1: true, t2: true, t3: true })
  })

  it('a mixed selection goes all OFF, the one predictable way', () => {
    seed({ t2: { enabled: false } })
    toggleClipsEnabled(['t1', 't2', 't3'])
    expect(enabled()).toMatchObject({ t1: false, t2: false, t3: false })
  })

  it('and back ON when every clip he picked is already off', () => {
    toggleClipsEnabled(['t1', 't2', 't3'])
    toggleClipsEnabled(['t1', 't2', 't3'])
    expect(enabled()).toMatchObject({ t1: true, t2: true, t3: true })
  })

  it('one clip alone is the old toggle, and its linked partner comes along', () => {
    toggleClipsEnabled(['vid'])
    expect(enabled()).toMatchObject({ vid: false, aud: false, t1: true })
    expect(useStore.getState().history.undo.at(-1)?.label).toBe('Disable clip')
    toggleClipsEnabled(['vid'])
    expect(enabled()).toMatchObject({ vid: true, aud: true })
  })

  it('leaves a locked track alone', () => {
    seed({}, true)
    toggleClipsEnabled(['t1', 'vid'])
    expect(enabled()).toMatchObject({ t1: true, vid: false })
  })
})
