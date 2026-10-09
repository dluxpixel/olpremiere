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
//
// ONE PASS FOR A SELECTION, 2026-10-07 (AU-8). A dubbed take lands as several
// clips, one per pause, and each used to need its own right-click and its own
// undo step. Every clip he picked is read, then all of them are cut in ONE undo
// step. And the words are KEPT on the media, the way the Words panel keeps them:
// a stretch of a file already listened to is never listened to again, by the
// Words panel or by this.

import { correctWordLag } from '../engine/captions/wordTiming'
import { getCaptionLanguage, modelFor, whisperModel } from '../engine/captions/transcribeConfig'
import { silentRanges, SILENCE_DEFAULTS, type CutRange, type SilenceOptions } from '../engine/silence'
import { clipEndS, clipGroupIds, rippleDeleteMany, splitGroup } from '../engine/timeline'
import { heardCovers, mergeHeardSpans, mergeWords, toSource } from '../engine/transcriptCut'
import { activeSequence, type Clip, type Id, type MediaAsset, type Sequence, type SpokenWord } from '../engine/types'
import { isCancel, wordsForCut } from './transcribeActions'
import { keptTimingMessage, newRippleReport } from './rippleNotice'
import { useStore } from './store'
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

const locateIn = (seq: Sequence, id: string): Clip | undefined => locate(seq, id)?.clip

/** A linked partner of `clipId` sits on a locked track. */
function partnerLocked(seq: Sequence, clipId: string): boolean {
  const ids = new Set(clipGroupIds(seq, clipId))
  return seq.tracks.some((t) => t.locked && t.clips.some((c) => ids.has(c.id)))
}

/**
 * Why a clip cannot be cut: `refused` said on its own when it was the only one,
 * `short` counted in the summary when it was one of a selection ("1 playing
 * backwards").
 */
type Refusal = { refused: string; short: string; tone: 'danger' | 'info' }

/** Whether a clip can be cut at all, before anything is read. */
function readyToRead(
  seq: Sequence,
  assets: Record<Id, MediaAsset>,
  clipId: string,
): { clip: Clip; asset: MediaAsset } | Refusal | null {
  const found = locate(seq, clipId)
  if (!found) return null
  if (found.locked) return { refused: 'Track is locked', short: 'on a locked track', tone: 'danger' }
  const clip = found.clip
  const asset = assets[clip.assetId]
  if (!asset?.hasAudio) return { refused: 'That clip has no sound to read', short: 'with no sound', tone: 'danger' }
  // The same refusal the Words panel and captions got on 2026-09-23: a reversed
  // clip's sound is read FORWARD, so its words would be placed backwards and
  // the cuts would land on his speech. Speed 0 makes no sound at all.
  if (clip.speed <= 0) {
    return clip.speed < 0
      ? { refused: 'This clip plays backwards, so its quiet parts cannot be cut', short: 'playing backwards', tone: 'danger' }
      : { refused: 'This clip is stopped, so there is no sound to read', short: 'stopped', tone: 'danger' }
  }
  // A linked clip is cut WITH its partner (below), so a partner on a locked
  // track would be changed behind the lock. Refuse before the long read.
  if (partnerLocked(seq, clipId)) {
    return { refused: 'Its linked clip is on a locked track, so nothing was cut', short: 'linked to a locked track', tone: 'danger' }
  }
  return { clip, asset }
}

/**
 * The tracks a clip's cut moves: its own and every linked partner's. Two clips
 * whose cuts move the same tracks are on the same line.
 */
function lineOf(seq: Sequence, clipId: string): string {
  const ids = new Set(clipGroupIds(seq, clipId))
  return seq.tracks
    .filter((t) => t.clips.some((c) => ids.has(c.id)))
    .map((t) => t.id)
    .join('|')
}

/**
 * The recogniser's lag, which the media's words may or may not have taken off.
 * Words kept by the Words tab and the caption doors are where he SAID them
 * (MediaAsset.wordsOnVoice); the cutter keeps the recogniser's own timings,
 * its air either side of a cut being tuned against them, and says so by leaving
 * the mark off. So it puts the lag back on words that have it taken off, and
 * takes it off the words it adds to media that has.
 */
const wordLagS = (): number => whisperModel(modelFor(getCaptionLanguage())).wordLagS

/** What one clip's reading came back with. */
interface Heard {
  /** The clip as it was READ: the words are placed against it. */
  clip: Clip
  asset: MediaAsset
  /** His speech, in seconds into the clip's source span (from its in point). */
  words: { startS: number; endS: number }[]
  /** What the recogniser heard, in SOURCE seconds, to keep on the media. Null when the media already knew. */
  fresh: SpokenWord[] | null
}

