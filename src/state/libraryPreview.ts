// Hear a saved sound before using it: the small play button on a Library card.
//
// A sound effect is picked by ear, and without this the only way to hear one
// was to put it on the timeline. It is a plain HTMLAudioElement on the item's
// blob URL (the same session cache every thumbnail uses), shared by all cards,
// so starting one stops the other and a second click on the same one stops it.
// Nothing here touches the project.

import { create } from 'zustand'
import type { Id } from '../engine/types'
import { getBlobUrl } from './blobUrls'
import { useToasts } from './toasts'

export const useLibraryPreview = create<{ playingId: Id | null }>(() => ({ playingId: null }))

let el: HTMLAudioElement | null = null
/** Bumped on every start and stop, so a slow blob lookup cannot start a sound he already moved past. */
let turn = 0

export function stopLibraryPreview(): void {
  turn++
  el?.pause()
  useLibraryPreview.setState({ playingId: null })
}

/** Play this item's sound, or stop it when it is the one already playing. */
export async function toggleLibraryPreview(item: { id: Id; name: string; blobKey: string }): Promise<void> {
  if (useLibraryPreview.getState().playingId === item.id) {
    stopLibraryPreview()
    return
  }
  stopLibraryPreview()
  if (typeof Audio === 'undefined') return
  const mine = turn
  const url = await getBlobUrl(item.blobKey)
  if (mine !== turn) return
  if (!url) {
    useToasts.getState().show(`${item.name}: Library media is missing`, 'danger')
    return
  }
  el ??= new Audio()
  const audio = el
  audio.onended = () => {
    if (mine === turn) useLibraryPreview.setState({ playingId: null })
  }
  audio.src = url
  audio.currentTime = 0
  useLibraryPreview.setState({ playingId: item.id })
  try {
    await audio.play()
  } catch {
    if (mine === turn) useLibraryPreview.setState({ playingId: null })
  }
}
