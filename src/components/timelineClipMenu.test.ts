import { describe, expect, it } from 'vitest'
import { MOVES } from '../engine/moves'
import { defaultTitleDef, newTitleClip, type Clip, type Sequence } from '../engine/types'
import type { MenuItem } from '../state/contextMenu'
import { useLibrary } from '../state/library'
import { clipContextMenuItems, type ClipMenuContext } from './timelineClipMenu'
import { ASSETS, makeClip, makeSeq, makeTrack } from './timelineTestFixtures'

const labels = (items: MenuItem[]): string[] => items.map((i) => i.label)
const item = (items: MenuItem[], label: string): MenuItem => {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`no "${label}" in ${labels(items).join(', ')}`)
  return found
}

/** V1: [v 0-2][w 2-4], A1: [a 0-2][b 2-4], v and a linked. */
function fixture() {
  const v = makeClip({ startS: 0, outS: 2, linkId: 'L' })
  const w = makeClip({ startS: 2, inS: 2, outS: 4 })
  const a = makeClip({ startS: 0, outS: 2, linkId: 'L' })
  const b = makeClip({ startS: 2, inS: 2, outS: 4 })
  const seq = makeSeq([makeTrack({ clips: [v, w] }), makeTrack({ kind: 'audio', clips: [a, b] })])
  return { v, w, a, b, seq }
}

const menu = (clip: Clip, seq: Sequence, over: Partial<ClipMenuContext> = {}): MenuItem[] =>
  clipContextMenuItems({
    clip,
    seq,
    assets: ASSETS,
    selNow: [clip.id],
    keepSelection: false,
    playheadS: 1,
    show: () => {},
    ...over,
  })

