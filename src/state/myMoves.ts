// HIS OWN MOVES: the ones he performs on the picture and keeps.
//
// His ask, 2026-08-14: *"I can animate how I want it, and then I save it, and
// you just save the movements, and then I can completely customize it."* And on
// the shape they take, 2026-08-15: *"I want it to be just like the built-in
// ten."* So what is stored here is a normalised MoveDef, the same thing the ten
// are, produced by `engine/recordMove.ts`.
//
// ⛔ THE STORAGE IS TRACK PRESETS' STORAGE, DELIBERATELY. `state/trackTemplate.ts`
// is the same shape of feature already shipped and already survived contact with
// him: localStorage under a namespaced key, a newest-wins cap, one corrupt row
// dropped alone, and a write that fails silently in private mode rather than
// throwing in his face. Inventing a second way to keep his things would be two
// things to fix the next time one of them is wrong.

import type { Beat, BeatAt, MoveDef } from '../engine/moves'
import { MOTION_CURVES } from '../engine/motion'

export interface MyMove {
  /** His own, not a MoveId: the built-in union is closed and these are not built in. */
  id: string
  name: string
  def: MoveDef
}

const KEY = 'olpremiere:my-moves'

/** Newest-wins cap, so a runaway save loop cannot fill the origin's quota. */
const MAX_MOVES = 24

let counter = 0
/** Ids outlive the session (they are persisted), so they carry a time part. */
export const freshMoveId = (): `mym-${string}` => `mym-${Date.now().toString(36)}-${(counter++).toString(36)}`

const CURVE_NAMES: readonly string[] = [...Object.keys(MOTION_CURVES), 'linear']

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * ⛔ THIS IS NOT DEFENSIVE PROGRAMMING, IT IS THE EDGE OF THE APP.
 *
 * What comes back out of localStorage is untrusted text that goes straight into
 * the renderer's transform maths, and this codebase has already paid for that
 * once: an unknown value reaching the ease switch returned undefined, NaNed the
 * transform and rendered a BLACK FRAME. So every number is checked for being a
 * number here, at the boundary, rather than guarded at each of the places that
 * later multiply by it.
 */
function sanitizeAt(raw: unknown): BeatAt | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (finite(o.frames)) return { frames: o.frames }
  if (finite(o.fromEnd)) return { fromEnd: o.fromEnd }
  if (finite(o.frac)) return { frac: o.frac }
  // ⛔ A PERFORMED BURST USES THIS ONE. Leaving it out of the sanitiser would let
  // him save a punch and find it gone the next time the shelf loaded.
  if (finite(o.secondsFromStart)) return { secondsFromStart: o.secondsFromStart }
  return null
}

/** One malformed beat rejects the WHOLE move: half a move is a different move. */
function sanitizeBeats(raw: unknown): Beat[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const beats: Beat[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const { at, d, aim, shift, curve } = item as Record<string, unknown>
    const when = sanitizeAt(at)
    if (!when) return null
    if (!finite(d)) return null
    if (typeof aim !== 'object' || aim === null) return null
    const a = aim as Record<string, unknown>
    if (!finite(a.x) || !finite(a.y)) return null
    if (typeof curve !== 'string' || !CURVE_NAMES.includes(curve)) return null
    let s: { x: number; y: number } | undefined
    if (shift !== undefined) {
      if (typeof shift !== 'object' || shift === null) return null
      const sh = shift as Record<string, unknown>
      if (!finite(sh.x) || !finite(sh.y)) return null
      s = { x: sh.x, y: sh.y }
    }
    beats.push({
      at: when,
      d,
      aim: { x: a.x, y: a.y },
      ...(s ? { shift: s } : {}),
      curve: curve as Beat['curve'],
    })
  }
  return beats
}

/** Unlike the beats inside one move, a corrupt MOVE is dropped alone: one bad
 * row must not cost him the rest of his shelf. */
function sanitizeMove(raw: unknown): MyMove | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, name, def } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id === '') return null
  if (typeof name !== 'string' || name === '') return null
  if (typeof def !== 'object' || def === null) return null
  const d = def as Record<string, unknown>
  const beats = sanitizeBeats(d.beats)
  if (!beats) return null
  if (d.window !== 'clip' && d.window !== 'moment') return null
  return {
    id,
    name,
    def: {
      id: id as `mym-${string}`,
      name,
      hint: typeof d.hint === 'string' ? d.hint : 'A move you performed and saved',
      window: d.window,
      beats,
      ...(finite(d.recordedDepth) ? { recordedDepth: d.recordedDepth } : {}),
    },
  }
}

function persist(moves: MyMove[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(moves))
  } catch {
    /* private mode / quota: his moves just will not persist */
  }
}

function load(): MyMove[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitizeMove).filter((m): m is MyMove => m !== null)
  } catch {
    return []
  }
}

/** His shelf, newest first. */
export function listMyMoves(): MyMove[] {
  return load()
}

/**
 * Keep a move he just performed. Returns it, or null when the recording had
 * nothing in it.
 *
 * Newest first, capped, and a name he reuses REPLACES rather than piling up a
 * second tile with the same label he cannot tell apart.
 */
export function saveMyMove(name: string, def: MoveDef): MyMove | null {
  const trimmed = name.trim()
  if (!trimmed || def.beats.length === 0) return null
  const id = freshMoveId()
  const move: MyMove = { id, name: trimmed, def: { ...def, id, name: trimmed } }
  const rest = load().filter((m) => m.name.toLowerCase() !== trimmed.toLowerCase())
  const next = [move, ...rest].slice(0, MAX_MOVES)
  persist(next)
  return move
}

export function removeMyMove(id: string): void {
  persist(load().filter((m) => m.id !== id))
}

export function getMyMove(id: string): MyMove | null {
  return load().find((m) => m.id === id) ?? null
}
