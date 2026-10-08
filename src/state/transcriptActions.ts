// The Words panel's two verbs: listen to a clip, and cut the timeline by its
// words. The words live on the MEDIA in source seconds (MediaAsset.words), so a
// file listened to once reads out on every clip cut from it, and a clip that
// is trimmed or split keeps its words without listening again.
//
// The reading itself is engine/transcriptCut.ts, pure. This file is only the
// store side: where the words go, and the one undo step a cut makes.

import { captionAfterCut } from '../engine/captions/captionStyle'
import { plural } from '../engine/plural'
import { cutRange, keepHeardWords, wordsOnTimeline } from '../engine/transcriptCut'
import { activeSequence, type Clip, type Id } from '../engine/types'
import { isCaptionTrack } from './captionActions'
import { updateActiveSequence, useStore } from './store'
import { listenToClip, listenToClips, wordLagNow } from './transcribeActions'

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
  const lagS = wordLagNow()
  useStore.getState().dispatch(`Listen to ${asset.name}`, (p) => {
    const a = p.assets[asset.id]
    return a ? { ...p, assets: { ...p.assets, [a.id]: keepHeardWords(a, words, clip.inS, clip.outS, lagS) } } : p
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
  const lagS = wordLagNow()
  useStore.getState().dispatch(`Listen to ${plural(heard.length, 'clip')}`, (p) => {
    let assets = p.assets
    for (const { clip, asset, words } of heard) {
      const a = assets[asset.id]
      if (a) assets = { ...assets, [a.id]: keepHeardWords(a, words, clip.inS, clip.outS, lagS) }
    }
    return assets === p.assets ? p : { ...p, assets }
  })
}

/** Take the words' stretch of timeline out and close the gap, in one undo step. The playhead lands on the cut. */
export function cutWords(startS: number, endS: number, count: number): void {
  updateActiveSequence(count === 1 ? 'Cut a word' : `Cut ${count} words`, (seq) => {
    // Each caption as it was, to tell which ones the cut split.
    const was = new Map<Id, Clip>()
    for (const t of seq.tracks) if (isCaptionTrack(t) && !t.locked) for (const c of t.clips) was.set(c.id, c)
    const cut = cutRange(seq, startS, endS)
    // ⛔ R-1. ONLY a caption the cut split is re-texted, and only at the edge
    // the cut made. Every other caption is handed back as the same object.
    const reText = (c: Clip): Clip | null => {
      const before = was.get(c.id)
      // A piece with a new id is the half after a cut: its start is the cut.
      // A piece that kept its id but lost its tail is the half before one.
      const piece = { start: !before, end: before !== undefined && c.outS !== before.outS }
      return captionAfterCut(c, piece)
    }
    return {
      ...cut,
      tracks: cut.tracks.map((t) =>
        !isCaptionTrack(t) || t.locked
          ? t
          : { ...t, clips: t.clips.map(reText).filter((c): c is NonNullable<typeof c> => c !== null) },
      ),
    }
  })
  useStore.getState().setUI({ playheadS: startS })
}
