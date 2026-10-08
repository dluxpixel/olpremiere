// @vitest-environment jsdom
//
// Ctrl+S while he is typing a caption. Before 2026-10-06 the keymap ignored
// every key inside a text field, so it saved nothing and said nothing, and the
// field had not even written his words to the project yet (fields write on blur).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installKeymap, type Binding } from './keymap'

vi.mock('./state/usageNotes', () => ({ noteShortcut: () => undefined }))

const steps: string[] = []

function field(): HTMLInputElement {
  const el = document.createElement('input')
  document.body.append(el)
  el.addEventListener('blur', () => steps.push(`committed "${el.value}"`))
  el.focus()
  return el
}

function press(target: EventTarget, key: string, ctrl = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, ctrlKey: ctrl, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

const bindings: Binding[] = [
  { combo: 'mod+s', description: 'Save project', domain: 'project', inFields: true, run: () => steps.push('saved') },
  { combo: 's', description: 'Snapping', domain: 'tools', run: () => steps.push('snapping') },
  { combo: 'backspace', description: 'Delete (lift)', domain: 'trim', run: () => steps.push('deleted the clip') },
]

afterEach(() => {
  steps.length = 0
  document.body.innerHTML = ''
})

describe('a shortcut pressed inside a text field', () => {
  it('Ctrl+S commits what he typed, then saves, and the browser does not get it', () => {
    const uninstall = installKeymap(bindings)
    const el = field()
    el.value = 'fixed caption'
    const e = press(el, 's', true)
    uninstall()
    expect(steps).toEqual(['committed "fixed caption"', 'saved'])
    expect(e.defaultPrevented).toBe(true)
  })

  it('Ctrl+S leaves him in the field, so the Backspace after it is his, not Delete clip', () => {
    // 2026-10-07: the commit used to blur the field, and every key after Ctrl+S
    // went to the editor: Backspace deleted the clip he was typing a title for.
    const uninstall = installKeymap(bindings)
    const el = field()
    el.value = 'Big new'
    press(el, 's', true)
    const after = document.activeElement
    press(after ?? document.body, 'Backspace')
    uninstall()
    expect(after).toBe(el)
    expect(steps).toEqual(['committed "Big new"', 'saved'])
  })

  it('a plain letter still types into the field', () => {
    const uninstall = installKeymap(bindings)
    const el = field()
    const e = press(el, 's')
    uninstall()
    expect(steps).toEqual([])
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(el)
  })

  it('outside a field the same keys work as before', () => {
    const uninstall = installKeymap(bindings)
    press(window, 's')
    press(window, 's', true)
    uninstall()
    expect(steps).toEqual(['snapping', 'saved'])
  })
})
