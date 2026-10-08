/**
 * @vitest-environment jsdom
 *
 * The Words and Captions tabs while he plays (CA-12, UI-8). Playback writes the
 * playhead to the store on every frame, and both tabs subscribed to it, so the
 * whole tab was drawn again on every frame, every word of the Words tab with it.
 * What is proven here is that a frame which does not move the word (or the
 * caption) under the playhead draws nothing, and that the mark still follows.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newClipFromAsset, newProject, type MediaAsset, type SpokenWord } from '../engine/types'
import { addCaptionsFromWords } from '../state/captionActions'
import { updateActiveSequence, useStore } from '../state/store'
import { useTranscribe } from '../state/transcribeActions'
import { CaptionsTab } from './CaptionsTab'
import { WordsTab } from './WordsTab'

const w = (text: string, startS: number, endS: number): SpokenWord => ({ text, startS, endS })
/** Two clips of the same talk, four words each, a second apart. */
const SAID = [w('one', 0.5, 0.9), w('two', 1.5, 1.9), w('three', 2.5, 2.9), w('four', 3.5, 3.9)]
const TALK: MediaAsset = {
  id: 'talk',
  name: 'talk.mp4',
  kind: 'audio',
  blobKey: 'b',
  durationS: 10,
  hasAudio: true,
  hasVideo: false,
  words: SAID,
  wordsOnVoice: true,
}

function seed(): void {
  const s = useStore.getState()
  s.setProject({ ...newProject(), assets: { talk: TALK } })
  updateActiveSequence('seed', (sq) => {
    const a1 = sq.tracks.find((t) => t.kind === 'audio')!.id
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === a1
          ? {
              ...t,
              clips: [
                { ...newClipFromAsset(TALK, 0), id: 'first', inS: 0, outS: 4 },
                { ...newClipFromAsset(TALK, 5), id: 'second', inS: 0, outS: 4 },
              ],
            }
          : t,
      ),
    }
  })
}

/** Play: one store write per frame, each its own render pass, as the transport makes them. */
function play(fromS: number, frames: number, stepS: number): void {
  for (let i = 0; i < frames; i++) act(() => useStore.getState().setUI({ playheadS: fromS + i * stepS }))
}

/**
 * Mount, and let the tab's first redraw go by before counting: React commits a
 * freshly mounted store subscriber twice the first time it changes, whatever
 * it selects (the tab before this fix did too, measured), and that is not a
 * cost of playing. `warmS` is a moment that moves the mark once.
 */
function mounted(ui: ReactElement, warmS: number): { commits: () => number } {
  let commits = 0
  render(
    <Profiler id="tab" onRender={() => commits++}>
      {ui}
    </Profiler>,
  )
  play(warmS, 1, 0)
  commits = 0
  return { commits: () => commits }
}

beforeEach(() => {
  localStorage.clear()
  seed()
  useStore.getState().setUI({ selection: [], playheadS: 0, playing: false })
})
afterEach(() => {
  cleanup()
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null, clipId: null })
})

describe('the Words tab while he plays', () => {
  it('draws nothing on a frame that stays inside the same word', () => {
    const tab = mounted(<WordsTab />, 0.6)
    // Sixty frames inside "two" of the first clip (1.5 to 1.9 s).
    play(1.5, 60, 0.005)
    // One for the mark landing on "two", none for the other fifty nine.
    expect(tab.commits()).toBeLessThanOrEqual(1)
    const words = screen.getAllByTestId('word')
    expect(words[1]!.className).toContain('underline')
    expect(words.filter((el) => el.className.includes('underline'))).toHaveLength(1)
  })

  it('the mark still follows the playhead from word to word and clip to clip', () => {
    render(<WordsTab />)
    const marked = (): string[] =>
      screen
        .getAllByTestId('word')
        .filter((el) => el.className.includes('underline'))
        .map((el) => el.dataset.index!)
    play(0.6, 1, 0)
    expect(marked()).toEqual(['0'])
    play(2.6, 1, 0)
    expect(marked()).toEqual(['2'])
    // The second clip starts at 5 s: its "two" plays at 6.5 s.
    play(6.6, 1, 0)
    expect(marked()).toEqual(['5'])
    play(4.5, 1, 0)
    expect(marked()).toEqual([])
  })

  it('picking and Shift picking across clips still selects the run', () => {
    render(<WordsTab />)
    const words = (): HTMLElement[] => screen.getAllByTestId('word')
    fireEvent.mouseDown(words()[2]!)
    fireEvent.mouseUp(screen.getByTestId('words-tab'))
    fireEvent.mouseDown(words()[5]!, { shiftKey: true })
    expect(words().map((el) => el.dataset.selected === 'true')).toEqual([false, false, true, true, true, true, false, false])
    expect(screen.getByTestId('cut-words').textContent).toContain('Cut 4 words')
    // A pick puts the playhead on the word picked.
    expect(useStore.getState().ui.playheadS).toBeCloseTo(6.5, 6)
  })
})

describe('the Captions list while he plays', () => {
  it('draws nothing on a frame that stays inside the same caption', () => {
    addCaptionsFromWords([w('hello', 0, 0.5), w('there', 2, 2.5), w('friend', 4, 4.5)])
    const tab = mounted(<CaptionsTab />, 0.1)
    play(2.0, 60, 0.005)
    expect(tab.commits()).toBeLessThanOrEqual(1)
    const active = screen.getAllByTestId('caption-row').filter((el) => el.dataset.active === 'true')
    expect(active.map((el) => el.querySelector('input')!.value)).toEqual(['there'])
  })
})

describe('Remove unused in the Media tab', () => {
  it('counts the bin once per edit, not once per frame', async () => {
    const { unusedAssetCount } = await import('../state/mediaActions')
    let walks = 0
    const project = useStore.getState().project
    // Every count reads the sequences to see what is used.
    const watched = new Proxy(project, {
      get(target, key, receiver) {
        if (key === 'sequences') walks++
        return Reflect.get(target, key, receiver) as unknown
      },
    })
    for (let i = 0; i < 60; i++) expect(unusedAssetCount(watched)).toBe(0)
    expect(walks).toBe(1)
    // An edit is a new project document, and is counted again.
    const edited = { ...project, assets: { ...project.assets, spare: { ...TALK, id: 'spare' } } }
    expect(unusedAssetCount(edited)).toBe(1)
  })
})

// CA-20. During a caption run every clip in the Words tab read "Listening",
// for clips nobody was hearing.
describe('the Words tab while a clip is being heard', () => {
  it('says "Listening" on that clip only', () => {
    const quiet = { ...TALK, words: undefined, wordsOnVoice: undefined }
    useStore.getState().setProject({ ...useStore.getState().project, assets: { talk: quiet } })
    useTranscribe.setState({ status: 'listening', cancel: () => {}, clipId: 'second' })
    render(<WordsTab />)
    const buttons = screen.getAllByTestId('listen-for-words')
    expect(buttons.map((b) => b.textContent)).toEqual(['Listen for words', 'Listening'])
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })
})
