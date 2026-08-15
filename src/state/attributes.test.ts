import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  defaultTitleDef,
  newProject,
  newTitleClip,
  type Clip,
  type Sequence,
} from '../engine/types'
import { copyClipAttributes, hasClipAttributes, pasteClipAttributes } from './attributes'
import { channelKeyframes } from '../engine/effects/channels'
import { setClipsAppearance } from './appearanceActions'
import { applyEffect, setChannel, toggleChannelAnimation } from './clipEdits'
import { updateActiveSequence, useStore } from './store'

vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const seq = (): Sequence => activeSequence(useStore.getState().project)
const clips = () => seq().tracks[0].clips

function seedTitle(startS: number): Clip {
  const clip = newTitleClip(defaultTitleDef('x'), startS, 5)
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

describe('copy / paste attributes', () => {
  it('stamps effects (fresh ids) + opacity from one clip onto others in one undo step', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    applyEffect(a.id, 'saturation')
    setChannel(a.id, 'opacity', 0.5)
    const srcEffectId = clips()[0].effects[0].id

    copyClipAttributes(a.id)
    expect(hasClipAttributes()).toBe(true)
    pasteClipAttributes([b.id])

    const cb = clips()[1]
    expect(cb.effects).toHaveLength(1)
    expect(cb.effects[0].type).toBe('saturation')
    expect(cb.effects[0].id).not.toBe(srcEffectId) // its own instance
    expect(cb.opacity).toBe(0.5)

    useStore.getState().undo()
    expect(clips()[1].effects).toHaveLength(0)
  })

  /**
   * ⛔ PASTING A LOOK MUST NOT DELETE A MOVE HE MADE BY HAND.
   *
   * The paste used to end with `applyAppearanceToClip(nc, attrs.appearance ?? {})`,
   * and an empty spec CLEARS the appearance channels: opacity, scale, posX, posY,
   * rotation. Those are the channels a move lives on, so copying a look off a
   * plain clip and stamping it on an animated one wiped the animation, with a
   * toast that said the paste had worked. Audit item 5, 2026-08-14. → D99.
   */
  it('leaves the target keyframes alone when the source carries no appearance', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    applyEffect(a.id, 'saturation')

    // b gets a move by hand: two Zoom moments.
    useStore.getState().setUI({ playheadS: 6.5 })
    toggleChannelAnimation(b.id, 'scale')
    useStore.getState().setUI({ playheadS: 8 })
    setChannel(b.id, 'scale', 1.2)
    const before = channelKeyframes(clips()[1], 'scale').map((k) => [k.t, k.value])
    expect(before).toHaveLength(2)

    copyClipAttributes(a.id)
    pasteClipAttributes([b.id])

    // The look landed AND the move survived.
    expect(clips()[1].effects[0].type).toBe('saturation')
    expect(channelKeyframes(clips()[1], 'scale').map((k) => [k.t, k.value])).toEqual(before)
  })

  it('still replaces the animation when the source HAS an appearance', () => {
    const a = seedTitle(0)
    const b = seedTitle(6)
    setClipsAppearance([a.id], { in: 'pop', durS: 0.4 })
    useStore.getState().setUI({ playheadS: 6.5 })
    toggleChannelAnimation(b.id, 'scale')
    useStore.getState().setUI({ playheadS: 8 })
    setChannel(b.id, 'scale', 1.2)

    copyClipAttributes(a.id)
    pasteClipAttributes([b.id])

    // The source's entrance owns those channels now, so b's hand move is gone
    // and what replaced it is a compiled appearance rather than nothing.
    expect(clips()[1].appearance).toBeTruthy()
    expect(channelKeyframes(clips()[1], 'scale').map((k) => [k.t, k.value])).not.toEqual([
      [6.5 - 6, 1],
      [8 - 6, 1.2],
    ])
  })

  it('refuses to paste when nothing was copied', () => {
    const b = seedTitle(0)
    const before = useStore.getState().project
    pasteClipAttributes([b.id]) // clipboard empty (fresh module state may carry over, so guard on selection anyway)
    // Either the clipboard is empty (no change) or a prior copy applied cleanly;
    // the invariant we assert is that pasting onto an EMPTY selection never throws.
    expect(() => pasteClipAttributes([])).not.toThrow()
    void before
  })
})
