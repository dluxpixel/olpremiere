/**
 * @vitest-environment jsdom
 *
 * The Library tab with his categories, rendered: the list with its counts, a
 * click that shows one category, the quick filter, naming a new category in
 * the dialog, the play button, and a card dropped on a category.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, audioTracks, newProject } from '../engine/types'

const hoisted = vi.hoisted(() => {
  const stores: Record<string, Map<string, unknown>> = {}
  const store = (name: string): Map<string, unknown> => (stores[name] ??= new Map())
  const objectStore = (name: string) => ({
    put: async (v: unknown, k: string) => {
      store(name).set(k, v)
    },
    delete: async (k: string) => {
      store(name).delete(k)
    },
  })
  const fakeDb = {
    getAll: async (name: string) => [...store(name).values()],
    get: async (name: string, k: string) => store(name).get(k),
    put: async (name: string, v: unknown, k: string) => {
      store(name).set(k, v)
    },
    delete: async (name: string, k: string) => {
      store(name).delete(k)
    },
    transaction: () => ({ objectStore, done: Promise.resolve() }),
  }
  const audio = { played: [] as string[], paused: 0 }
  return { stores, store, fakeDb, audio }
})

vi.mock('../state/persistence', () => ({
  db: async () => hoisted.fakeDb,
  getBlob: async (k: string) => (hoisted.store('blobs').get(k) as Blob | undefined) ?? null,
  putBlob: async (k: string, b: Blob) => {
    hoisted.store('blobs').set(k, b)
  },
}))
// jsdom has no object URLs; the preview only needs a URL string to hand over.
vi.mock('../state/blobUrls', () => ({
  useBlobUrl: () => null,
  getBlobUrl: async (k: string) => `blob:${k}`,
}))

import { useLibrary, type LibraryItem } from '../state/library'
import { ALL_VIEW, type LibraryCategory } from '../state/libraryCategories'
import { LIBRARY_MIME } from '../state/dnd'
import { useLibraryPreview } from '../state/libraryPreview'
import { useNamePrompt } from '../state/namePrompt'
import { useStore } from '../state/store'
import { NamePrompt } from '../ui/NamePrompt'
import { LibraryTab } from './LibraryTab'

class FakeAudio {
  src = ''
  currentTime = 0
  onended: (() => void) | null = null
  play(): Promise<void> {
    hoisted.audio.played.push(this.src)
    return Promise.resolve()
  }
  pause(): void {
    hoisted.audio.paused++
  }
}

const item = (id: string, name: string, kind: LibraryItem['kind'], categoryId?: string): LibraryItem => ({
  id,
  name,
  kind,
  blobKey: `lib/${id}`,
  durationS: 2,
  hasAudio: kind !== 'image',
  hasVideo: kind !== 'audio',
  addedAt: 1,
  ...(categoryId ? { categoryId } : {}),
})

const categories: LibraryCategory[] = [
  { id: 'mc', name: 'Minecraft', createdAt: 2 },
  { id: 'bc', name: 'Battle Cats', createdAt: 1 },
]

function seed(items: LibraryItem[], cats: LibraryCategory[] = categories): void {
  for (const i of items) {
    hoisted.store('library').set(i.id, i)
    hoisted.store('blobs').set(i.blobKey, new Blob(['x']))
  }
  useLibrary.setState({ items, presets: [], categories: cats, lastCategoryId: null, view: ALL_VIEW, loaded: true })
}

const rows = () => screen.getAllByTestId('library-category')
const row = (label: string) => rows().find((r) => r.textContent?.includes(label))!
/** The name line under each card's picture. */
const cardNames = () => screen.queryAllByTestId('library-card').map((c) => c.lastElementChild?.textContent)

