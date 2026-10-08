// Captioning what he selected: every clip, in one pass and one undo step.
//
// His words, 2026-10-03: *"right-clicking and selecting multiple clips just
// says 'Caption this clip,' and it captions only one."* What is proven here is
// the plumbing from a selection to one caption track; the recogniser is stood
// in for through `captionEars`, the same seam the end to end suite uses.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mem = vi.hoisted(() => {
  const data = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  }
  return { data }
})

const toasted: string[] = []
/** The kind of each toast, beside its words: 'danger' is red, anything else is not. */
const toastKinds: (string | undefined)[] = []
/** The button on each toast, if it has one. */
const toastActions: ({ label: string; onClick: () => void } | undefined)[] = []
vi.mock('./toasts', () => ({
  useToasts: {
    getState: () => ({
      show: (m: string, kind?: string, action?: { label: string; onClick: () => void }) => {
        toasted.push(m)
        toastKinds.push(kind)
        toastActions.push(action)
      },
    }),
  },
}))

// His vocabulary is read from every saved project, which takes a while on his
// disk. A few milliseconds here, so a run that waits for it shows that it does.
const vocab = vi.hoisted(() => ({ next: null as import('../engine/captions/vocabulary').Vocabulary | null }))
vi.mock('./captionVocabulary', async () => {
  const { EMPTY_VOCABULARY } = await vi.importActual<typeof import('../engine/captions/vocabulary')>('../engine/captions/vocabulary')
  return { currentVocabulary: () => new Promise((r) => setTimeout(() => r(vocab.next ?? EMPTY_VOCABULARY), 5)) }
})

import { AUTO_SHAPE, BUILTIN_CAPTION_STYLES, cleanShape } from '../engine/captions/captionStyle'
import type { CaptionWord } from '../engine/captions/captions'
import { clipEndS } from '../engine/timeline'
import {
  activeSequence,
  newClipFromAsset,
  newProject,
  videoTracks,
  type Clip,
  type MediaAsset,
  type Sequence,
} from '../engine/types'
import { CAPTION_TRACK_NAME, captionsOn, setCaptionText } from './captionActions'
import {
  captionFromScript,
  captionJobProgress,
  captionLabel,
  captionTargets,
  captionTheseClips,
  captionTheVoiceover,
  uncaptionedTargets,
  uncaptionedVoiceoverClipIds,
  voiceoverClipIds,
  voiceoverLabel,
  voiceoverTrackId,
} from './captionRun'
import { reloadCaptionStyles, saveNewCaptionStyle, setDefaultCaptionStyle } from './captionStyles'
import { updateActiveSequence, useStore } from './store'
import { SCRIPT_NOT_HEARD, captionEars, scriptUnheardMessage, useTranscribe } from './transcribeActions'
import { wordsOnTimeline } from '../engine/transcriptCut'
import { clipsWithoutWords, listenForEveryClip } from './transcriptActions'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const asset = (id: string, kind: MediaAsset['kind'] = 'audio'): MediaAsset => ({
  id,
  name: id,
  kind,
  blobKey: 'b',
  durationS: 10,
  hasAudio: true,
  hasVideo: kind === 'video',
})

/** What each clip "says": three words, back to back, from where it sits. */
const heard: string[] = []
captionEars.wordsForClip = async (clip: Clip, _asset, opts = {}): Promise<CaptionWord[]> => {
  heard.push(clip.id)
  await Promise.resolve()
  const words = ['one', 'two', 'three'].map((t, i) => ({
    text: `${t}${clip.id.slice(-1)}`,
    startS: clip.startS + i * 0.25,
    endS: clip.startS + (i + 1) * 0.25,
  }))
  // The real door also hands over the words in the media's own seconds.
  opts.onSpoken?.(words.map((w) => ({ text: w.text, startS: clip.inS + w.startS - clip.startS, endS: clip.inS + w.endS - clip.startS })))
  return words
}

