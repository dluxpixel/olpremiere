import { describe, expect, it } from 'vitest'
import { MOVES } from '../engine/moves'
import { defaultTitleDef, newTitleClip, type Clip, type Sequence } from '../engine/types'
import type { MenuItem } from '../state/contextMenu'
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
      expect.arrayContaining(['Punch in at playhead', 'Motion', 'Transition in', 'Transition out', 'Remove green screen']),
    )
    expect(labels(items)).not.toContain('Crossfade with next')
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
})
