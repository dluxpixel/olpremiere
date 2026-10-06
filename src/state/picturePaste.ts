// A picture pasted from the system clipboard: ask, maybe cut it out, then put it
// on the timeline.
//
// His words, 2026-09-28: *"Make it so I can just paste pictures"*, and *"maybe I
// can use my new app for the background removal. When I paste something, I can
// select, when pasting it, to remove the background automatically."* Asked how,
// he picked: ask on every paste, keep the background or remove it.
//
// The rules (which paste wins, where the picture lands) are in pasteRules.ts.
// This file is the page and the store around them.

import { create } from 'zustand'
import type { CutoutResult } from '../../electron/ipc-types'
import { isEditableTarget } from '../keymap'
import { activeSequence, type Id } from '../engine/types'
import { clipMarkerLost, clipMarkerOnSystemClipboard, pasteAtPlayhead } from './clipboard'
import { importFiles } from './mediaActions'
import {
  createPasteRouter,
  cutoutName,
  cutoutProblem,
  mediaFrom,
  pastedPictureName,
  pictureAimNote,
  picturesFrom,
  placePastedInARow,
  type PictureAim,
} from './pasteRules'
import { clickedPasteTrack, selectPasted } from './pasteTarget'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

export interface PendingPicture {
  file: File
  /** An object URL, for the thumbnail in the dialog. */
  url: string
  /** The playhead when he pasted. The picture lands there even if the cutout takes a while. */
  atS: number
  /**
   * The line he had clicked when he pasted, if any. Like the time, taken at the
   * paste: the picture lands there even if he clicks elsewhere while it waits.
   */
  trackId?: Id
}

interface PastePictureState {
  /** The first picture of the paste, the one the dialog shows. */
  picture: PendingPicture | null
  /**
   * The other pictures pasted with it, in the order he copied them. They share
   * its time and its line, and land one after another behind it.
   */
  more: File[]
  phase: 'ask' | 'working' | 'failed'
  /** The plain sentence for a cutout that did not work. */
  problem: string | null
  /** Which picture CutStudio is on, from 1, while it works through several. */
  workingOn: number
}

export const usePastePicture = create<PastePictureState>(() => ({
  picture: null,
  more: [],
  phase: 'ask',
  problem: null,
  workingOn: 0,
}))

/**
 * Can this build hand a picture to CutStudio? The desktop app can. The web
 * build has no way to start a program on his computer, so there the button
 * shows, switched off, with the reason under it.
 */
export function canRemoveBackground(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.removeBackground === 'function'
}

// Bumped by every answer, so a cutout that comes back after he cancelled, or
// after he picked "Keep background" while it worked, is dropped on the floor.
let job = 0

/**
 * The cut out copies made so far for the pictures on screen, by place. Kept
 * while the question is up, so a "Remove background" tried again after CutStudio
 * stopped part way carries on from the picture it stopped at.
 */
let cutSoFar: (File | undefined)[] = []

/** Show the question for one pasted picture. A second paste while it is up is ignored. */
export function offerPicture(file: File): void {
  offerPictures([file])
}

/**
 * Show ONE question for every picture in the paste. A second paste while it is
 * up is ignored.
 *
 * ⛔ EVERY PICTURE, NOT THE FIRST. Five Battle Cats unit pictures copied in
 * Explorer used to ask about the first and drop the other four without a word.
 */
export function offerPictures(files: File[]): void {
  if (usePastePicture.getState().picture || files.length === 0) return
  const now = new Date()
  const [first, ...rest] = files.map((f) => new File([f], pastedPictureName(f.name, f.type, now), { type: f.type }))
  cutSoFar = []
  usePastePicture.setState({
    picture: {
      file: first!,
      url: URL.createObjectURL(first!),
      atS: useStore.getState().ui.playheadS,
      trackId: clickedPasteTrack(activeSequence(useStore.getState().project))?.id,
    },
    more: rest,
    phase: 'ask',
    problem: null,
    workingOn: 0,
  })
}

/** Every picture waiting on his answer, in order. */
function pending(): File[] {
  const { picture, more } = usePastePicture.getState()
  return picture ? [picture.file, ...more] : []
}

function close(): { picture: PendingPicture; files: File[] } | null {
  const { picture } = usePastePicture.getState()
  const files = pending()
  job++
  if (picture) URL.revokeObjectURL(picture.url)
  usePastePicture.setState({ picture: null, more: [], phase: 'ask', problem: null, workingOn: 0 })
  return picture ? { picture, files } : null
}

/** Escape, the X, or a click outside: nothing is pasted. */
export function cancelPicturePaste(): void {
  close()
}

/** Paste them as they are. */
export async function keepBackground(): Promise<void> {
  const closed = close()
  if (!closed) return
  const { picture, files } = closed
  const n = files.length
  await placePictures(files, picture.atS, picture.trackId, n === 1 ? 'Picture pasted' : `${n} pictures pasted`)
}

/**
 * Send it through CutStudio, then paste the cut out copy. While CutStudio works
 * the dialog stays up and says so. When it cannot, the dialog says why in plain
 * words and "Keep background" is right there.
 */
