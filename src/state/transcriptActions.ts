// The Words panel's two verbs: listen to a clip, and cut the timeline by its
// words. The words live on the MEDIA in source seconds (MediaAsset.words), so a
// file listened to once reads out on every clip cut from it, and a clip that
// is trimmed or split keeps its words without listening again.
//
// The reading itself is engine/transcriptCut.ts, pure. This file is only the
// store side: where the words go, and the one undo step a cut makes.

import { cutRange, mergeWords, toSource } from '../engine/transcriptCut'
import { activeSequence, type Id } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { listenToClip } from './transcribeActions'

/**
 * Listen to one clip and keep its words on its media. The clip's own source
 * span is what was heard, so that span is replaced and the rest of the file's
 * words, from other clips, are kept.
 */
export async function listenForWords(clipId: Id): Promise<void> {
  const heard = await listenToClip(clipId)
  if (!heard) return
  const s = useStore.getState()
  const clip = activeSequence(s.project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipId)
  const asset = clip ? s.project.assets[clip.assetId] : undefined
  if (!clip || !asset) return
  const inSource = heard.map((w) => ({ text: w.text, startS: toSource(clip, w.startS), endS: toSource(clip, w.endS) }))
  const words = mergeWords(asset.words, inSource, clip.inS, clip.outS)
  s.dispatch(`Listen to ${asset.name}`, (p) => {
    const a = p.assets[asset.id]
    return a ? { ...p, assets: { ...p.assets, [a.id]: { ...a, words } } } : p
  })
}

/** Take the words' stretch of timeline out and close the gap, in one undo step. The playhead lands on the cut. */
export function cutWords(startS: number, endS: number, count: number): void {
  updateActiveSequence(count === 1 ? 'Cut a word' : `Cut ${count} words`, (seq) => cutRange(seq, startS, endS))
  useStore.getState().setUI({ playheadS: startS })
}
