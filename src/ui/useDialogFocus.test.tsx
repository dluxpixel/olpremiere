/**
 * @vitest-environment jsdom
 *
 * A window takes the keyboard when it opens and gives it back when it closes (2026-10-06). Before
 * this no window took the focus at all, so the keys he pressed went to the edit behind it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDialogFocus } from './useDialogFocus'

function Box({ children }: { children?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useDialogFocus(box)
  return (
    <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" data-testid="box">
      {children}
    </div>
  )
}

function SelfFocusingField() {
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.focus(), [])
  return <input ref={field} data-testid="field" />
}

function opener(): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = 'open'
  document.body.append(b)
  b.focus()
  return b
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('useDialogFocus', () => {
  it('takes the focus off the button that opened it, and gives it back on close', () => {
    const b = opener()
    const { unmount } = render(<Box />)
    expect(document.activeElement).toBe(screen.getByTestId('box'))
    unmount()
    expect(document.activeElement).toBe(b)
  })

  it('leaves the focus on a field inside that took it itself', () => {
    opener()
    render(
      <Box>
        <SelfFocusingField />
      </Box>,
    )
    expect(document.activeElement).toBe(screen.getByTestId('field'))
  })

  it('does not pull the focus back if he moved it somewhere else on the way out', () => {
    opener()
    const other = document.createElement('input')
    document.body.append(other)
    const { unmount } = render(<Box />)
    other.focus()
    unmount()
    expect(document.activeElement).toBe(other)
  })

  it('the real Settings window takes the focus', async () => {
    const b = opener()
    const { SettingsDialog } = await import('../components/SettingsDialog')
    const { unmount } = render(<SettingsDialog onClose={() => {}} />)
    expect(screen.getByTestId('settings-dialog').contains(document.activeElement)).toBe(true)
    unmount()
    expect(document.activeElement).toBe(b)
  })

  // 2026-10-07: he opened "Paste a transcript" and pressed Ctrl+V at once. The focus was on the
  // window itself, not in its box, so nothing landed in the box.
  it('the Captions window puts the focus in its script box, and still gives it back on close', async () => {
    const b = opener()
    const { CaptionsDialog } = await import('../components/CaptionsDialog')
    const { unmount } = render(<CaptionsDialog initialMode="paste" onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByTestId('captions-text'))
    unmount()
    expect(document.activeElement).toBe(b)
  })
})
