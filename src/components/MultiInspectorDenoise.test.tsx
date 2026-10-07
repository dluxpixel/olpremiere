/**
 * @vitest-environment jsdom
 *
 * AU-18. A dubbed take lands as several clips, one per pause, and Cut the quiet
 * parts makes many more; each used to need its own noise reduction toggle.
 * With several clips selected, the Inspector turns it on for all of them, in
 * one undo step, through the real store.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))
const warmed: string[] = []
vi.mock('../engine/audio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/audio')>()),
  warmDenoise: (clip: { id: string }) => warmed.push(clip.id),
}))

import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from '../engine/types'
import { updateActiveSequence, useStore } from '../state/store'
import { MultiInspector, type SelectedClip } from './MultiInspector'

const TAKE: MediaAsset = { id: 'take', name: 'Voice recording 1.wav', kind: 'audio', blobKey: 'take', durationS: 30, hasAudio: true, hasVideo: false }

function seedTakes(): string[] {
  const p = useStore.getState().project
  useStore.getState().setProject({ ...p, assets: { ...p.assets, take: TAKE } })
  const ids = ['t1', 't2', 't3']
  updateActiveSequence('seed', (sq) => {
    const a1 = sq.tracks.find((t) => t.kind === 'audio')!.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === a1 ? { ...t, clips: ids.map((id, i) => ({ ...newClipFromAsset(TAKE, i * 5), id, inS: i * 5, outS: i * 5 + 4 })) } : t,
      ),
    }
  })
  return ids
}

function selectedOf(ids: string[]): SelectedClip[] {
  const seq = activeSequence(useStore.getState().project)
  return seq.tracks.flatMap((track) =>
    track.clips.filter((c) => ids.includes(c.id)).map((clip) => ({ clip, track, emitsAudio: true })),
  )
}
const clipById = (id: string): Clip =>
  activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

beforeEach(() => {
  warmed.length = 0
  useStore.getState().setProject(newProject())
})
afterEach(cleanup)

describe('Reduce noise on the multi selection Inspector', () => {
  it('turns it on for every selected clip in ONE undo step, and starts cleaning them all', async () => {
    const ids = seedTakes()
    render(<MultiInspector selected={selectedOf(ids)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reduce background noise (all)' }))
    expect(ids.map((id) => clipById(id).denoise)).toEqual([1, 1, 1])
    expect(warmed).toEqual(ids)
    useStore.getState().undo()
    expect(ids.map((id) => 'denoise' in clipById(id))).toEqual([false, false, false])
  })

  it('on everywhere, it shows the strength and the same button turns it off everywhere', async () => {
    const ids = seedTakes()
    updateActiveSequence('all on', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, denoise: 0.6 })) })),
    }))
    render(<MultiInspector selected={selectedOf(ids)} />)
    expect((screen.getByTestId('multi-denoise') as HTMLInputElement).value).toBe('60')
    await userEvent.click(screen.getByRole('button', { name: 'Turn noise reduction off (all)' }))
    expect(ids.map((id) => 'denoise' in clipById(id))).toEqual([false, false, false])
  })

  it('a mixed selection is not on: one press puts every clip at full strength', async () => {
    const ids = seedTakes()
    updateActiveSequence('one on', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 't2' ? { ...c, denoise: 0.5 } : c)) })),
    }))
    render(<MultiInspector selected={selectedOf(ids)} />)
    expect(screen.queryByTestId('multi-denoise')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Reduce background noise (all)' }))
    expect(ids.map((id) => clipById(id).denoise)).toEqual([1, 1, 1])
  })
})
