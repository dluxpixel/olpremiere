// A reel plan, turned into an ordinary project (the gym auto edit, phase 1).
//
// PURE: no store, no disk, no toasts. Given a checked plan and the media assets its
// clips became, it lays out the sequence the plan describes: shots on V1, their sound
// beside them on A1, titles on the tracks above, and one word caption per plan word
// on a Captions track. Nothing here is special to the plan: every clip, title and
// caption is the app's own, so David watches, tweaks and exports it like any project.
//
// What a plan does NOT change
// - `rotation` on a clip is what ffprobe reported. The app's decoders already honor
//   the file's own rotation flag, so turning the picture again would double rotate it.
//   It is read and left alone.
// - `audio.music` and `audio.beats` are checked by the validator and not placed yet.

import { REEL_FRAME, type ReelPlan, type ReelPlanTitle } from '../../electron/reelPlan'
import { applyAppearanceToClip } from '../engine/anim/appearance'
import { captionClips, type CaptionChunk } from '../engine/captions/captions'
import { BUILTIN_CAPTION_STYLES, dressCaption } from '../engine/captions/captionStyle'
import { wrapLinesWith } from '../engine/render/titleRaster'
import { addTrack, fitNewClipToFrame, recomputeDuration } from '../engine/timeline'
import {
  activeSequence,
  audioTracks,
  clipEndS,
  defaultTitleDef,
  newClipFromAsset,
  newId,
  newProject,
  newTitleClip,
  videoTracks,
  type Clip,
  type MediaAsset,
  type Project,
  type Sequence,
  type TitleDef,
  type Track,
} from '../engine/types'
import { CAPTION_TRACK_NAME } from './captionActions'
import { titleLookById, type TitleLook } from './titleShelf'

/** The look a plan title wears when its style is one we do not know: a sentence on a dark bar. */
const FALLBACK_LOOK_ID = 'caption-bar'

/**
 * A plan title's `style`, as one of the ready made looks on the title shelf. "hook" is
 * the big headline; the rest are the other voices a reel uses. Anything else wears the
 * fallback, so a style the writer invents later still lands as a readable title.
 */
export const REEL_TITLE_LOOKS: Readonly<Record<string, string>> = {
  hook: 'headline-pop',
  punch: 'yellow-punch',
  cta: 'yellow-punch',
  body: 'caption-bar',
  note: 'quiet-subtitle',
  chapter: 'chapter-card',
}

export function reelTitleLook(style: string): TitleLook {
  const wanted = REEL_TITLE_LOOKS[style.trim().toLowerCase()] ?? FALLBACK_LOOK_ID
  return titleLookById(wanted) ?? titleLookById(FALLBACK_LOOK_ID)!
}

/** The smallest a title is shrunk to in order to fit its box. */
const MIN_TITLE_PX = 28
/** How much narrower each step down is. */
const SHRINK_STEP = 0.92
/**
 * Average glyph width as a share of the font size, deliberately on the wide side so a
 * title is shrunk a step too early rather than run past its box. Capitals are wider.
 */
const EM_LOWER = 0.62
const EM_UPPER = 0.74

/** How many problems a refusal names before it says how many more there are. */
const PROBLEMS_SHOWN = 3

/**
 * One line for a toast from every problem a refused plan had: the first few in full
 * and a count of the rest. The whole list goes to the console, so nothing is lost.
 */
export function reelPlanRefusalMessage(problems: readonly string[]): string {
  const shown = problems.slice(0, PROBLEMS_SHOWN).join(' ')
  const more = problems.length - PROBLEMS_SHOWN
  const tail = more > 0 ? ` And ${more} more.` : ''
  return `This reel plan was not imported. ${shown}${tail}`
}

/** The empty project a plan is built into: the 9:16 frame at the plan's frame rate. */
export function newReelPlanProject(plan: ReelPlan, name: string): Project {
  const p = newProject(name, { w: REEL_FRAME.w, h: REEL_FRAME.h })
  const id = p.activeSequenceId
  return {
    ...p,
    sequences: { ...p.sequences, [id]: { ...p.sequences[id], fps: plan.fps } },
    settings: { ...p.settings, fps: plan.fps },
  }
}

/** A name for the project from the plan file's name: no extension, or "Reel plan". */
export function reelPlanProjectName(fileName: string): string {
  const base = fileName.replace(/\.json$/i, '').trim()
  return base.length > 0 ? base : 'Reel plan'
}

// ---- time on the frame grid -------------------------------------------------

interface Span {
  startF: number
  endF: number
}
/** A span on the frame grid that also keeps the plan's own times it was rounded from. */
interface TimedSpan extends Span {
  atS: number
  endS: number
}
const toFrame = (s: number, fps: number): number => Math.round(s * fps)
/** A span on the frame grid, at least one frame long. */
function spanOf(at: number, dur: number, fps: number): TimedSpan {
  const startF = toFrame(at, fps)
  return { startF, endF: Math.max(startF + 1, toFrame(at + dur, fps)), atS: at, endS: at + dur }
}
/**
 * Spans sorted by start, each ended where the next begins when rounding made them touch.
 * Two pieces the plan made contiguous (within a millisecond) can round one frame apart,
 * which would leave a black frame between two cuts; the later one then starts where the
 * earlier ends. A gap the plan really has is kept.
 */
