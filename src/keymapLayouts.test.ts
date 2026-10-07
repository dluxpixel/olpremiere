// @vitest-environment jsdom
//
// The shortcuts on a keyboard that types something else on those keys. The bindings are written
// as characters, and on a Czech keyboard the number row types `+ ě š č ř ž ý á í é`, `/` is
// Shift+ú, `[ ] \` need AltGr (Ctrl+Alt to the browser), and AltGr+C types `&`. None of those
// used to reach a binding. A US keyboard must work exactly as before.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { combosFromEvent, installKeymap, type Binding } from './keymap'

vi.mock('./state/usageNotes', () => ({ noteShortcut: () => {} }))

const ran: string[] = []
const bind = (combo: string): Binding => ({ combo, description: combo, domain: 'tools', run: () => ran.push(combo) })
let uninstall = () => {}

beforeEach(() => {
  ran.length = 0
  uninstall = installKeymap(['1', '2', '/', '[', ']', 'alt+[', '\\', '=', '-', 'mod+alt+c', 'shift++', 'space', 'shift+s'].map(bind))
})
afterEach(() => uninstall())

interface Press {
  key: string
  code: string
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
}

function press({ key, code, shift = false, ctrl = false, alt = false }: Press): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, shiftKey: shift, ctrlKey: ctrl, altKey: alt, bubbles: true, cancelable: true }),
  )
}

describe('a Czech keyboard', () => {
  it('runs the number keys whether or not Shift made the digit', () => {
    press({ key: '+', code: 'Digit1' })
    press({ key: '2', code: 'Digit2', shift: true })
    press({ key: 'ě', code: 'Digit2' })
    expect(ran).toEqual(['1', '2', '2'])
  })

  it('runs Loop on Shift+ú, which is where / is', () => {
    press({ key: '/', code: 'BracketLeft', shift: true })
    expect(ran).toEqual(['/'])
  })

  it('runs the keyframe jumps from AltGr and from the key where [ and ] sit on a US keyboard', () => {
    press({ key: '[', code: 'KeyF', ctrl: true, alt: true })
    press({ key: ']', code: 'KeyG', ctrl: true, alt: true })
    press({ key: '[', code: 'BracketLeft', ctrl: true, alt: true })
    press({ key: 'ú', code: 'BracketLeft' })
    press({ key: 'ú', code: 'BracketLeft', alt: true })
    expect(ran).toEqual(['[', ']', '[', '[', 'alt+['])
  })

  it('runs Zoom to fit from AltGr+Q and Copy attributes from Ctrl+Alt+C', () => {
    press({ key: '\\', code: 'KeyQ', ctrl: true, alt: true })
    press({ key: '&', code: 'KeyC', ctrl: true, alt: true })
    expect(ran).toEqual(['\\', 'mod+alt+c'])
  })

  it('zooms with the = and - it types, which sit on other keys than on a US keyboard', () => {
    press({ key: '=', code: 'Minus' })
    press({ key: '-', code: 'Slash' })
    expect(ran).toEqual(['=', '-'])
  })
})

describe('a US keyboard', () => {
  it('runs each key once, as before', () => {
    press({ key: '1', code: 'Digit1' })
    press({ key: '/', code: 'Slash' })
    press({ key: '[', code: 'BracketLeft' })
    press({ key: '+', code: 'Equal', shift: true })
    press({ key: 'S', code: 'KeyS', shift: true })
    press({ key: ' ', code: 'Space' })
    expect(ran).toEqual(['1', '/', '[', 'shift++', 'shift+s', 'space'])
  })

  it('leaves the keys that were never bound alone', () => {
    press({ key: '!', code: 'Digit1', shift: true })
    press({ key: '?', code: 'Slash', shift: true })
    press({ key: '{', code: 'BracketLeft', shift: true })
    press({ key: ' ', code: 'Space', shift: true })
    expect(ran).toEqual([])
  })
})

describe('combosFromEvent', () => {
  it('tries what was typed first', () => {
    const e = { key: '+', code: 'Digit1', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false } as KeyboardEvent
    expect(combosFromEvent(e)).toEqual(['+', '1'])
  })
})
