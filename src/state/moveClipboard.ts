// Copy a move off one clip and stamp it onto others.
//
// His ask, 2026-08-17, was for the keyframes to be easier: *"You have to implement
// features so it's actually possible and it's easy to do in our program too."* The
// research behind [[olp-what-makes-a-pro-edit-and-the-one-gap]] put the industry cost
// of hand keyframing zooms at 20 to 30 minutes a video, and the thing this app could
// not do at all was reuse a move he had shaped by hand: he had to perform it again.
//
// ⛔ WHY THIS IS NOT "Paste attributes". That one carries the LOOK, and D99 made it
// deliberately PRESERVE the target's move, because a paste he thinks is about colour
// must not delete motion he made by hand. So the move needs its own pair, and the two
// never fight over the same channels.

import { channelKeyframes, withChannelKeyframes } from '../engine/effects/channels'
import { fitMoveKeyframes, MOVE_CHANNELS } from '../engine/moves'
import { clipDurationS } from '../engine/timeline'
import { activeSequence, type AnimChannel, type Clip, type Keyframe } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

type MoveTracks = Partial<Record<AnimChannel, Keyframe[]>>

let clipboard: MoveTracks | null = null

export const hasClipMove = (): boolean => clipboard !== null

const clipById = (id: string | undefined): Clip | undefined => {
  if (!id) return undefined
  const seq = activeSequence(useStore.getState().project)
  return seq.tracks.flatMap((t) => t.clips).find((c) => c.id === id)
}

/** Copy the move off a clip (defaults to the first selected one). */
export function copyClipMove(clipId?: string): void {
  const clip = clipById(clipId ?? useStore.getState().ui.selection[0])
  if (!clip) {
    useToasts.getState().show('Select a clip to copy the move from', 'danger')
    return
  }
  const tracks: MoveTracks = {}
  let count = 0
  for (const channel of MOVE_CHANNELS) {
    const kfs = channelKeyframes(clip, channel)
    if (kfs.length > 0) {
      tracks[channel] = kfs.map((k) => ({ ...k }))
      count += kfs.length
    }
  }
  if (count === 0) {
    // Copying nothing would arm a paste that silently wipes the target's move,
    // which is worse than saying so.
    useToasts.getState().show('That clip has no move on it', 'danger')
    return
  }
  clipboard = tracks
  useToasts.getState().show('Move copied', 'success')
}

/**
 * Stamp the copied move onto every clip in `ids` (defaults to the selection), in ONE
 * undo step.
 *
 * REPLACES whatever move the target carried, exactly as clicking a tile does: one
 * clip means one move, so a paste that stacked would make the lit tile a lie.
 */
export function pasteClipMove(ids?: Iterable<string>): void {
  const tracks = clipboard
  if (!tracks) {
    useToasts.getState().show('Copy a move first', 'danger')
    return
  }
  const targets = new Set(ids ?? useStore.getState().ui.selection)
  if (targets.size === 0) {
    useToasts.getState().show('Select the clips to paste the move onto', 'danger')
    return
  }
  let done = 0
  updateActiveSequence('Paste move', (seq) => ({
    ...seq,
    tracks: seq.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (!targets.has(clip.id)) return clip
        const durS = clipDurationS(clip)
        let next = clip
        for (const channel of MOVE_CHANNELS) {
          const kfs = tracks[channel]
          next = withChannelKeyframes(next, channel, kfs ? fitMoveKeyframes(kfs, durS) : [])
        }
        done++
        return next
      }),
    })),
  }))
  useToasts.getState().show(done === 1 ? 'Move pasted' : `Move pasted onto ${done} clips`, 'success')
}