/**
 * The speech in one clip: what the media already knows when every second of
 * the clip has been listened to, else a listening.
 */
async function hear(
  clip: Clip,
  asset: MediaAsset,
  queue: { index: number; total: number } | null,
): Promise<Heard | 'busy' | 'failed' | 'cancelled'> {
  if (heardCovers(asset.heardSpans, clip.inS, clip.outS)) {
    // Every word that sounds inside the span, one running in across an edge too.
    const lateS = asset.wordsOnVoice ? wordLagS() : 0
    const words = (asset.words ?? [])
      .map((w) => ({ startS: w.startS + lateS, endS: w.endS + lateS }))
      .filter((w) => w.endS > clip.inS && w.startS < clip.outS)
      .map((w) => ({ startS: w.startS - clip.inS, endS: w.endS - clip.inS }))
    return { clip, asset, words, fresh: null }
  }
  let got
  try {
    got = await wordsForCut(clip, asset, queue)
  } catch (err) {
    return isCancel(err) ? 'cancelled' : 'failed'
  }
  if (got === null) return 'busy'
  // ⛔ wordsForCut HANDS BACK TIMELINE SECONDS (timelineWords: clip start plus
  // source time over speed), and silentRanges wants seconds into the clip's own
  // source span. Using them as they came added the clip start twice and divided
  // by the speed twice: on any clip not sitting at 0:00 every cut landed late
  // and ate his first words, and a take placed later than its own length was
  // deleted whole. Undone against `clip`, the clip that was READ, because that
  // is the one the words were placed on.
  const readSpeed = Math.abs(clip.speed || 1)
  const words = got.map((w) => ({
    startS: (w.startS - clip.startS) * readSpeed,
    endS: (w.endS - clip.startS) * readSpeed,
  }))
  const fresh = got.map((w) => ({ text: w.text, startS: toSource(clip, w.startS), endS: toSource(clip, w.endS) }))
  return { clip, asset, words, fresh }
}

/** One clip's quiet parts, on the timeline, ready to cut. */
interface Planned {
  heard: Heard
  trackId: string
  /** Timeline seconds to take out, in order. */
  cuts: { startT: number; endT: number }[]
}

/**
 * Transcribe the clip, find the runs with no speech in them, and take them out,
 * closing the gaps behind them. Given several clips (a selection), every one is
 * read and all of them are cut in ONE undo step.
 *
 * Resolves when the edit has landed, or as soon as there was nothing to do.
 * Never throws at the caller: every failure is a toast.
 */
