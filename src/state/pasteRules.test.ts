// Ctrl+V after 2026-09-28: clips or a picture, whichever he copied last, one
// paste per press, and a picture that never lands on top of anything.
//
// His words: *"Make it so I can just paste pictures"*. His pick for where
// anything pasted goes when its spot is taken: "the next free line".

import { describe, expect, it } from 'vitest'
import { makeAsset, makeClip, makeSeq, makeTrack } from '../components/timelineTestFixtures'
import { clipEndS, findClip } from '../engine/timeline'
import type { Sequence } from '../engine/types'
import {
  clipMarker,
  createPasteRouter,
  cutoutName,
  cutoutProblem,
  decidePaste,
  pastedPictureName,
  pasteNote,
  pictureAimNote,
  pictureHomeTrack,
  picturesFrom,
  placePastedPicture,
} from './pasteRules'

const pic = (name = 'image.png'): File => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

describe('which paste wins', () => {
  const marker = clipMarker(2)

  it('pastes his clips when there is no picture, as Ctrl+V always did', () => {
    expect(decidePaste({ text: '', marker, pictureCount: 0 })).toBe('clips')
    expect(decidePaste({ text: 'some words', marker: null, pictureCount: 0 })).toBe('clips')
  })

  it('pastes the picture when he copied it after the clips', () => {
    // Copying the picture replaced the clip marker on the system clipboard.
    expect(decidePaste({ text: '', marker, pictureCount: 1 })).toBe('picture')
  })

  it('pastes the picture when no clips were ever copied', () => {
    expect(decidePaste({ text: '', marker: null, pictureCount: 1 })).toBe('picture')
  })

  it('pastes the clips when they were copied after the picture', () => {
    // The clip copy wrote its marker over whatever was there, so if the marker
    // is still what the clipboard holds, nothing newer was copied.
    expect(decidePaste({ text: marker, marker, pictureCount: 1 })).toBe('clips')
  })

  it('a clip copy that could not mark the clipboard still wins over an older picture there', () => {
    expect(decidePaste({ text: '', marker, pictureCount: 1, markerLost: true })).toBe('clips')
  })

  it('writes a marker that reads as what it is when pasted anywhere else', () => {
    expect(clipMarker(1)).toBe('OL Premiere: 1 clip copied')
    expect(clipMarker(3)).toBe('OL Premiere: 3 clips copied')
  })
})

describe('one Ctrl+V is one paste', () => {
  function rig(opts: { marker?: string | null; busy?: boolean } = {}) {
    const calls: string[] = []
    const later: (() => void)[] = []
    const router = createPasteRouter({
      pasteClips: () => calls.push('clips'),
      offerPicture: (f) => calls.push(`picture ${f.name}`),
      clipMarker: () => opts.marker ?? null,
      busy: () => opts.busy ?? false,
      defer: (fn) => later.push(fn),
    })
    const settle = (): void => {
      while (later.length > 0) later.shift()!()
    }
    return { router, calls, settle }
  }

  it('the key and the paste event together offer the picture once, and paste no clips', () => {
    const { router, calls, settle } = rig({ marker: clipMarker(1) })
    router.onKey()
    router.onPaste({ text: '', pictures: [pic('shot.png')] })
    settle()
    expect(calls).toEqual(['picture shot.png'])
  })

  it('the key and the paste event together paste the clips once', () => {
    const { router, calls, settle } = rig()
    router.onKey()
    router.onPaste({ text: 'hello', pictures: [] })
    settle()
    expect(calls).toEqual(['clips'])
  })

  it('the key alone still pastes the clips, when no paste event comes', () => {
    const { router, calls, settle } = rig()
    router.onKey()
    settle()
    expect(calls).toEqual(['clips'])
  })

  it('two presses are two pastes, with or without paste events', () => {
    const a = rig()
    a.router.onKey()
    a.router.onKey()
    a.settle()
    expect(a.calls).toEqual(['clips', 'clips'])
    const b = rig()
    b.router.onKey()
    b.router.onPaste({ text: '', pictures: [] })
    b.router.onKey()
    b.router.onPaste({ text: '', pictures: [] })
    b.settle()
    expect(b.calls).toEqual(['clips', 'clips'])
  })

  it('does nothing while he is still answering about a picture', () => {
    const { router, calls, settle } = rig({ busy: true })
    router.onKey()
    router.onPaste({ text: '', pictures: [pic()] })
    router.onKey()
    settle()
    expect(calls).toEqual([])
  })

  it('a paste a text field took is not pasted again onto the timeline', () => {
    const { router, calls, settle } = rig()
    router.onKey()
    router.onPasteTakenElsewhere()
    settle()
    expect(calls).toEqual([])
  })
})

describe('picturesFrom', () => {
  it('takes picture files and leaves text and other files alone', () => {
    const shot = pic('shot.png')
    const items = [
      { kind: 'string', type: 'text/html', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => shot },
      { kind: 'file', type: 'application/pdf', getAsFile: () => new File([], 'a.pdf') },
    ]
    expect(picturesFrom(items)).toEqual([shot])
    expect(picturesFrom(null)).toEqual([])
  })
})

