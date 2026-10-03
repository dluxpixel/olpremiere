/**
 * @vitest-environment jsdom
 *
 * His ask, 2026-09-29: "make it so when i for example paste in a 4:3clip it
 * stretches to 16:9 when i select to". A Short is twenty clips, so the choice
 * has to reach every selected one from the multi selection Inspector, in one
 * undo step, through the real store.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { addClipWithLinkedAudio } from '../engine/timeline'
import { activeSequence, newProject, type Clip, type MediaAsset } from '../engine/types'
import { updateActiveSequence, useStore } from '../state/store'
import { MultiInspector, type SelectedClip } from './MultiInspector'

const asset = (id: string, width: number, height: number): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  blobKey: id,
  durationS: 10,
  width,
  height,
  hasAudio: true,
  hasVideo: true,
})

function place(a: MediaAsset, startS: number): string {
  const p = useStore.getState().project
  useStore.getState().setProject({ ...p, assets: { ...p.assets, [a.id]: a } })
  let id = ''
  updateActiveSequence('seed', (sq) => {
    const v1 = sq.tracks.find((t) => t.kind === 'video')!.id
    const a1 = sq.tracks.find((t) => t.kind === 'audio')!.id
    const r = addClipWithLinkedAudio(sq, v1, a1, a, startS, { exact: true })
    id = r.videoClipId
    return r.seq
  })
  return id
}

/** What the Inspector hands the panel: every selected clip with its track. */
function selectedOf(ids: string[]): SelectedClip[] {
  const seq = activeSequence(useStore.getState().project)
  return seq.tracks.flatMap((track) =>
    track.clips.filter((c) => ids.includes(c.id)).map((clip) => ({ clip, track, emitsAudio: track.kind === 'audio' })),
  )
}
const clipById = (id: string): Clip =>
  activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

beforeEach(() => {
  useStore.getState().setProject(newProject())
})
afterEach(cleanup)

describe('Frame on the multi selection Inspector', () => {
  it('shows what every selected picture shares, and Stretch to fill reaches all of them in one undo', async () => {
    const a = place(asset('tv', 640, 480), 0)
    const b = place(asset('tv2', 1440, 1080), 20)
    render(<MultiInspector selected={selectedOf([a, b])} />)
    const select = screen.getByTestId('multi-frame-fit') as HTMLSelectElement
    // Both landed filled, the way an import has always landed them.
    expect(select.value).toBe('fill')
    await userEvent.selectOptions(select, 'stretch')
    expect([a, b].map((id) => clipById(id).transform)).toEqual([
      expect.objectContaining({ fit: 'stretch', scale: 1 }),
      expect.objectContaining({ fit: 'stretch', scale: 1 }),
    ])
    useStore.getState().undo()
    expect([a, b].map((id) => 'fit' in clipById(id).transform)).toEqual([false, false])
  })

  it('says Mixed when they differ, so picking any one still fires on all of them', () => {
    const a = place(asset('tv', 640, 480), 0)
    const b = place(asset('tv2', 640, 480), 20)
    updateActiveSequence('stretch one', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === a ? { ...c, transform: { ...c.transform, scale: 1, fit: 'stretch' as const } } : c)),
      })),
    }))
    render(<MultiInspector selected={selectedOf([a, b])} />)
    const select = screen.getByTestId('multi-frame-fit') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.selectedOptions[0]?.textContent).toBe('Mixed')
  })
})