/** Three voice clips on A1, and a picture on V1 linked to the first. */
function seed(): { a: string; b: string; c: string; pic: string } {
  const s = useStore.getState()
  s.setProject({ ...s.project, assets: { a: asset('a'), b: asset('b'), c: asset('c'), v: asset('v', 'video') } })
  updateActiveSequence('seed', (sq) => {
    const v1 = sq.tracks.find((t) => t.kind === 'video')!.id
    const a1 = sq.tracks.find((t) => t.kind === 'audio')!.id
    const clip = (id: string, assetId: string, startS: number, linkId?: string): Clip => ({
      ...newClipFromAsset(asset(assetId), startS),
      id,
      outS: 1,
      ...(linkId ? { linkId } : {}),
    })
    return {
      ...sq,
      tracks: sq.tracks.map((t) =>
        t.id === a1
          ? { ...t, clips: [clip('clip-a', 'a', 0, 'L'), clip('clip-b', 'b', 3), clip('clip-c', 'c', 6)] }
          : t.id === v1
            ? { ...t, clips: [{ ...clip('pic-a', 'a', 0, 'L'), assetId: 'a' }] }
            : t,
      ),
    }
  })
  return { a: 'clip-a', b: 'clip-b', c: 'clip-c', pic: 'pic-a' }
}

beforeEach(() => {
  mem.data.clear()
  reloadCaptionStyles()
  heard.length = 0
  toasted.length = 0
  toastKinds.length = 0
  toastActions.length = 0
  vocab.next = null
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
  useTranscribe.setState({ status: 'idle', pct: null, downloading: false, cancel: null, queue: null })
})

describe('captioning a selection', () => {
  it('captions ALL the selected clips, onto one track, in one undo step', async () => {
    const { a, b, c } = seed()
    const before = videoTracks(seq()).length
    await captionTheseClips([a, b, c])
    expect(heard).toEqual([a, b, c])
    const captions = captionsOn(seq())
    // One caption from each clip's words, each inside its own clip.
    for (const [id, at] of [['a', 0], ['b', 3], ['c', 6]] as const) {
      const mine = captions.filter(({ clip }) => clip.title!.text.includes(id))
      expect(mine.length).toBeGreaterThan(0)
      expect(mine.every(({ clip }) => clip.startS >= at - 1e-9 && clipEndS(clip) <= at + 1 + 0.5)).toBe(true)
    }
    expect(videoTracks(seq()).filter((t) => t.name === CAPTION_TRACK_NAME)).toHaveLength(1)

    useStore.getState().undo()
    expect(videoTracks(seq())).toHaveLength(before)
    expect(captionsOn(seq())).toHaveLength(0)
  })

  it('says where it is while it works: clip 1 of 3, then 2, then 3', async () => {
    const { a, b, c } = seed()
    const seen: string[] = []
    const off = useTranscribe.subscribe((s) => {
      if (s.queue) seen.push(`${s.queue.index}/${s.queue.total}`)
    })
    await captionTheseClips([a, b, c])
    off()
    expect([...new Set(seen)]).toEqual(['1/3', '2/3', '3/3'])
    expect(useTranscribe.getState().status).toBe('idle')
  })

  it('counts a picture and its own sound as one take, and the label says so', () => {
    const { a, b, pic } = seed()
    expect(captionTargets([pic])).toEqual([a])
    expect(captionTargets([pic, a])).toEqual([a])
    expect(captionTargets([pic, a, b])).toEqual([a, b])
    expect(captionLabel(1)).toBe('Caption this clip')
    expect(captionLabel(3)).toBe('Caption 3 clips')
  })

  it('one clip goes through the single clip door, with no queue', async () => {
    const { b } = seed()
    const queues: unknown[] = []
    const off = useTranscribe.subscribe((s) => void queues.push(s.queue))
    await captionTheseClips([b])
    off()
    expect(heard).toEqual([b])
    expect(queues.every((q) => q === null)).toBe(true)
    expect(captionsOn(seq()).length).toBeGreaterThan(0)
  })

  it('a re-run of one clip replaces every old caption inside that clip, not just near its new words', async () => {
    // CA-1. The door used to pass no stretch, so the box around the NEW words
    // was the stretch, and an old caption late in the clip (a word this run did
    // not hear) survived beside the new ones.
    const { b } = seed()
    await captionTheseClips([b])
    const extra = { ...captionsOn(seq())[0]!.clip, id: 'old-edge', startS: 3.9, outS: 0.08 }
    updateActiveSequence('seed an old edge caption', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => (t.name === CAPTION_TRACK_NAME ? { ...t, clips: [...t.clips, extra] } : t)),
    }))
    await captionTheseClips([b])
    expect(captionsOn(seq()).some(({ clip }) => clip.id === 'old-edge')).toBe(false)
  })

  /** Run one caption pass with `during` done to the timeline while the clip is heard. */
  async function whileHeard(id: string, during: (c: Clip) => Clip): Promise<void> {
    const ears = captionEars.wordsForClip
    captionEars.wordsForClip = async (...args) => {
      const words = await ears(...args)
      updateActiveSequence('he edits while it listens', (sq) => ({
        ...sq,
        tracks: sq.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? during(c) : c)) })),
      }))
      return words
    }
    try {
      await captionTheseClips([id])
    } finally {
      captionEars.wordsForClip = ears
    }
  }

  it('one clip moved while it is heard is captioned where it is now (CA-16)', async () => {
    const { b } = seed()
    await whileHeard(b, (c) => ({ ...c, startS: c.startS + 2 }))
    const caps = captionsOn(seq())
    expect(caps.length).toBeGreaterThan(0)
    expect(caps[0]!.clip.startS).toBeCloseTo(5, 6)
    expect(caps.every(({ clip }) => clip.startS >= 5 - 1e-9)).toBe(true)
  })

  // CA-20. "No speech found in the clip" came up red, as if something broke.
  it('a clip nobody talks in says so, as information, not as a failure', async () => {
    const { b } = seed()
    const ears = captionEars.wordsForClip
    captionEars.wordsForClip = async () => []
    try {
      await captionTheseClips([b])
    } finally {
      captionEars.wordsForClip = ears
    }
    const i = toasted.indexOf('Nobody talks in this clip')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(toastKinds[i]).not.toBe('danger')
  })

  it('one clip trimmed while it is heard lays nothing, and says why', async () => {
    const { b } = seed()
    await whileHeard(b, (c) => ({ ...c, outS: 0.5 }))
    expect(captionsOn(seq())).toHaveLength(0)
    expect(toasted).toContain('That clip changed while it was being heard, so nothing was captioned')
  })

  it('uses the default caption style, length and all', async () => {
    const { a, b, c } = seed()
    const three = saveNewCaptionStyle({
      name: 'Three',
      look: { fontSizePx: 150 },
      refHeight: seq().height,
      shape: cleanShape({ ...AUTO_SHAPE, length: 'fixed', maxWords: 3, charsPerLine: 40 }),
      emphasisColor: '#FFD400',
    })
    setDefaultCaptionStyle(three.id)
    await captionTheseClips([a, b, c])
    expect(captionsOn(seq()).map(({ clip }) => clip.title!.text)).toEqual(['onea twoa threea', 'oneb twob threeb', 'onec twoc threec'])
    expect(captionsOn(seq()).every(({ clip }) => clip.title!.fontSizePx === 150)).toBe(true)
  })
})

