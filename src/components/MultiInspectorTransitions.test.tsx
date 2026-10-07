/**
 * @vitest-environment jsdom
 *
 * Review, 2026-10-07: the multi panel's transition length field read the FIRST
 * clip's length, so with lengths that differ, typing that number to make them
 * all equal committed nothing. It now reads "Mixed" and takes any number.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))

import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from '../engine/types'
import { updateActiveSequence, useStore } from '../state/store'
import { makeAsset } from './timelineTestFixtures'
import { MultiInspector, type SelectedClip } from './MultiInspector'

const seq = () => activeSequence(useStore.getState().project)
const clipById = (id: string): Clip => seq().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

/** Two pictures back to back on V1, each with a White Flash Out of its own length. */
function twoFlashes(lengths: [number, number]): string[] {
  const assets: Record<string, MediaAsset> = {}
  const clips: Clip[] = ['a', 'b'].map((k, i) => {
    assets[k] = makeAsset({ id: k, name: `${k}.png`, kind: 'image', durationS: 0, hasAudio: false, hasVideo: false, width: 640, height: 480 })
    return { ...newClipFromAsset(assets[k]!, i * 5), transitionOut: { type: 'whiteFlash', durationS: lengths[i]! } }
  })
  useStore.getState().setProject({ ...newProject('flashes'), assets })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.name === 'V1' ? { ...t, clips } : t)) }),
  )
  return clips.map((c) => c.id)
}

const selectedOf = (ids: string[]): SelectedClip[] =>
  seq().tracks.flatMap((track) =>
    track.clips.filter((c) => ids.includes(c.id)).map((clip) => ({ clip, track, emitsAudio: false })),
  )

/** Type into a scrub field and press Enter, the way he commits a number. */
function typeInto(field: HTMLElement, text: string): void {
  fireEvent.focus(field)
  fireEvent.change(field, { target: { value: text } })
  fireEvent.keyDown(field, { key: 'Enter' })
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('the multi panel transition length', () => {
  it('reads Mixed when the lengths differ, and the first clip number evens them out', () => {
    const ids = twoFlashes([0.2, 0.3])
    render(<MultiInspector selected={selectedOf(ids)} />)
    const field = screen.getByTestId('multi-transition-out-duration') as HTMLInputElement
    expect(field.value).toBe('Mixed')
    typeInto(field, '0.2')
    expect(ids.map((id) => clipById(id).transitionOut?.durationS)).toEqual([0.2, 0.2])
  })

  it('reads the shared length when they agree', () => {
    const ids = twoFlashes([0.3, 0.3])
    render(<MultiInspector selected={selectedOf(ids)} />)
    expect((screen.getByTestId('multi-transition-out-duration') as HTMLInputElement).value).toBe('0.3')
  })
})
