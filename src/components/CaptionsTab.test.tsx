/**
 * @vitest-environment jsdom
 *
 * The Captions list's search, with Replace all beside it (CA-17): a name the
 * model got wrong six times was six rows to retype, and the search already
 * found all six.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeSequence, newProject } from '../engine/types'
import { CAPTION_TRACK_NAME, addCaptionsFromWords, captionsOn } from '../state/captionActions'
import { updateActiveSequence, useStore } from '../state/store'
import { useToasts } from '../state/toasts'
import { CaptionsTab } from './CaptionsTab'

const texts = (): string[] => captionsOn(activeSequence(useStore.getState().project)).map(({ clip }) => clip.title!.text)

beforeEach(() => {
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
  addCaptionsFromWords(
    ['bamban', 'is', 'back', 'and', 'bambans', 'too', 'bamban'].map((text, i) => ({ text, startS: i * 2, endS: i * 2 + 0.5 })),
  )
})
afterEach(() => cleanup())

describe('Replace all', () => {
  it('shows once he searches, counts whole words only, and replaces them in one undo step', () => {
    render(<CaptionsTab />)
    expect(screen.queryByTestId('captions-replace')).toBeNull()
    fireEvent.change(screen.getByTestId('captions-search'), { target: { value: 'bamban' } })
    const button = screen.getByTestId('captions-replace-all') as HTMLButtonElement
    // The search shows three ("bambans" too), the replace counts the two whole words.
    expect(screen.getByTestId('captions-count').textContent).toBe('3 of 7')
    expect(button.textContent).toBe('Replace all (2)')
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('captions-replace'), { target: { value: 'Bun Bun' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(texts().filter((t) => t === 'Bun Bun')).toHaveLength(2)
    expect(texts()).toContain('bambans')
    useStore.getState().undo()
    expect(texts().filter((t) => t === 'bamban')).toHaveLength(2)
  })

  it('leaves a locked Captions track alone, and tells him', () => {
    updateActiveSequence('lock', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => (t.name === CAPTION_TRACK_NAME ? { ...t, locked: true } : t)),
    }))
    render(<CaptionsTab />)
    fireEvent.change(screen.getByTestId('captions-search'), { target: { value: 'bamban' } })
    fireEvent.change(screen.getByTestId('captions-replace'), { target: { value: 'Bun Bun' } })
    fireEvent.click(screen.getByTestId('captions-replace-all'))
    expect(texts().filter((t) => t === 'bamban')).toHaveLength(2)
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain('Your Captions track is locked, so nothing was changed')
  })
})
