/**
 * @vitest-environment jsdom
 *
 * "Paste a script" takes his script as plain text (CA-6): it was refused
 * ("Could not read that") unless it was word timed JSON or an SRT, though his
 * Shorts are scripted and the script already spells every name the model gets
 * wrong. Plain text is now heard for the timing and laid down in his words.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// His vocabulary is read from every saved project; nothing saved here.
vi.mock('../state/captionVocabulary', async () => {
  const { EMPTY_VOCABULARY } = await vi.importActual<typeof import('../engine/captions/vocabulary')>('../engine/captions/vocabulary')
  return { currentVocabulary: () => Promise.resolve(EMPTY_VOCABULARY) }
})

import type { CaptionWord } from '../engine/captions/captions'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from '../engine/types'
import { captionsOn } from '../state/captionActions'
import { updateActiveSequence, useStore } from '../state/store'
import { captionEars, useTranscribe } from '../state/transcribeActions'
import { CaptionsDialog } from './CaptionsDialog'

const texts = (): string[] => captionsOn(activeSequence(useStore.getState().project)).map(({ clip }) => clip.title!.text)

/** The recogniser stand in: the clip says "the bamban wins", the way the model hears it. */
const heard: string[] = []
captionEars.wordsForClip = async (clip: Clip): Promise<CaptionWord[]> => {
  heard.push(clip.id)
  await Promise.resolve()
  return ['the', 'bamban', 'wins'].map((text, i) => ({ text, startS: clip.startS + i * 0.4, endS: clip.startS + (i + 1) * 0.4 }))
}

function voiceClip(): void {
  const a: MediaAsset = { id: 'a', name: 'vo', kind: 'audio', blobKey: 'b', durationS: 10, hasAudio: true, hasVideo: false }
  const s = useStore.getState()
  s.setProject({ ...s.project, assets: { a } })
  updateActiveSequence('seed', (sq) => {
    const a1 = sq.tracks.find((t) => t.kind === 'audio')!.id
    return { ...sq, tracks: sq.tracks.map((t) => (t.id === a1 ? { ...t, clips: [{ ...newClipFromAsset(a, 0), id: 'vo', outS: 2 }] } : t)) }
  })
}

function paste(text: string, onClose = vi.fn()): typeof onClose {
  render(<CaptionsDialog onClose={onClose} />)
  fireEvent.change(screen.getByTestId('captions-text'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('captions-apply'))
  return onClose
}

beforeEach(() => {
  localStorage.clear()
  heard.length = 0
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null, clipId: null })
})
afterEach(() => cleanup())

describe('Paste a script', () => {
  it('a plain script is heard for the timing and laid down in his words', async () => {
    voiceClip()
    const onClose = paste('The Bun Bun wins')
    expect(onClose).toHaveBeenCalled()
    await vi.waitFor(() => expect(texts().length).toBeGreaterThan(0))
    expect(heard).toEqual(['vo'])
    expect(texts().join(' ')).toBe('the bun bun wins')
  })

  it('with nothing to listen to, says so and keeps the window open', () => {
    const onClose = paste('The Bun Bun wins')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/nothing to listen to/i)).toBeTruthy()
    expect(heard).toEqual([])
  })

  it('a script that opens on a direction in square brackets is still a script', async () => {
    voiceClip()
    const onClose = paste('[HOOK] The Bun Bun wins')
    expect(onClose).toHaveBeenCalled()
    await vi.waitFor(() => expect(texts().length).toBeGreaterThan(0))
    expect(texts().join(' ')).toBe('the bun bun wins')
  })

  it('JSON or SRT that does not read is never captioned as a script', () => {
    voiceClip()
    const onClose = paste('[{"text":"so","startS":')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/could not read that/i)).toBeTruthy()
    expect(heard).toEqual([])
  })

  it('word timed JSON still keeps its own timings and hears nothing', () => {
    voiceClip()
    const onClose = paste('[{"text":"so","startS":0.1,"endS":0.4},{"text":"it","startS":0.4,"endS":0.7}]')
    expect(onClose).toHaveBeenCalled()
    expect(heard).toEqual([])
    expect(texts().join(' ')).toContain('so')
  })
})
