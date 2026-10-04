// C on his own project, 2026-10-03.
//
// His words, with a screenshot of the recording selected under a pasted picture:
// *"I can't cut. When I click C, it won't cut in this frame, even though I'm on
// another frame."* The clips below are his "strong until" project as it was
// saved that evening (Documents\OL Premiere Projects), ids shortened. A 2.5x
// clip ended at frame 97.98 at 30 fps and everything after it inherited the
// fraction: every edit from there sits between two frames (138.54, 144.54,
// 155.54, 189.54, 205.98). The playhead only ever stands on a frame.
//
// The old rule wanted each piece at least 1/30 s long, so at every one of those
// edits the frame before it (0.54 of a frame from the clip's end) and the frame
// after it (0.46 of a frame from the next clip's start) were both refused, and
// splitAtPlayhead said nothing about either. This drives the real C against the
// real store, every frame of his edit.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const show = vi.fn()
vi.mock('./toasts', () => ({ useToasts: { getState: () => ({ show }) } }))

import { recomputeDuration } from '../engine/timeline'
import { activeSequence, newClipFromAsset, newProject, type Clip, type MediaAsset } from '../engine/types'
import { splitAtPlayhead, topAndTail } from './clipEdits'
import { placePastedPicture } from './pasteRules'
import { updateActiveSequence, useStore } from './store'

const IMG: MediaAsset = { id: 'img3080', name: 'IMG_3080.mp4', kind: 'video', blobKey: 'b1', durationS: 21.603333, hasAudio: true, hasVideo: true, fps: 30 }
const REC: MediaAsset = { id: 'rec', name: '2026-10-03 18-06-57.mp4', kind: 'video', blobKey: 'b2', durationS: 33.083333, hasAudio: true, hasVideo: true, fps: 60 }
const PIC: MediaAsset = { id: 'pic', name: 'Pasted picture 18-08-09.png', kind: 'image', blobKey: 'b3', durationS: 0, hasAudio: false, hasVideo: true }

type Row = [id: string, asset: MediaAsset, startS: number, inS: number, outS: number, speed: number, linkId?: string]
const clip = ([id, asset, startS, inS, outS, speed, linkId]: Row): Clip => ({
  ...newClipFromAsset(asset, startS),
  id,
  inS,
  outS,
  speed,
  ...(linkId ? { linkId } : {}),
})

// Saved 2026-10-03T17:02:41Z. The recording's audio halves had been deleted, so
// each recording piece is a link group of one.
const V1: Row[] = [
  ['img', IMG, 0, 0.5, 8.6649999999991, 2.5, 'g-img'],
  ['rec1', REC, 3.2659999999996403, 15.533333333333333, 18.237333333333723, 2, 'g1'],
  ['rec2', REC, 4.617999999999835, 18.237333333333723, 18.63733333333372, 2, 'g2'],
  ['rec3', REC, 4.817999999999834, 19.370666666667056, 22.370666666667056, 2, 'g3'],
  ['rec4', REC, 6.317999999999834, 25.866666666666667, 29.164000000000332, 2, 'g4'],
]
const V2: Row[] = [
  ['pic1', PIC, 3.26599999999964, 0, 1.552000000000195, 1],
  ['pic2', PIC, 4.817999999999834, 1.552000000000195, 1.9186666666668621, 1],
  ['pic3', PIC, 5.1846666666665016, 1.9186666666668621, 3.052000000000195, 1],
  ['pic4', PIC, 6.317999999999834, 3.052000000000195, 3.5999999999999996, 1],
  ['pic5', PIC, 6.865999999999639, 3.5999999999999996, 4.700666666667027, 1],
]

