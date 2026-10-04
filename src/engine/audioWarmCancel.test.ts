// Leaving an edit stops its sound from decoding ahead. The warm-up reads the
// seconds every audible clip plays, two at a time, so an edit tab going to sleep
// with forty clips still queued kept two decodes busy on a timeline nobody was
// looking at, while the tab he clicked waited behind them.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from './types'

const read: string[] = []
vi.mock('../state/persistence', () => ({
  // No bytes: each decode ends at once, which is all this needs to count them.
  getBlob: async (key: string) => {
    read.push(key)
    return null
  },
}))

const { cancelAudioWarm, prewarmAudio } = await import('./audio')

/** An edit with `n` voice clips on A1, each its own recording. */
function edit(n: number, take = 'take') {
  const p = newProject('mc night')
  const seq = activeSequence(p)
  const assets: Record<string, MediaAsset> = {}
  const clips: Clip[] = []
  for (let i = 0; i < n; i++) {
    const a: MediaAsset = { id: `${take}${i}`, name: `${take} ${i}.wav`, kind: 'audio', blobKey: `asset/${take}${i}`, durationS: 4, hasAudio: true, hasVideo: false }
    assets[a.id] = a
    clips.push(newClipFromAsset(a, i * 4))
  }
  const tracks = seq.tracks.map((t) => (t.kind === 'audio' && t.name === 'A1' ? { ...t, clips } : t))
  return { seq: { ...seq, tracks }, assets }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  read.length = 0
})

describe('the audio warm-up of an edit he has left', () => {
  it('starts nothing new once cancelled: only the two already running finish', async () => {
    const { seq, assets } = edit(6)
    prewarmAudio(seq, assets)
    // He clicks another tab while the first two are reading.
    cancelAudioWarm()
    await settle()
    expect(read).toEqual(['asset/take0', 'asset/take1'])
  })

  it('a warm-up started after the cancel runs in full, so the edit he lands on is not starved', async () => {
    cancelAudioWarm()
    const { seq, assets } = edit(4, 'fresh')
    prewarmAudio(seq, assets)
    await settle()
    expect(read).toHaveLength(4)
  })
})