// CA-5. A caption run never kept what it heard, so after "Caption every clip"
// the Words tab offered "Listen for words" on every clip and paid the model again.
describe('what a caption run heard', () => {
  const wordsOf = (clipId: string): string[] =>
    wordsOnTimeline(seq(), useStore.getState().project.assets)
      .find((r) => r.clip.id === clipId)!
      .words.map((w) => w.text)

  it('is kept on the media, so the Words tab needs no second listen, in the same undo step', async () => {
    const { a, b, c } = seed()
    await captionTheseClips([a, b, c])
    expect(wordsOf(a)).toEqual(['onea', 'twoa', 'threea'])
    expect(wordsOf(c)).toEqual(['onec', 'twoc', 'threec'])
    expect(clipsWithoutWords()).toEqual([])
    useStore.getState().undo()
    expect(captionsOn(seq())).toHaveLength(0)
    expect(wordsOf(a)).toEqual([])
  })

  it('one clip captioned keeps its words too, at the seconds it was heard', async () => {
    const { b } = seed()
    await captionTheseClips([b])
    const row = wordsOnTimeline(seq(), useStore.getState().project.assets).find((r) => r.clip.id === b)!
    expect(row.words.map((w) => w.atS)).toEqual([3, 3.25, 3.5])
  })

  it('"no captions yet" leaves out a clip that already has captions', async () => {
    const { a, b, c } = seed()
    await captionTheseClips([a])
    expect(uncaptionedTargets()).toEqual([b, c])
  })

  it('the Words tab listens to every clip with no words in one go, one undo step', async () => {
    const { a, b, c } = seed()
    expect(clipsWithoutWords()).toEqual([a, b, c])
    await listenForEveryClip()
    expect(heard).toEqual([a, b, c])
    expect(wordsOf(b)).toEqual(['oneb', 'twob', 'threeb'])
    expect(useTranscribe.getState().status).toBe('idle')
    useStore.getState().undo()
    expect(clipsWithoutWords()).toEqual([a, b, c])
  })
})