describe('names', () => {
  const at = new Date(2026, 8, 28, 18, 40, 12)

  it('names a screenshot by the time it was pasted, with no colon for Windows', () => {
    expect(pastedPictureName('image.png', 'image/png', at)).toBe('Pasted picture 18-40-12.png')
    expect(pastedPictureName('image.jpeg', 'image/jpeg', at)).toBe('Pasted picture 18-40-12.jpg')
    expect(pastedPictureName('', 'image/webp', at)).toBe('Pasted picture 18-40-12.webp')
  })

  it('keeps the real name of a file copied in Explorer', () => {
    expect(pastedPictureName('cat on sofa.jpg', 'image/jpeg', at)).toBe('cat on sofa.jpg')
  })

  it('names the cut out copy as a PNG', () => {
    expect(cutoutName('cat on sofa.jpg')).toBe('cat on sofa no background.png')
  })

  it('says every CutStudio problem in plain words', () => {
    for (const reason of ['not-found', 'no-start', 'slow-start', 'port-taken', 'no-model', 'failed'] as const) {
      expect(cutoutProblem(reason)).toMatch(/CutStudio/)
    }
  })
})

describe('where a pasted picture lands', () => {
  const image = makeAsset({ id: 'img', name: 'Pasted picture.png', kind: 'image', durationS: 0, hasAudio: false })
  /** V1 with his main footage from 0 to 10 s, plus whatever lines are asked for. */
  const withFootage = (above: ReturnType<typeof makeTrack>[] = []): Sequence => {
    const v1 = makeTrack({ name: 'V1', clips: [makeClip({ id: 'main', startS: 0, inS: 0, outS: 10 })] })
    return makeSeq([v1, ...above, makeTrack({ kind: 'audio', name: 'A1' })])
  }
  const spans = (seq: Sequence, name: string): number[][] =>
    seq.tracks.find((t) => t.name === name)!.clips.map((c) => [c.startS, clipEndS(c)])

  it('goes on V2, above his footage, exactly at the playhead', () => {
    const seq = withFootage([makeTrack({ name: 'V2' })])
    const { seq: out, clipId } = placePastedPicture(seq, image, 3)
    const placed = findClip(out, clipId)!
    expect(placed.track.name).toBe('V2')
    expect(placed.clip.startS).toBe(3)
    expect(spans(out, 'V1')).toEqual([[0, 10]])
  })

  it('goes on V1 when that is the only line and it is free there', () => {
    const seq = withFootage()
    const { seq: out, clipId } = placePastedPicture(seq, image, 12)
    expect(findClip(out, clipId)!.track.name).toBe('V1')
    expect(findClip(out, clipId)!.clip.startS).toBe(12)
  })

  it('makes a new line rather than cover his footage when V1 is the only line', () => {
    const seq = withFootage()
    const { seq: out, clipId } = placePastedPicture(seq, image, 3)
    const placed = findClip(out, clipId)!
    expect(placed.track.kind).toBe('video')
    expect(placed.track.name).not.toBe('V1')
    expect(placed.clip.startS).toBe(3)
    expect(spans(out, 'V1')).toEqual([[0, 10]])
  })

  it('goes up to the next free line when V2 is taken there, and moves nothing', () => {
    const v2 = makeTrack({ name: 'V2', clips: [makeClip({ id: 'title', startS: 2, inS: 0, outS: 4 })] })
    const seq = withFootage([v2])
    const { seq: out, clipId } = placePastedPicture(seq, image, 3)
    const placed = findClip(out, clipId)!
    expect(placed.track.name).not.toBe('V2')
    expect(placed.track.name).not.toBe('V1')
    expect(placed.clip.startS).toBe(3)
    expect(spans(out, 'V2')).toEqual([[2, 6]])
    expect(spans(out, 'V1')).toEqual([[0, 10]])
  })

  it('skips a locked V2', () => {
    const seq = withFootage([makeTrack({ name: 'V2', locked: true }), makeTrack({ name: 'V3' })])
    expect(pictureHomeTrack(seq)!.name).toBe('V3')
    const { seq: out, clipId } = placePastedPicture(seq, image, 3)
    expect(findClip(out, clipId)!.track.name).toBe('V3')
  })

  it('places nothing when every video line is locked', () => {
    const seq = makeSeq([makeTrack({ name: 'V1', locked: true }), makeTrack({ kind: 'audio', name: 'A1' })])
    const { seq: out, clipId } = placePastedPicture(seq, image, 3)
    expect(clipId).toBe('')
    expect(out).toBe(seq)
  })
})

