// Saved caption styles: save, update, rename, delete, the default every new
// caption uses, the move from the looks he saved before styles existed, the
// file beside his projects, and putting a style on captions that already exist.
//
// His ask, 2026-10-03: *"make it so I can somehow save caption styles,
// including caption length, how big it is, and stuff like that."*

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A real enough localStorage, in place before the store first reads it.
const mem = vi.hoisted(() => {
  const data = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size
    },
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = ls
  return { data }
})

const toasted: string[] = []
vi.mock('./toasts', () => ({
  useToasts: { getState: () => ({ show: (m: string) => void toasted.push(m) }) },
}))

import {
  AUTO_SHAPE,
  BUILTIN_CAPTION_STYLES,
  HOUSE_STYLE_ID,
  cleanShape,
  cleanStyle,
  type CaptionShape,
} from '../engine/captions/captionStyle'
import { jettismCaptionDef } from '../engine/captions/captions'
import { channelKeyframes } from '../engine/effects/channels'
import { clipEndS } from '../engine/timeline'
import { activeSequence, defaultTitleDef, newProject, newTitleClip, videoTracks, type Clip, type Sequence } from '../engine/types'
import { addCaptionsFromWords, applyCaptionStyle, CAPTION_TRACK_NAME, captionsOn, setCaptionText } from './captionActions'
import {
  LEGACY_DEFAULT_KEY,
  LEGACY_PRESETS_KEY,
  STYLES_KEY,
  captionStyleById,
  defaultCaptionStyle,
  deleteCaptionStyle,
  homeDecision,
  initCaptionStyles,
  migrateLegacyStyles,
  parseCaptionStyles,
  reloadCaptionStyles,
  renameCaptionStyle,
  saveCaptionStyleFromClip,
  saveNewCaptionStyle,
  setDefaultCaptionStyle,
  updateCaptionStyle,
  useCaptionStyles,
  type CaptionStyleDraft,
} from './captionStyles'
import { updateActiveSequence, useStore } from './store'

const seq = (): Sequence => activeSequence(useStore.getState().project)
const fixed = (over: Partial<CaptionShape> = {}): CaptionShape => cleanShape({ ...AUTO_SHAPE, length: 'fixed', ...over })

const draft = (over: Partial<CaptionStyleDraft> = {}): CaptionStyleDraft => ({
  name: 'Big three',
  look: { fontSizePx: 140, color: '#ffffff' },
  refHeight: 1920,
  shape: fixed({ maxWords: 3, charsPerLine: 30 }),
  emphasisColor: '#FFD400',
  ...over,
})

/** Words said back to back, a quarter second each, from `from`. */
const said = (text: string, from = 0) =>
  text.split(' ').map((t, i) => ({ text: t, startS: from + i * 0.25, endS: from + (i + 1) * 0.25 }))

const captionTexts = (): string[] => captionsOn(seq()).map(({ clip }) => clip.title!.text)