// CA-10. Every door read his vocabulary after its "already running" check and
// before it said it was busy, so for that whole read the pill was hidden, the
// buttons were live, and a second click started a second run.
describe('a second click while the first run gets going', () => {
  it('one clip: the job shows at once, and the second click starts nothing', async () => {
    const { b } = seed()
    const first = captionTheseClips([b])
    expect(useTranscribe.getState().status).not.toBe('idle')
    expect(useTranscribe.getState().cancel).not.toBeNull()
    const second = captionTheseClips([b])
    await Promise.all([first, second])
    expect(heard).toEqual([b])
    expect(toasted).toContain('A transcription is already running')
    expect(useTranscribe.getState().status).toBe('idle')
  })

  it('every clip: the same, so the clips are not all heard twice', async () => {
    const { a, b, c } = seed()
    const first = captionTheseClips([a, b, c])
    expect(useTranscribe.getState().status).not.toBe('idle')
    const second = captionTheseClips([a, b, c])
    await Promise.all([first, second])
    expect(heard).toEqual([a, b, c])
    expect(toasted).toContain('A transcription is already running')
  })

  it('the Words tab door too', async () => {
    const { a, b, c } = seed()
    const first = listenForEveryClip()
    expect(useTranscribe.getState().status).not.toBe('idle')
    const second = listenForEveryClip()
    await Promise.all([first, second])
    expect(heard).toEqual([a, b, c])
  })
})

