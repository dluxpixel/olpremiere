// The reel plan: the one file the gym auto edit hands to OL Premiere (contract
// version 1, written beside the script engine). This module is PURE: no electron,
// no disk, no DOM. The main process checks a plan with it before anything is built,
// and the renderer maps a checked plan into a project, so both sides use the same
// types and the same safe rect.
//
// A plan is all or nothing. The validator returns EVERY problem it finds, never just
// the first, so whoever writes the plan fixes it in one pass.

/** The frame every plan box is measured in, in pixels. */
export const REEL_FRAME = { w: 1080, h: 1920 } as const

/**
 * Where a title may sit, as [x, y, w, h] in the 1080 x 1920 frame: x 60 to 960, y 250
 * to 1500. That keeps text clear of the right side buttons and the caption bar. The
 * Python side uses the same numbers.
 */
export const REEL_SAFE_RECT: readonly [number, number, number, number] = [60, 250, 900, 1250]

export interface ReelPlanClip {
  id: string
  path: string
  /** What ffprobe reported. Informational: the decoder already honors the file's own flag. */
  rotation?: number
}

export interface ReelPlanShot {
  clip: string
  src_in: number
  src_out: number
  at: number
}

export interface ReelPlanTitle {
  text: string
  at: number
  dur: number
  style: string
  box: [number, number, number, number]
}

export interface ReelPlanWord {
  word: string
  at: number
  dur: number
}

export interface ReelPlanAudio {
  music: string | null
  beats: number[]
  keep_clip_audio: boolean
}

export interface ReelPlan {
  version: 1
  format: '9:16'
  fps: number
  duration: number
  source: Record<string, unknown>
  clips: ReelPlanClip[]
  timeline: ReelPlanShot[]
  titles: ReelPlanTitle[]
  captions: ReelPlanWord[]
  audio: ReelPlanAudio
}

export type ReelPlanCheck = { ok: true; plan: ReelPlan } | { ok: false; problems: string[] }

/** One millisecond: the slack for times a script rounded to a few decimals. */
const TIME_SLACK_S = 1e-3
/** Pixel slack for a box that sits exactly on a safe edge. */
const PX_SLACK = 1e-6

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/** A value echoed into a message, short enough that a bad plan cannot flood a toast. */
function shown(v: unknown): string {
  const t = JSON.stringify(v) ?? 'undefined'
  return t.length > 48 ? `${t.slice(0, 45)}...` : t
}

/**
 * Check a parsed plan. Returns the typed plan when it is sound, or EVERY problem when
 * it is not. Messages say where (`timeline[2]`) and what, in plain words.
 */
