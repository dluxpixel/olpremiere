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