// CA-11. His voiceover is several takes, each where he performed it, and the
// button captioned the one take under the playhead and stopped.
describe('"Caption the voiceover", with nothing selected', () => {
  /** Mark A1 as his voice line and put one more clip, not his voice, on A2. */
  function voiceLine(role: 'voice' | 'music' = 'voice'): void {
    const s = useStore.getState()
    s.setProject({ ...s.project, assets: { ...s.project.assets, d: asset('d') } })
    updateActiveSequence('mark the voice line', (sq) => {
      const [a1, a2] = sq.tracks.filter((t) => t.kind === 'audio')
      return {
        ...sq,
        tracks: sq.tracks.map((t) =>
          t.id === a1!.id
            ? { ...t, audioRole: role }
            : t.id === a2!.id
              ? { ...t, clips: [{ ...newClipFromAsset(asset('d'), 9), id: 'other-d', outS: 1 }] }
              : t,
        ),
      }
    })
  }

  it('captions every take on the voiceover line, in one pass and one undo step', async () => {
    const { a, b, c } = seed()
    voiceLine()
    const before = videoTracks(seq()).length
    expect(voiceoverClipIds()).toEqual([a, b, c])
    await captionTheVoiceover()
    expect(heard).toEqual([a, b, c])
    expect(videoTracks(seq()).filter((t) => t.name === CAPTION_TRACK_NAME)).toHaveLength(1)
    useStore.getState().undo()
    expect(videoTracks(seq())).toHaveLength(before)
  })

  // ⛔ R-3. His way (2026-08-24) is to caption the takes one by one and fix
  // each. The big button, pressed for the next take, heard every take again and
  // replaced the ones he had already fixed: deleted captions back, merges undone.
  const texts = () => captionsOn(seq()).map(({ clip }) => clip.title!.text)
  const inTake = (startS: number) => () =>
    captionsOn(seq())
      .map(({ clip }) => clip)
      .filter((cl) => cl.startS >= startS - 1e-9 && cl.startS < startS + 1 - 1e-9)

  it('captions only the takes with no captions, and leaves the one he fixed exactly as it is', async () => {
    const { a, b, c } = seed()
    voiceLine()
    await captionTheseClips([a])
    const first = captionsOn(seq())[0]!.clip
    setCaptionText(first.id, 'my own fix')
    const takeA = inTake(0)()
    heard.length = 0
    expect(uncaptionedVoiceoverClipIds()).toEqual([b, c])
    await captionTheVoiceover()
    expect(heard).toEqual([b, c])
    expect(inTake(0)()).toEqual(takeA)
    expect(inTake(3)().length).toBeGreaterThan(0)
    expect(inTake(6)().length).toBeGreaterThan(0)
    // One undo step back to just his fixed take.
    useStore.getState().undo()
    expect(captionsOn(seq()).map(({ clip }) => clip)).toEqual(takeA)
  })

  it('with every take captioned it hears nothing and asks first, offering to redo them all', async () => {
    const { a, b, c } = seed()
    voiceLine()
    await captionTheVoiceover()
    const fixed = captionsOn(seq())[0]!.clip
    setCaptionText(fixed.id, 'my own fix')
    const before = texts()
    heard.length = 0
    toastActions.length = 0
    expect(uncaptionedVoiceoverClipIds()).toEqual([])
    await captionTheVoiceover()
    expect(heard).toEqual([])
    expect(texts()).toEqual(before)
    const redo = toastActions.find((x) => x?.label === 'Redo all 3')
    expect(redo).toBeDefined()
    redo!.onClick()
    await vi.waitFor(() => expect(heard).toEqual([a, b, c]))
    await vi.waitFor(() => expect(useTranscribe.getState().status).toBe('idle'))
    expect(texts()).not.toContain('my own fix')
  })

  it('a take whose caption starts a hair before it is still a take with captions', async () => {
    const { a, b, c } = seed()
    voiceLine()
    await captionTheseClips([b])
    const first = captionsOn(seq())[0]!.clip
    expect(first.startS).toBeGreaterThanOrEqual(3 - 1e-9)
    // A one line take, its caption's start a frame or two before the take it
    // belongs to (a word snapped onto a frame, a recut moved off a neighbour).
    const others = new Set(captionsOn(seq()).map(({ clip }) => clip.id))
    others.delete(first.id)
    updateActiveSequence('nudge', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((cl) => !others.has(cl.id)).map((cl) => (cl.id === first.id ? { ...cl, startS: 2.95 } : cl)),
      })),
    }))
    expect(captionsOn(seq())).toHaveLength(1)
    expect(uncaptionedVoiceoverClipIds()).toEqual([a, c])
  })

  it('"Redo all 3" redoes the takes it counted, wherever the playhead has gone since', async () => {
    const { a, b, c } = seed()
    voiceLine()
    // A second voice line, its one take at 9 s, for the playhead to wander onto.
    updateActiveSequence('second voice line', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => (t.kind === 'audio' && t.clips.some((cl) => cl.id === 'other-d') ? { ...t, audioRole: 'voice' } : t)),
    }))
    await captionTheVoiceover()
    heard.length = 0
    toastActions.length = 0
    await captionTheVoiceover()
    const redo = toastActions.find((x) => x?.label === 'Redo all 3')
    expect(redo).toBeDefined()
    useStore.getState().setUI({ playheadS: 9.5 })
    expect(voiceoverClipIds()).toEqual(['other-d'])
    redo!.onClick()
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(useTranscribe.getState().status).toBe('idle'))
    expect(heard).toEqual([a, b, c])
  })

  it('the button says which takes it will hear', () => {
    expect(voiceoverLabel(1, 1)).toBe('Caption the voiceover')
    expect(voiceoverLabel(4, 4)).toBe('Caption the voiceover (4 clips)')
    expect(voiceoverLabel(4, 3)).toBe('Caption the 3 voiceover takes with no captions')
    expect(voiceoverLabel(4, 1)).toBe('Caption the 1 voiceover take with no captions')
    expect(voiceoverLabel(4, 0)).toBe('Re-caption the voiceover (4 clips)')
    expect(voiceoverLabel(1, 0)).toBe('Re-caption the voiceover')
  })

  it('the label follows the playhead onto another voice track', () => {
    const { a } = seed()
    voiceLine()
    // A second voice line, its one take at 9 s.
    updateActiveSequence('second voice line', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => (t.kind === 'audio' && t.clips.some((cl) => cl.id === 'other-d') ? { ...t, audioRole: 'voice' } : t)),
    }))
    const at = (playheadS: number) => voiceoverTrackId({ ...useStore.getState(), ui: { ...useStore.getState().ui, playheadS } })
    const trackOf = (id: string) => seq().tracks.find((t) => t.clips.some((cl) => cl.id === id))!.id
    expect(at(0.5)).toBe(trackOf(a))
    expect(at(9.5)).toBe(trackOf('other-d'))
  })

  it('an unmarked timeline: the takes on the line of the first clip with sound', async () => {
    const { a, b, c } = seed()
    await captionTheVoiceover()
    expect(heard).toEqual([a, b, c])
  })

  it('a music bed picked as the last resort is still the one clip it was', () => {
    const { a } = seed()
    voiceLine('music')
    // The only other line holds a clip that is not music, so that is the voiceover.
    expect(voiceoverClipIds()).toEqual(['other-d'])
    updateActiveSequence('only music', (sq) => ({
      ...sq,
      tracks: sq.tracks.map((t) => (t.kind === 'audio' && t.audioRole !== 'music' ? { ...t, clips: [] } : t)),
    }))
    expect(voiceoverClipIds()).toEqual([a])
  })
})