function seedHisProject(): void {
  useStore.getState().setProject({ ...newProject(), assets: { [IMG.id]: IMG, [REC.id]: REC, [PIC.id]: PIC } })
  updateActiveSequence('seed', (sq) =>
    recomputeDuration({
      ...sq,
      fps: 30,
      tracks: sq.tracks.map((t, i) => (i === 0 ? { ...t, clips: V1.map(clip) } : i === 1 ? { ...t, clips: V2.map(clip) } : t)),
    }),
  )
  show.mockClear()
}

const clipCount = (): number => activeSequence(useStore.getState().project).tracks.reduce((n, t) => n + t.clips.length, 0)
const pressC = (frame: number, selection: string[] = []): { cut: boolean; said: string | null } => {
  useStore.getState().setUI({ playheadS: frame / 30, selection })
  const before = useStore.getState().project
  splitAtPlayhead()
  const said = show.mock.calls.length > 0 ? String(show.mock.calls[show.mock.calls.length - 1]![0]) : null
  return { cut: useStore.getState().project !== before, said }
}

describe('C on his strong until project', () => {
  beforeEach(seedHisProject)

  it('the clips really are off the frame grid: the premise, measured', () => {
    const starts = activeSequence(useStore.getState().project).tracks[0]!.clips.map((c) => +(c.startS * 30).toFixed(2))
    expect(starts).toEqual([0, 97.98, 138.54, 144.54, 189.54])
  })

  it('his screenshot: the recording selected, the playhead on frame 190, half a frame inside it. C says why it cannot', () => {
    // 6.318 s is frame 189.54. Frame 190 is the first frame the clip shows: the
    // left piece of a cut there would show nothing at all.
    const { cut, said } = pressC(190, ['rec4'])
    expect(cut).toBe(false)
    expect(said).toMatch(/first frame of the clip/)
  })

  it('one frame before that edit, C cuts the clips still showing (0.54 of a frame from their end)', () => {
    const n = clipCount()
    const { cut } = pressC(189)
    expect(cut).toBe(true)
    // rec3 on V1 and pic3 on V2 both end at 189.54; each gives up a piece that
    // shows exactly frame 189.
    expect(clipCount()).toBe(n + 2)
    const v1 = activeSequence(useStore.getState().project).tracks[0]!.clips
    const piece = v1.find((c) => Math.abs(c.startS - 189 / 30) < 1e-9)!
    expect(piece).toBeDefined()
  })

  it('one frame further in, C cuts the selected recording, as it always did', () => {
    expect(pressC(191, ['rec4']).cut).toBe(true)
  })

  it('every frame of his edit: C either cuts or says why, never nothing', () => {
    const lastFrame = Math.ceil(activeSequence(useStore.getState().project).durationS * 30)
    const silent: number[] = []
    for (let f = 0; f <= lastFrame; f++) {
      seedHisProject()
      const { cut, said } = pressC(f)
      if (!cut && said === null) silent.push(f)
    }
    expect(silent).toEqual([])
  })
})

// The ways in. A playhead after playback rests wherever the transport stopped,
// between two frames, and both of these used it raw.
describe('a paused playhead between frames leaves nothing off the grid', () => {
  beforeEach(seedHisProject)
  const onGrid = (tS: number): boolean => Math.abs(tS * 30 - Math.round(tS * 30)) < 1e-6

  it('W trims the tail to the frame under the playhead, not between two', () => {
    // 2.6147 s: inside his IMG_3080 (0 to 97.98), frame 78.44.
    useStore.getState().setUI({ playheadS: 2.6147, selection: ['img'] })
    topAndTail('out')
    const img = activeSequence(useStore.getState().project).tracks[0]!.clips.find((c) => c.id === 'img')!
    expect(onGrid(img.startS + (img.outS - img.inS) / img.speed)).toBe(true)
  })

  it('a pasted picture lands on the frame under the playhead', () => {
    const at = 6.3187 // frame 189.56
    const { seq, clipId } = placePastedPicture(activeSequence(useStore.getState().project), PIC, at)
    const placed = seq.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!
    expect(placed.startS * 30).toBeCloseTo(190, 9)
  })
})
