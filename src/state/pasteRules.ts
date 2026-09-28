// The rules of Ctrl+V, kept apart from the page and the store so they can be
// proved in a test.
//
// His words, 2026-09-28: *"Make it so I can just paste pictures"*. Ctrl+V had
// pasted copied CLIPS long before that, so one key now answers two questions:
// which of the two did he copy last, and where does a pasted picture go.

import type { CutoutFailure } from '../../electron/ipc-types'
import { addClipFromAsset } from '../engine/timeline'
import { videoTracks, type Id, type MediaAsset, type Sequence, type Track } from '../engine/types'

/**
 * The text a clip copy puts on the SYSTEM clipboard.
 *
 * Copied clips live inside this app, where no other program can see them, so on
 * their own they could never say whether a picture on the system clipboard came
 * before them or after. Writing this on every clip copy settles it: while it is
 * still there, the clips are the newest thing he copied, and the moment he
 * copies a picture anywhere it is gone. Pasted into a text box somewhere else,
 * it reads as what it is.
 */
export function clipMarker(count: number): string {
  return `OL Premiere: ${count} clip${count === 1 ? '' : 's'} copied`
}

export type PasteChoice = 'clips' | 'picture'

/**
 * Whichever he copied LAST wins.
 *
 * - No picture on the system clipboard: his clips, the way Ctrl+V always was.
 * - A picture, and the clip marker is NOT what the clipboard holds: the picture
 *   was copied after the clips (or there are no clips), so the picture.
 * - The system clipboard still holds this app's clip marker: the clips.
 */
export function decidePaste(s: { text: string; marker: string | null; pictureCount: number }): PasteChoice {
  if (s.pictureCount === 0) return 'clips'
  if (s.marker !== null && s.text === s.marker) return 'clips'
  return 'picture'
}

/** The part of a DataTransferItem this reads, so a test can hand in a plain object. */
interface ClipboardItemLike {
  kind: string
  type: string
  getAsFile(): File | null
}

/**
 * The pictures in a paste: a screenshot, a picture copied in a browser, or a
 * picture file copied in Explorer. Text and other files are left alone.
 */
export function picturesFrom(items: ArrayLike<ClipboardItemLike> | undefined | null): File[] {
  const out: File[] = []
  for (const item of Array.from(items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) out.push(file)
  }
  return out
}

const EXT: Partial<Record<string, string>> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico' }
function extFor(mime: string): string {
  const known = EXT[mime]
  if (known) return known
  const sub = mime.startsWith('image/') ? mime.slice(6).replace(/[^a-z0-9]/gi, '') : ''
  return sub || 'png'
}

/**
 * The bin name for a pasted picture.
 *
 * A screenshot or a picture copied in a browser arrives as "image.png", which
 * says nothing, and every paste would share it. Those get the time of the paste
 * instead: "Pasted picture 18-40-12.png", dashes because Windows will not take a
 * colon in a filename. A real file copied in Explorer keeps its own name.
 */
export function pastedPictureName(original: string, mime: string, when: Date): string {
  if (original && !/^image\.[a-z0-9]+$/i.test(original)) return original
  const two = (n: number): string => String(n).padStart(2, '0')
  const time = `${two(when.getHours())}-${two(when.getMinutes())}-${two(when.getSeconds())}`
  return `Pasted picture ${time}.${extFor(mime)}`
}

/** The cut out copy's name: always a PNG, because that is what keeps it see-through. */
export function cutoutName(name: string): string {
  return `${name.replace(/\.[^.]+$/, '')} no background.png`
}

/**
 * The line a pasted picture starts looking from: the video line just above his
 * main footage (V2), or V1 while there is only one. A locked line is skipped.
 */
export function pictureHomeTrack(seq: Sequence): Track | null {
  const video = videoTracks(seq)
  const above = video.slice(video.length > 1 ? 1 : 0)
  return above.find((t) => !t.locked) ?? video.find((t) => !t.locked) ?? null
}

/**
 * Put a pasted picture on the timeline at exactly `atS`.
 *
 * `exact` lands it at that time, and where the line is taken there it goes on
 * the next free line up instead, so it never covers or cuts anything. His pick
 * for anything pasted, 2026-09-28: "the next free line". An empty clip id means
 * every video line is locked.
 */
export function placePastedPicture(seq: Sequence, asset: MediaAsset, atS: number): { seq: Sequence; clipId: Id } {
  const home = pictureHomeTrack(seq)
  if (!home) return { seq, clipId: '' }
  return addClipFromAsset(seq, home.id, asset, atS, { exact: true })
}

/** What went wrong with CutStudio, said the way he would say it. */
export function cutoutProblem(reason: CutoutFailure): string {
  switch (reason) {
    case 'not-found':
      return 'Can’t find CutStudio on this computer.'
    case 'no-start':
      return 'CutStudio would not start.'
    case 'slow-start':
      return 'CutStudio is still starting. Try again in a moment.'
    case 'port-taken':
      return 'Another app is using the port CutStudio needs (8787).'
    case 'no-model':
      return 'CutStudio needs its cutout model first. Open CutStudio once to get it.'
    case 'failed':
      return 'CutStudio couldn’t cut this picture out.'
  }
}

export interface PasteRouterDeps {
  /** Ctrl+V the way it always was: his copied clips at the playhead. */
  pasteClips: () => void
  /** Ask him about a picture: keep its background, or take it off. */
  offerPicture: (file: File) => void
  /** The text this app put on the system clipboard with its last clip copy. */
  clipMarker: () => string | null
  /** A picture is already waiting on his answer. */
  busy: () => boolean
  /** Run `fn` after the browser has had its turn to fire the paste event. */
  defer: (fn: () => void) => void
}

/**
 * ONE Ctrl+V, ONE paste.
 *
 * The key and the browser's paste event both see a single Ctrl+V. Only the paste
 * event can read a picture off the system clipboard, so the key does not paste
 * anything itself: it waits one turn, and the paste event, which the browser
 * fires inside that same keypress, makes the one decision. The key pastes clips
 * on its own only when no paste event came at all, so the old Ctrl+V can never
 * be lost and never happen twice.
 */
export function createPasteRouter(d: PasteRouterDeps) {
  let keysWaiting = 0
  return {
    onKey(): void {
      keysWaiting++
      d.defer(() => {
        if (keysWaiting === 0) return
        keysWaiting--
        if (!d.busy()) d.pasteClips()
      })
    },
    /** A paste that something else on the page (a text field) took. It still used up its key. */
    onPasteTakenElsewhere(): void {
      if (keysWaiting > 0) keysWaiting--
    },
    onPaste(clip: { text: string; pictures: File[] }): void {
      if (keysWaiting > 0) keysWaiting--
      // A second Ctrl+V while he is still answering about the first picture.
      if (d.busy()) return
      const choice = decidePaste({ text: clip.text, marker: d.clipMarker(), pictureCount: clip.pictures.length })
      if (choice === 'picture') d.offerPicture(clip.pictures[0]!)
      else d.pasteClips()
    },
  }
}