export async function cutQuietParts(clipIds: string | readonly string[], opts: SilenceOptions = SILENCE_DEFAULTS): Promise<void> {
  const ids = typeof clipIds === 'string' ? [clipIds] : [...clipIds]
  const show = useToasts.getState().show
  const s = useStore.getState()
  const seq0 = activeSequence(s.project)

  // One reading per take: a picture and its sound are one take, and cutting the
  // sound cuts the picture with it (below).
  const todo: { clip: Clip; asset: MediaAsset }[] = []
  const taken = new Set<string>()
  let firstRefusal: Refusal | null = null
  /** Clips of the selection passed over before reading, counted by why. */
  const refusedBy = new Map<string, number>()
  // ⛔ ONE LINE AT A TIME (review 2026-10-08). Each cut ripples only the tracks
  // it cuts, so a marquee over gameplay on V1/A1 and his voice on A2 cut each
  // against its OWN quiet parts and slid the two apart by different amounts,
  // and nothing said so. Only clips whose cuts move the same tracks as the first
  // one (the clip he right-clicked) are cut; the tracks they do not cut follow
  // them as any ripple does, and the clips on other lines are named, untouched.
  let line: string | null = null
  let otherLine = 0
  for (const id of ids) {
    if (taken.has(id)) continue
    const r = readyToRead(seq0, s.project.assets, id)
    if (!r) continue
    if ('refused' in r) {
      firstRefusal ??= r
      refusedBy.set(r.short, (refusedBy.get(r.short) ?? 0) + 1)
      continue
    }
    const group = clipGroupIds(seq0, id)
    for (const g of group) taken.add(g)
    const lineHere = lineOf(seq0, id)
    line ??= lineHere
    if (lineHere !== line) {
      otherLine++
      continue
    }
    todo.push(r)
  }
  if (todo.length === 0) {
    if (firstRefusal) show(firstRefusal.refused, firstRefusal.tone)
    return
  }
  // The single clip door, with its own words for every outcome, only when he
  // pointed at one clip and nothing else was passed over.
  const one = todo.length === 1 && refusedBy.size === 0 && otherLine === 0

  const heard: Heard[] = []
  const unread: string[] = []
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i]!
    const got = await hear(t.clip, t.asset, todo.length === 1 ? null : { index: i + 1, total: todo.length })
    if (got === 'cancelled') return
    if (got === 'busy') {
      show('A transcription is already running', 'danger')
      return
    }
    if (got === 'failed') {
      if (one) {
        show('Could not read the speech in that clip', 'danger')
        return
      }
      unread.push(t.asset.name)
      continue
    }
    heard.push(got)
  }

  // ⛔ EVERY CLIP IS READ AGAIN HERE, because reading took tens of seconds and
  // NOTHING blocked the timeline while it ran. Every cut below is placed with
  // the clip's `startS`, an absolute timeline second, and then applied to
  // whatever the sequence looks like NOW. Drag the clip during the run, or
  // ripple delete anything ahead of it, and those seconds point at different
  // footage: the cuts came out of a clip he never pointed at. The sweep in
  // transcribeActions.ts already re-reads for exactly this reason.
  const seqNow = activeSequence(useStore.getState().project)
  const fps = seqNow.fps > 0 ? seqNow.fps : 30
  const minPieceS = MIN_PIECE_FRAMES / fps
  const plans: Planned[] = []
  let silent = 0
  let changed = 0
  for (const h of heard) {
    if (h.words.length === 0) {
      if (one) {
        show('No speech found, so there is nothing to cut around', 'info')
        return
      }
      silent++
      continue
    }
    const liveFound = locate(seqNow, h.clip.id)
    if (!liveFound) {
      if (one) {
        show('That clip is gone now, so nothing was cut', 'info')
        return
      }
      changed++
      continue
    }
    if (liveFound.locked || partnerLocked(seqNow, h.clip.id)) {
      if (one) {
        show('Track is locked', 'danger')
        return
      }
      changed++
      continue
    }
    const live = liveFound.clip
    // A trim or a speed change moves what the word timings MEAN: they are source
    // seconds measured from the `inS` the reading started with. Placing them against
    // a different span would cut in the wrong places while looking like it worked.
    const sameSpan =
      Math.abs(live.inS - h.clip.inS) < EPS &&
      Math.abs(live.outS - h.clip.outS) < EPS &&
      Math.abs((live.speed || 1) - (h.clip.speed || 1)) < EPS
    if (!sameSpan) {
      if (one) {
        show('That clip changed while it was being read, so nothing was cut', 'info')
        return
      }
      changed++
      continue
    }

    // ⛔ THE SOURCE SPAN, NOT THE TIMELINE DURATION. extractClipPcm renders
    // `clip.inS -> clip.outS` of the SOURCE at offset 0 and ignores speed, so the
    // word timings are source seconds measured from `inS`. Handing this
    // clipDurationS (which divides by speed) would misplace every cut on any clip
    // that is not at 1x.
    const sourceSpanS = Math.max(0, live.outS - live.inS)
    const ranges: CutRange[] = silentRanges(h.words, sourceSpanS, opts)
    if (ranges.length === 0 && one) {
      show('No quiet parts long enough to cut', 'info')
      return
    }
    const speed = Math.abs(live.speed || 1)
    const cuts = ranges
      .map((r) => ({ startT: live.startS + r.startS / speed, endT: live.startS + r.endS / speed }))
      .filter((c) => c.endT - c.startT >= minPieceS)
    const trackId = seqNow.tracks.find((t) => t.clips.some((c) => c.id === live.id))?.id
    if (cuts.length > 0 && trackId) plans.push({ heard: h, trackId, cuts })
  }

  let cutS = 0
  let places = 0
  let clipsCut = 0
  /** Quiet parts left alone because a linked clip does not run exactly across them (a J or L cut). */
  let partnerShort = 0
  const report = newRippleReport()
  if (plans.length > 0) {
    useStore.getState().dispatch(todo.length === 1 ? 'Cut the quiet parts' : `Cut the quiet parts of ${todo.length} clips`, (p) => {
      const seq = p.sequences[p.activeSequenceId]
      let next = seq
      const doomed: string[] = []
      for (const plan of plans) {
        let took = 0
        for (const { startT, endT } of plan.cuts) {
          // ⛔ THE PICTURE IS CUT WITH ITS SOUND. splitGroup cuts every linked
          // member at the same instant and the ripple below takes the whole group,
          // so the picture and the voice close up together. This used to cut the
          // sound alone (splitClipOnly): the picture kept playing the quiet part
          // and his lips ran ahead of his voice by everything cut. An unlinked clip
          // has no group, so splitGroup is a plain split for it.
          const before = next
          const a = idCovering(next, plan.trackId, startT)
          // A linked clip that does not run right across the range (a J or L
          // cut) makes the split refuse, all or nothing: counted, so the toast
          // says that and not that the quiet part was too short.
          const runsAcross = (id: string): boolean => {
            const c = locateIn(next, id)
            return !!c && c.startS <= startT + EPS && clipEndS(c) >= endT - EPS
          }
          const partnerOff = a !== null && !clipGroupIds(next, a).every(runsAcross)
          if (a) next = splitGroup(next, a, startT)
          const b = idCovering(next, plan.trackId, endT)
          if (b) next = splitGroup(next, b, endT)

          // ⛔ ONLY TAKE A PIECE THAT IS EXACTLY THE RANGE. The splitter has a
          // min-piece guard that can decline one side, and a range that only got cut
          // at one end would otherwise delete footage he wanted. The same holds for
          // every linked partner: one trimmed on its own may run past the range,
          // and the ripple deletes the whole group.
          const track = next.tracks.find((tr) => tr.id === plan.trackId)
          const exact = (c: Clip) => Math.abs(c.startS - startT) < EPS && Math.abs(clipEndS(c) - endT) < EPS
          const piece = track?.clips.find(exact)
          const group = piece ? clipGroupIds(next, piece.id).map((id) => locateIn(next, id)) : []
          if (!piece || !group.every((c) => c && exact(c))) {
            // Nothing taken here, so no stray cut marks left behind either.
            if (partnerOff) partnerShort++
            next = before
            continue
          }
          doomed.push(piece.id)
          cutS += endT - startT
          places++
          took++
        }
        if (took > 0) clipsCut++
      }
      if (doomed.length === 0) return p
      const cutSeq = rippleDeleteMany(next, doomed, report)
      // What was heard stays on the media, in the same undo step: undo the cut
      // and the words it heard go with it.
      const assets = { ...p.assets }
      for (const plan of plans) {
        const fresh = plan.heard.fresh
        const a = assets[plan.heard.asset.id]
        if (!fresh || !a) continue
        const { inS, outS } = plan.heard.clip
        // Into words that are where he said them, the recogniser's timings would sit a lag late.
        // Taking the lag off can carry a first word back past the clip's in point, and the
        // Words tab drops a word that starts before it, so no word starts before inS.
        const onVoice = a.wordsOnVoice ? correctWordLag(fresh, wordLagS()) : fresh
        const added = onVoice.map((w) => {
          const startS = Math.max(w.startS, inS)
          return { ...w, startS, endS: Math.max(w.endS, startS) }
        })
        assets[a.id] = { ...a, words: mergeWords(a.words, added, inS, outS), heardSpans: mergeHeardSpans(a.heardSpans, inS, outS) }
      }
      return { ...p, assets, sequences: { ...p.sequences, [seq.id]: cutSeq } }
    })
  }

  // What it could not do, said once, on the same line.
  const passed = [
    unread.length > 0 ? `could not read ${unread.length === 1 ? unread[0] : `${unread.length} clips`}` : null,
    silent > 0 ? `${silent} with no speech` : null,
    changed > 0 ? `${changed} changed while being read` : null,
    ...[...refusedBy].map(([why, n]) => `${n} ${why}`),
    otherLine > 0 ? `${otherLine} on ${otherLine === 1 ? 'another track' : 'other tracks'} left alone, so the tracks stay in sync` : null,
  ].filter((x): x is string => x !== null)
  const left = passed.length > 0 ? ` (${passed.join(', ')})` : ''

  if (places === 0) {
    // Said as it is: a quiet part the linked clip does not run across (a J or L
    // cut) was not too short, it was left alone so the pair is never cut apart.
    const why =
      partnerShort > 0
        ? one
          ? 'Its linked clip does not run across the quiet parts, so nothing was cut'
          : `No quiet part could be cut with its linked clip${left}`
        : one
          ? 'The quiet parts were all too short to cut cleanly'
          : `No quiet parts long enough to cut${left}`
    show(why, 'info')
    return
  }
  // One toast, not two: a track that kept its timing is said on the same line.
  const kept = keptTimingMessage(seqNow, report)
  const across = one ? '' : `, across ${clipsCut} clip${clipsCut === 1 ? '' : 's'}`
  const said = `Cut ${cutS.toFixed(1)}s of quiet, in ${places} place${places === 1 ? '' : 's'}${across}${left}`
  show(kept ? `${said}. ${kept}` : said, 'success', {
    label: 'Undo',
    onClick: () => void import('../collab/collabControl').then((m) => m.performHistoryStep('undo')),
  })
}