// CA-18. The "Spell N more your way" button was fed only by the style learning,
// which reads a project only when he archives it, so it never showed.
describe('a spelling he has fixed once', () => {
  const said = (): string => captionsOn(seq()).map(({ clip }) => clip.title!.text).join(' ')
  const offer = () => toastActions.find((a) => a?.label === 'Spell 1 more your way')

  it('is offered after the run, never put in unasked, and goes in on his say so in one undo step', async () => {
    const { b } = seed()
    vocab.next = { rewrites: [], candidates: [{ heard: ['twob'], his: 'two bee', seen: 1 }] }
    await captionTheseClips([b])
    expect(said()).toContain('twob')
    expect(offer()).toBeDefined()
    offer()!.onClick()
    expect(said()).toContain('two bee')
    expect(said()).not.toContain('twob')
    expect(toasted).toContain('1 spelled your way')
    useStore.getState().undo()
    expect(said()).toContain('twob')
  })

  it('is offered by the sweep too', async () => {
    const { a, b, c } = seed()
    vocab.next = { rewrites: [], candidates: [{ heard: ['threec'], his: 'three see', seen: 1 }] }
    await captionTheseClips([a, b, c])
    expect(offer()).toBeDefined()
  })

  it('leaves a caption he has retyped since alone', async () => {
    const { b } = seed()
    vocab.next = { rewrites: [], candidates: [{ heard: ['twob'], his: 'two bee', seen: 1 }] }
    await captionTheseClips([b])
    const mine = captionsOn(seq()).find(({ clip }) => clip.title!.text.includes('twob'))!.clip
    setCaptionText(mine.id, 'my own words')
    offer()!.onClick()
    expect(said()).toContain('my own words')
    expect(said()).not.toContain('two bee')
    expect(toasted).toContain('Nothing left to change')
  })

  it('offers nothing when no caption holds one', async () => {
    const { b } = seed()
    vocab.next = { rewrites: [], candidates: [{ heard: ['nowhere'], his: 'somewhere', seen: 1 }] }
    await captionTheseClips([b])
    expect(toastActions.filter(Boolean)).toEqual([])
  })
})

