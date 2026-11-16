/**
 * @vitest-environment jsdom
 *
 * The TikTok text mode switch in the monitor's Frame menu, beside the guides.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject } from '../engine/types'
import { FrameSettingsMenu, frameSettingsActive } from './FrameSettingsMenu'

afterEach(cleanup)

const seq = () => activeSequence(newProject())

function open(props: Partial<Parameters<typeof FrameSettingsMenu>[0]> = {}) {
  render(<FrameSettingsMenu seq={seq()} safeMargins={false} onSafeMargins={() => {}} {...props} />)
  fireEvent.click(screen.getByTestId('frame-settings-button'))
}

describe('TikTok text mode in the Frame menu', () => {
  it('has a labelled switch with its help line, off by default', () => {
    open({ onAppGuides: () => {}, onTiktokMode: () => {} })
    const toggle = screen.getByLabelText('TikTok text mode') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.getByText("TikTok style text, typed on the video, kept inside TikTok's safe area.")).toBeTruthy()
  })

  it('shows the state it is given and reports a click', () => {
    const onTiktokMode = vi.fn()
    open({ tiktokMode: true, onTiktokMode })
    const toggle = screen.getByTestId('tiktok-mode-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    expect(onTiktokMode).toHaveBeenCalledWith(false)
  })

  it('leaves the guides switch showing his own choice while the mode is on', () => {
    open({ appGuides: false, onAppGuides: () => {}, tiktokMode: true, onTiktokMode: () => {} })
    expect((screen.getByTestId('app-guides-toggle') as HTMLInputElement).checked).toBe(false)
  })

  it('is not there where the owner gave no handler', () => {
    open()
    expect(screen.queryByTestId('tiktok-mode-toggle')).toBeNull()
  })

  it('lights the Frame button while the mode is on, so it cannot hide in the drawer', () => {
    expect(frameSettingsActive(seq(), false, false, false)).toBe(false)
    expect(frameSettingsActive(seq(), false, false, true)).toBe(true)
  })
})
