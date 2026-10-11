// @vitest-environment jsdom
//
// Hold to compare is a VIEW: the preview draws the picture without its effects while it is held,
// and the project, the undo stack and the clips never hear about it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewBeforeActive, previewEpoch, resolveForPreview } from '../engine/preview'
import { resolveFrame } from '../engine/render/resolve'
import { recomputeDuration } from '../engine/timeline'
import { activeSequence, defaultTransform, newProject, type Clip, type EffectInstance } from '../engine/types'
import { holdBefore, isHoldingBefore, releaseBefore } from './compareHold'
import { updateActiveSequence, useStore } from './store'

const blur: EffectInstance = { id: 'fx1', type: 'gaussianBlur', params: { blur: 8 }, enabled: true }
const mk = (id: string): Clip => ({
  id,
  assetId: `asset-${id}`,
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
  effects: [blur],
})

/** Clip "a" on the first video track and clip "b" on the second, each with one effect. */
function seed(): void {
  updateActiveSequence('seed', (sq) => {
    const videos = sq.tracks.filter((t) => t.kind === 'video')
    return recomputeDuration({
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === videos[0].id ? { ...t, clips: [mk('a')] } : t.id === videos[1]?.id ? { ...t, clips: [mk('b')] } : t,
      ),
    })
  })
}

const count = (ops: ReturnType<typeof resolveFrame>['ops']): number =>
  ops.reduce((n, op) => n + (op.type === 'layer' ? op.layer.effects.length : 0), 0)
const effectsAt = (tS: number): number =>
  count(resolveForPreview(activeSequence(useStore.getState().project), tS).ops)

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 1 })
})
afterEach(() => releaseBefore())

describe('hold to compare', () => {
  it('shows the picture without effects while held and the real one after', () => {
    seed()
    const real = effectsAt(1)
    expect(real).toBeGreaterThan(0)
    holdBefore()
    expect(isHoldingBefore()).toBe(true)
    expect(previewBeforeActive()).toBe(true)
    expect(effectsAt(1)).toBe(0)
    releaseBefore()
    expect(previewBeforeActive()).toBe(false)
    expect(effectsAt(1)).toBe(real)
  })

  it('bumps the preview epoch on the hold and on the release, so a paused frame redraws', () => {
    seed()
    const e0 = previewEpoch()
    holdBefore()
    const e1 = previewEpoch()
    releaseBefore()
    expect(e1).toBeGreaterThan(e0)
    expect(previewEpoch()).toBeGreaterThan(e1)
  })

  it('is safe to call twice: a held key repeats, and letting go twice is harmless', () => {
    seed()
    holdBefore()
    const e = previewEpoch()
    holdBefore()
    expect(previewEpoch()).toBe(e)
    releaseBefore()
    const e2 = previewEpoch()
    releaseBefore()
    expect(previewEpoch()).toBe(e2)
  })

  it('writes nothing: the project is the same object and the undo stack the same length', () => {
    seed()
    const before = useStore.getState()
    holdBefore()
    releaseBefore()
    const after = useStore.getState()
    expect(after.project).toBe(before.project)
    expect(after.history.undo.length).toBe(before.history.undo.length)
    expect(activeSequence(after.project).tracks.flatMap((t) => t.clips).every((c) => c.effects.length === 1)).toBe(true)
  })

  it('compares only the clips he selected, and every clip when none is selected', () => {
    seed()
    useStore.getState().setUI({ selection: ['a'] })
    holdBefore()
    expect(effectsAt(1)).toBe(1)
    releaseBefore()
    useStore.getState().setUI({ selection: [] })
    holdBefore()
    expect(effectsAt(1)).toBe(0)
  })

  it('does not hold on an empty edit, where there is no picture to compare', () => {
    holdBefore()
    expect(isHoldingBefore()).toBe(false)
    expect(previewBeforeActive()).toBe(false)
  })

  it('leaves resolveFrame alone: the real frame still has its effects during a hold', () => {
    seed()
    holdBefore()
    expect(count(resolveFrame(activeSequence(useStore.getState().project), 1).ops)).toBeGreaterThan(0)
  })
})

/** Pretend the page is shown or hidden, the way a tab switch does. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('a hold that has no key or pointer to end it', () => {
  afterEach(() => {
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

  it('ends when the window loses focus', () => {
    seed()
    holdBefore()
    expect(isHoldingBefore()).toBe(true)
    window.dispatchEvent(new Event('blur'))
    expect(isHoldingBefore()).toBe(false)
    expect(previewBeforeActive()).toBe(false)
  })

  it('ends when the page is hidden, and not when it is shown', () => {
    seed()
    holdBefore()
    setVisibility('visible')
    expect(isHoldingBefore()).toBe(true)
    setVisibility('hidden')
    expect(isHoldingBefore()).toBe(false)
    expect(previewBeforeActive()).toBe(false)
  })

  it('listens only while held: the listeners come off on release and none stack up', () => {
    seed()
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const docAdd = vi.spyOn(document, 'addEventListener')
    const docRemove = vi.spyOn(document, 'removeEventListener')
    holdBefore()
    holdBefore()
    expect(add.mock.calls.filter((c) => (c[0] as string) === 'blur')).toHaveLength(1)
    expect(docAdd.mock.calls.filter((c) => (c[0] as string) === 'visibilitychange')).toHaveLength(1)
    releaseBefore()
    expect(remove.mock.calls.filter((c) => (c[0] as string) === 'blur')).toHaveLength(1)
    expect(docRemove.mock.calls.filter((c) => (c[0] as string) === 'visibilitychange')).toHaveLength(1)
    // Letting go again, or a blur after the release, does nothing.
    const e = previewEpoch()
    releaseBefore()
    window.dispatchEvent(new Event('blur'))
    expect(previewEpoch()).toBe(e)
    add.mockRestore()
    remove.mockRestore()
    docAdd.mockRestore()
    docRemove.mockRestore()
  })
})

describe('the project changing under a hold', () => {
  it('ends the hold when a clip is deleted mid hold, so the badge never sits over the real picture', () => {
    seed()
    holdBefore()
    expect(isHoldingBefore()).toBe(true)
    updateActiveSequence('delete', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== 'a') })) }),
    )
    expect(isHoldingBefore()).toBe(false)
    expect(previewBeforeActive()).toBe(false)
    expect(effectsAt(1)).toBe(1)
  })

  it('ends the hold on an undo', () => {
    seed()
    holdBefore()
    useStore.getState().undo()
    expect(isHoldingBefore()).toBe(false)
    expect(previewBeforeActive()).toBe(false)
  })

  it('keeps the hold through anything that is not the project: the selection and the playhead', () => {
    seed()
    holdBefore()
    useStore.getState().setUI({ selection: ['b'] })
    useStore.getState().setUI({ playheadS: 2 })
    expect(isHoldingBefore()).toBe(true)
    expect(previewBeforeActive()).toBe(true)
  })

  it('stops watching the project once released, and never subscribes twice', () => {
    seed()
    // Count live store subscriptions: each subscribe adds one, each unsubscribe takes it away.
    const real = useStore.subscribe
    let live = 0
    const spy = vi.spyOn(useStore, 'subscribe').mockImplementation(((...a: unknown[]) => {
      live++
      const off = (real as (...x: unknown[]) => () => void).apply(useStore, a)
      return () => {
        live--
        off()
      }
    }) as never)
    holdBefore()
    holdBefore()
    expect(live).toBe(1)
    releaseBefore()
    expect(live).toBe(0)
    spy.mockRestore()
  })
})
