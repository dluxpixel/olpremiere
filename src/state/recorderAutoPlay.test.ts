import { beforeEach, describe, expect, it, vi } from 'vitest'

// The option is stored INVERTED (a key present means OFF), because every install
// that already exists has no key at all. Storing it the usual way round would
// have read "no key" as "he turned it off" and shipped the feature dead for
// everyone who has ever opened the app.
const KEY = 'olpremiere:recorder:autoplay-off'

// The suite runs in node, which has no localStorage; the recorder is written to
// tolerate that, so persistence needs a real one to be tested at all.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

// 20s, not the 5s default. Each test's FIRST act is a cold dynamic import of
// voiceRecorder, which drags in the store, playback and the audio engine behind
// it. Alone that is instant; inside the full suite, with 70 files competing for
// the machine, it timed out at 5s. A gate that cries wolf is a gate people stop
// reading, and nothing here is measuring speed.
describe('the play-while-recording option survives a reload the right way round', { timeout: 20_000 }, () => {
  beforeEach(() => {
    store.clear()
  })

  it('is ON for an install that has never seen the option', async () => {
    const { useRecorder } = await import('./voiceRecorder')
    expect(store.has(KEY)).toBe(false)
    expect(useRecorder.getState().autoPlay).toBe(true)
  })

  it('writes a key only when he turns it OFF, and clears it when he turns it back on', async () => {
    const { setAutoPlay, useRecorder } = await import('./voiceRecorder')
    setAutoPlay(false)
    expect(store.get(KEY)).toBe('1')
    expect(useRecorder.getState().autoPlay).toBe(false)

    setAutoPlay(true)
    expect(store.has(KEY)).toBe(false)
    expect(useRecorder.getState().autoPlay).toBe(true)
  })
})
