/**
 * @vitest-environment jsdom
 *
 * ⛔ THE FIRST TEST IN THIS REPO THAT RENDERS A COMPONENT, and the file it picked
 * is not an accident. The Add effect menu was built, failed four end to end runs
 * in four different places, and was REVERTED, because there was no way to ask
 * "does this popup open" without a 20 minute Playwright run.
 *
 * The bug was eight lines of event timing. Everything below runs in
 * milliseconds and would have caught it on the first try.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ applied: [] as { clipId: string; type: string }[] }))

vi.mock('../state/clipEdits', () => ({
  applyEffect: (clipId: string, type: string) => {
    hoisted.applied.push({ clipId, type })
  },
}))

import { AddEffectMenu } from './AddEffectMenu'

const open = async () => {
  const user = userEvent.setup()
  await user.click(screen.getByTestId('inspector-add-effect'))
  return user
}

beforeEach(() => {
  hoisted.applied.length = 0
  localStorage.clear()
})

// ⛔ Testing Library only unmounts by itself when vitest runs with globals on,
// and this repo does not. Without this every render piles up in the same body
// and the second test finds two buttons.
afterEach(cleanup)

// jsdom has no layout, so it has no scrollIntoView. Stubbed HERE rather than
// guarded in the component: the browser has the method, and shipping code should
// not carry a branch that only a test environment can take.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('AddEffectMenu', () => {
  it('shows a button and no menu until it is asked for', () => {
    render(<AddEffectMenu clipId="c1" />)
    expect(screen.getByTestId('inspector-add-effect')).toBeTruthy()
    expect(screen.queryByTestId('add-effect-menu')).toBeNull()
  })

  /**
   * ⛔ THE REGRESSION THAT COST A WHOLE BUILD. A document listener registered
   * inside the opening click still receives that click, because React handles at
   * the root and the document sits above it on the way up. The menu opened and
   * shut in the same gesture, which read as flakiness rather than as a bug.
   */
  it('stays open after the click that opened it', async () => {
    render(<AddEffectMenu clipId="c1" />)
    await open()
    expect(screen.getByTestId('add-effect-menu')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('add-effect-search'))
  })

  it('opens and closes ten times without missing one', async () => {
    render(<AddEffectMenu clipId="c1" />)
    const user = userEvent.setup()
    const button = screen.getByTestId('inspector-add-effect')
    for (let i = 0; i < 10; i++) {
      await user.click(button)
      expect(screen.queryByTestId('add-effect-menu'), `open ${i + 1}`).not.toBeNull()
      await user.click(button)
      expect(screen.queryByTestId('add-effect-menu'), `close ${i + 1}`).toBeNull()
    }
  })

  it('finds an effect by what it does rather than by its name', async () => {
    render(<AddEffectMenu clipId="c1" />)
    const user = await open()
    await user.type(screen.getByTestId('add-effect-search'), 'bloom')
    const rows = screen.getAllByTestId('add-effect-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute('data-type')).toBe('glow')

    await user.click(rows[0])
    expect(hoisted.applied).toEqual([{ clipId: 'c1', type: 'glow' }])
    expect(screen.queryByTestId('add-effect-menu')).toBeNull()
  })

  it('says so when nothing matches, instead of showing everything', async () => {
    render(<AddEffectMenu clipId="c1" />)
    const user = await open()
    await user.type(screen.getByTestId('add-effect-search'), 'zzzzzznotaneffect')
    expect(screen.queryAllByTestId('add-effect-row')).toHaveLength(0)
    expect(screen.getByText('Nothing matches that.')).toBeTruthy()
  })

  it('adds an effect from the keyboard alone', async () => {
    render(<AddEffectMenu clipId="c1" />)
    const user = await open()
    const wanted = screen.getAllByTestId('add-effect-row')[1].getAttribute('data-type')
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByTestId('add-effect-row')[1].getAttribute('data-highlighted')).toBe('true')
    await user.keyboard('{Enter}')
    expect(hoisted.applied).toEqual([{ clipId: 'c1', type: wanted }])
  })

  it('wraps the highlight round the ends rather than dying at them', async () => {
    render(<AddEffectMenu clipId="c1" />)
    const user = await open()
    const rows = () => screen.getAllByTestId('add-effect-row')
    const last = rows().length - 1
    await user.keyboard('{ArrowUp}')
    expect(rows()[last].getAttribute('data-highlighted')).toBe('true')
    await user.keyboard('{ArrowDown}')
    expect(rows()[0].getAttribute('data-highlighted')).toBe('true')
  })

  it('Escape closes it and adds nothing', async () => {
    render(<AddEffectMenu clipId="c1" />)
    const user = await open()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('add-effect-menu')).toBeNull()
    expect(hoisted.applied).toEqual([])
  })

  it('a click outside closes it and adds nothing', async () => {
    render(<AddEffectMenu clipId="c1" />)
    const user = await open()
    await user.click(screen.getByTestId('add-effect-backdrop'))
    expect(screen.queryByTestId('add-effect-menu')).toBeNull()
    expect(hoisted.applied).toEqual([])
  })

  it('opens with an empty box the next time, never the old query', async () => {
    render(<AddEffectMenu clipId="c1" />)
    const user = await open()
    await user.type(screen.getByTestId('add-effect-search'), 'bloom')
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('inspector-add-effect'))
    expect((screen.getByTestId('add-effect-search') as HTMLInputElement).value).toBe('')
  })
})
