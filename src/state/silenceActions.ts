// Cut the quiet parts out of a clip.
//
// His bar, set when I asked: *"I don't think it's that useful. It could be
// really useful, but you would have to make it really, really good."* So it does
// the whole job in ONE undo step and says exactly what it took, with one click
// to put it back.
//
// ⛔ IT IS NOT A TOGGLE, AND I WILL NOT CALL IT ONE. Making silence come back
// without cutting would mean sequence time mapping through skipped ranges, which
// moves every clip after it: that is a rewrite of how time works, not a feature.
// What it has instead is one undo press for the whole operation and an Undo on
// the toast, the same shape as removing an effect.

import { silentRanges, SILENCE_DEFAULTS, type SilenceOptions } from '../engine/silence'
import { clipEndS, rippleDeleteMany, splitClipOnly } from '../engine/timeline'
import { activeSequence, type Clip, type Sequence } from '../engine/types'
import { wordsForClip } from './transcribeActions'
import { updateActiveSequence, useStore } from './store'
import { useToasts } from './toasts'

/** Two frames: below this a piece is a sliver the splitter would refuse anyway. */
const MIN_PIECE_FRAMES = 2

function locate(seq: Sequence, clipId: string): { clip: Clip; locked: boolean } | null {
  for (const t of seq.tracks) {
    const clip = t.clips.find((c) => c.id === clipId)
    if (clip) return { clip, locked: t.locked }
  }
  return null
}

/** The clip covering `t` on the track that holds `nearId`, after earlier splits moved ids around. */
function idCovering(seq: Sequence, trackId: string, t: number): string | null {
  const track = seq.tracks.find((tr) => tr.id === trackId)
  const hit = track?.clips.find((c) => t > c.startS + 1e-6 && t < clipEndS(c) - 1e-6)
  return hit?.id ?? null
}

const EPS = 1e-4

/**
 * Transcribe the clip, find the runs with no speech in them, and take them out,
 * closing the gaps behind them.
 *
 * Resolves when the edit has landed, or as soon as there was nothing to do.
 * Never throws at the caller: every failure is a toast.
 */
export async function cutQuietParts(clipId: string, opts: SilenceOptions = SILENCE_DEFAULTS): Promise<void> {
  const show = useToasts.getState().show
  const s = useStore.getState()
  const seq0 = activeSequence(s.project)
  const found = locate(seq0, clipId)
  if (!found) return
  if (found.locked) {
    show('Track is locked', 'danger')
    return
  }
  const clip = found.clip
  const asset = s.project.assets[clip.assetId]
  if (!asset?.hasAudio) {
    show('That clip has no sound to read', 'danger')
    return
  }

  let words
  try {
    words = await wordsForClip(clip, asset)
  } catch {
    show('Could not read the speech in that clip', 'danger')
    return
  }
  if (words.length === 0) {
    show('No speech found, so there is nothing to cut around', 'info')
    return
  }

  // ⛔ THE CLIP IS READ AGAIN HERE, because reading it took tens of seconds and
  // NOTHING blocked the timeline while it ran. Every cut below is placed with
  // `clip.startS`, an absolute timeline second, and then applied to whatever the
  // sequence looks like NOW. Drag the clip during the run, or ripple delete
  // anything ahead of it, and those seconds point at different footage: the cuts
  // came out of a clip he never pointed at. The sweep in transcribeActions.ts
  // already re-reads for exactly this reason.
  const liveFound = locate(activeSequence(useStore.getState().project), clipId)
  if (!liveFound) {
    show('That clip is gone now, so nothing was cut', 'info')
    return
  }
  if (liveFound.locked) {
    show('Track is locked', 'danger')
    return
  }
  const live = liveFound.clip
  // A trim or a speed change moves what the word timings MEAN: they are source
  // seconds measured from the `inS` the reading started with. Placing them against
  // a different span would cut in the wrong places while looking like it worked.
  const sameSpan =
    Math.abs(live.inS - clip.inS) < EPS &&
    Math.abs(live.outS - clip.outS) < EPS &&
    Math.abs((live.speed || 1) - (clip.speed || 1)) < EPS
  if (!sameSpan) {
    show('That clip changed while it was being read, so nothing was cut', 'info')
    return
  }

  // ⛔ THE SOURCE SPAN, NOT THE TIMELINE DURATION. extractClipPcm renders
  // `clip.inS -> clip.outS` of the SOURCE at offset 0 and ignores speed, so the
  // word timings are source seconds measured from `inS`. Handing this
  // clipDurationS (which divides by speed) would misplace every cut on any clip
  // that is not at 1x.
  const sourceSpanS = Math.max(0, live.outS - live.inS)
  const ranges = silentRanges(words, sourceSpanS, opts)
  if (ranges.length === 0) {
    show('No quiet parts long enough to cut', 'info')
    return
  }

  const speed = Math.abs(live.speed || 1)
  const seqNow = activeSequence(useStore.getState().project)
  const fps = seqNow.fps > 0 ? seqNow.fps : 30
  const minPieceS = MIN_PIECE_FRAMES / fps
  const trackId = seqNow.tracks.find((t) => t.clips.some((c) => c.id === clipId))?.id
  if (!trackId) return

  let cutS = 0
  let taken = 0
  updateActiveSequence('Cut the quiet parts', (seq) => {
    let next = seq
    const doomed: string[] = []
    for (const r of ranges) {
      const startT = live.startS + r.startS / speed
      const endT = live.startS + r.endS / speed
      if (endT - startT < minPieceS) continue

      const a = idCovering(next, trackId, startT)
      if (a) next = splitClipOnly(next, a, startT)
      const b = idCovering(next, trackId, endT)
      if (b) next = splitClipOnly(next, b, endT)

      // ⛔ ONLY TAKE A PIECE THAT IS EXACTLY THE RANGE. The splitter has a
      // min-piece guard that can decline one side, and a range that only got cut
      // at one end would otherwise delete footage he wanted.
      const track = next.tracks.find((tr) => tr.id === trackId)
      const piece = track?.clips.find(
        (c) => Math.abs(c.startS - startT) < EPS && Math.abs(clipEndS(c) - endT) < EPS,
      )
      if (!piece) continue
      doomed.push(piece.id)
      cutS += endT - startT
      taken++
    }
    if (doomed.length === 0) return seq
    return rippleDeleteMany(next, doomed)
  })

  if (taken === 0) {
    show('The quiet parts were all too short to cut cleanly', 'info')
    return
  }
  show(`Cut ${cutS.toFixed(1)}s of quiet, in ${taken} place${taken === 1 ? '' : 's'}`, 'success', {
    label: 'Undo',
    onClick: () => void import('../collab/collabControl').then((m) => m.performHistoryStep('undo')),
  })
}