beforeEach(() => {
  mem.data.clear()
  reloadCaptionStyles()
  toasted.length = 0
  useStore.getState().setProject(newProject())
  useStore.getState().setUI({ selection: [], playheadS: 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('saving caption styles', () => {
  it('saves a style with its length and size, and it is still there after a restart', () => {
    const s = saveNewCaptionStyle(draft())
    expect(captionStyleById(s.id)).toMatchObject({ name: 'Big three', look: { fontSizePx: 140 }, shape: { length: 'fixed', maxWords: 3 } })

    reloadCaptionStyles() // what a fresh launch does
    expect(captionStyleById(s.id)).toMatchObject({ name: 'Big three', refHeight: 1920, shape: { maxWords: 3, charsPerLine: 30 } })
  })

  it('never gives two styles the same name', () => {
    saveNewCaptionStyle(draft())
    expect(saveNewCaptionStyle(draft()).name).toBe('Big three 2')
    expect(saveNewCaptionStyle(draft({ name: 'House style' })).name).toBe('House style 2')
  })

  it('updates and renames his own styles, and never a built in one', () => {
    const s = saveNewCaptionStyle(draft())
    updateCaptionStyle(s.id, { shape: fixed({ maxWords: 5 }) })
    expect(captionStyleById(s.id)!.shape.maxWords).toBe(5)
    renameCaptionStyle(s.id, 'Long ones')
    expect(captionStyleById(s.id)!.name).toBe('Long ones')
    expect(updateCaptionStyle(HOUSE_STYLE_ID, { look: { color: '#ff0000' } })).toBeNull()
    expect(captionStyleById(HOUSE_STYLE_ID)!.look).toEqual({})
  })

  it('deletes one, and new captions fall back to the house style when it was the default', () => {
    const s = saveNewCaptionStyle(draft())
    setDefaultCaptionStyle(s.id)
    expect(defaultCaptionStyle().id).toBe(s.id)
    expect(deleteCaptionStyle(s.id)).toBe(true)
    expect(captionStyleById(s.id)).toBeUndefined()
    expect(defaultCaptionStyle().id).toBe(HOUSE_STYLE_ID)
    expect(deleteCaptionStyle(HOUSE_STYLE_ID)).toBe(false)
  })

  it('remembers the default across a restart, and ignores one that does not exist', () => {
    const s = saveNewCaptionStyle(draft())
    setDefaultCaptionStyle(s.id)
    setDefaultCaptionStyle('nope')
    reloadCaptionStyles()
    expect(defaultCaptionStyle().id).toBe(s.id)
  })

  it('saves the look of a caption on the timeline and makes it the default', () => {
    const t = newTitleClip({ ...defaultTitleDef('hi'), fontSizePx: 150, color: '#00ff00' }, 0, 1)
    updateActiveSequence('seed', (sq) => ({ ...sq, tracks: sq.tracks.map((tr, i) => (i === 0 ? { ...tr, clips: [t] } : tr)) }))
    const s = saveCaptionStyleFromClip(t.id)!
    expect(defaultCaptionStyle().id).toBe(s.id)
    expect(s.look).toMatchObject({ fontSizePx: 150, color: '#00ff00' })
    expect(s.refHeight).toBe(seq().height)
    // A look picked off one caption says nothing about length: the default's stays.
    expect(s.shape).toEqual(AUTO_SHAPE)
  })
})

describe('what he saved before caption styles existed', () => {
  const legacy = [
    { id: 'tp-0-0', name: 'Style 1', style: { fontSizePx: 140, color: '#ff0000' }, appearance: { in: 'pop', durS: 0.15 } },
    { id: 'tp-1-1', name: 'Blue', style: { color: '#0000ff' } },
  ]

  it('comes across, ids and names and the default he picked, and the old keys are left alone', () => {
    mem.data.set(LEGACY_PRESETS_KEY, JSON.stringify(legacy))
    mem.data.set(LEGACY_DEFAULT_KEY, 'tp-1-1')
    reloadCaptionStyles()
    expect(useCaptionStyles.getState().saved.map((s) => [s.id, s.name])).toEqual([
      ['tp-0-0', 'Style 1'],
      ['tp-1-1', 'Blue'],
    ])
    expect(defaultCaptionStyle().id).toBe('tp-1-1')
    expect(mem.data.get(LEGACY_PRESETS_KEY)).toBe(JSON.stringify(legacy))
    // Written under the new key at once, so the move happens once.
    expect(parseCaptionStyles(mem.data.get(STYLES_KEY) ?? null)?.styles).toHaveLength(2)
  })

  it('maps the old built in picks onto the styles that replaced them', () => {
    expect(migrateLegacyStyles(null, '', 1).defaultId).toBe(HOUSE_STYLE_ID)
    expect(migrateLegacyStyles(null, 'builtin-jettism', 1).defaultId).toBe(HOUSE_STYLE_ID)
    expect(migrateLegacyStyles(null, 'builtin-yellow-pop', 1).defaultId).toBe('builtin-yellow-pop')
    expect(migrateLegacyStyles(null, 'gone', 1).defaultId).toBe(HOUSE_STYLE_ID)
    expect(migrateLegacyStyles('not json', null, 1).saved).toEqual([])
  })

  it('makes the same captions the old look made', () => {
    mem.data.set(LEGACY_PRESETS_KEY, JSON.stringify(legacy))
    mem.data.set(LEGACY_DEFAULT_KEY, 'tp-0-0')
    reloadCaptionStyles()
    addCaptionsFromWords([{ text: 'hello', startS: 0, endS: 0.5 }], { style: defaultCaptionStyle() })
    const [{ clip }] = captionsOn(seq())
    // The old run spread the preset over the house caption, absolute pixels and all.
    expect(clip.title).toEqual({ ...jettismCaptionDef('hello', seq().height), fontSizePx: 140, color: '#ff0000' })
    expect(clip.appearance?.in).toBe('pop')
  })
})

describe('the file beside his projects', () => {
  const snap = (styles: unknown[], savedAt: number, defaultId = HOUSE_STYLE_ID) =>
    parseCaptionStyles(JSON.stringify({ kind: 'ol-premiere-caption-styles', version: 1, savedAt, styles, defaultId }))
  const one = { ...draft(), id: 'cs-1', updatedAt: 1 }

  it('wins only when it holds his styles and was saved later', () => {
    const empty = { saved: [], defaultId: HOUSE_STYLE_ID, savedAt: 0 }
    expect(homeDecision(empty, snap([one], 10))).toBe('adopt-file')
    expect(homeDecision({ ...empty, saved: [one as never], savedAt: 20 }, snap([one], 10))).toBe('write-file')
    expect(homeDecision(empty, snap([], 10))).toBe('nothing')
    expect(homeDecision(empty, null)).toBe('nothing')
  })

  it('brings his styles back after the browser profile was wiped, and keeps the file current after', async () => {
    vi.useFakeTimers()
    const written: string[] = []
    vi.stubGlobal('window', {
      api: {
        captionStylesRead: async () => JSON.stringify({ kind: 'ol-premiere-caption-styles', version: 1, savedAt: 50, styles: [one], defaultId: 'cs-1' }),
        captionStylesWrite: async (json: string) => void written.push(json),
      },
    })
    await initCaptionStyles()
    expect(captionStyleById('cs-1')?.name).toBe('Big three')
    expect(defaultCaptionStyle().id).toBe('cs-1')
    expect(toasted).toContain('Your caption styles came back from their file')
    // The quick copy has it again too.
    expect(parseCaptionStyles(mem.data.get(STYLES_KEY) ?? null)?.styles.map((s) => s.id)).toEqual(['cs-1'])

    renameCaptionStyle('cs-1', 'Renamed')
    vi.advanceTimersByTime(400)
    expect(parseCaptionStyles(written.at(-1) ?? null)?.styles[0]?.name).toBe('Renamed')
  })
})

describe('new captions in a style', () => {
  it('cut at the style length and drawn at its size', () => {
    addCaptionsFromWords(said('so i went to the store'), { style: { ...draft(), id: 'x', updatedAt: 1 } })
    const texts = captionTexts()
    // House case puts the capital back on a lone "I".
    expect(texts).toEqual(['so I went', 'to the store'])
    const h = seq().height
    expect(captionsOn(seq())[0]!.clip.title!.fontSizePx).toBe(Math.round((140 * h) / 1920))
    // The track remembers what its captions were cut to.
    expect(videoTracks(seq()).find((t) => t.name === CAPTION_TRACK_NAME)!.captionShape).toMatchObject({ length: 'fixed', maxWords: 3 })
  })

  it('without a style, are the house captions every run has always made', () => {
    addCaptionsFromWords([{ text: 'TNT', startS: 0, endS: 0.4 }])
    const { clip } = captionsOn(seq())[0]!
    expect(clip.title).toEqual(jettismCaptionDef('TNT', seq().height))
    expect(clip.appearance).toBeUndefined()
  })

  it('sets a long caption on two balanced lines when the style asks for two', () => {
    const style = { ...draft({ shape: fixed({ maxWords: 8, charsPerLine: 12, lines: 2 }) }), id: 'x', updatedAt: 1 }
    addCaptionsFromWords(said('so i went to the store'), { style })
    expect(captionTexts()).toEqual(['so I went\nto the store'])
  })

  it('keeps the highlight on the word it picked, in the style highlight colour', () => {
    const style = { ...draft({ look: { color: '#ffffff' }, emphasisColor: '#ff00ff', shape: AUTO_SHAPE }), id: 'x', updatedAt: 1 }
    addCaptionsFromWords(
      [
        { text: 'this', startS: 0, endS: 0.3 },
        { text: 'is', startS: 0.6, endS: 0.9 },
        { text: 'huge', startS: 1.2, endS: 1.6, emphasis: true },
      ],
      { style },
    )
    const huge = captionsOn(seq()).find(({ clip }) => clip.title!.text === 'huge')!.clip
    expect(huge.title!.color).toBe('#ff00ff')
    expect(huge.captionEmphasis).toBe(true)
    expect(captionsOn(seq()).find(({ clip }) => clip.title!.text === 'this')!.clip.title!.color).toBe('#ffffff')
  })
})

// ⛔ CA-8. "As spoken" only switched off the draw time case, and every run had
// already written its words lowercase with the full stops gone, so "As
// spoken" looked exactly like lowercase and Subtitles lost its full stops.
describe('a style that writes captions as spoken', () => {
  const house = BUILTIN_CAPTION_STYLES[0]!
  const spokenStyle = { ...house, id: 'sp', name: 'Spoken', builtin: false, caseRule: 'spoken' as const }
  const steve = [
    { text: 'Steve', startS: 0, endS: 0.4 },
    { text: 'hit', startS: 0.4, endS: 0.7 },
    { text: 'Minecraft.', startS: 0.7, endS: 1.2 },
  ]

  it('keeps his capitals and full stops', () => {
    addCaptionsFromWords(steve, { style: spokenStyle, model: 'm' })
    expect(captionTexts().join(' ')).toBe('Steve hit Minecraft.')
  })

  it('still writes a lone i as I, and a thousands comma his way', () => {
    addCaptionsFromWords(
      [
        { text: 'i', startS: 0, endS: 0.3 },
        { text: 'made', startS: 1, endS: 1.3 },
        { text: '30,000.', startS: 2, endS: 2.5 },
      ],
      { style: spokenStyle },
    )
    expect(captionTexts()).toEqual(['I', 'made', '30 000.'])
  })

  it('the house style is untouched: lowercase, full stops gone', () => {
    addCaptionsFromWords(steve, { style: house })
    expect(captionTexts().join(' ')).toBe('steve hit minecraft')
  })

  it('put on house captions, writes the ones he has not touched as spoken, and keeps his edits', () => {
    addCaptionsFromWords(steve, { style: house, model: 'm' })
    const hit = captionsOn(seq()).find(({ clip }) => clip.title!.text.includes('hit'))!.clip
    setCaptionText(hit.id, 'smacked')
    applyCaptionStyle(spokenStyle)
    const texts = captionTexts()
    expect(texts).toContain('smacked')
    expect(texts.join(' ')).toContain('Minecraft.')
    expect(texts.join(' ')).toContain('Steve')
  })

  it('is kept when saved, and a style without it reads as house', () => {
    expect(cleanStyle({ ...spokenStyle })?.caseRule).toBe('spoken')
    expect(cleanStyle({ ...house, caseRule: 'shout' })?.caseRule).toBeUndefined()
  })
})

describe('putting a style on captions he already has', () => {
  const house = BUILTIN_CAPTION_STYLES[0]!

  it('changes only the look, in one undo step, when the length is the same', () => {
    addCaptionsFromWords(said('so i went to the store'), { style: house })
    const before = captionsOn(seq()).map(({ clip }) => [clip.id, clip.startS])
    const big = { ...house, id: 'big', name: 'Big', look: { fontSizePx: 160 }, refHeight: seq().height }
    const r = applyCaptionStyle(big)
    expect(r).toMatchObject({ recut: false, locked: 0 })
    expect(captionsOn(seq()).map(({ clip }) => [clip.id, clip.startS])).toEqual(before)
    expect(captionsOn(seq()).every(({ clip }) => clip.title!.fontSizePx === 160)).toBe(true)
    useStore.getState().undo()
    expect(captionsOn(seq()).every(({ clip }) => clip.title!.fontSizePx !== 160)).toBe(true)
  })

  it('cuts them again when the length is different, keeping what he typed, in one undo step', () => {
    addCaptionsFromWords(said('so i went to the store'), { style: house })
    const first = captionsOn(seq())[0]!.clip
    setCaptionText(first.id, first.title!.text.replace('so', 'So'))
    const count = captionsOn(seq()).length
    const r = applyCaptionStyle({ ...draft(), id: 'b3', updatedAt: 1 })
    expect(r.recut).toBe(true)
    expect(captionTexts()).toEqual(['So I went', 'to the store'])
    expect(videoTracks(seq()).find((t) => t.name === CAPTION_TRACK_NAME)!.captionShape).toMatchObject({ maxWords: 3 })
    useStore.getState().undo()
    expect(captionsOn(seq())).toHaveLength(count)
    expect(captionTexts()[0]!.startsWith('So')).toBe(true)
  })

  it('cuts only the selected ones, and never runs them into a caption that stays', () => {
    addCaptionsFromWords(said('so i went to the store and bought some apples'), { style: house })
    const all = captionsOn(seq()).map(({ clip }) => clip)
    const picked = all.slice(0, 3).map((c) => c.id)
    applyCaptionStyle({ ...draft({ shape: fixed({ maxWords: 12, charsPerLine: 60 }) }), id: 'b', updatedAt: 1 }, picked)
    const clips = captionsOn(seq()).map(({ clip }) => clip)
    for (let i = 1; i < clips.length; i++) expect(clips[i]!.startS).toBeGreaterThanOrEqual(clipEndS(clips[i - 1]!) - 1e-9)
    expect(clips.slice(1).map((c) => c.id)).toEqual(all.slice(3).map((c) => c.id))
    // What was selected is what replaced the selection.
    expect(useStore.getState().ui.selection).toEqual([clips[0]!.id])
  })

  // CA-19. A recut caption that ran into one that stays was trimmed without its
  // animation, so its exit sat past its new end and never played.
  it('a recut caption trimmed against one that stays still plays its exit at its new end', () => {
    addCaptionsFromWords(said('so i went to the store and bought some apples'), { style: house })
    const all = captionsOn(seq()).map(({ clip }) => clip)
    const clean = BUILTIN_CAPTION_STYLES.find((s) => s.id === 'builtin-clean')!
    const fade = { ...clean, id: 'fade-long', name: 'Fade long', shape: fixed({ maxWords: 12, charsPerLine: 60 }), updatedAt: 1 }
    applyCaptionStyle(fade, all.slice(0, 3).map((c) => c.id))
    const [cut, next] = captionsOn(seq()).map(({ clip }) => clip)
    // It was trimmed: it ends exactly where the caption that stays begins.
    expect(clipEndS(cut!)).toBeCloseTo(next!.startS, 9)
    const opacity = channelKeyframes(cut!, 'opacity')
    expect(opacity.length).toBeGreaterThan(0)
    const last = opacity[opacity.length - 1]!
    expect(last.t).toBeCloseTo(clipEndS(cut!) - cut!.startS, 6)
    expect(last.value).toBe(0)
  })

  // ⛔ CA-7. A recut read the words back off the captions and spread a caption's
  // words by letter count, so a length round trip moved every word off his voice.
  it('another length and back puts every caption on the word again, not where its letters say', () => {
    const subtitles = BUILTIN_CAPTION_STYLES.find((s) => s.id === 'builtin-subtitles')!
    const spoken = [
      ['i', 0.0, 0.1], ['hit', 0.1, 0.25], ['a', 0.25, 0.32], ['new', 0.32, 0.5], ['personal', 0.5, 1.15],
      ['record', 1.15, 1.6], ['on', 1.6, 1.7], ['bench', 1.7, 2.2],
    ].map(([text, startS, endS]) => ({ text: text as string, startS: startS as number, endS: endS as number }))
    addCaptionsFromWords(spoken, { style: house })
    const first = captionsOn(seq()).map(({ clip }) => [clip.title!.text, +clip.startS.toFixed(4)])
    applyCaptionStyle(subtitles)
    applyCaptionStyle(house)
    expect(captionsOn(seq()).map(({ clip }) => [clip.title!.text, +clip.startS.toFixed(4)])).toEqual(first)
    // And again: no drift on a second trip either.
    applyCaptionStyle(subtitles)
    applyCaptionStyle(house)
    expect(captionsOn(seq()).map(({ clip }) => [clip.title!.text, +clip.startS.toFixed(4)])).toEqual(first)
  })

  it('a caption he retyped is spread as before, since its old word times are for other words', () => {
    const subtitles = BUILTIN_CAPTION_STYLES.find((s) => s.id === 'builtin-subtitles')!
    addCaptionsFromWords(said('so i went to the store'), { style: house })
    applyCaptionStyle(subtitles)
    const one = captionsOn(seq())[0]!.clip
    setCaptionText(one.id, 'we all went to a big shop')
    applyCaptionStyle(house)
    expect(captionTexts().join(' ')).toBe('we all went to a big shop')
  })

  it('leaves a locked Captions track alone and says how many', () => {
    addCaptionsFromWords(said('so i went'), { style: house })
    updateActiveSequence('lock', (sq) => ({ ...sq, tracks: sq.tracks.map((t) => (t.name === CAPTION_TRACK_NAME ? { ...t, locked: true } : t)) }))
    const r = applyCaptionStyle({ ...house, id: 'big', name: 'Big', look: { fontSizePx: 160 }, refHeight: 1080 })
    expect(r).toMatchObject({ styled: 0, locked: captionsOn(seq()).length })
  })

  it('edits one caption from the list in one undo step, and a locked one refuses', () => {
    addCaptionsFromWords(said('so i went'), { style: house })
    const c: Clip = captionsOn(seq())[0]!.clip
    expect(setCaptionText(c.id, '  Hey  ')).toBe(true)
    expect(captionTexts()[0]).toBe('Hey')
    useStore.getState().undo()
    expect(captionTexts()[0]).toBe(c.title!.text)
    expect(setCaptionText(c.id, '   ')).toBe(false)
    updateActiveSequence('lock', (sq) => ({ ...sq, tracks: sq.tracks.map((t) => (t.name === CAPTION_TRACK_NAME ? { ...t, locked: true } : t)) }))
    expect(setCaptionText(c.id, 'Nope')).toBe(false)
    expect(captionTexts()[0]).toBe(c.title!.text)
    expect(toasted).toContain('That caption is on a locked track')
  })
})

// CA-13. The Subtitles look with the highlight on came out in three around the
// lit word. The word is now coloured inside its phrase, and back and forth
// between lengths keeps it lit.
describe('the key word inside a whole phrase', () => {
  const house = BUILTIN_CAPTION_STYLES[0]!
  const subtitles = BUILTIN_CAPTION_STYLES.find((s) => s.id === 'builtin-subtitles')!
  const leaned = () => said('i hit a new personal record on bench').map((x) => (x.text === 'record' ? { ...x, emphasis: true } : x))
  const litOf = (c: Clip) => (c.title!.wordColors ?? []).map((l) => [l.word, l.color])

  it('a Subtitles run keeps the phrase in one caption and colours the word in it', () => {
    addCaptionsFromWords(leaned(), { style: subtitles })
    expect(captionTexts().map((t) => t.replace('\n', ' '))).toEqual(['I hit a new personal record on bench'])
    const one = captionsOn(seq())[0]!.clip
    expect(litOf(one)).toEqual([['record', subtitles.emphasisColor]])
    expect(one.title!.color).toBe('#ffffff')
  })

  it('house, then Subtitles, then house: the word is lit the whole way', () => {
    addCaptionsFromWords(leaned(), { style: house })
    expect(captionsOn(seq()).find(({ clip }) => clip.title!.text === 'record')!.clip.captionEmphasis).toBe(true)
    applyCaptionStyle(subtitles)
    expect(captionsOn(seq())).toHaveLength(1)
    expect(litOf(captionsOn(seq())[0]!.clip)).toEqual([['record', subtitles.emphasisColor]])
    applyCaptionStyle(house)
    const record = captionsOn(seq()).find(({ clip }) => clip.title!.text === 'record')!.clip
    expect(record.captionEmphasis).toBe(true)
    expect(record.title!.color).toBe(house.emphasisColor)
  })

  it('a new look on the same length colours the word in the new highlight', () => {
    addCaptionsFromWords(leaned(), { style: subtitles })
    applyCaptionStyle({ ...subtitles, id: 'mine', name: 'Mine', builtin: false, emphasisColor: '#00ff00' })
    expect(litOf(captionsOn(seq())[0]!.clip)).toEqual([['record', '#00ff00']])
  })
})