describe('the clip right-click menu', () => {
  it('opens with the clipboard verbs and ends with the gap verbs', () => {
    const { v, seq } = fixture()
    const items = menu(v, seq)
    expect(labels(items).slice(0, 4)).toEqual(['Copy', 'Cut', 'Duplicate', 'Paste'])
    expect(labels(items).slice(-2)).toEqual(['Close gap before', 'Close all gaps on track'])
  })

  it('offers moves, punch, motion, transitions and green screen on a video clip', () => {
    const { v, seq } = fixture()
    const items = menu(v, seq)
    const moves = item(items, 'Moves')
    expect(moves.submenu?.map((m) => m.label)).toEqual(MOVES.map((m) => m.name))
    // A move with no digit shows no shortcut, never the word "undefined".
    expect(moves.submenu?.some((m) => m.shortcut === 'undefined')).toBe(false)
    expect(labels(items)).toEqual(
      expect.arrayContaining(['Punch in at playhead', 'Motion', 'Flip left to right', 'Transition in', 'Transition out', 'Remove green screen']),
    )
    expect(labels(items)).not.toContain('Crossfade with next')
  })

  // His ask, 2026-09-29: a 4:3 clip that stretches to 16:9 "when i select to".
  it('offers Fit inside, Fill and crop and Stretch to fill on a picture, ticking the one it shows', () => {
    const { v, w, seq } = fixture()
    const fourThree = { av: { ...ASSETS.av, width: 640, height: 480 } }
    const frame = item(menu(v, seq, { assets: fourThree }), 'Frame').submenu!
    expect(frame.map((f) => f.label)).toEqual(['Fit inside', 'Fill and crop', 'Stretch to fill'])
    // Scale 1 on a 4:3 picture in 16:9 is the whole picture inside: Fit.
    expect(frame.map((f) => f.checked)).toEqual([true, false, false])
    const stretched = { ...v, transform: { ...v.transform, fit: 'stretch' as const } }
    const seq2 = { ...seq, tracks: seq.tracks.map((t, i) => (i === 0 ? { ...t, clips: [stretched, w] } : t)) }
    expect(item(menu(stretched, seq2, { assets: fourThree }), 'Frame').submenu!.map((f) => f.checked)).toEqual([false, false, true])
  })

  it('puts the choice on every selected picture, counting only the pictures', () => {
    const { v, w, a, seq } = fixture()
    const items = menu(v, seq, { selNow: [v.id, w.id, a.id], keepSelection: true })
    expect(labels(items)).toContain('Frame · all 2')
    // Neither the sound nor a caption has a shape to fit.
    expect(labels(menu(a, seq))).not.toContain('Frame')
    const t = newTitleClip(defaultTitleDef('hi'), 5, 1)
    const withTitle = { ...seq, tracks: seq.tracks.map((tr, i) => (i === 0 ? { ...tr, clips: [...tr.clips, t] } : tr)) }
    expect(labels(menu(t, withTitle))).not.toContain('Frame')
  })

  it('marks a transition edge with no neighbour as playing from nothing', () => {
    const { v, seq } = fixture()
    const items = menu(v, seq)
    const inSub = item(items, 'Transition in').submenu!
    const outSub = item(items, 'Transition out').submenu!
    expect(inSub[0]).toMatchObject({ label: 'None', checked: true })
    expect(inSub[1].label.endsWith('(from nothing)')).toBe(true)
    expect(outSub[1].label.endsWith('(from nothing)')).toBe(false)
  })

  it('offers crossfades and the sound verbs on an audio clip with a touching neighbour', () => {
    const { a, b, seq } = fixture()
    const items = menu(a, seq)
    expect(labels(items)).toContain('Crossfade with next')
    expect(labels(items)).not.toContain('Crossfade with previous')
    expect(labels(items)).toEqual(expect.arrayContaining(['Level this clip', 'Auto-Caption from voiceover', 'Cut the quiet parts']))
    expect(labels(items)).not.toContain('Transition in')
    expect(labels(menu(b, seq))).toContain('Crossfade with previous')
  })

  it('disables the playhead verbs when the playhead is outside the clip', () => {
    const { v, seq } = fixture()
    expect(item(menu(v, seq, { playheadS: 1 }), 'Split at playhead').disabled).toBe(false)
    const outside = menu(v, seq, { playheadS: 3 })
    for (const label of ['Split at playhead', 'Trim head to playhead', 'Trim tail to playhead', 'Punch in at playhead']) {
      expect(item(outside, label).disabled).toBe(true)
    }
  })

  it('names which half of a linked pair Delete removes', () => {
    const { v, w, a, seq } = fixture()
    expect(labels(menu(v, seq))).toContain('Delete video')
    expect(labels(menu(a, seq))).toContain('Delete audio')
    expect(labels(menu(w, seq))).toContain('Delete')
  })

  it('counts a kept multi-selection in the labels', () => {
    const { v, w, seq } = fixture()
    const items = menu(v, seq, { selNow: [v.id, w.id], keepSelection: true })
    expect(labels(items)).toEqual(
      expect.arrayContaining(['Split 2 clips at playhead', 'Delete 2 clips', 'Ripple delete 2 clips', 'Paste attributes to 2', 'Paste move to 2', 'Moves · all 2']),
    )
  })

  it('disables Close gap before when there is no gap', () => {
    const { v, w, seq } = fixture()
    expect(item(menu(w, seq), 'Close gap before').disabled).toBe(true)
    const later = makeClip({ startS: 5 })
    const gappy = makeSeq([makeTrack({ clips: [v, later] })])
    expect(item(menu(later, gappy), 'Close gap before').disabled).toBe(false)
  })

  it('offers the style presets on a single title and leaves the video verbs off it', () => {
    const title = newTitleClip(defaultTitleDef('Hi'), 0, 2)
    const seq = makeSeq([makeTrack({ clips: [title] })])
    const items = menu(title, seq, { playheadS: 5 })
    expect(labels(items)).toContain('Style preset')
    expect(labels(items)).not.toContain('Moves')
    expect(labels(items)).not.toContain('Remove green screen')
  })

  // His words, 2026-09-28: *"when I want to save a sound effect for Battle
  // Cats, I can."* The sound is often already on the timeline when he decides.
  it('saves a clip with media to the Library, into any of his categories', () => {
    useLibrary.setState({
      categories: [
        { id: 'mc', name: 'Minecraft', createdAt: 2 },
        { id: 'bc', name: 'Battle Cats', createdAt: 1 },
      ],
      lastCategoryId: 'bc',
    })
    const { a, v, seq } = fixture()
    for (const clip of [a, v]) {
      const save = item(menu(clip, seq), 'Save to Library')
      expect(save.submenu?.map((m) => m.label)).toEqual(['Unsorted', 'Battle Cats', 'Minecraft', 'New category...'])
      // The tick is where a one-click save would go: the category he used last.
      expect(save.submenu?.find((m) => m.checked)?.label).toBe('Battle Cats')
    }
  })

  it('offers no Library save on a clip with no media behind it', () => {
    const title = newTitleClip(defaultTitleDef('Hi'), 0, 2)
    expect(labels(menu(title, makeSeq([makeTrack({ clips: [title] })])))).not.toContain('Save to Library')
    const orphan = makeClip({ assetId: 'gone' })
    expect(labels(menu(orphan, makeSeq([makeTrack({ clips: [orphan] })])))).not.toContain('Save to Library')
  })
})
