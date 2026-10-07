/**
 * @vitest-environment jsdom
 *
 * Ctrl+S while he is typing in a field writes what he typed, saves, and leaves
 * him IN the field, through the app's real keymap.
 *
 * Before 2026-10-07 the save took the focus out of the field to get his words
 * into the project, so his next keys were shortcuts, not letters: Backspace
 * deleted the clip he was writing for, C cut it, Space played. A caption row was
 * also rebuilt under his caret once its words were written, so putting the focus
 * back afterwards would not have been enough.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: () => {} }) }),
}))
// Only the save Ctrl+S asks for is replaced, so the test can see it ran.
const saveSettled = vi.hoisted(() => vi.fn<(always?: boolean) => Promise<void>>(async () => undefined))
vi.mock('../state/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/persistence')>()),
  saveSettled,
}))

import { buildAppBindings } from '../App'
import { activeSequence, newProject } from '../engine/types'
import { installKeymap } from '../keymap'
import { addCaptionsFromWords, captionsOn } from '../state/captionActions'
import { useStore } from '../state/store'
import { CaptionsTab } from './CaptionsTab'
import { ScrubField, SPECS } from './EffectControls'
import { Inspector } from './Inspector'
import { installResizeObserver } from './timelineDomFixtures'
import { PlayheadTimecode } from './PlayheadWidgets'

/** Words said back to back, a quarter second each. */
const said = (text: string) =>
  text.split(' ').map((t, i) => ({ text: t, startS: i * 0.25, endS: (i + 1) * 0.25 }))
const captions = () => captionsOn(activeSequence(useStore.getState().project)).map(({ clip }) => clip)
/** The caption a row in the list is for. */
const captionOf = (row: HTMLElement) => captions().find((c) => c.id === row.closest<HTMLElement>('[data-id]')?.dataset.id)

let uninstall = (): void => undefined

beforeEach(() => {
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  saveSettled.mockClear()
  uninstall = installKeymap(buildAppBindings())
})

afterEach(() => {
  uninstall()
  cleanup()
  vi.unstubAllGlobals()
})

describe('Ctrl+S in a caption row', () => {
  it('writes his words and saves, and the Backspace after it is a letter, not Delete clip', async () => {
    addCaptionsFromWords(said('so i went'))
    const user = userEvent.setup()
    render(<CaptionsTab />)
    const row = screen.getAllByTestId('caption-row-text')[0] as HTMLInputElement
    const id = captionOf(row)!.id
    await user.click(row)
    // Clicking into the row selects its caption, which is what Delete would take.
    expect(useStore.getState().ui.selection).toEqual([id])
    const before = row.value
    await user.keyboard('{End} home')
    await user.keyboard('{Control>}s{/Control}')
    expect(saveSettled).toHaveBeenCalledTimes(1)
    expect(captionOf(row)!.title!.text).toBe(`${before} home`)
    // The same field, still under his caret: not rebuilt, not left.
    expect(row.isConnected).toBe(true)
    expect(document.activeElement).toBe(row)
    await user.keyboard('{Backspace}')
    expect(captions().map((c) => c.id)).toContain(id)
    expect(row.value).toBe(`${before} hom`)
    // Leaving the field writes the rest.
    await user.tab()
    expect(captions().find((c) => c.id === id)!.title!.text).toBe(`${before} hom`)
  })

  it('keeps the row he is typing in on screen when his words no longer match the search', async () => {
    addCaptionsFromWords(said('so i went'))
    const user = userEvent.setup()
    render(<CaptionsTab />)
    await user.type(screen.getByTestId('captions-search'), 'went')
    const row = screen.getAllByTestId('caption-row-text')[0] as HTMLInputElement
    const id = captionOf(row)!.id
    await user.click(row)
    await user.clear(row)
    await user.type(row, 'so i left')
    await user.keyboard('{Control>}s{/Control}')
    expect(captions().find((c) => c.id === id)!.title!.text).toBe('so i left')
    expect(row.isConnected).toBe(true)
    expect(document.activeElement).toBe(row)
    // Once he leaves it, the search hides it like any other caption that does not match.
    await user.tab()
    expect(screen.queryAllByTestId('caption-row-text')).toHaveLength(0)
  })
})

describe('the field is told it was left, once', () => {
  it('its onBlur runs once per Ctrl+S, and the caret never moves', async () => {
    const left = vi.fn()
    const user = userEvent.setup()
    render(<input data-testid="name" defaultValue="" onBlur={left} />)
    const field = screen.getByTestId('name')
    await user.click(field)
    await user.keyboard('ab{Control>}s{/Control}')
    expect(left).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(field)
  })
})

describe('Ctrl+S in a field that closes when it is left', () => {
  it('the clip start time in the Inspector moves the clip and stays open', async () => {
    addCaptionsFromWords(said('so i went'))
    const clip = captions()[0]!
    useStore.getState().setUI({ selection: [clip.id] })
    installResizeObserver()
    const user = userEvent.setup()
    render(<Inspector width={320} />)
    await user.click(screen.getByTestId('clip-start-timecode'))
    const input = screen.getByTestId('clip-start-timecode-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    await user.clear(input)
    await user.keyboard('00:00:05:00')
    await user.keyboard('{Control>}s{/Control}')
    expect(captions().find((c) => c.id === clip.id)!.startS).toBeCloseTo(5, 5)
    expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
    // Backspace is his, and the clip is still there.
    await user.keyboard('{Backspace}')
    expect(captions().map((c) => c.id)).toContain(clip.id)
  })

  it('a number field writes the number and stays open for more typing', async () => {
    const writes: number[] = []
    function Field() {
      const [v, setV] = useState(0.5)
      return (
        <ScrubField
          value={v}
          spec={SPECS.opacity}
          testId="opacity"
          ariaLabel="Opacity"
          onCommit={(n) => {
            writes.push(n)
            setV(n)
          }}
        />
      )
    }
    const user = userEvent.setup()
    render(<Field />)
    const field = screen.getByTestId('opacity') as HTMLInputElement
    // Tabbing in opens it for typing.
    await user.tab()
    expect(document.activeElement).toBe(field)
    await user.clear(field)
    await user.keyboard('0.25')
    await user.keyboard('{Control>}s{/Control}')
    expect(writes).toEqual([0.25])
    expect(document.activeElement).toBe(field)
    expect(field.readOnly).toBe(false)
    await user.keyboard('{Backspace}')
    expect(field.value).toBe('0.2')
    await user.tab()
    expect(writes).toEqual([0.25, 0.2])
  })

  it('the playhead time field jumps there and stays open', async () => {
    // Two seconds of captions, so there is somewhere to jump to.
    addCaptionsFromWords(said('one two three four five six seven eight'))
    const user = userEvent.setup()
    render(<PlayheadTimecode fps={30} testId="playhead" editable />)
    await user.click(screen.getByTestId('playhead'))
    const input = screen.getByTestId('playhead-input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    await user.clear(input)
    await user.keyboard('0:01.00')
    await user.keyboard('{Control>}s{/Control}')
    expect(useStore.getState().ui.playheadS).toBeCloseTo(1, 5)
    expect(input.isConnected).toBe(true)
    expect(document.activeElement).toBe(input)
  })
})
