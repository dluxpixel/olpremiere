// @vitest-environment jsdom
//
// R held shows the picture without effects, and letting go (the key coming up, the window losing
// the focus, the keymap going away) puts them back. The wiring, not the view: compareHold.test.ts
// proves what the hold does to the preview.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAppBindings } from './App'
import { recomputeDuration } from './engine/timeline'
import { defaultTransform, newProject, type Clip } from './engine/types'
import { installKeymap } from './keymap'
import { isHoldingBefore, releaseBefore } from './state/compareHold'
import { updateActiveSequence, useStore } from './state/store'

vi.mock('./state/toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const clip: Clip = {
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
  effects: [{ id: 'fx', type: 'gaussianBlur', params: { blur: 8 }, enabled: true }],
}

const fire = (type: 'keydown' | 'keyup', key: string, code: string, repeat = false, target: EventTarget = window) =>
  target.dispatchEvent(new KeyboardEvent(type, { key, code, repeat, bubbles: true, cancelable: true }))

let uninstall = () => {}
beforeEach(() => {
  useStore.getState().setProject(newProject())
  updateActiveSequence('seed', (sq) => {
    const v = sq.tracks.find((t) => t.kind === 'video')!
    return recomputeDuration({ ...sq, tracks: sq.tracks.map((t) => (t.id === v.id ? { ...t, clips: [clip] } : t)) })
  })
  uninstall = installKeymap(buildAppBindings())
})
afterEach(() => {
  uninstall()
  releaseBefore()
})

describe('the R key', () => {
  it('is a binding that knows how to let go', () => {
    expect(buildAppBindings().find((x) => x.combo === 'r')?.onRelease).toBeTypeOf('function')
  })

  it('holds while down, survives key repeat, and lets go when the key comes up', () => {
    fire('keydown', 'r', 'KeyR')
    expect(isHoldingBefore()).toBe(true)
    fire('keydown', 'r', 'KeyR', true)
    fire('keydown', 'r', 'KeyR', true)
    expect(isHoldingBefore()).toBe(true)
    fire('keyup', 'r', 'KeyR')
    expect(isHoldingBefore()).toBe(false)
  })

  it('lets go when the keyup reports a capital letter', () => {
    fire('keydown', 'r', 'KeyR')
    fire('keyup', 'R', 'KeyR')
    expect(isHoldingBefore()).toBe(false)
  })

  it('lets go when the window loses the focus with the key still down', () => {
    fire('keydown', 'r', 'KeyR')
    window.dispatchEvent(new Event('blur'))
    expect(isHoldingBefore()).toBe(false)
  })

  it('lets go when the keymap goes away', () => {
    fire('keydown', 'r', 'KeyR')
    uninstall()
    expect(isHoldingBefore()).toBe(false)
  })

  it('is not ended by another key coming up', () => {
    fire('keydown', 'r', 'KeyR')
    fire('keyup', 'a', 'KeyA')
    expect(isHoldingBefore()).toBe(true)
  })

  it('is left alone in a text field, where R is a letter', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    fire('keydown', 'r', 'KeyR', false, input)
    expect(isHoldingBefore()).toBe(false)
    input.remove()
  })

  it('adds no undo step', () => {
    const n = useStore.getState().history.undo.length
    fire('keydown', 'r', 'KeyR')
    fire('keyup', 'r', 'KeyR')
    expect(useStore.getState().history.undo.length).toBe(n)
  })
})
