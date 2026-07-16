import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'

// Toasts touch window.setTimeout, which the node test env lacks.
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import { addCaptionsFromWords } from './captionActions'
import { applyAppearanceToClips, applyTextPresetToClips, captureTextPreset, type TextStylePreset } from './textPresets'
import { updateActiveSequence, useStore } from './store'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clips = () => seq().tracks[0].clips

function seedTitle(startS: number): Clip {
  const clip = newTitleClip(defaultTitleDef('hello'), startS, 5)
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [...t.clips, clip] } : t)),
    }),
  )
  return clip
}

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

const PRESET: TextStylePreset = {
  id: 'p1',
  name: 'Test',
  style: { textCase: 'lower', color: '#00ff00', outline: { color: '#000000', widthPx: 12 } },
  appearance: { in: 'pop', durS: 0.15 },
}

describe('applyTextPresetToClips', () => {
  it('applies style + animation to every selected title in one undo step', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    applyTextPresetToClips([a.id, b.id], PRESET)
    const [ca, cb] = clips()
    expect(ca.title!.textCase).toBe('lower')
    expect(cb.title!.color).toBe('#00ff00')
    expect(ca.title!.outline).toEqual({ color: '#000000', widthPx: 12 })
    expect(cb.title!.textCase).toBe('lower')
    // The 'pop' entrance compiled scale + opacity keyframes.
    expect((ca.keyframes?.scale?.length ?? 0) + (ca.keyframes?.opacity?.length ?? 0)).toBeGreaterThan(0)
    expect(ca.appearance?.in).toBe('pop')

    useStore.getState().undo()
    expect(clips().every((c) => c.title!.textCase === undefined)).toBe(true)
  })
})

describe('applyAppearanceToClips', () => {
  it('sets an entrance animation on all selected titles without touching style', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    applyAppearanceToClips([a.id, b.id], { in: 'bounce', durS: 0.2 })
    expect(clips().every((c) => c.appearance?.in === 'bounce')).toBe(true)
    // Colour/case untouched.
    expect(clips()[0].title!.color).toBe(defaultTitleDef().color)
  })
})

describe('captureTextPreset', () => {
  it('round-trips a clip style into a preset', () => {
    const a = seedTitle(0)
    applyTextPresetToClips([a.id], PRESET)
    const captured = captureTextPreset(a.id, 'Captured')
    expect(captured).not.toBeNull()
    expect(captured!.style.textCase).toBe('lower')
    expect(captured!.style.outline).toEqual({ color: '#000000', widthPx: 12 })
    expect(captured!.appearance?.in).toBe('pop')
  })
})

describe('addCaptionsFromWords with a preset', () => {
  it('lands the whole run pre-styled by the preset', () => {
    addCaptionsFromWords(
      [
        { text: 'hello', startS: 0, endS: 0.5 },
        { text: 'world', startS: 0.6, endS: 1.1 },
      ],
      { preset: PRESET },
    )
    // Captions land on a new top video track.
    const caption = seq()
      .tracks.flatMap((t) => t.clips)
      .find((c) => c.title?.text.toLowerCase() === 'hello')
    expect(caption).toBeTruthy()
    expect(caption!.title!.textCase).toBe('lower')
    expect(caption!.title!.outline).toEqual({ color: '#000000', widthPx: 12 })
    expect(caption!.appearance?.in).toBe('pop')
  })
})
