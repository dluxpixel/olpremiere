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
  pastedPictureName,
  pictureAimNote,
  picturesFrom,
  type PictureAim,
  placePastedPicture,
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
  picture: PendingPicture | null
  phase: 'ask' | 'working' | 'failed'
  /** The plain sentence for a cutout that did not work. */
  problem: string | null
}

export const usePastePicture = create<PastePictureState>(() => ({ picture: null, phase: 'ask', problem: null }))

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

/** Show the question for one pasted picture. A second paste while it is up is ignored. */
export function offerPicture(file: File): void {
  if (usePastePicture.getState().picture) return
  const named = new File([file], pastedPictureName(file.name, file.type, new Date()), { type: file.type })
  usePastePicture.setState({
    picture: {
      file: named,
      url: URL.createObjectURL(named),
      atS: useStore.getState().ui.playheadS,
      trackId: clickedPasteTrack(activeSequence(useStore.getState().project))?.id,
    },
    phase: 'ask',
    problem: null,
  })
}

function close(): PendingPicture | null {
  const { picture } = usePastePicture.getState()
  job++
  if (picture) URL.revokeObjectURL(picture.url)
  usePastePicture.setState({ picture: null, phase: 'ask', problem: null })
  return picture
}

/** Escape, the X, or a click outside: nothing is pasted. */
export function cancelPicturePaste(): void {
  close()
}

/** Paste it as it is. */
export async function keepBackground(): Promise<void> {
  const picture = close()
  if (picture) await placePicture(picture.file, picture.atS, picture.trackId, 'Picture pasted')
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
  const mine = ++job
  usePastePicture.setState({ phase: 'working', problem: null })
  let result: CutoutResult
  try {
    result = await api.removeBackground(await picture.file.arrayBuffer(), picture.file.type)
  } catch (err) {
    result = { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
  if (mine !== job) return
  if (!result.ok) {
    console.warn('OL Premiere: CutStudio could not remove the background:', result.reason, result.detail)
    usePastePicture.setState({ phase: 'failed', problem: cutoutProblem(result.reason) })
    return
  }
  close()
  const cut = new File([result.png], cutoutName(picture.file.name), { type: 'image/png' })
  await placePicture(cut, picture.atS, picture.trackId, 'Picture pasted without its background')
}

/**
 * Into the bin, then onto the timeline at the playhead he pasted at, on the line
 * he had clicked (or its home line), selected.
 */
async function placePicture(file: File, atS: number, trackId: Id | undefined, message: string): Promise<void> {
  const [id] = await importFiles([file], { successMessage: message })
  // Nothing imported: importFiles has already said why.
  if (!id) return
  const asset = useStore.getState().project.assets[id]
  if (!asset) return
  let clipId = ''
  let aimed = undefined as PictureAim | undefined
  updateActiveSequence('Paste picture', (sq) => {
    const placed = placePastedPicture(sq, asset, atS, trackId)
    clipId = placed.clipId
    aimed = placed.aimed
    return placed.seq
  })
  // Selected, unlike a clip added from the bin: a pasted picture is nearly always
  // moved or sized next, and it has no linked sound a selection could split off.
  if (clipId) selectPasted([clipId])
  // ⛔ A PICTURE NEVER LANDS ON ANOTHER LINE WITHOUT A WORD, and never on a locked
  // one: the line he clicked said busy, locked or audio, and so does this.
  const note = aimed ? pictureAimNote(activeSequence(useStore.getState().project), clipId, aimed) : null
  if (note) useToasts.getState().show(note, 'info')
  else if (!clipId) useToasts.getState().show('Every video line is locked, so the picture is only in your media', 'info')
}


const router = createPasteRouter({
  pasteClips: pasteAtPlayhead,
  offerPicture,
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
    })
  }
  window.addEventListener('paste', onPaste)
  return () => window.removeEventListener('paste', onPaste)
}
