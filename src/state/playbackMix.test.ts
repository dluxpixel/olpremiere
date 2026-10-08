import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ⛔ AU-9. Mixing and editing while it plays, against the real Transport and the
// real store. Every mute, solo or fader move used to rebuild the whole sound,
// a click and 50 ms and more of nothing each time, and a clip edit was not heard
// at all until he stopped. The sound is stood in for: each graph it builds
// says whether it took a mix change live.
const h = vi.hoisted(() => ({ builds: 0, takesMix: true, mixes: 0, follows: [] as unknown[] }))
vi.mock('../engine/audio', () => ({
  ensureAudioContext: () => {
    throw new Error('no audio context in node')
  },
  SCHEDULE_LATENCY_S: 0.05,
  scheduleAudio: (_seq: unknown, _assets: unknown, _fromS: number, follow?: unknown) => {
    h.builds += 1
    h.follows.push(follow)
    return Promise.resolve(
      Object.assign(() => undefined, {
        setMix: () => {
          h.mixes += 1
          return h.takesMix
        },
      }),
    )
  },
  clipEmitsAudioOn: (kind: string, clip: { linkId?: string; ownAudioOff?: boolean }) =>
    kind === 'audio' || (clip.linkId === undefined && !clip.ownAudioOff),
}))
vi.mock('../engine/preview', () => ({ pauseAllPreviewVideos: () => {}, setPreviewTransportRate: () => {} }))
vi.mock('./voiceRecorder', () => ({
  isTakeInProgress: () => false,
  pauseRecording: () => {},
  resumeRecording: () => {},
  takeHeard: () => {},
}))
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show: () => {} }) } }))

const { CLIP_EDIT_SETTLE_MS, isPlaying, togglePlay } = await import('./playbackControl')
const { updateActiveSequence } = await import('./store')
const { makeClip, makeTrack } = await import('../components/timelineTestFixtures')

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  globalThis.requestAnimationFrame = (() => 1) as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => undefined) as unknown as typeof cancelAnimationFrame
  updateActiveSequence('An edit with sound', (seq) => ({
    ...seq,
    durationS: 20,
    tracks: [
      makeTrack({ id: 'V1', kind: 'video', clips: [makeClip({ id: 'v', linkId: 'L', outS: 20 })] }),
      makeTrack({ id: 'A1', kind: 'audio', clips: [makeClip({ id: 'a', linkId: 'L', outS: 20 })] }),
      makeTrack({ id: 'A2', kind: 'audio', clips: [makeClip({ id: 'm', assetId: 'm', outS: 20 })] }),
    ],
  }))
  h.builds = 0
  h.follows = []
  h.mixes = 0
  h.takesMix = true
  togglePlay()
  await settle()
  expect(isPlaying()).toBe(true)
  expect(h.builds).toBe(1)
})

afterEach(() => {
  vi.useRealTimers()
  if (isPlaying()) togglePlay()
})

const editTrack = (id: string, patch: object): void =>
  updateActiveSequence('edit', (seq) => ({ ...seq, tracks: seq.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
const editClip = (id: string, patch: object): void =>
  updateActiveSequence('edit', (seq) => ({
    ...seq,
    tracks: seq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  }))

describe('a mix change while it plays', () => {
  it('a fader, a mute or a solo moves the live sound, and nothing is rebuilt', () => {
    editTrack('A2', { volumeDb: -6 })
    editTrack('A2', { muted: true })
    editTrack('A1', { solo: true })
    expect(h.mixes).toBe(3)
    expect(h.builds).toBe(1)
  })

  it('a change the live sound cannot follow is rebuilt', async () => {
    h.takesMix = false
    editTrack('A2', { autoLevel: 'medium' })
    await settle()
    expect(h.builds).toBe(2)
  })
})

describe('a clip edit while it plays is heard', () => {
  it('a clip’s volume is rebuilt once he has stopped moving it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (const db of [-1, -2, -3, -4]) {
      editClip('a', { audioGainDb: db })
      await vi.advanceTimersByTimeAsync(CLIP_EDIT_SETTLE_MS / 2)
    }
    // Still moving: nothing rebuilt yet.
    expect(h.builds).toBe(1)
    await vi.advanceTimersByTimeAsync(CLIP_EDIT_SETTLE_MS)
    expect(h.builds).toBe(2)
    // And once only.
    await vi.advanceTimersByTimeAsync(CLIP_EDIT_SETTLE_MS * 5)
    expect(h.builds).toBe(2)
  })

  it('noise reduction, a trim or a fade is heard too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    editClip('m', { denoise: 0.5 })
    await vi.advanceTimersByTimeAsync(CLIP_EDIT_SETTLE_MS + 1)
    editClip('m', { outS: 12 })
    await vi.advanceTimersByTimeAsync(CLIP_EDIT_SETTLE_MS + 1)
    editClip('a', { fadeInS: 0.5 })
    await vi.advanceTimersByTimeAsync(CLIP_EDIT_SETTLE_MS + 1)
    expect(h.builds).toBe(4)
  })

  // ⛔ SF-1. The rebuild is handed where the picture is, so a slow one (a noise
  // pass, a long span read again) starts where he has got to, not back where
  // he made the edit.
  it('the rebuild after a clip edit is told where the picture is', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    editClip('a', { denoise: 1 })
    await vi.advanceTimersByTimeAsync(CLIP_EDIT_SETTLE_MS + 1)
    expect(h.builds).toBe(2)
    expect(h.follows[0]).toBeUndefined() // Play itself starts where it was asked to
    expect(h.follows[1]).toBeTypeOf('function')
  })

  it('a picture edit changes nothing he hears, and rebuilds nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    editClip('v', { opacity: 0.5 })
    editClip('v', { audioGainDb: -6 }) // a linked picture's own sound is not played
    await vi.advanceTimersByTimeAsync(CLIP_EDIT_SETTLE_MS * 3)
    expect(h.builds).toBe(1)
  })
})
