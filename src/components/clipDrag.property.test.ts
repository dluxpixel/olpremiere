// ⛔ THE DRAG, CHECKED AGAINST THOUSANDS OF TIMELINES HE COULD ACTUALLY HAVE, 2026-10-03.
//
// His words that day: "make it so when i select multiple stuff and drag it anywhere it actually
// works and stays in the SAME SHAPE as when i dragged it". The focused tests in
// engine/blockMove.test.ts pin each bug the two hunts proved. This file is the net under all of
// them: seeded random timelines (video and audio lanes interleaved, packed and sparse, linked
// pairs, locked lanes), a random selection, a random clip grabbed, a random lane and time aimed
// at, and every drag checked for the rules he asked for:
//
// - nothing outside the block changes at all, not a field;
// - every clip of the block moves by ONE time delta and ONE lane delta, and nothing else about it
//   changes;
// - no two clips overlap on any lane, nothing starts before zero, no clip is lost or added;
// - the block lands at the legal spot nearest to where he let go (checked by brute force);
// - the lane delta is the farthest legal one toward where he aimed;
// - the live preview equals what the release commits, snapping included.
//
// The seed is fixed so a failure is reproducible: the message names the case number.

import { describe, expect, it } from 'vitest'
import { dragBlockIds, moveBlock, planBlockMove } from '../engine/blockMove'
import { collectSnapPoints, recomputeDuration } from '../engine/timeline'
import { clipEndS, defaultTransform, type Clip, type Id, type Sequence, type Track } from '../engine/types'
import { dragCommit, moveStep } from './timelineGestures'
import { ASSETS } from './timelineTestFixtures'