export function validateReelPlan(raw: unknown): ReelPlanCheck {
  const problems: string[] = []
  const bad = (msg: string): void => {
    problems.push(msg)
  }

  if (!isObj(raw)) return { ok: false, problems: ['The plan must be a JSON object.'] }

  if (raw.version !== 1) bad(`version must be 1 (the file says ${shown(raw.version)}).`)
  if (raw.format !== '9:16') bad(`format must be "9:16" (the file says ${shown(raw.format)}).`)
  const fpsOk = isNum(raw.fps) && raw.fps >= 1 && raw.fps <= 240
  if (!fpsOk) bad('fps must be a number from 1 to 240.')
  const durOk = isNum(raw.duration) && raw.duration > 0
  if (!durOk) bad('duration must be a number above 0.')
  if (raw.source !== undefined && !isObj(raw.source)) bad('source must be an object when it is present.')

  // ---- clips ----
  const clipIds = new Set<string>()
  if (!Array.isArray(raw.clips)) {
    bad('clips must be a list.')
  } else {
    raw.clips.forEach((c: unknown, i: number) => {
      const at = `clips[${i}]`
      if (!isObj(c)) {
        bad(`${at}: must be an object.`)
        return
      }
      if (!isStr(c.id) || c.id.length === 0) bad(`${at}: id must be a non-empty string.`)
      else if (clipIds.has(c.id)) bad(`${at}: id ${shown(c.id)} is used twice.`)
      else clipIds.add(c.id)
      if (!isStr(c.path) || c.path.trim().length === 0) bad(`${at}: path must be a non-empty string.`)
      if (c.rotation !== undefined && !isNum(c.rotation)) bad(`${at}: rotation must be a number when it is present.`)
    })
  }

  // ---- timeline ----
  if (!Array.isArray(raw.timeline)) {
    bad('timeline must be a list.')
  } else {
    if (raw.timeline.length === 0) bad('timeline has no shots, so there is nothing to build.')
    let prevEnd = 0
    let prevAt = -Infinity
    raw.timeline.forEach((s: unknown, i: number) => {
      const at = `timeline[${i}]`
      if (!isObj(s)) {
        bad(`${at}: must be an object.`)
        return
      }
      if (!isStr(s.clip)) bad(`${at}: clip must be a clip id.`)
      else if (!clipIds.has(s.clip)) bad(`${at}: clip ${shown(s.clip)} is not in clips.`)
      const inOk = isNum(s.src_in)
      const outOk = isNum(s.src_out)
      const atOk = isNum(s.at)
      if (!inOk) bad(`${at}: src_in must be a number.`)
      if (!outOk) bad(`${at}: src_out must be a number.`)
      if (!atOk) bad(`${at}: at must be a number.`)
      if (inOk && (s.src_in as number) < 0) bad(`${at}: src_in must be 0 or more.`)
      if (inOk && outOk && (s.src_out as number) <= (s.src_in as number)) {
        bad(`${at}: src_out (${s.src_out}) must be above src_in (${s.src_in}).`)
      }
      if (atOk && (s.at as number) < 0) bad(`${at}: at must be 0 or more.`)
      if (atOk) {
        const start = s.at as number
        if (start < prevAt - TIME_SLACK_S) bad(`${at}: starts at ${start}, before the shot above it (${prevAt}). The timeline must be sorted by at.`)
        else if (start < prevEnd - TIME_SLACK_S) bad(`${at}: starts at ${start}, before the shot above it ends (${prevEnd}). Shots cannot overlap.`)
        prevAt = Math.max(prevAt, start)
        if (inOk && outOk && (s.src_out as number) > (s.src_in as number)) {
          const end = start + ((s.src_out as number) - (s.src_in as number))
          if (durOk && end > (raw.duration as number) + TIME_SLACK_S) {
            bad(`${at}: ends at ${Number(end.toFixed(3))}, past the plan duration (${raw.duration}).`)
          }
          prevEnd = Math.max(prevEnd, end)
        }
      }
    })
  }

  // ---- titles ----
  if (!Array.isArray(raw.titles)) {
    bad('titles must be a list.')
  } else {
    const [sx, sy, sw, sh] = REEL_SAFE_RECT
    raw.titles.forEach((t: unknown, i: number) => {
      const at = `titles[${i}]`
      if (!isObj(t)) {
        bad(`${at}: must be an object.`)
        return
      }
      if (!isStr(t.text) || t.text.trim().length === 0) bad(`${at}: text must be a non-empty string.`)
      if (!isStr(t.style)) bad(`${at}: style must be a string.`)
      if (!isNum(t.at)) bad(`${at}: at must be a number.`)
      else if (t.at < 0) bad(`${at}: at must be 0 or more.`)
      if (!isNum(t.dur)) bad(`${at}: dur must be a number.`)
      else if (t.dur <= 0) bad(`${at}: dur must be above 0.`)
      const box = t.box
      if (!Array.isArray(box) || box.length !== 4 || !box.every(isNum)) {
        bad(`${at}: box must be four numbers [x, y, w, h].`)
      } else {
        const [x, y, w, h] = box as number[]
        if (w <= 0 || h <= 0) {
          bad(`${at}: box ${shown(box)} needs a width and a height above 0.`)
        } else if (x < sx - PX_SLACK || y < sy - PX_SLACK || x + w > sx + sw + PX_SLACK || y + h > sy + sh + PX_SLACK) {
          bad(
            `${at}: box ${shown(box)} is outside the safe rect [${REEL_SAFE_RECT.join(', ')}] (x ${sx} to ${sx + sw}, y ${sy} to ${sy + sh}).`,
          )
        }
      }
    })
  }

  // ---- captions ----
  if (!Array.isArray(raw.captions)) {
    bad('captions must be a list.')
  } else {
    raw.captions.forEach((w: unknown, i: number) => {
      const at = `captions[${i}]`
      if (!isObj(w)) {
        bad(`${at}: must be an object.`)
        return
      }
      if (!isStr(w.word) || w.word.trim().length === 0) bad(`${at}: word must be a non-empty string.`)
      if (!isNum(w.at)) bad(`${at}: at must be a number.`)
      else if (w.at < 0) bad(`${at}: at must be 0 or more.`)
      if (!isNum(w.dur)) bad(`${at}: dur must be a number.`)
      else if (w.dur <= 0) bad(`${at}: dur must be above 0.`)
    })
  }

  // ---- audio ----
  if (!isObj(raw.audio)) {
    bad('audio must be an object.')
  } else {
    const a = raw.audio
    if (a.music !== null && !isStr(a.music)) bad('audio.music must be a file path or null.')
    if (!Array.isArray(a.beats) || !a.beats.every(isNum)) bad('audio.beats must be a list of times in seconds.')
    if (typeof a.keep_clip_audio !== 'boolean') bad('audio.keep_clip_audio must be true or false.')
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, plan: raw as unknown as ReelPlan }
}

/** Parse the text of a plan file and check it. A file that is not JSON is one plain problem. */
export function parseReelPlan(text: string): ReelPlanCheck {
  let raw: unknown
  try {
    // A plan written by a tool that adds a byte order mark is still a plan.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return { ok: false, problems: ['The file is not valid JSON.'] }
  }
  return validateReelPlan(raw)
}
