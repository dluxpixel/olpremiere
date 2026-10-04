/**
 * @vitest-environment jsdom
 *
 * His words, 2026-10-04: *"selecting multiple images and putting effects on them
 * that actually apply to all of them."* Three pasted pictures selected, and every
 * way the multi selection Inspector takes an effect, through the real store: the
 * Add effect list, an effect dragged into the panel, and the Punch grade button.
 * Each one must reach all three in ONE undo step and say how many it changed.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ shown: [] as string[] }))
vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), {
    getState: () => ({ show: (message: string) => toasts.shown.push(message) }),
  }),
}))

import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from '../engine/types'
import { EFFECT_MIME } from '../state/dnd'
import { updateActiveSequence, useStore } from '../state/store'
import { makeAsset } from './timelineTestFixtures'
import { MultiInspector, type SelectedClip } from './MultiInspector'

const seq = () => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!
const effectsOf = (ids: string[]): string[][] => ids.map((id) => clipById(id).effects.map((e) => e.type))

/** Three pasted pictures at the same time on V1 and V2, and V1 again later. */
function threePictures(): string[] {
  const assets: Record<string, MediaAsset> = {}
  const clips: Clip[] = ['a', 'b', 'c'].map((k, i) => {
    assets[k] = makeAsset({ id: k, name: `${k}.png`, kind: 'image', durationS: 0, hasAudio: false, hasVideo: false, width: 640, height: 480 })
    return newClipFromAsset(assets[k]!, i === 2 ? 6 : 0)
  })
  useStore.getState().setProject({ ...newProject('pictures'), assets })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t) => {
        if (t.name === 'V1') return { ...t, clips: [clips[0]!, clips[2]!] }
        if (t.name === 'V2') return { ...t, clips: [clips[1]!] }
        return t
      }),
    }),
  )
  return clips.map((c) => c.id)
}

function selectedOf(ids: string[]): SelectedClip[] {
  return seq().tracks.flatMap((track) =>
    track.clips.filter((c) => ids.includes(c.id)).map((clip) => ({ clip, track, emitsAudio: false })),
  )
}

beforeEach(() => {
  toasts.shown.length = 0
  localStorage.clear()
})
afterEach(cleanup)

describe('the multi selection Inspector, with three pictures selected', () => {
  it('Add effect puts it on all three, in ONE undo step, and says how many', async () => {
    const ids = threePictures()
    render(<MultiInspector selected={selectedOf(ids)} />)
    await userEvent.setup().selectOptions(screen.getByTestId('multi-add-effect'), 'gaussianBlur')
    expect(effectsOf(ids)).toEqual([['gaussianBlur'], ['gaussianBlur'], ['gaussianBlur']])
    expect(toasts.shown).toEqual(['Added Gaussian Blur to 3 clips'])
    useStore.getState().undo()
    expect(effectsOf(ids)).toEqual([[], [], []])
  })

  it('an effect dragged into the panel lands on all three and says how many', () => {
    const ids = threePictures()
    render(<MultiInspector selected={selectedOf(ids)} />)
    fireEvent.drop(screen.getByTestId('multi-effects'), {
      dataTransfer: { types: [EFFECT_MIME], getData: (m: string) => (m === EFFECT_MIME ? 'saturation' : '') },
    })
    expect(effectsOf(ids)).toEqual([['saturation'], ['saturation'], ['saturation']])
    expect(toasts.shown).toEqual(['Added Saturation to 3 clips'])
  })

  it('Punch grade grades all three and counts three', async () => {
    const ids = threePictures()
    render(<MultiInspector selected={selectedOf(ids)} />)
    await userEvent.setup().click(screen.getByTestId('multi-punch-grade'))
    expect(ids.map((id) => clipById(id).effects.length)).toEqual([3, 3, 3])
    expect(toasts.shown).toEqual(['Punch grade on 3 clips'])
  })
})
