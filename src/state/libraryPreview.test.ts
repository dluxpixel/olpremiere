// The small play button on a Library card.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./blobUrls', () => ({ getBlobUrl: async () => 'blob:sound' }))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: vi.fn() }) } }))

const { setAudioOutputDevice } = await import('../engine/audio')
const { stopLibraryPreview, toggleLibraryPreview } = await import('./libraryPreview')

afterEach(async () => {
  stopLibraryPreview()
  await setAudioOutputDevice(null)
  vi.unstubAllGlobals()
})

describe('toggleLibraryPreview', () => {
  // ⛔ AU-19. Playback followed the output he picked; a Library sound played on
  // the system default.
  it('plays on the output he picked', async () => {
    const setSinkId = vi.fn(async () => {})
    const play = vi.fn(async () => {})
    vi.stubGlobal(
      'Audio',
      class {
        src = ''
        currentTime = 0
        onended: (() => void) | null = null
        setSinkId = setSinkId
        play = play
        pause = () => {}
      },
    )
    await setAudioOutputDevice('headphones')
    await toggleLibraryPreview({ id: 's1', name: 'whoosh.wav', blobKey: 'asset/s1' })
    expect(play).toHaveBeenCalled()
    expect(setSinkId).toHaveBeenCalledWith('headphones')
  })
})