// His words, 2026-10-04: *"make sure it also pastes it on the same line because I
// clicked the V4."* A picture used to go to V2 whatever he had clicked.
describe('a pasted picture onto the line he clicked', () => {
  const image = makeAsset({ id: 'img', name: 'Pasted picture.png', kind: 'image', durationS: 0, hasAudio: false })
  const lines = (over: Record<string, Partial<ReturnType<typeof makeTrack>>> = {}): Sequence =>
    makeSeq([
      makeTrack({ name: 'V1', clips: [makeClip({ id: 'main', startS: 0, inS: 0, outS: 10 })] }),
      ...['V2', 'V3', 'V4'].map((name) => makeTrack({ name, ...over[name] })),
      makeTrack({ kind: 'audio', name: 'A1', ...over.A1 }),
    ])
  const idOf = (seq: Sequence, name: string): string => seq.tracks.find((t) => t.name === name)!.id
  const spans = (seq: Sequence, name: string): number[][] =>
    seq.tracks.find((t) => t.name === name)!.clips.map((c) => [c.startS, clipEndS(c)])

  it('goes on V4, exactly at the playhead, and not on V2', () => {
    const seq = lines()
    const { seq: out, clipId, aimed } = placePastedPicture(seq, image, 3, idOf(seq, 'V4'))
    const placed = findClip(out, clipId)!
    expect(placed.track.name).toBe('V4')
    expect(placed.clip.startS).toBe(3)
    expect(aimed).toBeUndefined()
  })

  it('goes up to the next free line when the clicked one is busy there, and says which', () => {
    const seq = lines({ V4: { clips: [makeClip({ id: 'busy', startS: 2, inS: 0, outS: 4 })] } })
    const { seq: out, clipId, aimed } = placePastedPicture(seq, image, 3, idOf(seq, 'V4'))
    const placed = findClip(out, clipId)!
    expect(placed.track.name).not.toBe('V4')
    expect(placed.clip.startS).toBe(3)
    expect(spans(out, 'V4')).toEqual([[2, 6]])
    expect(aimed).toEqual({ trackId: idOf(seq, 'V4'), problem: 'busy' })
    expect(pictureAimNote(out, clipId, aimed!)).toBe(`V4 is busy at that time, so the picture went on ${placed.track.name}`)
  })

  it('places nothing on a locked clicked line, and says the picture is only in his media', () => {
    const seq = lines({ V4: { locked: true } })
    const { seq: out, clipId, aimed } = placePastedPicture(seq, image, 3, idOf(seq, 'V4'))
    expect(clipId).toBe('')
    expect(out).toBe(seq)
    expect(pictureAimNote(out, clipId, aimed!)).toBe('V4 is locked, so the picture is only in your media')
  })

  it('an audio clicked line sends it to its home line and says so', () => {
    const seq = lines()
    const { seq: out, clipId, aimed } = placePastedPicture(seq, image, 3, idOf(seq, 'A1'))
    expect(findClip(out, clipId)!.track.name).toBe('V2')
    expect(pictureAimNote(out, clipId, aimed!)).toBe('A1 is an audio track, so the picture went on V2')
  })

  it('a line this edit does not have is no aim: home as ever, and nothing to say', () => {
    const seq = lines()
    const { seq: out, clipId, aimed } = placePastedPicture(seq, image, 3, 'gone')
    expect(findClip(out, clipId)!.track.name).toBe('V2')
    expect(aimed).toBeUndefined()
  })
})

describe('what a clip paste says about where it went', () => {
  const seq = makeSeq([
    makeTrack({ name: 'V1' }),
    makeTrack({ name: 'V2' }),
    makeTrack({ name: 'V3' }),
    makeTrack({ kind: 'audio', name: 'A1' }),
  ])
  const [v1, v2, v3, a1] = seq.tracks
  const quiet = { redirected: [], targetUnused: false, lifted: 0, grown: 0 }

  it('says nothing when every clip landed on the line it asked for', () => {
    expect(pasteNote(seq, v3, quiet)).toBeNull()
    expect(pasteNote(seq, undefined, quiet)).toBeNull()
  })

  it('names the busy line and the one the clip went on', () => {
    expect(pasteNote(seq, v2, { ...quiet, redirected: [{ askedId: v2!.id, landedId: v3!.id }] })).toBe(
      'V2 is busy at that time, so the clip went on V3',
    )
  })

  it('counts them when several clips went elsewhere', () => {
    const two = [
      { askedId: v1!.id, landedId: v2!.id },
      { askedId: v2!.id, landedId: v3!.id },
    ]
    expect(pasteNote(seq, undefined, { ...quiet, redirected: two })).toBe(
      '2 clips went on a free track, because their own was busy at that time',
    )
  })

  it('says an unused target, a lifted shape and added lines, each in its own words', () => {
    expect(pasteNote(seq, a1, { ...quiet, targetUnused: true })).toBe(
      'A1 is an audio track, so what you copied went back on the tracks it came from',
    )
    expect(pasteNote(seq, v1, { ...quiet, lifted: 1 })).toBe(
      'The copied clips would not fit under V1, so they sit one track higher to keep their shape',
    )
    expect(pasteNote(seq, v1, { ...quiet, lifted: 2 })).toBe(
      'The copied clips would not fit under V1, so they sit 2 tracks higher to keep their shape',
    )
    expect(pasteNote(seq, a1, { ...quiet, grown: 1 })).toBe('One new track was added to keep the copied clips together')
    expect(pasteNote(seq, a1, { ...quiet, grown: 3 })).toBe('3 new tracks were added to keep the copied clips together')
  })
})