/** mulberry32: small, fast, and the same sequence on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const F = 1 / 30
const TOL = 1e-9

interface World {
  seq: Sequence
}

function randomSequence(rand: () => number): Sequence {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
  let n = 0
  const clip = (startF: number, extra: Partial<Clip> = {}): Clip => ({
    id: `c${n++}`,
    assetId: 'av',
    startS: startF * F,
    inS: int(0, 30) * F,
    outS: 0,
    speed: 1,
    enabled: true,
    transform: defaultTransform(),
    opacity: 1,
    blendMode: 'normal',
    audioGainDb: 0,
    fadeInS: rand() < 0.2 ? 0.2 : 0,
    fadeOutS: 0,
    effects: [],
    ...(rand() < 0.1 ? { transitionIn: { type: 'crossDissolve' as const, durationS: 0.3 } } : {}),
    ...extra,
  })
  const withDur = (c: Clip, durF: number): Clip => ({ ...c, outS: c.inS + durF * F })

  const nV = int(1, 4)
  const nA = int(1, 3)
  const kinds: ('video' | 'audio')[] = [...Array(nV).fill('video'), ...Array(nA).fill('audio')]
  // Interleave the kinds at random: the lane delta must count lanes of one kind, never raw indices.
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = int(0, i)
    ;[kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!]
  }
  const tracks: Track[] = kinds.map((kind, i) => {
    const packed = rand() < 0.4
    const clips: Clip[] = []
    let cursor = int(0, 40)
    const count = int(0, 7)
    for (let k = 0; k < count; k++) {
      const durF = int(3, 90)
      clips.push(withDur(clip(cursor), durF))
      cursor += durF + (packed ? (rand() < 0.8 ? 0 : int(1, 10)) : int(0, 60))
    }
    return {
      id: `T${i}`,
      kind,
      name: `T${i}`,
      height: 64,
      muted: false,
      solo: false,
      locked: rand() < 0.12,
      volumeDb: 0,
      pan: 0,
      clips,
    }
  })

  // Linked pairs: a video clip whose sound sits on an audio lane at the same time, where it fits.
  const audio = tracks.filter((t) => t.kind === 'audio')
  let link = 0
  for (const t of tracks) {
    if (t.kind !== 'video') continue
    t.clips = t.clips.map((v) => {
      if (rand() >= 0.35 || audio.length === 0) return v
      const at = audio[int(0, audio.length - 1)]!
      const s = v.startS
      const e = clipEndS(v)
      if (at.clips.some((c) => c.startS < e - TOL && clipEndS(c) > s + TOL)) return v
      const linkId = `L${link++}`
      const partner: Clip = { ...clip(0), startS: s, inS: v.inS, outS: v.outS, linkId }
      at.clips = [...at.clips, partner].sort((a, b) => a.startS - b.startS)
      return { ...v, linkId }
    })
  }
  return recomputeDuration({
    id: 'seq',
    name: 'Prop',
    fps: 30,
    width: 1080,
    height: 1920,
    sampleRate: 48000,
    durationS: 0,
    tracks,
    markers: rand() < 0.5 ? [{ id: 'm1', t: int(0, 300) * F, label: '', color: '#fff' }] : [],
  })
}

const where = (seq: Sequence): Map<Id, { clip: Clip; track: number }> => {
  const m = new Map<Id, { clip: Clip; track: number }>()
  seq.tracks.forEach((t, i) => t.clips.forEach((c) => m.set(c.id, { clip: c, track: i })))
  return m
}

/** Every rule that must hold for ANY drag result, whatever the delta was. */
function checkShape(
  label: string,
  seq: Sequence,
  out: Sequence,
  blockIds: readonly Id[],
  grabbedId: Id,
): { deltaS: number; laneShift: number } {
  const before = where(seq)
  const after = where(out)
  const inBlock = new Set(blockIds)
  expect(after.size, `${label}: clip count`).toBe(before.size)
  for (const id of before.keys()) expect(after.has(id), `${label}: ${id} still there`).toBe(true)

  for (const t of out.tracks) {
    for (let i = 0; i < t.clips.length; i++) {
      const c = t.clips[i]!
      expect(c.startS, `${label}: ${c.id} starts at or after zero`).toBeGreaterThanOrEqual(0)
      if (i > 0) {
        const prev = t.clips[i - 1]!
        expect(c.startS, `${label}: ${t.id} sorted`).toBeGreaterThanOrEqual(prev.startS)
        expect(c.startS, `${label}: ${c.id} overlaps ${prev.id} on ${t.id}`).toBeGreaterThanOrEqual(clipEndS(prev) - TOL)
      }
    }
  }

  // Outside the block: not one field, not one lane.
  for (const [id, b] of before) {
    if (inBlock.has(id)) continue
    const a = after.get(id)!
    expect(a.track, `${label}: ${id} kept its lane`).toBe(b.track)
    expect(a.clip, `${label}: ${id} untouched`).toBe(b.clip)
  }

  // Inside: one delta, one lane delta, nothing else.
  const g = before.get(grabbedId)
  if (!g || blockIds.length === 0) {
    expect(out, `${label}: an empty block moves nothing`).toBe(seq)
    return { deltaS: 0, laneShift: 0 }
  }
  const kind = seq.tracks[g.track]!.kind
  const lanes = seq.tracks.map((t, i) => ({ t, i })).filter((x) => x.t.kind === kind).map((x) => x.i)
  const pos = (i: number) => lanes.indexOf(i)
  const ga = after.get(grabbedId)!
  const deltaS = ga.clip.startS - g.clip.startS
  const laneShift = pos(ga.track) - pos(g.track)
  for (const id of blockIds) {
    const b = before.get(id)!
    const a = after.get(id)!
    expect(a.clip.startS - b.clip.startS, `${label}: ${id} moved by the block delta`).toBeCloseTo(deltaS, 9)
    expect({ ...a.clip, startS: 0 }, `${label}: ${id} changed only its start`).toEqual({ ...b.clip, startS: 0 })
    if (seq.tracks[b.track]!.kind === kind) {
      expect(pos(a.track) - pos(b.track), `${label}: ${id} moved by the block lane delta`).toBe(laneShift)
    } else {
      expect(a.track, `${label}: ${id} of the other kind kept its lane`).toBe(b.track)
    }
    expect(out.tracks[a.track]!.locked && a.track !== b.track, `${label}: ${id} landed on a locked lane`).toBe(false)
  }
  return { deltaS, laneShift }
}