export async function removeBackground(): Promise<void> {
  const { picture, phase } = usePastePicture.getState()
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!picture || phase === 'working' || !api?.removeBackground) return
  const files = pending()
  const mine = ++job
  usePastePicture.setState({ phase: 'working', problem: null })
  // One picture at a time: CutStudio is one program on his PC, and he sees "3 of 5".
  for (const [i, file] of files.entries()) {
    if (cutSoFar[i]) continue
    usePastePicture.setState({ workingOn: i + 1 })
    let result: CutoutResult
    try {
      result = await api.removeBackground(await file.arrayBuffer(), file.type)
    } catch (err) {
      result = { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) }
    }
    if (mine !== job) return
    if (!result.ok) {
      console.warn('OL Premiere: CutStudio could not remove the background:', result.reason, result.detail)
      usePastePicture.setState({ phase: 'failed', problem: cutoutProblem(result.reason), workingOn: 0 })
      return
    }
    cutSoFar[i] = new File([result.png], cutoutName(file.name), { type: 'image/png' })
  }
  const cut = files.map((f, i) => cutSoFar[i] ?? f)
  close()
  const n = cut.length
  await placePictures(
    cut,
    picture.atS,
    picture.trackId,
    n === 1 ? 'Picture pasted without its background' : `${n} pictures pasted without their background`,
  )
}

/**
 * Into the bin, then onto the timeline from the playhead he pasted at, one after
 * another, on the line he had clicked (or its home line), selected. One import
 * and one paste step, however many there are.
 */
async function placePictures(files: File[], atS: number, trackId: Id | undefined, message: string): Promise<void> {
  const ids = await importFiles(files, { successMessage: message })
  // Nothing imported: importFiles has already said why.
  const assets = ids.map((id) => useStore.getState().project.assets[id]).filter((a) => a !== undefined)
  if (assets.length === 0) return
  let placed: { clipIds: Id[]; aimed?: PictureAim; aimedClipId: Id } = { clipIds: [], aimedClipId: '' }
  updateActiveSequence(assets.length === 1 ? 'Paste picture' : `Paste ${assets.length} pictures`, (sq) => {
    const r = placePastedInARow(sq, assets, atS, trackId)
    placed = r
    return r.seq
  })
  // Selected, unlike a clip added from the bin: a pasted picture is nearly always
  // moved or sized next, and it has no linked sound a selection could split off.
  if (placed.clipIds.length > 0) selectPasted(placed.clipIds)
  // ⛔ A PICTURE NEVER LANDS ON ANOTHER LINE WITHOUT A WORD, and never on a locked
  // one: the line he clicked said busy, locked or audio, and so does this.
  const seq = activeSequence(useStore.getState().project)
  const note = placed.aimed ? pictureAimNote(seq, placed.aimedClipId, placed.aimed) : null
  if (note) useToasts.getState().show(note, 'info')
  else if (placed.clipIds.length === 0) {
    useToasts.getState().show('Every video line is locked, so the picture is only in your media', 'info')
  }
}

/**
 * Video and sound files pasted from Explorer: into the bin, and onto the timeline
 * from the playhead, one after another, on the line he clicked. No question: a
 * clip has no background to ask about. Not selected, the way a clip added from
 * the bin is not, so its linked sound stays with it.
 */
export async function pasteMediaFiles(files: File[]): Promise<void> {
  const atS = useStore.getState().ui.playheadS
  const trackId = clickedPasteTrack(activeSequence(useStore.getState().project))?.id
  const ids = await importFiles(files)
  const assets = ids.map((id) => useStore.getState().project.assets[id]).filter((a) => a !== undefined)
  if (assets.length === 0) return
  let placed: { clipIds: Id[]; aimed?: PictureAim; aimedClipId: Id } = { clipIds: [], aimedClipId: '' }
  updateActiveSequence(assets.length === 1 ? `Paste ${assets[0]!.name}` : `Paste ${assets.length} files`, (sq) => {
    const r = placePastedInARow(sq, assets, atS, trackId)
    placed = r
    return r.seq
  })
  const seq = activeSequence(useStore.getState().project)
  const note = placed.aimed ? pictureAimNote(seq, placed.aimedClipId, placed.aimed, 'clip') : null
  if (note) useToasts.getState().show(note, 'info')
  else if (placed.clipIds.length === 0) useToasts.getState().show('Every line is locked, so it is only in your media', 'info')
}


const router = createPasteRouter({
  pasteClips: pasteAtPlayhead,
  offerPictures,
  pasteFiles: (files) => void pasteMediaFiles(files),
  clipMarker: clipMarkerOnSystemClipboard,
  markerLost: clipMarkerLost,
  busy: () => usePastePicture.getState().picture !== null,
  defer: (fn) => {
    window.setTimeout(fn, 0)
  },
})

/** Ctrl+V's keymap half. It pastes nothing itself: see createPasteRouter. */
export function pasteKey(): void {
  router.onKey()
}

/** The browser's paste event, for the whole editor. Returns the uninstall. */
export function installPasteListener(): () => void {
  const onPaste = (e: ClipboardEvent): void => {
    // A paste into a text field belongs to the field: a title, a project name.
    if (e.defaultPrevented || isEditableTarget(e.target)) {
      router.onPasteTakenElsewhere()
      return
    }
    e.preventDefault()
    router.onPaste({
      text: e.clipboardData?.getData('text/plain') ?? '',
      pictures: picturesFrom(e.clipboardData?.items),
      media: mediaFrom(e.clipboardData?.items),
    })
  }
  window.addEventListener('paste', onPaste)
  return () => window.removeEventListener('paste', onPaste)
}