function noOverlap(spans: TimedSpan[]): Span[] {
  return spans.map((s, i) => {
    const prev = spans[i - 1]
    const next = spans[i + 1]
    const meets = prev !== undefined && s.startF - prev.endF === 1 && Math.abs(s.atS - prev.endS) <= 1e-3
    return {
      startF: meets ? prev.endF : s.startF,
      endF: next && s.endF > next.startF ? next.startF : s.endF,
    }
  })
}

// ---- titles -----------------------------------------------------------------

/**
 * Put a title's words inside the plan's box. The title raster wraps at a fixed width
 * for the whole frame and centres the block on the frame plus the offsets, so the
 * offsets move the block to the middle of the box, and the lines are broken here, and
 * the type shrunk in steps, until the block fits the box. Never below MIN_TITLE_PX.
 */
function fitTitleToBox(def: TitleDef, box: ReelPlanTitle['box']): TitleDef {
  const [, , boxW, boxH] = box
  const pad = def.box?.paddingPx ?? 0
  const stroke = def.outline?.widthPx ?? 0
  const availW = Math.max(40, boxW - 2 * pad - stroke)
  const availH = Math.max(20, boxH - 2 * pad - stroke)
  const em = def.textCase === 'upper' ? EM_UPPER : EM_LOWER
  for (let size = def.fontSizePx; ; size = Math.floor(size * SHRINK_STEP)) {
    const px = Math.max(size, MIN_TITLE_PX)
    const measure = (s: string): number => s.length * px * em
    const lines = wrapLinesWith(measure, def.text, availW)
    const widest = Math.max(...lines.map(measure))
    const height = lines.length * px * def.lineHeight
    if (px === MIN_TITLE_PX || (widest <= availW && height <= availH)) {
      return { ...def, fontSizePx: px, text: lines.join('\n') }
    }
  }
}

function titleClipFor(t: ReelPlanTitle, span: Span, fps: number): Clip {
  const look = reelTitleLook(t.style)
  const [x, y, w, h] = t.box
  const placed: TitleDef = {
    ...defaultTitleDef(t.text),
    ...look.style,
    // The plan's box decides where it sits, centred in it.
    align: 'center',
    vAlign: 'middle',
    offsetXPx: x + w / 2 - REEL_FRAME.w / 2,
    offsetYPx: y + h / 2 - REEL_FRAME.h / 2,
  }
  const clip = newTitleClip(fitTitleToBox(placed, t.box), span.startF / fps, (span.endF - span.startF) / fps)
  return applyAppearanceToClip(clip, look.appearance, REEL_FRAME.w, REEL_FRAME.h)
}

// ---- the sequence -----------------------------------------------------------

export interface ReelPlanBuild {
  seq: Sequence
  /** Things the plan asked for that the media could not give, in plain words. */
  warnings: string[]
}

const withTrackClips = (seq: Sequence, trackId: string, clips: Clip[]): Sequence => ({
  ...seq,
  tracks: seq.tracks.map((t) => (t.id === trackId ? { ...t, clips } : t)),
})

const overlaps = (track: Track, clip: Clip): boolean =>
  track.clips.some((c) => c.startS < clipEndS(clip) - 1e-6 && clipEndS(c) > clip.startS + 1e-6)

/**
 * Lay a checked plan out on `base` (an empty 9:16 sequence). `assets` is the media of
 * each plan clip, by the plan's clip id. Throws when a clip has no media: the caller
 * imports every clip first and does not get here otherwise.
 */