/** By brute force: the legal deltas for the block on its destination lanes, and the nearest to want. */
function bestLegalDistance(seq: Sequence, blockIds: readonly Id[], grabbedId: Id, laneShift: number, wantS: number): number {
  const before = where(seq)
  const inBlock = new Set(blockIds)
  const g = before.get(grabbedId)!
  const kind = seq.tracks[g.track]!.kind
  const lanes = seq.tracks.map((t, i) => ({ t, i })).filter((x) => x.t.kind === kind).map((x) => x.i)
  const members = blockIds.map((id) => {
    const b = before.get(id)!
    const p = lanes.indexOf(b.track)
    return { clip: b.clip, to: p < 0 ? b.track : lanes[p + laneShift]! }
  })
  const floor = -Math.min(...members.map((m) => m.clip.startS))
  const w = Math.max(floor, wantS)
  const legal = (d: number) =>
    d >= floor - TOL &&
    members.every((m) =>
      seq.tracks[m.to]!.clips.every(
        (c) => inBlock.has(c.id) || !(m.clip.startS + d < clipEndS(c) - 1e-7 && clipEndS(m.clip) + d > c.startS + 1e-7),
      ),
    )
  const candidates = [w, floor]
  for (const m of members) {
    for (const c of seq.tracks[m.to]!.clips) {
      if (inBlock.has(c.id)) continue
      candidates.push(c.startS - clipEndS(m.clip), clipEndS(c) - m.clip.startS)
    }
  }
  let best = Infinity
  for (const d of candidates) if (legal(d)) best = Math.min(best, Math.abs(d - w))
  return best
}

/** The farthest lane delta toward the request that keeps every clip of the block on an open lane. */
function bestLaneShift(seq: Sequence, blockIds: readonly Id[], grabbedId: Id, targetTrackId: Id): number {
  const before = where(seq)
  const g = before.get(grabbedId)!
  const kind = seq.tracks[g.track]!.kind
  const lanes = seq.tracks.map((t, i) => ({ t, i })).filter((x) => x.t.kind === kind).map((x) => x.i)
  const ti = seq.tracks.findIndex((t) => t.id === targetTrackId)
  const requested = ti >= 0 && seq.tracks[ti]!.kind === kind ? lanes.indexOf(ti) - lanes.indexOf(g.track) : 0
  let best = 0
  const step = Math.sign(requested)
  for (let s = step; step !== 0 && Math.abs(s) <= Math.abs(requested); s += step) {
    const ok = blockIds.every((id) => {
      const b = before.get(id)!
      const p = lanes.indexOf(b.track)
      if (p < 0) return true
      const q = p + s
      return q >= 0 && q < lanes.length && !seq.tracks[lanes[q]!]!.locked
    })
    if (ok) best = s
  }
  return best
}

const CASES = 4000

