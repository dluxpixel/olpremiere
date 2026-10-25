/**
 * @vitest-environment jsdom
 *
 * The Captions list's search, with Replace all beside it (CA-17): a name the
 * model got wrong six times was six rows to retype, and the search already
 * found all six. And the two word pop switches of the Style section.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CaptionStyle } from '../engine/captions/captionStyle'
import { WORD_POP_COLOR, WORD_POP_SIZE } from '../engine/captions/wordPop'
import { activeSequence, newProject } from '../engine/types'
import { CAPTION_TRACK_NAME, addCaptionsFromWords, captionsOn } from '../state/captionActions'
import { reloadCaptionStyles, useCaptionStyles } from '../state/captionStyles'
import { answerNamePrompt, useNamePrompt } from '../state/namePrompt'
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

// The two word pop switches in the Style section. What the editor holds is only
// readable once it is saved, so each case saves the look as a new style and reads
// that: on is the lime colour and the 15 percent peak, off is null.
describe('the word pop switches in the Style section', () => {
  beforeEach(() => {
    reloadCaptionStyles()
    render(<CaptionsTab />)
    fireEvent.click(screen.getByTestId('captions-style-fold'))
  })
  afterEach(() => {
    answerNamePrompt(null)
    reloadCaptionStyles()
  })

  const box = (id: string): HTMLInputElement => screen.getByTestId(id) as HTMLInputElement

  /** Save the look being edited as a new style, answering the name question, and give back what was saved. */
  async function saveLook(name: string): Promise<CaptionStyle> {
    const before = useCaptionStyles.getState().saved.length
    fireEvent.click(screen.getByTestId('caption-style-save-new'))
    expect(useNamePrompt.getState().request?.title).toBe('Name this caption style')
    await act(async () => {
      answerNamePrompt(name)
      await Promise.resolve()
    })
    const saved = useCaptionStyles.getState().saved
    expect(saved).toHaveLength(before + 1)
    return saved[saved.length - 1]!
  }

  it('Light the word starts off, shows the lime colour well once on, and is null again once off', async () => {
    expect(box('caption-style-word-pop').checked).toBe(false)
    expect(screen.queryByTestId('caption-style-word-pop-color')).toBeNull()

    fireEvent.click(box('caption-style-word-pop'))
    expect(box('caption-style-word-pop').checked).toBe(true)
    expect(box('caption-style-word-pop-color').value.toLowerCase()).toBe(WORD_POP_COLOR.toLowerCase())
    // His colour is kept as he picks it.
    fireEvent.change(box('caption-style-word-pop-color'), { target: { value: '#112233' } })
    expect(box('caption-style-word-pop-color').value).toBe('#112233')
    const lit = await saveLook('Lit')
    expect(lit.look.wordPop).toEqual({ color: '#112233' })

    // The saved style is the one on show now, with the switch on and his colour in the well.
    expect(box('caption-style-word-pop').checked).toBe(true)
    expect(box('caption-style-word-pop-color').value).toBe('#112233')
    fireEvent.click(box('caption-style-word-pop'))
    expect(box('caption-style-word-pop').checked).toBe(false)
    expect(screen.queryByTestId('caption-style-word-pop-color')).toBeNull()
    const unlit = await saveLook('Unlit')
    expect(unlit.look.wordPop).toBeNull()
    // The size pop was never touched by it.
    expect(unlit.look.wordPopSize ?? null).toBeNull()
  })

  it('Light the word without touching the colour saves the lime default', async () => {
    fireEvent.click(box('caption-style-word-pop'))
    const lit = await saveLook('Lime')
    expect(lit.look.wordPop).toEqual({ color: WORD_POP_COLOR })
  })

  it('Pop the word starts off, goes on at 15 percent, and is null again once off', async () => {
    expect(box('caption-style-word-pop-size').checked).toBe(false)
    expect(screen.queryByTestId('caption-style-word-pop-size-value')).toBeNull()

    fireEvent.click(box('caption-style-word-pop-size'))
    expect(box('caption-style-word-pop-size').checked).toBe(true)
    expect(box('caption-style-word-pop-size-value').value).toBe(String(WORD_POP_SIZE))
    const popped = await saveLook('Popped')
    expect(popped.look.wordPopSize).toBe(WORD_POP_SIZE)
    expect(WORD_POP_SIZE).toBe(1.15)

    fireEvent.click(box('caption-style-word-pop-size'))
    expect(box('caption-style-word-pop-size').checked).toBe(false)
    expect(screen.queryByTestId('caption-style-word-pop-size-value')).toBeNull()
    const still = await saveLook('Still')
    expect(still.look.wordPopSize).toBeNull()
    // The colour was never touched by it.
    expect(still.look.wordPop ?? null).toBeNull()
  })

  it('the two work alone and together', async () => {
    fireEvent.click(box('caption-style-word-pop'))
    fireEvent.click(box('caption-style-word-pop-size'))
    const both = await saveLook('Both')
    expect(both.look.wordPop).toEqual({ color: WORD_POP_COLOR })
    expect(both.look.wordPopSize).toBe(WORD_POP_SIZE)
    // Colour off, size stays.
    fireEvent.click(box('caption-style-word-pop'))
    const sizeOnly = await saveLook('Size only')
    expect(sizeOnly.look.wordPop).toBeNull()
    expect(sizeOnly.look.wordPopSize).toBe(WORD_POP_SIZE)
  })
})
