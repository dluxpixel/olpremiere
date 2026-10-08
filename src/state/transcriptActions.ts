// The Words panel's two verbs: listen to a clip, and cut the timeline by its
// words. The words live on the MEDIA in source seconds (MediaAsset.words), so a
// file listened to once reads out on every clip cut from it, and a clip that
// is trimmed or split keeps its words without listening again.
//
// The reading itself is engine/transcriptCut.ts, pure. This file is only the
// store side: where the words go, and the one undo step a cut makes.

import { cutRange, mergeHeardSpans, mergeWords, toSource } from '../engine/transcriptCut'
import { activeSequence, type Id } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { listenToClip } from './transcribeActions'

/**
 * Listen to one clip and keep its words on its media. The clip's own source
 * span is what was heard, so that span is replaced and the rest of the file's
 * words, from other clips, are kept.
 */
export async function listenForWords(clipId: Id): Promise<void> {
  // ⛔ THE CLIP AS IT IS HEARD, read in the same tick listenToClip reads it. The
  // words come back placed on the timeline through THIS clip, and listening
  // takes tens of seconds with the timeline free to edit. Turned back through
  // the clip as it is when the listening ends, a drag or a trim meanwhile moved
  // every stored word by as much, onto sound he never said there.
  const clip = activeSequence(useStore.getState().project)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === clipId)
  const heard = await listenToClip(clipId)
  if (!heard || !clip) return
  const s = useStore.getState()
  const asset = s.project.assets[clip.assetId]
  if (!asset) return
  const inSource = heard.map((w) => ({ text: w.text, startS: toSource(clip, w.startS), endS: toSource(clip, w.endS) }))
  s.dispatch(`Listen to ${asset.name}`, (p) => {
    const a = p.assets[asset.id]
    if (!a) return p
    // What it heard, and THAT it heard this stretch: a quiet stretch is then known
    // to be quiet, and Cut the quiet parts can use it without listening again.
    const words = mergeWords(a.words, inSource, clip.inS, clip.outS)
    const heardSpans = mergeHeardSpans(a.heardSpans, clip.inS, clip.outS)
    return { ...p, assets: { ...p.assets, [a.id]: { ...a, words, heardSpans } } }
  })
}

/** Take the words' stretch of timeline out and close the gap, in one undo step. The playhead lands on the cut. */
export function cutWords(startS: number, endS: number, count: number): void {
  updateActiveSequence(count === 1 ? 'Cut a word' : `Cut ${count} words`, (seq) => cutRange(seq, startS, endS))
  useStore.getState().setUI({ playheadS: startS })
}
