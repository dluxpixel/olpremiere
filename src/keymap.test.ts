// What is left of the keymap after 2026-08-17: the shape, the dispatch and the label.
//
// ⛔ THIS FILE USED TO TEST THE SEARCH AND THE GROUPING, and every one of those tests
// went with the code. The command palette and the shortcut sheet were cut on his word,
// they were the only readers of `searchBindings`, `groupBindings`, `fuzzyScore`,
// `dedupeBindings` and the two domain tables, and a test of deleted code is worse than
// no test because it reads as coverage. → D114
//
// What replaced them is coverage the file never had. `comboLabel` survived the cut with
// three callers, all of them tooltips, and **a tooltip is now the only way a shortcut
// reaches him**, so it is the one function here that is load bearing.

import { describe, expect, it } from 'vitest'
import { comboFromEvent, comboLabel } from './keymap'

const press = (key: string, mods: Partial<KeyboardEvent> = {}): string =>
  comboFromEvent({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods } as KeyboardEvent)

describe('comboFromEvent', () => {
  it('reads a bare key in lower case', () => {
    expect(press('P')).toBe('p')
    expect(press('p')).toBe('p')
  })

  it('names the space bar rather than passing a blank through', () => {
    expect(press(' ')).toBe('space')
  })

  it('orders the modifiers the way a binding is written', () => {
    expect(press('p', { ctrlKey: true, shiftKey: true, altKey: true })).toBe('mod+shift+alt+p')
  })
})

describe('comboLabel', () => {
  /**
   * The tooltip is the last surface that tells him a key exists, so this is the
   * sentence he actually reads. Off mac, where he works.
   */
  it('writes a combo the way a keyboard is labelled', () => {
    expect(comboLabel('mod+s')).toBe('Ctrl+S')
    expect(comboLabel('shift+alt+p')).toBe('Shift+Alt+P')
    expect(comboLabel('space')).toBe('Space')
  })

  it('capitalises a named key without shouting it', () => {
    expect(comboLabel('arrowleft')).toBe('Arrowleft')
    expect(comboLabel('alt+arrowright')).toBe('Alt+Arrowright')
  })
})
