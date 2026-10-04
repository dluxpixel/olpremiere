/**
 * @vitest-environment jsdom
 *
 * Escape closes a dialog (2026-10-03): the newest open one only, never while a menu is open over
 * it, and a typing field lets go before the dialog does.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openEscapeLayers, useEscapeToClose } from './useEscapeToClose'

function Dialog({ id, onClose, active = true, children }: { id: string; onClose: () => void; active?: boolean; children?: React.ReactNode }) {
  useEscapeToClose(onClose, active)
  return <div role="dialog" data-testid={id}>{children}</div>
}

const press = (target: Element | Window = window) => fireEvent.keyDown(target, { key: 'Escape' })

afterEach(cleanup)

describe('useEscapeToClose', () => {
  it('closes the dialog that is open', () => {
    const onClose = vi.fn()
    render(<Dialog id="a" onClose={onClose} />)
    press()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('goes to the newest dialog only, so a prompt over Settings closes alone', () => {
    const settings = vi.fn()
    const prompt = vi.fn()
    render(
      <>
        <Dialog id="settings" onClose={settings} />
        <Dialog id="prompt" onClose={prompt} />
      </>,
    )
    press()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(settings).not.toHaveBeenCalled()
  })

  it('hands the key to the dialog underneath once the one above has gone', () => {
    const settings = vi.fn()
    const prompt = vi.fn()
    const { rerender } = render(
      <>
        <Dialog id="settings" onClose={settings} />
        <Dialog id="prompt" onClose={prompt} />
      </>,
    )
    rerender(<Dialog id="settings" onClose={settings} />)
    press()
    expect(settings).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a dialog that is not active, and nothing once it unmounts', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Dialog id="a" onClose={onClose} active={false} />)
    press()
    expect(onClose).not.toHaveBeenCalled()
    rerender(<Dialog id="a" onClose={onClose} />)
    expect(openEscapeLayers()).toBe(1)
    rerender(<div />)
    expect(openEscapeLayers()).toBe(0)
    press()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves the key to a menu that is open over the dialog', () => {
    const onClose = vi.fn()
    render(
      <>
        <Dialog id="a" onClose={onClose} />
        <div role="menu" data-esc-owner="" />
      </>,
    )
    press()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still sees the menu as open when it closes itself on the same press', () => {
    // The menu's own listener runs on this press and takes it off the page before the dialog's
    // listener gets its turn. The dialog must not read that as "no menu" and close as well.
    const onClose = vi.fn()
    render(<Dialog id="a" onClose={onClose} />)
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('data-esc-owner', '')
    document.body.appendChild(menu)
    const menuCloses = () => menu.remove()
    document.addEventListener('keydown', menuCloses, true)
    press(document.body)
    document.removeEventListener('keydown', menuCloses, true)
    expect(menu.isConnected).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    // And with the menu gone, the next press closes the dialog.
    press(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves the key to a field that handles it and stops it, the way a rename box does', () => {
    const onClose = vi.fn()
    render(
      <Dialog id="a" onClose={onClose}>
        <input data-testid="field" onKeyDown={(e) => e.stopPropagation()} />
      </Dialog>,
    )
    press(screen.getByTestId('field'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('is not put off by a key the global keymap has already preventDefaulted', () => {
    // The keymap preventDefaults Escape (it owns "deselect all") before any dialog's listener runs.
    const onClose = vi.fn()
    render(<Dialog id="a" onClose={onClose} />)
    const keymap = (e: KeyboardEvent) => e.preventDefault()
    document.addEventListener('keydown', keymap, true)
    press(document.body)
    document.removeEventListener('keydown', keymap, true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lets go of a text field first, and closes on the next press', () => {
    const onClose = vi.fn()
    render(
      <Dialog id="a" onClose={onClose}>
        <textarea data-testid="script" />
        <input data-testid="name" type="text" />
      </Dialog>,
    )
    const script = screen.getByTestId('script') as HTMLTextAreaElement
    script.focus()
    expect(document.activeElement).toBe(script)
    press(script)
    expect(document.activeElement).not.toBe(script)
    expect(onClose).not.toHaveBeenCalled()
    press()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not treat a checkbox or a range as a field being typed in', () => {
    const onClose = vi.fn()
    render(
      <Dialog id="a" onClose={onClose}>
        <input data-testid="box" type="checkbox" />
      </Dialog>,
    )
    const box = screen.getByTestId('box')
    box.focus()
    press(box)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores every other key', () => {
    const onClose = vi.fn()
    render(<Dialog id="a" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
