// @vitest-environment jsdom
//
// Words he reads that were wrong, stale, technical or bad English (UI sweep, 2026-10-06): a
// Settings hint about a model the app no longer picks, "this engine", a collab tooltip written
// for a developer, "1 file ... have", "(s)", "(unsupported?)" and "Band tightness".

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shown: string[] = []
vi.mock('../state/toasts', () => ({
  useToasts: Object.assign(() => ({}), { getState: () => ({ show: (m: string) => shown.push(m) }) }),
}))

import { newProject, activeSequence, defaultTitleDef, newTitleClip } from '../engine/types'
import { recomputeDuration } from '../engine/timeline'
import { EFFECTS_HINT, missingMediaLine } from '../components/LeftPanel'
import { FrameSettingsMenu } from '../components/FrameSettingsMenu'
import { SettingsDialog } from '../components/SettingsDialog'
import { collabBadgeTitle } from '../components/TopBar'
import { copyClipAttributes, pasteClipAttributes } from '../state/attributes'
import { importFailureMessage } from '../state/mediaActions'
import { updateActiveSequence, useStore } from '../state/store'

const DASHES = /[\u2013\u2014]/

/** Every word on the element and in its tooltips. */
const wordsOf = (el: Element): string =>
  [el.textContent ?? '', ...Array.from(el.querySelectorAll('[title]'), (t) => t.getAttribute('title') ?? '')].join(' ')

beforeEach(() => {
  shown.length = 0
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})
afterEach(cleanup)

describe('Settings', () => {
  it('says what the language is for, and nothing about models or engines', () => {
    render(<SettingsDialog onClose={() => {}} />)
    const words = wordsOf(screen.getByTestId('settings-dialog'))
    expect(words).toMatch(/The language you speak in your videos/)
    expect(words).not.toMatch(/Whisper|multilingual|engine/i)
    expect(words).not.toMatch(DASHES)
  })
})

describe('the Frame menu', () => {
  it('calls the blurred background zoom what it is', async () => {
    updateActiveSequence('blur on', (sq) => ({ ...sq, blurBackground: true }))
    const seq = activeSequence(useStore.getState().project)
    render(<FrameSettingsMenu seq={seq} safeMargins={false} onSafeMargins={() => {}} />)
    await userEvent.click(screen.getByTestId('frame-settings-button'))
    const menu = screen.getByTestId('frame-settings-menu')
    expect(menu.textContent).toMatch(/Background zoom/)
    expect(menu.textContent).not.toMatch(/tightness/i)
  })
})

describe('the live room badge', () => {
  it('says who can join in his words', () => {
    const tabs = collabBadgeTitle('tabs', 'abc')
    const relay = collabBadgeTitle('relay', 'abc')
    expect(tabs).toBe('Live room abc: only other windows on this computer can join. Click to set your name.')
    expect(relay).toBe('Live room abc: anyone with the link edits with you. Click to set your name.')
    for (const t of [tabs, relay]) expect(t).not.toMatch(/THIS|deploy|cross-machine|\u00b7|[\u2013\u2014]/)
  })
})

describe('the left panel', () => {
  it('agrees with one file and with several', () => {
    expect(missingMediaLine(1)).toBe('1 file on this edit has no media. Your cuts are all still here.')
    expect(missingMediaLine(3)).toBe('3 files on this edit have no media. Your cuts are all still here.')
  })

  it('tells him an effect takes a double click, not a click', () => {
    expect(EFFECTS_HINT).toMatch(/^Double click/)
    expect(EFFECTS_HINT).not.toMatch(DASHES)
  })
})

describe('toasts', () => {
  it('say plainly that a file could not be imported, without a guess in brackets', () => {
    expect(importFailureMessage([])).toBeNull()
    const one = importFailureMessage(['notes.txt'])!
    const many = importFailureMessage(['a.txt', 'b.doc'])!
    expect(one).toBe('notes.txt could not be imported. The app cannot open this kind of file.')
    expect(many).toBe('2 files could not be imported. The app cannot open that kind of file.')
    for (const m of [one, many]) expect(m).not.toMatch(/\?\)|\(s\)|unsupported/)
  })

  it('ask for the clips to paste onto in proper English', () => {
    const clip = newTitleClip(defaultTitleDef('x'), 0, 5)
    updateActiveSequence('seed', (sq) =>
      recomputeDuration({ ...sq, tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [clip] } : t)) }),
    )
    copyClipAttributes(clip.id)
    shown.length = 0
    pasteClipAttributes([])
    expect(shown).toEqual(['Select the clips to paste onto first'])
  })
})