export function applyReelPlan(base: Sequence, plan: ReelPlan, assets: Readonly<Record<string, MediaAsset>>): ReelPlanBuild {
  const fps = plan.fps
  const warnings: string[] = []
  const limitF = toFrame(plan.duration, fps)
  let seq: Sequence = { ...base, fps, width: REEL_FRAME.w, height: REEL_FRAME.h }

  // ---- the shots: V1, with their sound on A1 ----
  const v1 = videoTracks(seq)[0]
  const a1 = audioTracks(seq)[0]
  const rawSpans = plan.timeline.map((s) => spanOf(s.at, s.src_out - s.src_in, fps))
  const shotSpans = noOverlap(rawSpans)
  const videoClips: Clip[] = []
  const audioClips: Clip[] = []
  plan.timeline.forEach((shot, i) => {
    const asset = assets[shot.clip]
    if (!asset) throw new Error(`reel plan: no media for clip ${shot.clip}`)
    const span = shotSpans[i]
    let frames = span.endF - span.startF
    if (frames < 1) {
      warnings.push(`Shot ${i + 1} is shorter than one frame, so it was left out.`)
      return
    }
    // Never ask a file for more than it has. A shot cut short leaves a gap, not a shift.
    if (asset.durationS > 0) {
      const room = Math.floor((asset.durationS - shot.src_in) * fps + 1e-6)
      if (room < frames) {
        if (room < 1) {
          warnings.push(`Shot ${i + 1} starts past the end of ${asset.name}, so it was left out.`)
          return
        }
        // The frame that closed a rounding gap is ours, not the plan's: losing it is no news.
        const closedGap = rawSpans[i].startF - span.startF
        if (room + closedGap < frames) {
          warnings.push(`Shot ${i + 1} was cut short: ${asset.name} ends before the plan's out point.`)
        }
        frames = room
      }
    }
    const startS = span.startF / fps
    const placed: Clip = { ...newClipFromAsset(asset, startS), inS: shot.src_in, outS: shot.src_in + frames / fps }
    const video = fitNewClipToFrame(placed, asset, seq)
    if (plan.audio.keep_clip_audio && asset.hasAudio) {
      // The app's own pair: the picture is video only, its sound sits on A1 linked to it.
      const linkId = newId()
      videoClips.push({ ...video, linkId })
      audioClips.push({ ...placed, id: newId(), linkId })
    } else if (!plan.audio.keep_clip_audio) {
      videoClips.push({ ...video, ownAudioOff: true })
    } else {
      videoClips.push(video)
    }
  })
  seq = withTrackClips(seq, v1.id, videoClips)
  if (a1) seq = withTrackClips(seq, a1.id, audioClips)

  // ---- the titles: the tracks above V1, a new one when two are on screen at once ----
  const titleLimit = (t: ReelPlanTitle, i: number): Clip | null => {
    const span = spanOf(t.at, t.dur, fps)
    const endF = Math.min(span.endF, limitF)
    if (endF <= span.startF) {
      warnings.push(`Title ${i + 1} starts after the end of the reel, so it was left out.`)
      return null
    }
    return titleClipFor(t, { startF: span.startF, endF }, fps)
  }
  const titles = plan.titles
    .map((t, i) => titleLimit(t, i))
    .filter((c): c is Clip => c !== null)
    .sort((a, b) => a.startS - b.startS)
  const titleTrackIds = videoTracks(seq).slice(1).map((t) => t.id)
  for (const clip of titles) {
    let trackId = titleTrackIds.find((id) => !overlaps(seq.tracks.find((t) => t.id === id)!, clip))
    if (trackId === undefined) {
      seq = addTrack(seq, 'video')
      const vts = videoTracks(seq)
      trackId = vts[vts.length - 1].id
      titleTrackIds.push(trackId)
    }
    const track = seq.tracks.find((t) => t.id === trackId)!
    seq = withTrackClips(seq, trackId, [...track.clips, clip].sort((a, b) => a.startS - b.startS))
  }

  // ---- the captions: one per plan word, on the app's Captions track ----
  if (plan.captions.length > 0) {
    const style = BUILTIN_CAPTION_STYLES[0]!
    const sorted = [...plan.captions].sort((a, b) => a.at - b.at)
    const spans = noOverlap(sorted.map((w) => spanOf(w.at, w.dur, fps)))
    const chunks: CaptionChunk[] = []
    sorted.forEach((w, i) => {
      const text = w.word.trim()
      const shown = text.length > 24 ? `${text.slice(0, 21)}...` : text
      if (spans[i].startF >= limitF) {
        warnings.push(`Caption “${shown}” starts after the end of the reel, so it was left out.`)
        return
      }
      if (spans[i].endF <= spans[i].startF) {
        warnings.push(`Caption “${shown}” falls on the same frame as the next one, so it was left out.`)
        return
      }
      const span = { startF: spans[i].startF, endF: Math.min(spans[i].endF, limitF) }
      const startS = span.startF / fps
      const endS = span.endF / fps
      chunks.push({ text, startS, endS, emphasis: false, words: [{ text, startS, endS }] })
    })
    if (chunks.length > 0) {
      const clips = captionClips(chunks, {
        seqWidth: REEL_FRAME.w,
        seqHeight: REEL_FRAME.h,
        caseRule: style.caseRule ?? 'house',
      }).map((c) => dressCaption(c, style, REEL_FRAME.w, REEL_FRAME.h))
      const grown = addTrack(seq, 'video')
      const target = videoTracks(grown).at(-1)!
      seq = {
        ...grown,
        tracks: grown.tracks.map((t) =>
          t.id === target.id ? { ...t, clips, name: CAPTION_TRACK_NAME, captionShape: style.shape } : t,
        ),
      }
    }
  }

  return { seq: recomputeDuration(seq), warnings }
}

/** The sequence a project is being edited in, for callers that hold only the project. */
export function applyReelPlanToProject(project: Project, plan: ReelPlan, assets: Readonly<Record<string, MediaAsset>>): { project: Project; warnings: string[] } {
  const base = activeSequence(project)
  const { seq, warnings } = applyReelPlan(base, plan, assets)
  return { project: { ...project, sequences: { ...project.sequences, [base.id]: seq } }, warnings }
}
