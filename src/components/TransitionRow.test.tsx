/**
 * @vitest-environment jsdom
 *
 * Open finding 8, transition duration truth (ol-premiere-open-threads-2026-08-04.md):
 * an Inspector-added transition on a clip with none passed durationS 1, which
 * sits inside every kind's envelope except White Flash and Glitch, so
 * setClipTransition kept it verbatim. An Inspector-added Cross Dissolve landed
 * at 1.0s while a dropped one defaults to 0.4s.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  calls: [] as { clipId: string; edge: string; kind: string; durationS: number | undefined }[],
}))

vi.mock('../state/clipEdits', () => ({
  setClipTransition: (clipId: string, edge: string, kind: string, durationS?: number) => {
    hoisted.calls.push({ clipId, edge, kind, durationS })
  },
  removeClipTransition: () => {},
}))

import { defaultTransform, type Clip } from '../engine/types'
import { TransitionRow } from './EffectControls'

const clip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  assetId: 'a1',
  startS: 0,
  inS: 0,
  outS: 4,
  speed: 1,
  enabled: true,
  transform: defaultTransform(),
  opacity: 1,
  blendMode: 'normal',
  audioGainDb: 0,
  fadeInS: 0,
  fadeOutS: 0,
  effects: [],
  ...overrides,
})

afterEach(cleanup)

describe('TransitionRow', () => {
  it('adds a fresh transition with an undefined duration, not the 1s placeholder, so the kind default lands', async () => {
    hoisted.calls.length = 0
    const user = userEvent.setup()
    render(<TransitionRow clip={clip()} edge="in" testId="transition-in" />)
    await user.selectOptions(screen.getByTestId('transition-in'), 'crossDissolve')
    expect(hoisted.calls).toEqual([{ clipId: 'c1', edge: 'in', kind: 'crossDissolve', durationS: undefined }])
  })

  it('still carries the stored duration when switching kind on a clip that already had a transition', async () => {
    hoisted.calls.length = 0
    const user = userEvent.setup()
    const withTransition = clip({ transitionIn: { type: 'dipToBlack', durationS: 0.7 } })
    render(<TransitionRow clip={withTransition} edge="in" testId="transition-in" />)
    await user.selectOptions(screen.getByTestId('transition-in'), 'crossDissolve')
    expect(hoisted.calls).toEqual([{ clipId: 'c1', edge: 'in', kind: 'crossDissolve', durationS: 0.7 }])
  })
})
