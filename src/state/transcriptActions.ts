// The Words panel's two verbs: listen to a clip, and cut the timeline by its
// words. The words live on the MEDIA in source seconds (MediaAsset.words), so a
// file listened to once reads out on every clip cut from it, and a clip that
// is trimmed or split keeps its words without listening again.
//
// The reading itself is engine/transcriptCut.ts, pure. This file is only the
// store side: where the words go, and the one undo step a cut makes.

import { plural } from '../engine/plural'
import { cutRange, mergeWords, wordsOnTimeline } from '../engine/transcriptCut'
import { activeSequence, type Id } from '../engine/types'
import { updateActiveSequence, useStore } from './store'
import { listenToClip, listenToClips } from './transcribeActions'

/**
 * Listen to one clip and keep its words on its media. The clip's own source
 * span is what was heard, so that span is replaced and the rest of the file's
 * words, from other clips, are kept.
 */
export async function listenForWords(clipId: Id): Promise<void> {
  const heard = await listenToClip(clipId)
  if (!heard) return
  // The words are already in the media's seconds, from the clip as it was heard,
  // so where the clip sits now does not matter.
  const { clip, asset, words } = heard
  useStore.getState().dispatch(`Listen to ${asset.name}`, (p) => {
    const a = p.assets[asset.id]
    return a ? { ...p, assets: { ...p.assets, [a.id]: { ...a, words: mergeWords(a.words, words, clip.inS, clip.outS) } } } : p
  })
}

/** The clips the Words tab has no words for yet, that can be listened to. */
export function clipsWithoutWords(): Id[] {
  const s = useStore.getState()
  return wordsOnTimeline(activeSequence(s.project), s.project.assets)
    .filter((row) => row.words.length === 0 && row.clip.speed > 0)
    .map((row) => row.clip.id)
}

/**
 * Listen to every clip the Words tab has no words for, one after another, and
 * keep all of it in ONE undo step. Before this it was one button per clip, and
 * a twenty clip edit was twenty presses.
 */
export async function listenForEveryClip(): Promise<void> {
  const ids = clipsWithoutWords()
  if (ids.length === 0) return
  const heard = await listenToClips(ids)
  if (heard.length === 0) return
  useStore.getState().dispatch(`Listen to ${plural(heard.length, 'clip')}`, (p) => {
    let assets = p.assets
    for (const { clip, asset, words } of heard) {
      const a = assets[asset.id]
      if (a) assets = { ...assets, [a.id]: { ...a, words: mergeWords(a.words, words, clip.inS, clip.outS) } }
    }
    return assets === p.assets ? p : { ...p, assets }
  })
}

/** Take the words' stretch of timeline out and close the gap, in one undo step. The playhead lands on the cut. */
export function cutWords(startS: number, endS: number, count: number): void {
  updateActiveSequence(count === 1 ? 'Cut a word' : `Cut ${count} words`, (seq) => cutRange(seq, startS, endS))
  useStore.getState().setUI({ playheadS: startS })
}