beforeEach(() => {
  for (const k of Object.keys(hoisted.stores)) delete hoisted.stores[k]
  hoisted.audio.played.length = 0
  hoisted.audio.paused = 0
  vi.stubGlobal('Audio', FakeAudio)
  localStorage.clear()
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ playheadS: 0, selection: [] })
  useNamePrompt.setState({ request: null, resolve: null })
  useLibraryPreview.setState({ playingId: null })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the Library tab with categories', () => {
  it('lists All, Unsorted and his categories A to Z, each with its count', () => {
    seed([item('a', 'meow.wav', 'audio', 'bc'), item('b', 'hiss.wav', 'audio', 'bc'), item('c', 'intro.mp4', 'video')])
    render(<LibraryTab />)
    expect(rows().map((r) => r.textContent)).toEqual(['All3', 'Unsorted1', 'Battle Cats2', 'Minecraft0'])
    expect(screen.getAllByTestId('library-card')).toHaveLength(3)
  })

  it('shows only one category when he clicks it', async () => {
    seed([item('a', 'meow.wav', 'audio', 'bc'), item('c', 'intro.mp4', 'video')])
    render(<LibraryTab />)
    await userEvent.click(row('Battle Cats'))
    expect(row('Battle Cats').getAttribute('aria-pressed')).toBe('true')
    expect(cardNames()).toEqual(['meow.wav'])
    expect(screen.getByText('Media · Battle Cats')).toBeTruthy()
    await userEvent.click(row('Minecraft'))
    expect(cardNames()).toEqual([])
    expect(screen.getByTestId('library-view-empty').textContent).toMatch(/Nothing in Minecraft yet/)
  })

  it('narrows the cards with the quick filter', async () => {
    seed([item('a', 'meow.wav', 'audio', 'bc'), item('b', 'hiss.wav', 'audio'), item('c', 'intro.mp4', 'video')])
    render(<LibraryTab />)
    await userEvent.type(screen.getByTestId('library-filter'), 'wav')
    expect(cardNames()).toEqual(['meow.wav', 'hiss.wav'])
    await userEvent.clear(screen.getByTestId('library-filter'))
    await userEvent.type(screen.getByTestId('library-filter'), 'zzzz')
    expect(cardNames()).toEqual([])
    expect(screen.getByTestId('library-no-match')).toBeTruthy()
  })

  it('still says the Library is empty when nothing is saved, categories or not', () => {
    seed([], categories)
    render(<LibraryTab />)
    expect(screen.getByTestId('library-empty')).toBeTruthy()
  })

  it('names a new category in the dialog and shows it', async () => {
    seed([item('a', 'meow.wav', 'audio')], [])
    render(
      <>
        <LibraryTab />
        <NamePrompt />
      </>,
    )
    await userEvent.click(screen.getByTestId('library-new-category'))
    const dialog = await screen.findByTestId('name-prompt')
    await userEvent.type(within(dialog).getByTestId('name-prompt-input'), 'Battle Cats{Enter}')
    await vi.waitFor(() => expect(row('Battle Cats')).toBeTruthy())
    expect(screen.queryByTestId('name-prompt')).toBeNull()
    expect(row('Battle Cats').getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps the dialog open and says why when the name is taken', async () => {
    seed([], categories)
    render(
      <>
        <LibraryTab />
        <NamePrompt />
      </>,
    )
    await userEvent.click(screen.getByTestId('library-new-category'))
    await userEvent.type(await screen.findByTestId('name-prompt-input'), 'battle cats{Enter}')
    expect(screen.getByTestId('name-prompt')).toBeTruthy()
    expect(screen.getByTestId('name-prompt-problem').textContent).toBe('You already have Battle Cats')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('name-prompt')).toBeNull()
    expect(useLibrary.getState().categories).toHaveLength(2)
  })

  it('plays a saved sound on its play button, and stops it on a second click', async () => {
    seed([item('a', 'meow.wav', 'audio'), item('c', 'intro.mp4', 'video')])
    render(<LibraryTab />)
    const play = screen.getAllByTestId('library-preview')
    expect(play).toHaveLength(1) // sounds only
    await userEvent.click(play[0])
    await vi.waitFor(() => expect(hoisted.audio.played).toEqual(['blob:lib/a']))
    expect(screen.getByTestId('library-preview').getAttribute('aria-label')).toBe('Stop meow.wav')
    await userEvent.click(screen.getByTestId('library-preview'))
    expect(screen.getByTestId('library-preview').getAttribute('aria-label')).toBe('Play meow.wav')
    expect(hoisted.audio.paused).toBeGreaterThan(0)
  })

  it('puts a card on the timeline at the playhead with Enter', async () => {
    seed([item('a', 'meow.wav', 'audio')])
    useStore.getState().setUI({ playheadS: 2 })
    render(<LibraryTab />)
    screen.getByTestId('library-card').focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(audioTracks(activeSequence(useStore.getState().project))[0].clips.map((c) => c.startS)).toEqual([2]),
    )
  })

  it('files a card dropped on a category row', async () => {
    seed([item('a', 'meow.wav', 'audio')])
    render(<LibraryTab />)
    const target = row('Battle Cats')
    const dataTransfer = { types: [LIBRARY_MIME], getData: (k: string) => (k === LIBRARY_MIME ? 'a' : ''), dropEffect: 'none' }
    fireEvent.dragOver(target, { dataTransfer })
    await act(async () => {
      fireEvent.drop(target, { dataTransfer })
    })
    await vi.waitFor(() => expect(useLibrary.getState().items[0].categoryId).toBe('bc'))
    expect(row('Battle Cats').textContent).toBe('Battle Cats1')
    expect(row('Unsorted').textContent).toBe('Unsorted0')
  })

  it('never takes a drop on All, which is not a place to file things', () => {
    seed([item('a', 'meow.wav', 'audio', 'bc')])
    render(<LibraryTab />)
    const dataTransfer = { types: [LIBRARY_MIME], getData: () => 'a', dropEffect: 'none' }
    fireEvent.drop(row('All'), { dataTransfer })
    expect(useLibrary.getState().items[0].categoryId).toBe('bc')
    expect(useLibrary.getState().view).toBe(ALL_VIEW)
  })
})