describe('a clip drag, on thousands of random timelines', () => {
  it(`keeps the block rigid, destroys nothing, lands at the nearest legal spot, and previews what it commits (${CASES} seeded cases)`, () => {
    const rand = rng(20261003)
    const world: World = { seq: randomSequence(rand) }
    const stats = { moved: 0, collided: 0, laneClamped: 0, laneChanged: 0, multi: 0, linkedInBlock: 0, empty: 0, snapped: 0 }

    for (let k = 0; k < CASES; k++) {
      const label = `case ${k}`
      if (k % 4 === 0) world.seq = randomSequence(rand)
      const seq = world.seq
      const all = seq.tracks.flatMap((t, i) => t.clips.map((c) => ({ c, i })))
      const grabbable = all.filter((x) => !seq.tracks[x.i]!.locked)
      if (grabbable.length === 0) continue
      const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
      const grab = grabbable[int(0, grabbable.length - 1)]!.c
      const density = [0, 0.15, 0.4, 0.8][int(0, 3)]!
      const selection = all.filter((x) => x.c.id === grab.id || rand() < density).map((x) => x.c.id)
      const blockIds = dragBlockIds(seq, selection, grab.id)
      const home = seq.tracks[all.find((x) => x.c.id === grab.id)!.i]!
      const sameKind = seq.tracks.filter((t) => t.kind === home.kind)
      // Mostly a lane of his clip's kind (locked or not), sometimes any lane at all, sometimes home.
      const pick = rand()
      const target =
        pick < 0.65
          ? sameKind[int(0, sameKind.length - 1)]!.id
          : pick < 0.85
            ? seq.tracks[int(0, seq.tracks.length - 1)]!.id
            : home.id
      const r = rand()
      const tS =
        r < 0.6 ? grab.startS + int(-120, 120) * F : r < 0.85 ? int(0, 600) * F : r < 0.95 ? grab.startS : -int(1, 60) * F

      const frozen = JSON.stringify(seq)
      const out = moveBlock(seq, blockIds, grab.id, target, tS)
      expect(JSON.stringify(seq), `${label}: the input is never mutated`).toBe(frozen)
      const got = checkShape(label, seq, out, blockIds, grab.id)

      if (blockIds.length === 0) {
        stats.empty++
        continue
      }
      const plan = planBlockMove(seq, blockIds, grab.id, target, tS)
      if (out !== seq) {
        expect(got.deltaS, `${label}: the plan's delta is the one that landed`).toBeCloseTo(plan.deltaS, 9)
        expect(got.laneShift, `${label}: the plan's lane delta is the one that landed`).toBe(plan.laneShift)
      } else {
        expect(plan.deltaS === 0 && plan.laneShift === 0, `${label}: nothing landed only when the plan is a no-op`).toBe(true)
      }
      expect(plan.laneShift, `${label}: farthest legal lane delta`).toBe(bestLaneShift(seq, blockIds, grab.id, target))
      const wantS = tS - grab.startS
      const best = bestLegalDistance(seq, blockIds, grab.id, plan.laneShift, wantS)
      const at0 = where(seq)
      const floor = -Math.min(...blockIds.map((id) => at0.get(id)!.clip.startS))
      const w = Math.max(floor, wantS)
      expect(Math.abs(plan.deltaS - w), `${label}: nearest legal spot`).toBeLessThanOrEqual(best + 1e-7)

      // The live preview, snapping on or off, is exactly what the release commits.
      const drag = {
        kind: 'move' as const,
        clipId: grab.id,
        grabOffsetS: 0,
        trackKind: seq.tracks[all.find((x) => x.c.id === grab.id)!.i]!.kind,
        downClientX: 0,
        downClientY: 0,
        blockIds,
        collapseCandidate: false,
      }
      const snap =
        rand() < 0.5 ? { points: collectSnapPoints(seq, { excludeClipIds: blockIds, playheadS: int(0, 300) * F }), thresholdS: 8 * F } : null
      const step = moveStep(seq, drag, { startS: tS, trackId: target }, snap)
      const committed = dragCommit(drag, step.final, ASSETS)!.apply(seq)
      expect(committed, `${label}: preview equals commit`).toEqual(step.next)
      checkShape(`${label} (snapped)`, seq, step.next, blockIds, grab.id)
      if (step.indicatorT !== null) stats.snapped++

      if (out !== seq) stats.moved++
      if (Math.abs(plan.deltaS - w) > TOL) stats.collided++
      if (plan.laneShift !== 0) stats.laneChanged++
      const ti = seq.tracks.findIndex((t) => t.id === target)
      if (seq.tracks[ti]!.kind === drag.trackKind) {
        const kindLanes = seq.tracks.map((t, i) => ({ t, i })).filter((x) => x.t.kind === drag.trackKind).map((x) => x.i)
        const requested = kindLanes.indexOf(ti) - kindLanes.indexOf(all.find((x) => x.c.id === grab.id)!.i)
        if (requested !== plan.laneShift) stats.laneClamped++
      }
      if (blockIds.length > 1) stats.multi++
      if (blockIds.some((id) => at0.get(id)!.clip.linkId)) stats.linkedInBlock++
    }

    // The generator must actually exercise every branch, or a green run proves nothing.
    console.info('clip drag property stats', JSON.stringify(stats))
    expect(stats.moved).toBeGreaterThan(CASES * 0.3)
    expect(stats.collided).toBeGreaterThan(CASES * 0.1)
    expect(stats.laneChanged).toBeGreaterThan(CASES * 0.1)
    expect(stats.laneClamped).toBeGreaterThan(CASES * 0.03)
    expect(stats.multi).toBeGreaterThan(CASES * 0.3)
    expect(stats.linkedInBlock).toBeGreaterThan(CASES * 0.1)
    expect(stats.snapped).toBeGreaterThan(CASES * 0.05)
    // A few seconds alone; the budget is for the full suite running every file at once.
  }, 120_000)
})