// CA-6. His Shorts are scripted, and the names the model never heard were the
// biggest group of his fixes. His script is laid down in his words, timed by
// what the clips were heard to say.
describe('captions from his own script', () => {
  const said = (): string[] => captionsOn(seq()).map(({ clip }) => clip.title!.text)
  const spoken = { ...BUILTIN_CAPTION_STYLES[0]!, caseRule: 'spoken' as const }

  it('lays his words at the heard times, his spelling and capitals, in one undo step', async () => {
    const { b } = seed()
    useStore.getState().setUI({ selection: [b] })
    const before = videoTracks(seq()).length
    // The model heard "twob" where he wrote "Two B".
    await captionFromScript('Oneb Two B threeb.', spoken)
    expect(heard).toEqual([b])
    expect(said().join(' ')).toBe('Oneb Two B threeb.')
    // Each word on screen when it was heard: "Two B" over the one word "twob".
    const at = captionsOn(seq()).flatMap(({ clip }) => (clip.captionWords ?? []).map((w) => [w.text, clip.startS + w.startS] as const))
    expect(at.map(([t]) => t)).toEqual(['Oneb', 'Two', 'B', 'threeb.'])
    expect(at[1]![1]).toBeCloseTo(3.25, 6)
    expect(at[3]![1]).toBeCloseTo(3.5, 6)
    // His words, not the machine's: nothing for his vocabulary to learn from.
    expect(captionsOn(seq()).every(({ clip }) => !clip.captionOrigin)).toBe(true)
    useStore.getState().undo()
    expect(videoTracks(seq())).toHaveLength(before)
  })

  it('with nothing selected it times the voiceover, and keeps the captions of every take the script is not about', async () => {
    const { a, b, c } = seed()
    await captionTheseClips([a, b, c])
    heard.length = 0
    useStore.getState().setUI({ selection: [] })
    await captionFromScript('oneb two b threeb')
    expect(heard).toEqual([a, b, c])
    const text = said().join(' ')
    expect(text).toContain('onea')
    expect(text).toContain('threec')
    expect(text).toContain('two b')
    expect(text).not.toContain('twob')
  })

  it('a script nobody said there lays nothing, and says so', async () => {
    const { b } = seed()
    useStore.getState().setUI({ selection: [b] })
    await captionFromScript('completely different words')
    expect(captionsOn(seq())).toHaveLength(0)
    expect(toasted).toContain(SCRIPT_NOT_HEARD)
  })

  it('is null when there is nothing to listen to, so the window can say so', () => {
    expect(captionFromScript('so it goes')).toBeNull()
    expect(heard).toEqual([])
  })

  // ⛔ R-2. Select one clip and paste the whole Short's script, the natural
  // thing to do: the lines for the other clips were laid 0.12 s a word either
  // side of it, over clips this run never heard.
  it('a whole script with one clip selected leaves every other caption exactly as it was', async () => {
    const { a, b, c } = seed()
    await captionTheseClips([a, b, c])
    const others = () => captionsOn(seq()).map(({ clip }) => clip).filter((cl) => cl.startS < 3 || cl.startS >= 4)
    const before = others()
    heard.length = 0
    useStore.getState().setUI({ selection: [b] })
    await captionFromScript('Onea twoa threea, the first one.\nOneb Two B threeb.\nOnec twoc threec, the last one.', spoken)
    expect(heard).toEqual([b])
    expect(said().join(' ')).toContain('Two B')
    expect(others()).toEqual(before)
    // Nothing of his script was laid outside the clip it was heard in.
    const fromScript = captionsOn(seq()).filter(({ clip }) => clip.startS >= 3 && clip.startS < 4)
    expect(fromScript.every(({ clip }) => clipEndS(clip) <= 4 + 1e-9)).toBe(true)
    expect(toasted).toContain('2 lines of your script were not heard there, so they have no captions')
  })

  it('a line cut from the end of the edit is not laid past it, and the sequence does not grow', async () => {
    const laid = () => ({
      durationS: seq().durationS,
      captions: captionsOn(seq()).map(({ clip }) => [clip.title!.text, clip.startS, clipEndS(clip)]),
    })
    // The same clip with only the lines he kept: what the edit really says.
    useStore.getState().setUI({ selection: [seed().c] })
    await captionFromScript('Onec twoc threec.', spoken)
    const kept = laid()
    useStore.getState().setProject(newProject())
    useStore.getState().setUI({ selection: [seed().c] })
    await captionFromScript('Onec twoc threec.\nAnd that was the whole video.', spoken)
    expect(said().join(' ')).toBe('Onec twoc threec.')
    expect(laid()).toEqual(kept)
    expect(toasted).toContain('1 line of your script was not heard there, so it has no captions')
  })

  it('says nothing more when every word of the script was heard', async () => {
    const { b } = seed()
    useStore.getState().setUI({ selection: [b] })
    await captionFromScript('Oneb Two B threeb.', spoken)
    expect(toasted.filter((t) => t.includes('not heard'))).toEqual([])
  })

  // ⛔ S-1. A word of the script could land in a take it was not said in, and
  // that take's captions were replaced by it. Nothing is said in two takes here
  // but the script, so what each clip says is stood in for by clip.
  const takes = (says: Record<string, string>) => {
    const real = captionEars.wordsForClip
    captionEars.wordsForClip = async (clip: Clip, _asset, opts = {}): Promise<CaptionWord[]> => {
      await Promise.resolve()
      const words = (says[clip.id] ?? '')
        .split(' ')
        .filter(Boolean)
        .map((text, i) => ({ text, startS: clip.startS + i * 0.1, endS: clip.startS + (i + 1) * 0.1 }))
      opts.onSpoken?.(words.map((x) => ({ text: x.text, startS: clip.inS + x.startS - clip.startS, endS: clip.inS + x.endS - clip.startS })))
      return words
    }
    return () => void (captionEars.wordsForClip = real)
  }
  const inTake = (fromS: number) =>
    captionsOn(seq())
      .map(({ clip }) => clip)
      .filter((cl) => cl.startS >= fromS - 1e-9 && cl.startS < fromS + 1 - 1e-9)

  it('a whole script with an ad-libbed take after it leaves the ad-lib take exactly as it was', async () => {
    const { a, b } = seed()
    await captionTheseClips([a, b])
    const adLib = inTake(3)
    expect(adLib.length).toBeGreaterThan(0)
    const restore = takes({ [a]: 'alpha beta gamma', [b]: 'yeah alpha beta gamma man' })
    try {
      useStore.getState().setUI({ selection: [a, b] })
      await captionFromScript('Alpha beta gamma.', spoken)
    } finally {
      restore()
    }
    expect(inTake(3)).toEqual(adLib)
    expect(inTake(0).map((cl) => cl.title!.text).join(' ')).toBe('Alpha beta gamma.')
  })

  it('a take that has only one stray word of the script is not replaced, and the word is not laid in it', async () => {
    const { a, b } = seed()
    await captionTheseClips([a, b])
    const adLib = inTake(3)
    const restore = takes({ [a]: 'alpha beta gamma', [b]: 'so whatever yeah delta right now' })
    try {
      useStore.getState().setUI({ selection: [a, b] })
      await captionFromScript('Alpha beta gamma delta.', spoken)
    } finally {
      restore()
    }
    expect(inTake(3)).toEqual(adLib)
    expect(inTake(0).map((cl) => cl.title!.text).join(' ')).toBe('Alpha beta gamma')
    expect(toasted).toContain('1 word of your script was not heard there, so it has no captions')
  })

  it('words missed between two takes that do not touch are not laid across the gap between them', async () => {
    const { a, b } = seed()
    await captionTheseClips([a, b])
    const restore = takes({ [a]: 'alpha beta', [b]: 'zeta' })
    try {
      useStore.getState().setUI({ selection: [a, b] })
      await captionFromScript('Alpha beta gamma delta zeta.', spoken)
    } finally {
      restore()
    }
    // Take a is 0 to 1 s and take b is 3 to 4 s: nothing starts between them.
    const starts = captionsOn(seq()).map(({ clip }) => clip.startS)
    expect(starts.length).toBeGreaterThan(0)
    expect(starts.filter((t) => t >= 1 && t < 3 - 1e-9)).toEqual([])
    expect(inTake(0).map((cl) => cl.title!.text).join(' ')).toContain('gamma')
    expect(inTake(3).map((cl) => cl.title!.text).join(' ')).toBe('zeta.')
  })

  it('a short take that the script is about is still replaced, one word and all', async () => {
    const { a, b } = seed()
    await captionTheseClips([a, b])
    const restore = takes({ [a]: 'alpha beta gamma', [b]: 'delta' })
    try {
      useStore.getState().setUI({ selection: [a, b] })
      await captionFromScript('Alpha beta gamma Delta!', spoken)
    } finally {
      restore()
    }
    expect(inTake(3).map((cl) => cl.title!.text).join(' ')).toBe('Delta!')
  })
})

describe('what a script run says it left out', () => {
  it('counts lines, then words left out of lines it heard', () => {
    expect(scriptUnheardMessage(0, 0)).toBeNull()
    expect(scriptUnheardMessage(1, 0)).toBe('1 line of your script was not heard there, so it has no captions')
    expect(scriptUnheardMessage(3, 0)).toBe('3 lines of your script were not heard there, so they have no captions')
    expect(scriptUnheardMessage(0, 4)).toBe('4 words of your script were not heard there, so they have no captions')
    expect(scriptUnheardMessage(2, 1)).toBe('2 lines and 1 more word of your script were not heard there, so they have no captions')
  })
})

describe('the job progress', () => {
  it('moves one clip at a time and never runs past the clip it is on', () => {
    expect(captionJobProgress('reading', null, { index: 1, total: 4 })).toBeCloseTo(0.0125, 6)
    expect(captionJobProgress('listening', null, { index: 2, total: 4 })).toBeCloseTo(0.4, 6)
    expect(captionJobProgress('listening', null, { index: 4, total: 4 })!).toBeLessThan(1)
    expect(captionJobProgress('listening', null, null)).toBeNull()
    expect(captionJobProgress('model', 50, null)).toBeCloseTo(0.35, 6)
  })
})
